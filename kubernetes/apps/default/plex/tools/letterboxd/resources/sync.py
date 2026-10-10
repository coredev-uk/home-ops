#!/usr/bin/env python3
"""Sync Plex watch history to Letterboxd.

History comes from Tautulli, not Plex, so entries survive the underlying file
being deleted or the library being rebuilt. A cursor on the PVC makes each run
incremental; a first run does not backfill (see SYNC_SINCE).

Letterboxd's API is request-only and explicitly not granted "for private or
personal projects", so the only routes in are the import page driven by a
headless browser (rpa) or the CSV importer by hand (csv). A CSV is written every
run either way, as an audit trail and as the fallback when the browser breaks.

Stdlib only, except the rpa path which imports playwright lazily.
"""

from __future__ import annotations

import csv
import json
import logging
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("letterboxd-sync")

# Plex userRating and the importer's Rating10 are both 0-10, so no conversion.
CSV_COLUMNS = [
    "tmdbID",
    "imdbID",
    "Title",
    "Year",
    "WatchedDate",
    "Rating10",
    "Rewatch",
]


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
    rewatch: bool = False

    @property
    def watched_date(self) -> str:
        # Local time (TZ is set on the container), so a late-night film does not
        # land on the following day.
        return datetime.fromtimestamp(self.watched_at).strftime("%Y-%m-%d")

    @property
    def film_key(self) -> str | None:
        """Stable identity for dedup across runs."""
        if self.tmdb_id:
            return f"tmdb:{self.tmdb_id}"
        if self.imdb_id:
            return f"imdb:{self.imdb_id}"
        # Media deleted from the library returns no metadata, so fall back to
        # the title/year pair Letterboxd matches on when ids are absent.
        slug = re.sub(r"[^a-z0-9]+", "-", self.title.lower()).strip("-")
        return f"title:{slug}:{self.year or 0}" if slug else None

    def csv_row(self) -> dict[str, str]:
        return {
            "tmdbID": self.tmdb_id or "",
            "imdbID": self.imdb_id or "",
            "Title": self.title,
            "Year": str(self.year) if self.year else "",
            "WatchedDate": self.watched_date,
            "Rating10": f"{self.rating10:g}" if self.rating10 is not None else "",
            "Rewatch": "true" if self.rewatch else "false",
        }


class State:
    """Cursor and dedup ledger, persisted on the PVC.

    The cursor only advances past entries actually delivered, so a failed run is
    retried rather than skipped.
    """

    def __init__(self, path: Path, initial_cursor: int = 0):
        self.path = path
        self.cursor = 0
        self.logged: dict[str, str] = {}  # "tmdb:603|2026-10-01" -> iso timestamp
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
        self.logged = dict(data.get("logged", {}))
        log.info(
            "state: cursor=%s (%s), %d logged entries",
            self.cursor,
            datetime.fromtimestamp(self.cursor).isoformat() if self.cursor else "never",
            len(self.logged),
        )

    def save(self) -> None:
        payload = {"cursor": self.cursor, "logged": self.logged}
        # Write-then-rename: an interrupted run must not truncate state.
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True))
        tmp.replace(self.path)

    def seen(self, entry: Entry) -> bool:
        key = entry.film_key
        return bool(key) and f"{key}|{entry.watched_date}" in self.logged

    def watched_before(self, entry: Entry) -> bool:
        key = entry.film_key
        if not key:
            return False
        return any(k.startswith(f"{key}|") for k in self.logged)

    def record(self, entry: Entry) -> None:
        key = entry.film_key
        if key:
            self.logged[f"{key}|{entry.watched_date}"] = datetime.now(
                timezone.utc
            ).isoformat()


def http_json(url: str, *, timeout: int = 60) -> tuple[int, object]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw, status = resp.read(), resp.status
    except urllib.error.HTTPError as exc:
        raw, status = exc.read(), exc.code
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw.decode("utf-8", "replace")


class Tautulli:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def call(self, cmd: str, fatal: bool = True, **params: object) -> object:
        query = {"apikey": self.api_key, "cmd": cmd}
        query.update({k: v for k, v in params.items() if v is not None})
        url = f"{self.base_url}/api/v2?{urllib.parse.urlencode(query)}"
        status, payload = http_json(url)
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

        `start_date` is day-precision only, so it just keeps the pages small;
        the row's unix `date` is authoritative, which avoids re-importing
        everything watched earlier the same day.
        """
        start_date = None
        if since:
            start_date = datetime.fromtimestamp(since).strftime("%Y-%m-%d")

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
                start_date=start_date,
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


def write_csv(entries: list[Entry], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    path = out_dir / f"diary-{stamp}.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for entry in entries:
            writer.writerow(entry.csv_row())
    # Stable path, so it can be fetched predictably.
    latest = out_dir / "latest.csv"
    latest.write_bytes(path.read_bytes())
    log.info("wrote %d entries to %s (and latest.csv)", len(entries), path.name)
    return path


def deliver_rpa(entries: list[Entry], csv_path: Path, state_dir: Path, dry_run: bool) -> list[Entry]:
    """Drive the import page with a headless browser.

    Depends on Letterboxd's markup and will break when they change it, so a
    screenshot is saved on failure and the run's CSV stays valid for a manual
    import.
    """
    if dry_run:
        log.info("[dry-run] would import %d entries via %s", len(entries), csv_path.name)
        return list(entries)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("LETTERBOXD_DELIVERY=rpa needs playwright; use the playwright image")

    username = env("LETTERBOXD_USERNAME", required=True)
    password = env("LETTERBOXD_PASSWORD", required=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        page = browser.new_page()
        try:
            page.goto("https://letterboxd.com/sign-in/", wait_until="domcontentloaded")
            page.fill("#field-username", username)
            page.fill("#field-password", password)
            page.click("#signin-button, button[type='submit']")
            page.wait_for_load_state("networkidle")

            if "sign-in" in page.url:
                raise RuntimeError("still on the sign-in page; credentials rejected?")

            page.goto("https://letterboxd.com/import/", wait_until="domcontentloaded")
            page.set_input_files("input[type='file']", str(csv_path))
            # Parsed client-side, then the confirm control appears; the row
            # count is not known up front.
            page.wait_for_selector("text=/Import \\d+ film/i", timeout=120_000)
            page.click("text=/Import \\d+ film/i")
            page.wait_for_load_state("networkidle", timeout=120_000)
            log.info("import submitted for %d entries", len(entries))
            return list(entries)
        except Exception as exc:
            shot = state_dir / "rpa-failure.png"
            try:
                page.screenshot(path=str(shot), full_page=True)
                log.error("saved failure screenshot to %s", shot)
            except Exception:
                pass
            log.error("browser import failed: %s", exc)
            log.error("the CSV at %s is still valid - import it manually", csv_path)
            return []
        finally:
            browser.close()


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    delivery = env("LETTERBOXD_DELIVERY", "csv").strip().lower()
    if delivery not in ("csv", "rpa"):
        sys.exit(f"LETTERBOXD_DELIVERY must be csv or rpa (got {delivery!r})")

    dry_run = env_bool("DRY_RUN")
    state_dir = Path(env("STATE_DIR", "/data"))
    state_dir.mkdir(parents=True, exist_ok=True)

    # Only consulted when there is no state yet. Unset means "start from now",
    # i.e. never backfill; SYNC_SINCE=1970-01-01 forces the full history.
    since = env("SYNC_SINCE").strip()
    if since:
        try:
            initial_cursor = int(
                datetime.strptime(since, "%Y-%m-%d").timestamp()
            )
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

    # Plex servers are usually shared, so an unscoped run must be opted into.
    user_id = env("TAUTULLI_USER_ID") or None
    if not user_id and not env_bool("TAUTULLI_ALL_USERS"):
        sys.exit(
            "TAUTULLI_USER_ID is not set. Set it to the Plex user whose history "
            "should be synced (cmd=get_users lists them), or set "
            "TAUTULLI_ALL_USERS=true to deliberately sync every user."
        )

    log.info("delivery=%s dry_run=%s threshold=%s%%", delivery, dry_run, threshold)

    rows = tautulli.movie_history(state.cursor, threshold, user_id)
    log.info("%d completed film play(s) since the cursor", len(rows))
    if not rows:
        log.info("nothing to sync")
        # Must persist even when idle, or the next run finds no state and
        # restarts the window at its own "now", skipping the gap.
        if not dry_run:
            state.save()
        return 0

    # Oldest first: a first watch must precede its rewatch, and capping then
    # leaves a contiguous remainder for the next run.
    entries: list[Entry] = []
    want_rating = env_bool("SYNC_RATINGS", True)
    seen_in_batch: set[str] = set()

    for row in rows:
        if len(entries) >= max_per_run:
            log.info(
                "capped at MAX_PER_RUN=%d; the remainder is picked up next run",
                max_per_run,
            )
            break

        entry = Entry(
            rating_key=str(row.get("rating_key") or ""),
            title=str(row.get("full_title") or row.get("title") or "unknown"),
            year=int(row["year"]) if str(row.get("year") or "").isdigit() else None,
            watched_at=int(row.get("date") or 0),
        )
        if not entry.rating_key:
            log.warning("history row without a rating_key, skipping: %s", entry.title)
            continue

        tautulli.enrich(entry, want_rating)
        if not entry.film_key:
            log.warning("no usable identity for %s, skipping", entry.title)
            continue
        if state.seen(entry):
            log.debug("already logged %s on %s", entry.title, entry.watched_date)
            continue

        entry.rewatch = entry.film_key in seen_in_batch or state.watched_before(entry)
        seen_in_batch.add(entry.film_key)
        entries.append(entry)

    if not entries:
        log.info("no new entries after filtering; advancing cursor")
        state.cursor = int(rows[-1].get("date") or state.cursor)
        if not dry_run:
            state.save()
        return 0

    by_title = sum(1 for e in entries if (e.film_key or "").startswith("title:"))
    if by_title:
        log.warning(
            "%d of %d entries have no tmdb/imdb id and rely on title/year "
            "matching; check those on the import page",
            by_title,
            len(entries),
        )

    # Both modes: audit trail, and the fallback if the browser import fails.
    csv_path = write_csv(entries, state_dir / "exports")

    if delivery == "csv":
        delivered = entries
        log.info("csv mode: import %s at https://letterboxd.com/import/", csv_path.name)
    else:
        delivered = deliver_rpa(entries, csv_path, state_dir, dry_run)

    if not delivered:
        log.error("nothing delivered; leaving the cursor unchanged for a retry")
        return 1

    for entry in delivered:
        state.record(entry)
    # Only as far as what actually landed.
    state.cursor = delivered[-1].watched_at

    if dry_run:
        log.info("[dry-run] state not persisted")
    else:
        state.save()

    log.info(
        "delivered %d/%d entries; cursor now %s",
        len(delivered),
        len(entries),
        datetime.fromtimestamp(state.cursor).isoformat(),
    )
    return 0 if len(delivered) == len(entries) else 1


if __name__ == "__main__":
    sys.exit(main())
