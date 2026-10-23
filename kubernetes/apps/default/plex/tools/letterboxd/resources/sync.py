#!/usr/bin/env python3
"""Sync Plex watch history to the Letterboxd diary.

History comes from Tautulli, not Plex, so entries survive the underlying file
being deleted or the library being rebuilt. A cursor on the PVC makes each run
incremental; a first run does not backfill (see SYNC_SINCE).

Entries are written through Letterboxd's own API (api.letterboxd.com/api/v0),
signing in with the account's username and password, the same way the
Jellyscribe Jellyfin plugin (github.com/builtbyproxy/Jellyscribe) does. The
diary itself is the dedup source: a film already logged on that date is
skipped, and an earlier entry makes the new one a rewatch.

Stdlib only.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("letterboxd-sync")

# Letterboxd only grants API keys to commercial partners, so this is the
# key/secret pair Jellyscribe ships (LetterboxdApiConstants.cs). If Letterboxd
# revokes it, sign-in fails with 401/403; take the new pair from Jellyscribe.
LETTERBOXD_API = "https://api.letterboxd.com/api/v0"
LETTERBOXD_API_KEY = "ebe3d27ec52a35fc8d1835c6531c37bd72b7a54337666d5bd759379b72ae16f0"
LETTERBOXD_API_SECRET = "c60ce045d25bc90cb56026a8dd621eebeef995cbecc51951192da75348c977cd"

# Cloudflare in front of the API 403s urllib's default "Python-urllib/x.y".
USER_AGENT = "plex-letterboxd-sync/1.0"
# Longest Retry-After honoured on a 429 before giving up on the run.
MAX_RETRY_AFTER = 60


def env(name: str, default: str | None = None, required: bool = False) -> str:
    value = os.environ.get(name, default if default is not None else "")
    if required and not value:
        sys.exit(f"{name} is required")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    return env(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)))
    except ValueError:
        sys.exit(f"{name} must be an integer")


@dataclass
class Entry:
    """One watch, normalised away from both Tautulli's and Letterboxd's shapes."""

    rating_key: str
    title: str
    year: int | None
    watched_at: int  # unix seconds, the Tautulli history row's `date`
    tmdb_id: str | None = None
    imdb_id: str | None = None
    rating10: float | None = None

    @property
    def watched_date(self) -> str:
        # Local time (TZ is set on the container), so a late-night film does not
        # land on the following day.
        return datetime.fromtimestamp(self.watched_at).strftime("%Y-%m-%d")

    @property
    def stars(self) -> float | None:
        """Plex's 0-10 as Letterboxd's 0.5-5.0 in half steps, halves rounding up."""
        if not self.rating10 or self.rating10 <= 0:
            return None
        return min(max(math.floor(self.rating10 + 0.5) / 2, 0.5), 5.0)


class State:
    """The cursor, persisted on the PVC.

    It advances past each history row once that row is settled (logged, already
    in the diary, or unmatchable), and is saved after every row, so a failed or
    interrupted run resumes at the first unsettled row.
    """

    def __init__(self, path: Path, initial_cursor: int = 0):
        self.path = path
        self.cursor = 0
        self._load(initial_cursor)

    def _load(self, initial_cursor: int) -> None:
        if not self.path.exists():
            self.cursor = initial_cursor
            log.info(
                "no state file at %s; first run starts from %s",
                self.path,
                datetime.fromtimestamp(self.cursor).isoformat()
                if self.cursor
                else "the beginning of history",
            )
            return
        try:
            data = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            # Refuse to continue rather than silently re-import everything.
            sys.exit(f"state file {self.path} is unreadable ({exc}); fix or remove it")
        self.cursor = int(data.get("cursor", 0))
        log.info(
            "state: cursor=%s (%s)",
            self.cursor,
            datetime.fromtimestamp(self.cursor).isoformat() if self.cursor else "never",
        )

    def save(self) -> None:
        # Write-then-rename: an interrupted run must not truncate state.
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"cursor": self.cursor}, indent=2))
        tmp.replace(self.path)


def http_json(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> tuple[int, object, dict[str, str]]:
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw, status, resp_headers = resp.read(), resp.status, dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw, status, resp_headers = exc.read(), exc.code, dict(exc.headers)
    if not raw:
        return status, None, resp_headers
    try:
        return status, json.loads(raw), resp_headers
    except json.JSONDecodeError:
        return status, raw.decode("utf-8", "replace"), resp_headers


class Tautulli:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def call(self, cmd: str, fatal: bool = True, **params: object) -> object:
        query = {"apikey": self.api_key, "cmd": cmd}
        query.update({k: v for k, v in params.items() if v is not None})
        url = f"{self.base_url}/api/v2?{urllib.parse.urlencode(query)}"
        status, payload, _ = http_json(url)
        if status != 200 or not isinstance(payload, dict):
            if not fatal:
                return None
            sys.exit(f"tautulli {cmd} failed: HTTP {status}")
        response = payload.get("response") or {}
        if response.get("result") != "success":
            if not fatal:
                return None
            sys.exit(f"tautulli {cmd} failed: {response.get('message')}")
        return response.get("data")

    def movie_history(self, since: int, threshold: float, user_id: str | None) -> list[dict]:
        """Completed film plays newer than `since`, oldest first.

        Tautulli's `start_date` means "only this exact date", so `after`
        (inclusive, day precision) bounds the query instead. It is set a day
        early because Tautulli resolves dates in its own timezone, which may
        differ from ours; the row's unix `date` is authoritative, which also
        avoids re-importing everything watched earlier the same day.
        """
        after = None
        if since:
            after = (datetime.fromtimestamp(since) - timedelta(days=1)).strftime("%Y-%m-%d")

        rows: list[dict] = []
        offset, page_size = 0, 200
        while True:
            data = self.call(
                "get_history",
                media_type="movie",
                order_column="date",
                order_dir="desc",
                start=offset,
                length=page_size,
                after=after,
                user_id=user_id,
                grouping=1,
            )
            if not isinstance(data, dict):
                break
            page = data.get("data") or []
            if not page:
                break

            exhausted = False
            for row in page:
                when = int(row.get("date") or 0)
                if when <= since:
                    # Newest first, so everything after this is older too.
                    exhausted = True
                    continue
                if not self._is_complete(row, threshold):
                    continue
                rows.append(row)

            if exhausted or len(page) < page_size:
                break
            offset += page_size

        rows.sort(key=lambda r: int(r.get("date") or 0))
        return rows

    @staticmethod
    def _is_complete(row: dict, threshold: float) -> bool:
        # Either signal clearing the bar counts, so a film scrubbed to the end
        # still registers. watched_status is 1 / 0.5 / 0.
        try:
            if float(row.get("watched_status") or 0) >= 1:
                return True
        except (TypeError, ValueError):
            pass
        try:
            return float(row.get("percent_complete") or 0) >= threshold
        except (TypeError, ValueError):
            return False

    def enrich(self, entry: Entry, want_rating: bool) -> None:
        """Fill in external ids and the Plex rating from item metadata.

        Returns quietly when the item is gone: Tautulli keeps the history row
        after the media is deleted, but get_metadata then 400s, so there are no
        ids to be had and the entry falls back to title/year matching.
        """
        data = self.call("get_metadata", fatal=False, rating_key=entry.rating_key)
        if not isinstance(data, dict) or not data:
            log.info(
                "no metadata for %s (%s) - media removed, matching on title/year",
                entry.title,
                entry.year or "year unknown",
            )
            return

        for guid in data.get("guids") or []:
            if not isinstance(guid, str):
                continue
            if guid.startswith("tmdb://"):
                entry.tmdb_id = guid.removeprefix("tmdb://")
            elif guid.startswith("imdb://"):
                entry.imdb_id = guid.removeprefix("imdb://")

        if not entry.year:
            try:
                entry.year = int(data.get("year") or 0) or None
            except (TypeError, ValueError):
                entry.year = None

        if want_rating:
            try:
                rating = float(data.get("user_rating") or 0)
            except (TypeError, ValueError):
                rating = 0
            entry.rating10 = rating if rating > 0 else None


class LetterboxdError(Exception):
    pass


class Letterboxd:
    """The slice of Letterboxd's API needed to write diary entries."""

    def __init__(self) -> None:
        self.token = ""
        self.member_id = ""

    def request(
        self,
        method: str,
        path: str,
        params: dict[str, object] | None = None,
        *,
        json_body: dict | None = None,
        form: dict[str, str] | None = None,
    ) -> object:
        """A signed request; one retry on a short 429, LetterboxdError otherwise."""
        body, ctype = None, None
        if json_body is not None:
            body, ctype = json.dumps(json_body), "application/json"
        elif form is not None:
            body, ctype = urllib.parse.urlencode(form), "application/x-www-form-urlencoded"

        for attempt in range(2):
            # The signature covers nonce and timestamp, so a retry re-signs.
            query = urllib.parse.urlencode(
                {
                    **(params or {}),
                    "apikey": LETTERBOXD_API_KEY,
                    "nonce": str(uuid.uuid4()),
                    "timestamp": str(int(time.time())),
                }
            )
            url = f"{LETTERBOXD_API}{path}?{query}"
            signature = hmac.new(
                LETTERBOXD_API_SECRET.encode(),
                f"{method}\0{url}\0{body or ''}".encode(),
                hashlib.sha256,
            ).hexdigest()
            headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
            if ctype:
                headers["Content-Type"] = ctype
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"

            status, payload, resp_headers = http_json(
                f"{url}&signature={signature}",
                method=method,
                body=body.encode() if body is not None else None,
                headers=headers,
            )
            if status == 429 and attempt == 0:
                try:
                    wait = int(resp_headers.get("Retry-After") or 5)
                except ValueError:
                    wait = 5
                if wait <= MAX_RETRY_AFTER:
                    log.warning("letterboxd rate limited %s; retrying in %ds", path, wait)
                    time.sleep(wait)
                    continue
            if 200 <= status < 300:
                return payload
            # Error bodies can echo the request, so never the sign-in's.
            detail = "" if path == "/auth/token" else f": {str(payload)[:300]}"
            raise LetterboxdError(f"{method} {path} returned HTTP {status}{detail}")
        raise AssertionError("unreachable")

    def sign_in(self, username: str, password: str) -> None:
        token = self.request(
            "POST",
            "/auth/token",
            form={"grant_type": "password", "username": username, "password": password},
        )
        if not isinstance(token, dict) or not token.get("access_token"):
            raise LetterboxdError("sign-in reply had no access token")
        self.token = token["access_token"]
        me = self.request("GET", "/me")
        member = (me or {}).get("member") if isinstance(me, dict) else None
        if not isinstance(member, dict) or not member.get("id"):
            raise LetterboxdError("/me reply had no member id")
        self.member_id = member["id"]
        log.info("signed in to letterboxd as %s", member.get("username") or username)

    def find_film(self, entry: Entry) -> dict | None:
        """The Letterboxd film for an entry: by TMDb id, then IMDb id, then an
        exact title and year match. None when nothing matches unambiguously."""
        for prefix, ident in (("tmdb", entry.tmdb_id), ("imdb", entry.imdb_id)):
            if not ident:
                continue
            data = self.request("GET", "/films", {"filmId": f"{prefix}:{ident}", "perPage": 1})
            items = (data or {}).get("items") or [] if isinstance(data, dict) else []
            if items:
                return items[0]

        if not entry.year:
            return None
        data = self.request(
            "GET",
            "/search",
            {"input": entry.title, "include": "FilmSearchItem", "perPage": 20},
        )
        items = (data or {}).get("items") or [] if isinstance(data, dict) else []
        wanted = entry.title.casefold()
        matches = [
            item["film"]
            for item in items
            if isinstance(item.get("film"), dict)
            and str(item["film"].get("name", "")).casefold() == wanted
            and item["film"].get("releaseYear") == entry.year
        ]
        return matches[0] if len(matches) == 1 else None

    def diary_dates(self, film_id: str) -> set[str]:
        """Every date this member has the film in their diary, all pages."""
        dates: set[str] = set()
        cursor: str | None = None
        while True:
            params: dict[str, object] = {"member": self.member_id, "film": film_id, "perPage": 100}
            if cursor:
                params["cursor"] = cursor
            data = self.request("GET", "/log-entries", params)
            if not isinstance(data, dict):
                raise LetterboxdError("diary read returned no data")
            for item in data.get("items") or []:
                date = (item.get("diaryDetails") or {}).get("diaryDate")
                if date:
                    dates.add(str(date)[:10])
            cursor = data.get("next")
            if not cursor:
                return dates

    def log_watch(self, film_id: str, date: str, rewatch: bool, stars: float | None) -> None:
        body: dict[str, object] = {
            "filmId": film_id,
            "diaryDetails": {"diaryDate": date, "rewatch": rewatch},
            "like": False,
            "tags": [],
        }
        if stars is not None:
            body["rating"] = stars
        self.request("POST", "/log-entries", json_body=body)


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    dry_run = env_bool("DRY_RUN")
    state_dir = Path(env("STATE_DIR", "/data"))
    state_dir.mkdir(parents=True, exist_ok=True)

    # Only consulted when there is no state yet. Unset means "start from now",
    # i.e. never backfill; SYNC_SINCE=1970-01-01 forces the full history.
    since = env("SYNC_SINCE").strip()
    if since:
        try:
            initial_cursor = int(datetime.strptime(since, "%Y-%m-%d").timestamp())
        except ValueError:
            sys.exit(f"SYNC_SINCE must be YYYY-MM-DD (got {since!r})")
    else:
        initial_cursor = int(datetime.now().timestamp())

    state = State(state_dir / "state.json", initial_cursor)

    tautulli = Tautulli(
        env("TAUTULLI_URL", "http://tautulli.default.svc.cluster.local"),
        env("TAUTULLI_API_KEY", required=True),
    )

    threshold = float(env("COMPLETION_THRESHOLD", "85"))
    max_per_run = env_int("MAX_PER_RUN", 50)
    want_rating = env_bool("SYNC_RATINGS", True)

    # Plex servers are usually shared, so an unscoped run must be opted into.
    user_id = env("TAUTULLI_USER_ID") or None
    if not user_id and not env_bool("TAUTULLI_ALL_USERS"):
        sys.exit(
            "TAUTULLI_USER_ID is not set. Set it to the Plex user whose history "
            "should be synced (cmd=get_users lists them), or set "
            "TAUTULLI_ALL_USERS=true to deliberately sync every user."
        )

    log.info("dry_run=%s threshold=%s%%", dry_run, threshold)

    rows = tautulli.movie_history(state.cursor, threshold, user_id)
    log.info("%d completed film play(s) since the cursor", len(rows))
    if not rows:
        log.info("nothing to sync")
        # Must persist even when idle, or the next run finds no state and
        # restarts the window at its own "now", skipping the gap.
        if not dry_run:
            state.save()
        return 0

    letterboxd = Letterboxd()
    try:
        letterboxd.sign_in(
            env("LETTERBOXD_USERNAME", required=True),
            env("LETTERBOXD_PASSWORD", required=True),
        )
    except LetterboxdError as exc:
        log.error("letterboxd sign-in failed: %s", exc)
        return 1

    # Diary reads can lag a write just made, so a film watched twice in one
    # batch is tracked here as well.
    logged_this_run: dict[str, set[str]] = {}
    logged = skipped = 0

    # Oldest first: a first watch must precede its rewatch, and stopping early
    # leaves a contiguous remainder for the next run.
    for row in rows:
        if logged + skipped >= max_per_run:
            log.info("capped at MAX_PER_RUN=%d; the remainder is picked up next run", max_per_run)
            break

        entry = Entry(
            rating_key=str(row.get("rating_key") or ""),
            title=str(row.get("full_title") or row.get("title") or "unknown"),
            year=int(row["year"]) if str(row.get("year") or "").isdigit() else None,
            watched_at=int(row.get("date") or 0),
        )
        label = f"{entry.title} ({entry.year or '?'}) on {entry.watched_date}"

        try:
            if entry.rating_key:
                tautulli.enrich(entry, want_rating)
            film = letterboxd.find_film(entry)
            if film is None:
                # Permanent: retrying would block every later watch behind it.
                log.warning("no unambiguous letterboxd match for %s, skipping", label)
                skipped += 1
            else:
                film_id = str(film["id"])
                dates = letterboxd.diary_dates(film_id) | logged_this_run.get(film_id, set())
                if entry.watched_date in dates:
                    log.info("already in the diary: %s", label)
                    skipped += 1
                else:
                    rewatch = any(d < entry.watched_date for d in dates)
                    stars = entry.stars
                    if dry_run:
                        log.info("[dry-run] would log %s%s", label, " (rewatch)" if rewatch else "")
                    else:
                        letterboxd.log_watch(film_id, entry.watched_date, rewatch, stars)
                        log.info(
                            "logged %s%s%s",
                            label,
                            " (rewatch)" if rewatch else "",
                            f" rated {stars:g}" if stars is not None else "",
                        )
                    logged_this_run.setdefault(film_id, set()).add(entry.watched_date)
                    logged += 1
        except LetterboxdError as exc:
            # Stop rather than hammer a failing API; this row is retried next run.
            log.error("letterboxd failed on %s: %s", label, exc)
            log.info("logged %d, skipped %d before the failure", logged, skipped)
            return 1

        state.cursor = entry.watched_at
        if not dry_run:
            state.save()

    log.info(
        "logged %d, skipped %d; cursor now %s%s",
        logged,
        skipped,
        datetime.fromtimestamp(state.cursor).isoformat(),
        " [dry-run, state not persisted]" if dry_run else "",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
