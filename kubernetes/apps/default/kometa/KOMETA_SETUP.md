# Kometa Setup Reference

Last captured: 2026-06-03

This file documents the intended Kometa deployment. It intentionally omits API keys, auth tokens, and other secrets.

## Deployment

- Namespace: `default`
- HelmRelease: `kometa`
- App image: `kometateam/kometa:v2.3.1@sha256:683c04827ef3fecf1cc5cb178f75f91f968aef6c6d89d34bc9c70966fd1d7259`
- Chart: `oci://ghcr.io/bjw-s-labs/helm/app-template`, version `5.0.1`
- Schedule: `0 5 * * *`
- Timezone: `Europe/London`
- Config PVC: mounted at `/config`
- Config files are mounted from `kometa-configmap`:
    - `/config/config.yml`
    - `/config/Movies.yml`
    - `/config/TV.yml`
- Config is read-only at runtime using `KOMETA_READ_ONLY_CONFIG=true`
- Kometa is run as a CronJob with `KOMETA_RUN=true`, so each Kubernetes job runs once and exits
- Root filesystem is read-only for the app container
- Configured as non-root UID/GID `1000`

## Required Secrets

ExternalSecret: `kubernetes/apps/default/kometa/app/externalsecret.yaml`

New 1Password item key: `kometa`

Required fields on the `kometa` item:

- `PLEX_TOKEN`
- `TMDB_API_KEY`
- `MDBLIST_API_KEY`

Initial values were created with `op` from:

- `PLEX_TOKEN`: Plex pod `Preferences.xml` `PlexOnlineToken`
- `TMDB_API_KEY`: user-provided TMDb API key
- `MDBLIST_API_KEY`: Agregarr settings

Kometa's docs recommend a Plex token generated expressly for Kometa rather than a server token from `Preferences.xml`; replace `PLEX_TOKEN` later if you want to follow that recommendation strictly.

Also uses existing 1Password items:

- `radarr`, field `RADARR_API_KEY`
- `sonarr`, field `SONARR_API_KEY`
- `tautulli`, field `TAUTULLI_API_KEY`

Kometa config secret placeholders intentionally avoid underscores because Kometa documents that config secret names like `<<my_secret>>` do not work.

## Plex

- Host: `plex.default.svc.cluster.local`
- Port: `32400`
- SSL verification: disabled for in-cluster HTTP access
- Libraries:
    - `Films`
    - `TV Programmes`

## Placeholder Mitigation

Kometa does not use Agregarr-style placeholder media files for these collections.

To avoid the Seerr requestability issue documented in the Agregarr setup notes:

- No media placeholder paths are mounted.
- Missing item reporting is disabled with `show_missing: false` and `show_missing_assets: false`.
- Radarr/Sonarr are configured only for safe API availability. `add_missing`, `add_existing`, `upgrade_existing`, `monitor_existing`, search, and cutoff search are disabled.
- No `placeholder_*`, `radarr_add_missing`, or `sonarr_add_missing` template variables are configured.
- Collection files are intended to build Plex collections from items already present in Plex.

## Supported Services

Configured Kometa-supported services available in this cluster:

- Plex
- Tautulli
- Radarr, non-mutating only
- Sonarr, non-mutating only

Configured external services:

- TMDb
- MDBList

Not configured because Kometa does not expose connectors for them in the current docs:

- Maintainerr
- Seerr/Overseerr

## Collections

Custom movie collections:

- `Recently Added Movies`
- `Recently Released Movies`
- `Popular on Plex - Films`

Custom TV collections:

- `Recently Added TV`
- `Recently Released Episodes`
- `Popular on Plex - TV`

Default collection files:

- Films: `basic`, `tmdb`, `imdb`, `tautulli`, `streaming`, `seasonal`, `universe`, `studio`, `genre`
- TV Programmes: `basic`, `tmdb`, `imdb`, `tautulli`, `streaming`, `network`, `genre`

Library-level defaults:

- `collection_mode: hide`
- `use_separator: false`

Kometa does not have a direct Seerr/Overseerr recently-requested builder, so Agregarr's `Recently Requested` rows are not recreated here.

## Documentation Checked

- Kometa docs: `https://kometa.wiki/en/latest/`
- Latest release checked: `v2.3.1`
- Official image documentation uses `kometateam/kometa`
- Defaults-first setup avoids Trakt OAuth state in GitOps
