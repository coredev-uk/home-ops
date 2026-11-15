#!/usr/bin/env python3
"""Prometheus exporter for Seerr requests that nothing is downloading.

Each scrape lists Seerr's approved-but-unavailable and failed requests, then
asks Radarr or Sonarr whether the request still wants released content and
whether the download queue holds a live download for it. A request that wants
content and has no live download is exported as

    seerr_request_stalled{request_id, media_type, title, requested_by} 1

and the SeerrRequestStalled alert fires once that holds for a few minutes. A
failed grab is blocklisted and replaced within seconds when the quality
profile accepts another release, so a request only stays stalled when the
profile rejects every release, every grab fails, or the import is blocked.

Wanted means:
- movie: Radarr has no file and counts the movie as available (released per
  its minimum availability). Unreleased requests are not stalled.
- series: monitored episodes of the requested seasons, without a file, that
  aired before the request. Episodes airing later arrive through Sonarr's RSS
  hours after air, which is normal and not a stalled request.

A live download is a queue item still downloading or importing with no
warning or error; a stalled torrent or a blocked import is not live.

Stdlib only.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("seerr-exporter")

SEERR_URL = os.environ["SEERR_URL"].rstrip("/")
RADARR_URL = os.environ["RADARR_URL"].rstrip("/")
SONARR_URL = os.environ["SONARR_URL"].rstrip("/")
SEERR_API_KEY = os.environ["SEERR_API_KEY"]
RADARR_API_KEY = os.environ["RADARR_API_KEY"]
SONARR_API_KEY = os.environ["SONARR_API_KEY"]
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))
TIMEOUT = 10

# Seerr's request filters: approved with media not yet available, and requests
# Seerr failed to hand to Radarr/Sonarr.
REQUEST_FILTERS = ("processing", "failed")
LIVE_STATES = {"downloading", "importPending", "importing"}


def get(base: str, key: str, path: str, **params: object) -> object:
    url = f"{base}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-Api-Key": key, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.load(resp)


def seerr_requests() -> list[dict]:
    requests: dict[int, dict] = {}
    for flt in REQUEST_FILTERS:
        skip = 0
        while True:
            page = get(SEERR_URL, SEERR_API_KEY, "/api/v1/request", take=100, skip=skip, filter=flt)
            for r in page["results"]:
                requests[r["id"]] = r
            skip += len(page["results"])
            if not page["results"] or skip >= page["pageInfo"]["results"]:
                break
    return list(requests.values())


def live_queue(base: str, key: str, id_field: str) -> set[int]:
    page = get(base, key, "/api/v3/queue", pageSize=1000)
    return {
        rec[id_field]
        for rec in page["records"]
        if rec.get(id_field) is not None
        and rec.get("trackedDownloadState") in LIVE_STATES
        and rec.get("trackedDownloadStatus") == "ok"
    }


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def movie_stalled(req: dict, radarr_live: set[int]) -> tuple[bool, str]:
    tmdb_id = req["media"]["tmdbId"]
    movies = get(RADARR_URL, RADARR_API_KEY, "/api/v3/movie", tmdbId=tmdb_id)
    if not movies:
        # Seerr failed to add it, or it was removed from Radarr: nothing will fetch it.
        return True, f"tmdb {tmdb_id}"
    movie = movies[0]
    title = f"{movie['title']} ({movie['year']})"
    if movie["hasFile"] or not movie["isAvailable"]:
        return False, title
    return movie["id"] not in radarr_live, title


def series_stalled(req: dict, sonarr_live: set[int]) -> tuple[bool, str]:
    tvdb_id = req["media"].get("tvdbId")
    series = get(SONARR_URL, SONARR_API_KEY, "/api/v3/series", tvdbId=tvdb_id) if tvdb_id else []
    if not series:
        return True, f"tvdb {tvdb_id}"
    show = series[0]
    title = show["title"]
    seasons = {s["seasonNumber"] for s in req.get("seasons", [])}
    requested_at = parse_time(req["createdAt"])
    episodes = get(SONARR_URL, SONARR_API_KEY, "/api/v3/episode", seriesId=show["id"])
    wanted = any(
        ep["seasonNumber"] in seasons
        and ep["monitored"]
        and not ep["hasFile"]
        and ep.get("airDateUtc")
        and parse_time(ep["airDateUtc"]) < requested_at
        for ep in episodes
    )
    if not wanted:
        return False, title
    return show["id"] not in sonarr_live, title


def label(value: str) -> str:
    return value.replace("\\", r"\\").replace('"', r"\"").replace("\n", r"\n")


def collect() -> str:
    requests = seerr_requests()
    radarr_live = live_queue(RADARR_URL, RADARR_API_KEY, "movieId")
    sonarr_live = live_queue(SONARR_URL, SONARR_API_KEY, "seriesId")
    lines = [
        "# HELP seerr_request_stalled Request wants released content and nothing is downloading it.",
        "# TYPE seerr_request_stalled gauge",
    ]
    for req in requests:
        if req["type"] == "movie":
            stalled, title = movie_stalled(req, radarr_live)
        else:
            stalled, title = series_stalled(req, sonarr_live)
        if not stalled:
            continue
        user = req.get("requestedBy") or {}
        labels = {
            "request_id": str(req["id"]),
            "media_type": req["type"],
            "title": title,
            "requested_by": user.get("displayName") or user.get("email") or "unknown",
        }
        rendered = ",".join(f'{k}="{label(v)}"' for k, v in labels.items())
        lines.append(f"seerr_request_stalled{{{rendered}}} 1")
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path != "/metrics":
            self.send_error(404)
            return
        try:
            body = collect().encode()
        except Exception:
            # A failed scrape shows as up == 0 instead of a silently empty result.
            log.exception("collect failed")
            self.send_error(503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("listening on :%d", LISTEN_PORT)
    ThreadingHTTPServer(("", LISTEN_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
