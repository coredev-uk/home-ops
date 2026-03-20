# Default Namespace Postgres/Redis Compatibility

This matrix documents whether each app in `kubernetes/apps/default` exposes environment-variable based compatibility with centralized PostgreSQL or Redis.

| App | Postgres | Redis | Notes |
| --- | --- | --- | --- |
| atuin | yes | no | Supports `ATUIN_DB_URI` (migrated in this branch) |
| autobrr | no | no | No Postgres/Redis env knobs in current deployment values |
| bazarr | no | no | No Postgres/Redis env knobs in current deployment values |
| changedetection | no | no | No Postgres/Redis env knobs in current deployment values |
| deduparr | no | no | No Postgres/Redis env knobs in current deployment values |
| frigate | no | no | No Postgres/Redis env knobs in current deployment values |
| glance | no | no | No Postgres/Redis env knobs in current deployment values |
| home-assistant | no | no | No Postgres/Redis env knobs in current deployment values |
| homebridge | no | no | No Postgres/Redis env knobs in current deployment values |
| jellyfin | no | no | No Postgres/Redis env knobs in current deployment values |
| mealie | yes | no | Supports `DB_ENGINE=postgres` and `POSTGRES_*` envs (migrated in this branch) |
| notifiarr | no | no | No Postgres/Redis env knobs in current deployment values |
| outline | yes | yes | Already uses `DATABASE_URL` (Postgres) and `REDIS_URL` |
| pocket-id | yes | no | Supports `DB_CONNECTION_STRING` (migrated in this branch) |
| prowlarr | no | no | No Postgres/Redis env knobs in current deployment values |
| qbittorrent | no | no | No Postgres/Redis env knobs in current deployment values |
| qui | no | no | No Postgres/Redis env knobs in current deployment values |
| radarr | no | no | No Postgres/Redis env knobs in current deployment values |
| sabnzbd | no | no | No Postgres/Redis env knobs in current deployment values |
| seasonpackerr | no | no | No Postgres/Redis env knobs in current deployment values |
| seerr | no | no | No Postgres/Redis env knobs in current deployment values |
| sonarr | no | no | No Postgres/Redis env knobs in current deployment values |

## Migrated in this branch

- `atuin`: switched from SQLite to centralized PostgreSQL
- `mealie`: switched from SQLite to centralized PostgreSQL
- `pocket-id`: switched from SQLite to centralized PostgreSQL

## Centralized database bootstrap

`kubernetes/apps/db/postgresql/app/helmrelease.yaml` now includes an `initdb` script that creates roles and databases for:

- `atuin`
- `mealie`
- `pocket_id`

The script is idempotent and safe to re-run. In the Bitnami chart this runs during PostgreSQL cluster initialization, so existing clusters may require one manual run of equivalent SQL if already initialized.
