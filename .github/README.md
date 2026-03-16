<div align="center">

# Home Operations

Personal home-ops repository for running a Talos Kubernetes cluster with Flux GitOps.

[![Renovate](https://img.shields.io/github/actions/workflow/status/coredev-uk/home-ops/renovate.yaml?branch=main&style=for-the-badge&logo=renovatebot&logoColor=white&label=Renovate)](https://github.com/coredev-uk/home-ops/actions/workflows/renovate.yaml)
[![Schemas](https://img.shields.io/github/actions/workflow/status/coredev-uk/home-ops/schemas.yaml?branch=main&style=for-the-badge&logo=databricks&logoColor=white&label=Schemas)](https://github.com/coredev-uk/home-ops/actions/workflows/schemas.yaml)
[![Flux Local](https://img.shields.io/github/actions/workflow/status/coredev-uk/home-ops/flux-local.yaml?branch=main&style=for-the-badge&logo=flux&logoColor=white&label=Flux%20Local)](https://github.com/coredev-uk/home-ops/actions/workflows/flux-local.yaml)

</div>

This is a practical, single-cluster setup focused on reliability and straightforward operations.

## Overview

- Kubernetes runs on Talos Linux.
- Flux reconciles cluster state from this repository.
- Workloads and platform config live under `kubernetes/`.
- Bootstrap and lifecycle operations are managed with `just` modules.

## Hardware

| Device | Qty | CPU | Memory | Storage | Role | Misc Hardware |
|---|---:|---|---|---|---|---|
| Beelink SEi14 (`hyperion-0`) | 1 | Intel Core Ultra 5 125H | 32GB DDR5 | 1TB NVMe M.2 (Ceph), 128GB NVMe M.2 (Talos) | Kubernetes node | Google Coral TPU A+E |
| Lenovo ThinkCentre M720q (`hyperion-1`) | 1 | Intel Core i5-8400T | 16GB DDR4 | 1TB SSD (Ceph), 256GB SSD (Talos) | Kubernetes node | - |
| Lenovo ThinkCentre M920q (`hyperion-2`) | 1 | Intel Core i5-8500T | 16GB DDR4 | 1TB SSD (Ceph), 128GB SSD (Talos) | Kubernetes node | - |
| UniFi UNAS 2 | 1 | - | - | 2x 2TB Seagate IronWolf HDD | NAS | - |

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

On Nix systems, this repository is configured to use `devenv` (`devenv.nix`, `devenv.yaml`, `.envrc`) for a reproducible local toolchain, including `just`, `kubectl`, `talosctl`, `flux`, and related utilities.

## Credits

Many patterns and parts of this setup were sourced from [onedr0p/home-ops](https://github.com/onedr0p/home-ops). Credit to that project for the structure and inspiration.
