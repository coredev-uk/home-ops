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
📁 kubernetes
├── 📁 apps       # applications
├── 📁 components # re-useable kustomize components
└── 📁 flux       # flux system configuration
```

## Operations

```sh
# show available commands
just -l

# bootstrap the full stack (Talos + Kubernetes + apps)
just bootstrap

# run specific bootstrap stages
just bootstrap talos
just bootstrap kube
just bootstrap apps

# Kubernetes utility operations
just kube sync-ks
just kube sync-hr

# Talos day-2 operations
just talos upgrade-node hyperion-0
just talos upgrade-k8s v1.34.1
```

## Development Environment

The toolchain comes from a Nix flake (`flake.nix`, loaded by direnv through `.envrc`): `just`, `kubectl`, `talosctl`, `flux`, `helm`/`helmfile`, `flate`, `crane` and the git hook tools. `op` is taken from the system. Renovate keeps `flake.lock` current; CI pins its own tool versions in `.github/workflows/ci.yaml`.

## Renovate and Clarence

Renovate (`.renovaterc.json5`, run every two hours by `.github/workflows/renovate.yaml` as `bot-cecil[bot]`) opens the update pull requests; it never merges them. [Clarence](https://github.com/coredev-uk/clarence) (`kubernetes/apps/clarence`) does: it rules on each Renovate pull request (code checks, then the Jev model on the release notes), labels it `clarence/*`, and merges what its policy passes one at a time, then waits for the Flux Kustomizations and HelmReleases it touched to apply the merge commit, soaks, and opens a revert pull request and halts merging if the deploy is unhealthy. Changes under `.github/workflows/` are verified by CI on `main` instead. The policy is `kubernetes/apps/clarence/clarence/app/policy-home-ops.json`; while a scope's mode is `shadow` Clarence only labels and comments. The same Deployment runs a second controller for `coredev-uk/sona-go`.

Every open pull request gets one Clarence card, edited in place: the verdict, what it deploys, the checks, Jev's reading and a timeline from queue to live. Its checkboxes (re-run, hold, merge, explain) act on the next poll when `coredev-uk` ticks them. Separate comments appear only when something needs you: an unhealthy deploy, a revert, a dequeue, or a reply to a command.

Comment on a pull request (only `coredev-uk`; `/clarence help` answers anyone):

| Comment                                               | Effect                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `/clarence merge`                                     | Queue it for merge at its current head                            |
| `/clarence merge --allow destructive,image`           | Same, accepting those checks' blocking findings (`health` too)    |
| `/clarence merge at 03:00` · `after #570` · `--batch` | Same, scheduled                                                   |
| `/clarence cancel`                                    | Take it out of the queue                                          |
| `/clarence revert`                                    | On a merged pull request: open a revert pull request and queue it |
| `/clarence reclassify`                                | Ask Jev again and rerun the checks                                |
| `/clarence status`                                    | The ruling, checks, queue position, health gate and deploy state  |
| `/clarence explain`                                   | Which parts of the release notes drive each flagged Jev answer    |
| `/clarence hold` · `/clarence unhold`                 | Never merge this pull request / undo that                         |
| `/clarence help`                                      | Every command and the card checkbox it matches                    |

After an unhealthy deploy, fix it, `/clarence merge` or close the revert, then remove `clarence/unhealthy` from the original pull request. Operations, metrics and the full rule set: [docs/clarence.md](https://github.com/coredev-uk/clarence/blob/main/docs/clarence.md).

## Credits

Many patterns and parts of this setup were sourced from [onedr0p/home-ops](https://github.com/onedr0p/home-ops). Credit to that project for the structure and inspiration.
