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

### Secrets provider

Secrets live in 1Password. Proton Pass can replace it only where Proton has a client for it:

| Where                                                      | Switch                                                                          | Proton Pass                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions (`renovate.yaml`, `tag.yaml`)               | repository variable `SECRETS_PROVIDER` (unset or `1password`, or `proton-pass`) | `protonpass/load-secret-action` reads `pass://kubernetes/bot-cecil/...` with the repository secret `PROTON_PASS_PERSONAL_ACCESS_TOKEN`, a token granted viewer access to the `kubernetes` vault (`pass-cli pat create`, then `pass-cli pat access grant`) |
| `just template` (Talos config, bootstrap secrets)          | environment variable `SECRETS_PROVIDER`                                         | the `op://vault/item/field` and `op://vault/item/section/field` references become `pass://vault/item/field` and `pass://vault/item/section.field` for `pass-cli inject`; the items need the same names in a signed-in Proton Pass                         |
| ExternalSecrets (`ClusterSecretStore/onepassword-connect`) | none                                                                            | no provider: External Secrets Operator 2.15.0 has none, and [external-secrets#6917](https://github.com/external-secrets/external-secrets/pull/6917) is still open                                                                                         |

The `bootstrap/` Secrets for 1Password Connect only make sense with the 1Password store, so a Proton Pass bootstrap still needs the `1password` item until the ExternalSecrets move.

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

`kubernetes/apps/nix-cache` serves an [Attic](https://github.com/zhaofengli/attic) binary cache at `https://nix-cache.hera.ac/coredev` (public, envoy-internal only) for [coredev-uk/nixos](https://github.com/coredev-uk/nixos). Every 30 minutes the `nix-cache-builder` CronJob looks for commits it has not built on that repository's `main` and on its open pull requests from its own branches. For each, it builds every `x86_64-linux` nixosConfiguration and homeConfiguration (`atlas`, `paul@atlas`), pushes whatever built and cache.nixos.org, nix-community and nix-citizen do not already sign, and sets the commit's `nix-cache` status as BOT Cecil. A run with nothing new stops before mounting the store. It never writes to the repository: its nightly `update-flake-lock` workflow opens the `flake-update` pull request as BOT Cecil, and the pull request merges itself once its checks and `nix-cache` pass, so `main` only gets a lock whose builds are already in the cache. The builder needs a privileged pod for the Nix sandbox, so it runs under RuntimeClass `kata` (`siderolabs/kata-containers` in the Talos schematic). Its Nix store is an ext4 image on a Ceph volume. The Grafana dashboard is _Nix Cache_, and the alerts are `NixCacheMainBuildFailed`, `NixCacheBuilderStale` and `NixFlakeLockStale`.

One-time setup, in 1Password item `nix-cache` (the builder also reads BOT Cecil's `GITHUB_BOT_APP_CLIENT_ID` and `GITHUB_BOT_APP_PRIVATE_KEY` from item `bot-cecil`; the app needs Commit statuses, Contents and Pull requests on coredev-uk/nixos):

- `ATTIC_SERVER_TOKEN_RS256_SECRET_BASE64`: `openssl genrsa -traditional 4096 | base64 -w0` (Attic needs a PKCS#1 key)
- `ATTIC_TOKEN`: `atticadm -f kubernetes/apps/nix-cache/attic/app/resources/server.toml make-token --sub nix-cache-builder --validity 10y --pull coredev --push coredev --create-cache coredev --configure-cache coredev --configure-cache-retention coredev`, with the key above in the environment

The first run creates the cache and logs its public key (`[nix-cache] cache coredev: Public Key: ...`). Add that key and `https://nix-cache.hera.ac/coredev` to `hosts/default.nix` in coredev-uk/nixos. Run a build now with `kubectl -n nix-cache create job --from=cronjob/nix-cache-builder nix-cache-builder-manual`.

## Credits

Many patterns and parts of this setup were sourced from [onedr0p/home-ops](https://github.com/onedr0p/home-ops). Credit to that project for the structure and inspiration.
