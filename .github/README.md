<div align="center">

# Home Operations

Personal home-ops repository for running a Talos Kubernetes cluster with Flux GitOps.

</div>

<div align="center">

![Home Internet](https://kromgo.hera.ac/badges/buddy_ping)
![Status Page](https://kromgo.hera.ac/badges/buddy_status_page)
![Alertmanager](https://kromgo.hera.ac/badges/buddy_heartbeat)

</div>

<div align="center">

![Age](https://kromgo.hera.ac/badges/cluster_birth_age)
![Uptime](https://kromgo.hera.ac/badges/cluster_uptime_age)
![Nodes](https://kromgo.hera.ac/badges/cluster_node_count)
![Pods](https://kromgo.hera.ac/badges/cluster_pod_count)
![CPU](https://kromgo.hera.ac/badges/cluster_cpu_usage)
![Memory](https://kromgo.hera.ac/badges/cluster_memory_usage)
![Alerts](https://kromgo.hera.ac/badges/cluster_alert_count)

</div>

This is a practical, single-cluster setup focused on reliability and straightforward operations.

## Overview

- Kubernetes runs on Talos Linux.
- Flux reconciles cluster state from this repository.
- Workloads and platform config live under `kubernetes/`.
- Bootstrap and lifecycle operations are managed with `just` modules.

## Hardware

| Device                                  | Qty | CPU                     | Memory    | Storage                                     | Role            | Misc Hardware        |
| --------------------------------------- | --: | ----------------------- | --------- | ------------------------------------------- | --------------- | -------------------- |
| Beelink SEi14 (`hyperion-0`)            |   1 | Intel Core Ultra 5 125H | 32GB DDR5 | 1TB NVMe M.2 (Ceph), 256GB NVMe M.2 (Talos) | Kubernetes node | Google Coral TPU A+E |
| Lenovo ThinkCentre M720q (`hyperion-1`) |   1 | Intel Core i5-8400T     | 16GB DDR4 | 1TB SSD (Ceph), 128GB SSD (Talos)           | Kubernetes node | -                    |
| Lenovo ThinkCentre M920q (`hyperion-2`) |   1 | Intel Core i5-8500T     | 16GB DDR4 | 1TB SSD (Ceph), 500GB SSD (Talos)           | Kubernetes node | -                    |
| UniFi UNAS 2                            |   1 | -                       | -         | 2x 2TB Seagate IronWolf HDD                 | NAS             | -                    |

## Repository Layout

```text
📁 bootstrap      # helmfile and kustomize used to bring up a new cluster
📁 kubernetes
├── 📁 apps       # applications, Flux itself under flux-system
└── 📁 components # re-useable kustomize components
📁 talos          # Talos machine configuration
```

## Operations

```sh
# show available commands
just -l

# bootstrap the full stack (Talos + Kubernetes + apps)
just bootstrap cluster

# Kubernetes utility operations
just kube sync ks
just kube sync hr

# Talos day-2 operations (tuppr upgrades the cluster from kubernetes/apps/system-upgrade)
just talos upgrade-node hyperion-0
just talos upgrade-k8s <version>
```

## Development Environment

The toolchain comes from a Nix flake (`flake.nix`, loaded by direnv through `.envrc`): `just`, `kubectl`, `talosctl`, `flux`, `helm`/`helmfile`, `flate`, `crane` and the git hook tools. `op` is taken from the system. Renovate keeps `flake.lock` current; CI installs Nix and runs its tools from the same flake.

## Renovate and Clarence

Renovate (`.renovaterc.json5`, run every two hours by `.github/workflows/renovate.yaml` as `bot-cecil[bot]`) opens the update pull requests; it never merges them. Clarence (`kubernetes/apps/clarence`, the `bot-clarence` GitHub App) does: it rules on each Renovate pull request (code checks, then the Jev model on the release notes), labels it `verdict/*`, and merges what its policy passes one at a time (`state/*` follows it from queued to live), then waits for the Flux Kustomizations and HelmReleases it touched to apply the merge commit, soaks, and opens a revert pull request and halts merging if the deploy is unhealthy. Changes under `.github/workflows/` are verified by CI on `main` instead. Clarence scans the old and new image of each image update with Trivy against the in-cluster Trivy server (`kubernetes/apps/clarence/trivy`): an update whose new image drops HIGH or CRITICAL CVEs the old one has gets `kind/security` and goes ahead in the merge line, and the daily report lists those CVEs in the images the cluster runs. The policy is `kubernetes/apps/clarence/clarence/app/policy-home-ops.json`; while a scope's mode is `shadow` Clarence only labels and comments. The same Deployment runs controllers for `coredev-uk/sona-go` and `coredev-uk/clarence`.

Every open pull request gets one Clarence card, edited in place: the verdict, what it deploys, the checks, Jev's reading and a timeline from queue to live. Its checkboxes (re-run, hold, merge, explain) act within about 20 seconds when `coredev-uk` ticks them; GitHub's webhook wakes Clarence sooner. Separate comments appear only when something needs you: an unhealthy deploy, a revert or a dequeue.

Mention Clarence at the start of a comment (only `coredev-uk`; `@bot-clarence help` answers anyone):

| Comment                                                   | Effect                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `@bot-clarence merge`                                     | Queue it for merge at its current head                            |
| `@bot-clarence merge --allow destructive,image`           | Same, accepting those checks' blocking findings (`health` too)    |
| `@bot-clarence merge at 03:00` · `after #570` · `--batch` | Same, scheduled                                                   |
| `@bot-clarence cancel`                                    | Take it out of the queue                                          |
| `@bot-clarence revert`                                    | On a merged pull request: open a revert pull request and queue it |
| `@bot-clarence reclassify`                                | Ask Jev again and rerun the checks                                |
| `@bot-clarence status`                                    | The ruling, checks, queue position, health gate and deploy state  |
| `@bot-clarence explain`                                   | Which parts of the release notes drive each flagged Jev answer    |
| `@bot-clarence hold` · `@bot-clarence unhold`             | Never merge this pull request / undo that                         |
| `@bot-clarence help`                                      | Every command and the card checkbox it matches                    |

Clarence answers a command with a reaction, and the reason goes on the card's timeline: 👀 queued, in progress · 👍 done · 🚀 merged · 👎 refused, or cancelled by you · 😕 failed or not understood. Only `status`, `explain` and `help` reply with a comment.

After an unhealthy deploy, fix it, `@bot-clarence merge` or close the revert, then remove `state/unhealthy` from the original pull request.

## Nix Cache

`kubernetes/apps/nix-cache` serves an [Attic](https://github.com/zhaofengli/attic) binary cache at `https://attic.hera.ac/coredev` (public through envoy-external: reading needs no token) for [coredev-uk/nixos](https://github.com/coredev-uk/nixos). That repository's `Hosts` workflow builds its hosts and pushes them there with the `ATTIC_TOKEN` secret:

- `atlas` (system and `paul@atlas`) on every pull request and push to `main`, on the `nixos-runner` runners (`kubernetes/apps/actions-runner-system/actions-runner-controller/runners/nixos`): one job at a time, each in its own Kata VM, with a Nix store that persists between jobs. They reach Attic at envoy-external directly.
- `poseidon` (nix-darwin) weekly and on demand, on GitHub's macOS runners, which join the tailnet (`oracle/headscale`, `tag:ci`, allowed only envoy-external's 443) to push. On pull requests and other pushes its check passes without building.

Both skip targets the cache already has (`nix-fast-build --skip-cached`), push paths as they land in the store (`attic watch-store`), and on `main` record each target's store path as a `nix-cache/<target>` commit status. The cache's upstream keys are cache.nixos.org's, nix-community's and nix-citizen's, so Attic skips whatever those already sign and holds only what nobody else builds. Pushes never go through Cloudflare, which rejects request bodies over 100 MB. Attic's chunks live on the NAS share `NixCache` (`expanse.internal:/var/nfs/shared/NixCache`); its SQLite database, which holds the cache's signing key, is on the `attic` claim and backed up by kopiur. Paths nobody fetched for 30 days are garbage-collected. The Grafana dashboard is _Nix Cache_.

One-time setup:

- The NAS share `NixCache`, exported over NFS to the cluster like `Media` and `Kopiur`, writable by uid 65534.
- In 1Password item `nix-cache`: `ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64`, `openssl genrsa -traditional 4096 | base64 -w0` (Attic needs a PKCS#1 key), and `ATTIC_TOKEN`, made as `kubernetes/apps/nix-cache/attic/app/externalsecret.yaml` describes and also set as the `ATTIC_TOKEN` Actions secret on coredev-uk/nixos.
- The cache, with a short-lived token that may create and configure it: `attic cache create --public hera:coredev`, then `attic cache configure hera:coredev --upstream-cache-key-name cache.nixos.org-1 --upstream-cache-key-name nix-community.cachix.org-1 --upstream-cache-key-name nix-citizen.cachix.org-1`. `attic cache info hera:coredev` prints the public key that `hosts/default.nix` in coredev-uk/nixos trusts.
- The `hyperion-actions-runner` GitHub App installed on coredev-uk/nixos as well as this repository, and `just oracle ci-authkey` for the macOS runners' tailnet key (Actions secret `TS_AUTHKEY`).
- On coredev-uk/nixos, workflows from outside contributors need approval (Settings > Actions > General): a fork's pull request would otherwise run on `nixos-runner`.

## Credits

Many patterns and parts of this setup were sourced from [onedr0p/home-ops](https://github.com/onedr0p/home-ops). Credit to that project for the structure and inspiration.
