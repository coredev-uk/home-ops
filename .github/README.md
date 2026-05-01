<div align="center">

# Home Operations

Personal home-ops repository for running a Talos Kubernetes cluster with Flux GitOps.
</div>

<div align="center">

[![Home-Internet](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus.hera.ac%2Fapi%2Fv1%2Fendpoints%2Fstatus_ping%2Fhealth%2Fbadge.shields&style=for-the-badge&logo=ubiquiti&logoColor=white&label=Home%20Internet)](https://status.hera.ac)&nbsp;&nbsp;
[![Status-Page](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus.hera.ac%2Fapi%2Fv1%2Fendpoints%2Fstatus_status-page%2Fhealth%2Fbadge.shields&style=for-the-badge&logo=statuspage&logoColor=white&label=Status%20Page)](https://status.hera.ac)&nbsp;&nbsp;
[![Alertmanager](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus.hera.ac%2Fapi%2Fv1%2Fendpoints%2Fstatus_heartbeat%2Fhealth%2Fbadge.shields&style=for-the-badge&logo=prometheus&logoColor=white&label=Alertmanager)](https://status.hera.ac)

</div>

<div align="center">

[![Age-Days](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_age_days&style=flat-square&label=Age)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![Uptime-Days](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_uptime_days&style=flat-square&label=Uptime)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![Node-Count](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_node_count&style=flat-square&label=Nodes)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![Pod-Count](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_pod_count&style=flat-square&label=Pods)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![CPU-Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_cpu_usage&style=flat-square&label=CPU)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![Memory-Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_memory_usage&style=flat-square&label=Memory)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![Power-Usage](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_power_usage&style=flat-square&label=Power)](https://github.com/kashalls/kromgo)&nbsp;&nbsp;
[![Alerts](https://img.shields.io/endpoint?url=https%3A%2F%2Fkromgo.hera.ac%2Fcluster_alert_count&style=flat-square&label=Alerts)](https://github.com/kashalls/kromgo)

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
