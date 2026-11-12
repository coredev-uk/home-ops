"""Prometheus exporter for the Nix cache (sidecar in the attic HelmRelease).

Attic has no metrics endpoint. Every REFRESH_SECONDS this reads Attic's SQLite database
(read-only) for what the cache holds. A scrape only returns the last snapshot.
"""

import os
import sqlite3
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ATTIC_DB = os.environ.get("ATTIC_DB", "/db/server.db")
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "60"))
PORT = int(os.environ.get("PORT", "9102"))

lock = threading.Lock()
snapshot = {"body": ""}


def log(msg):
    print(f"[nix-cache-exporter] {msg}", flush=True)


def esc(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def ts(value):
    """Attic stores timestamps as text, e.g. '2026-11-03 14:52:10.123456 +00:00'."""
    if not value:
        return None
    return datetime.fromisoformat(value.replace(" +", "+").replace(" -", "-")).timestamp()


class Metrics:
    def __init__(self):
        self.lines = []
        self.declared = set()

    def add(self, name, kind, help_text, value, labels=None):
        if value is None:
            return
        if name not in self.declared:
            self.lines.append(f"# HELP {name} {help_text}")
            self.lines.append(f"# TYPE {name} {kind}")
            self.declared.add(name)
        label = ""
        if labels:
            label = "{" + ",".join(f'{k}="{esc(v)}"' for k, v in labels.items()) + "}"
        self.lines.append(f"{name}{label} {float(value):.17g}")


def collect_cache(m):
    # mode=ro: never writes the database. WAL mode still needs the -shm file writable,
    # which is why the volume is mounted read-write.
    db = sqlite3.connect(f"file:{ATTIC_DB}?mode=ro", uri=True, timeout=10)
    try:
        day_ago = time.time() - 86400
        for cache_id, name in db.execute("SELECT id, name FROM cache WHERE deleted_at IS NULL"):
            labels = {"cache": name}
            count, nar_bytes = db.execute(
                "SELECT count(*), coalesce(sum(n.nar_size), 0) FROM object o "
                "JOIN nar n ON n.id = o.nar_id WHERE o.cache_id = ?",
                (cache_id,),
            ).fetchone()
            m.add("nix_cache_objects", "gauge", "Store paths in the cache.", count, labels)
            m.add("nix_cache_nar_bytes", "gauge",
                  "Uncompressed size of the store paths in the cache.", nar_bytes, labels)
            newest = None
            accessed = 0
            for created, last_accessed in db.execute(
                "SELECT created_at, last_accessed_at FROM object WHERE cache_id = ?", (cache_id,)
            ):
                created_ts = ts(created)
                newest = created_ts if newest is None else max(newest, created_ts)
                access_ts = ts(last_accessed)
                if access_ts is not None and access_ts >= day_ago:
                    accessed += 1
            m.add("nix_cache_last_push_timestamp_seconds", "gauge",
                  "When the newest store path was pushed.", newest, labels)
            m.add("nix_cache_objects_accessed_24h", "gauge",
                  "Store paths a client fetched in the last 24 hours.", accessed, labels)
        chunks, stored = db.execute(
            "SELECT count(*), coalesce(sum(coalesce(file_size, chunk_size)), 0) FROM chunk "
            "WHERE state = 'V'"
        ).fetchone()
        m.add("nix_cache_chunks", "gauge", "Deduplicated chunks in Attic's storage.", chunks)
        m.add("nix_cache_stored_bytes", "gauge",
              "Compressed, deduplicated bytes the cache stores.", stored)
    finally:
        db.close()
    m.add("nix_cache_database_bytes", "gauge", "Size of Attic's SQLite database.",
          os.path.getsize(ATTIC_DB))


def refresh():
    while True:
        start = time.time()
        m = Metrics()
        ok = 1
        for part in (collect_cache,):
            try:
                part(m)
            except Exception as e:  # noqa: BLE001 - report and keep serving the rest
                ok = 0
                log(f"{part.__name__} failed: {e}")
        m.add("nix_cache_exporter_collect_success", "gauge",
              "1 if the last collection read everything.", ok)
        m.add("nix_cache_exporter_collect_duration_seconds", "gauge",
              "How long the last collection took.", time.time() - start)
        with lock:
            snapshot["body"] = "\n".join(m.lines) + "\n"
        time.sleep(REFRESH_SECONDS)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics":
            with lock:
                body = snapshot["body"].encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
        elif self.path == "/healthz":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
        else:
            body = b"not found\n"
            self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    threading.Thread(target=refresh, daemon=True).start()
    log(f"listening on :{PORT}")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
