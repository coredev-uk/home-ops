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

`kubernetes/apps/nix-cache` runs [niks3](https://github.com/Mic92/niks3), the write side of the binary cache for [coredev-uk/nixos](https://github.com/coredev-uk/nixos). The cache itself is the Cloudflare R2 bucket `nix-cache`, which Nix reads directly at `https://nix-cache.hera.ac` (the bucket's custom domain), so the hosts can substitute from it while the cluster is down. That repository's `Hosts` workflow builds every host on GitHub's runners for every pull request and every push to `main`: one matrix job each, `atlas` (system and `paul@atlas`, on Ubuntu) and `poseidon` (nix-darwin, on macOS). Each job skips targets the cache already has (`nix-fast-build --skip-cached`) and pushes each derivation as it finishes through [niks3-action](https://github.com/Mic92/niks3-action). The workflow authenticates with its GitHub OIDC token, and niks3 hands out presigned URLs, so the NARs go straight to R2. On `main` it pins the results (`https://nix-cache.hera.ac/pins/atlas`, `pins/paul-at-atlas`, `pins/poseidon`), which keeps them through garbage collection. niks3 tracks references in a CNPG Postgres, and its GC CronJob drops closures older than a week. Only `/api/` is public, at `niks3.hera.ac`. The Grafana dashboard is _niks3_.

One-time setup, in 1Password item `nix-cache` (the R2 account id comes from `CLOUDFLARE_ACCOUNT_TAG` in item `cloudflare`):

- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: an R2 Account API token with Object Read & Write on the `nix-cache` bucket only. The bucket's custom domain is `nix-cache.hera.ac`.
- `NIKS3_SIGNING_KEY`: `nix key generate-secret --key-name nix-cache.hera.ac-1`, and `NIKS3_PUBLIC_KEY` its public half (`nix key convert-secret-to-public`), which `hosts/default.nix` in coredev-uk/nixos trusts
- `NIKS3_API_TOKEN`: at least 36 random characters, for the GC CronJob
- `POSTGRES_PASSWORD`: the niks3 database owner's

## Credits

Many patterns and parts of this setup were sourced from [onedr0p/home-ops](https://github.com/onedr0p/home-ops). Credit to that project for the structure and inspiration.
