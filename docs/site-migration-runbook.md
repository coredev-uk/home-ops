# Site Migration Runbook — hyperion cluster relocation

**Scope:** physically relocate all three nodes (`hyperion-0/1/2`), the switch, and the NAS to a
new site in one trip, on a new IP range. No network bridge between old and new site. No return
trip if something's wrong — this has to work from what travels in the vehicle.

**Status:** complete. Migration executed 2026-08-30 (shutdown) → 2026-09-18 (restore). All open
decisions in §0 are resolved, all post-move verification in §5 is green, and `site-migration` has
been merged to `main`. See §8 for what actually happened during restore, including a few issues
this runbook didn't anticipate.

---

## 0. Decisions needed before move day

These aren't things I can safely decide for you — get them settled with at least a few days of
runway so the rest of this doc can be finalized against real values.

1. ~~New site IP block.~~ **Resolved** — reserve the whole `192.168.100.0`–`192.168.199.0`
   "hundreds" range for the new site (see §1 for why). New property, new network, no legacy
   equipment to collide with — mesh entries only occupy up to `.40` today, so the block is clear.
2. ~~VLAN3 / "VPN" network.~~ **Resolved** — keeping it, moves to `192.168.120.0/24`. See §1 for
   the full address table.
3. ~~Security cameras.~~ **Resolved** — Frigate has been decommissioned and removed from the repo
   (2026-08-26), dropped from scope.
4. ~~DHCP reservations for the three nodes.~~ **Resolved** — set on the new gateway; all three
   nodes came up `Ready` at their new `192.168.110.11/12/13` addresses. MAC-based, as planned:
    - `hyperion-0`: `b0:41:6f:10:7c:e5`
    - `hyperion-1`: `f8:75:a4:e8:17:3a`
    - `hyperion-2`: `e8:6a:64:da:07:6f`
5. ~~UniFi ProtonVPN policy route for VLAN3.~~ **Resolved** — recreated on the new gateway pointed
   at `192.168.120.0/24`. As anticipated, it got a new UniFi `networkconf` object ID
   (`6aad91ea01c47862ce3620dc`, was `699387394169ddacaf400dd6`); `network/unifi-vpn-restarter`
   updated to match and merged to `main` (`a621def`).
6. ~~`wireguard-client` / headscale ingress.~~ **Resolved, confirmed live** — checked against the
   running cluster: the pod is healthy and actively proxying traffic, and `headscale nodes list`
   shows the Oracle VPS (`130.162.183.212`) itself registered as an online tailscale node
   (`oracle-vps`). It's not a duplicate of `cloudflare-tunnel` — that path serves `hs.hera.ac` for
   the public internet via `envoy-external`; this one is the VPS's own dedicated tunnel to reach
   headscale's control endpoint. Both are real, both stay as-is — no action needed either way, this
   just confirms it isn't dead weight.
7. ~~Where does the NAS (`expanse`) live in the new VLAN scheme?~~ **Resolved** — same network as
   the stack, `192.168.110.0/24`, at `.40`. Same-VLAN as the apps that reach it over NFS (Plex, the
   *arr stack, kopiur backups), so no inter-VLAN routing dependency to worry about. Worth a static
   DHCP reservation for it too, same reasoning as the three nodes (item 4) — exclude `.40` from the
   dynamic DHCP range.
8. ~~Local DNS (`.internal` zone) — bigger than just `k8s.internal`.~~ **Resolved** — all
   re-pointed at the new site and verified resolving:
    - `k8s.internal` → new floating VIP (`192.168.110.10`) — verified, apiserver reachable through it
    - `expanse.internal` (the NAS) → `192.168.110.40`
    - `hyperion-0/1/2.internal` → new node addresses (the DHCP reservations from item 4)
    - `unifi.internal` → the UniFi controller itself; self-resolved on the new gateway, no action
      needed
    - Referenced by: `talos/machineconfig.yaml.j2` (`k8s.internal`), 8× NFS mounts + the kopiur
      `ClusterRepository` + a blackbox-exporter probe (`expanse.internal`), `dynacat`'s dashboard
      config + a blackbox-exporter probe (`hyperion-N.internal`), `network/unifi-vpn-restarter`
      (`unifi.internal`)
    - **Separately**, the UniFi gateway's forward-DNS rule for the `hera.ac` zone (conditional
      forward to the in-cluster Pi-hole, not a UniFi static entry) also needed re-pointing at
      Pi-hole's new LB IP (`192.168.110.245`, was `192.168.20.245`) — this wasn't anticipated in the
      original decision list. Done; `hera.ac` resolves internally.

---

## 1. New IP plan (proposed)

Your current site keeps the cluster on its own VLAN (`.20`, labeled "IOT"), separate from the main
LAN (`.10`) and the VPN VLAN (`.30`) — that segmentation is worth keeping, not flattening into one
flat `/24`. And since this is becoming a 3-site mesh (soon to be more, potentially), the new site
should get a **reserved block**, not just the next free single `/24` — self-documenting from the
routing table alone, no future collision-checking needed.

**Proposal: reserve `192.168.100.0`–`192.168.199.0` (the whole "hundreds" range) for the new
site**, mirroring the existing tens-based per-VLAN convention shifted up a block:

| VLAN                   | New site           | Mirrors             |
| ---------------------- | ------------------ | ------------------- |
| Primary/management LAN | `192.168.100.0/24` | today's `.10`       |
| Cluster (server) VLAN  | `192.168.110.0/24` | today's `.20` "IOT" |
| VPN VLAN               | `192.168.120.0/24` | today's `.30`       |

`.130`–`.190` stays free at the new site for anything added later; `.200`–`.255` stays free
network-wide for a future fourth site. Needs an OSPF route advertised into the mesh once it's up,
same pattern as `192.168.40.0/24 → mesh net1` today. (Deliberately staying inside `192.168.0.0/16`
rather than `10.0.0.0/8` for site/host addressing — the cluster's pod/service CIDRs already live in
`10.42.0.0/16`/`10.43.0.0/16`, and keeping host addressing out of `10.0.0.0/8` avoids ever having
to think about that collision.)

Cluster-specific addresses (LB pool, per-app IPs, floating VIP) live in the **cluster VLAN**
(`192.168.110.0/24`), matching where they live today (`.20`, not `.10`):

| Purpose                                                               | Current (`192.168.20.0/24`) | New (`192.168.110.0/24`) |
| --------------------------------------------------------------------- | --------------------------- | ------------------------ |
| Bootstrap/control-plane floating VIP (`Layer2VIPConfig`, all 3 nodes) | `.29`                       | `.10`                    |
| Cilium LB pool                                                        | `.240/28`                   | `.240/28`                |
| kube-api LB (`k8s.hera.ac`)                                           | `.241`                      | `.241`                   |
| envoy-gateway `external`                                              | `.246`                      | `.246`                   |
| envoy-gateway `protected`                                             | `.242`                      | `.242`                   |
| envoy-gateway `internal`                                              | `.243`                      | `.243`                   |
| qbittorrent                                                           | `.244`                      | `.244`                   |
| pihole                                                                | `.245`                      | `.245`                   |
| plex                                                                  | `.248`                      | `.248`                   |

Last octets kept identical to the current scheme — makes the diff trivial to eyeball and re-verify
against this table. Gateway for the cluster VLAN would be `192.168.110.1`. **One deliberate
exception:** the floating VIP moved to `.10` (not `.29`) to keep it clearly separated from the
node DHCP reservations, which now live at `.11`–`.13`.

VPN VLAN addresses (Multus/ipvlan on `net0.3`, policy-routed VPN egress for a few apps) — same
last-octet-preserving remap, gateway `192.168.120.1`:

| Purpose                                           | Current (`192.168.30.0/24`) | New (`192.168.120.0/24`) |
| ------------------------------------------------- | --------------------------- | ------------------------ |
| hyperion-0 VLAN3 address                          | `.240`                      | `.240`                   |
| hyperion-1 VLAN3 address                          | `.241`                      | `.241`                   |
| hyperion-2 VLAN3 address                          | `.242`                      | `.242`                   |
| blackbox-exporter (vpn)                           | `.13`                       | `.13`                    |
| prowlarr                                          | `.14`                       | `.14`                    |
| qbittorrent                                       | `.15`                       | `.15`                    |
| Policy-route gateway (`multus/networks/vpn.yaml`) | `192.168.30.1`              | `192.168.120.1`          |

`k8s.internal` (used as `controlPlane.endpoint` and in `apiServer.certSANs`) is one of several
`.internal` hostnames this repo depends on but doesn't define — see §0 item 8 for the full list
(it's bigger than just this one).

---

## 2. Complete inventory of files that reference the old range

Verified by grepping the whole repo for every `192.168.x.x` occurrence, not just `.20`/`.30` — this
is the full list, not a sample.

**Talos (`talos/`):** all values below move to the **cluster VLAN** (`192.168.110.0/24`), not the
primary LAN. **Note:** `main` restructured this directory on 2026-08-27 (`talos/machineconfig.yaml.j2`
→ split into `talos/cluster.yaml.j2` + `talos/controlplane.yaml.j2`; `talos/nodes/hyperion-*.yaml.j2`
→ moved to `talos/nodes/controlplane/hyperion-*.yaml.j2`) — paths below are current as of that
restructure. When it was merged into this branch, the IP edits below survived the merge cleanly for
`hyperion-0` and `hyperion-2` (git's rename detection handled it), but were silently dropped for
`hyperion-1` and both cluster-wide files — those four were manually re-applied 2026-08-27 and
re-verified against this table.

- `cluster.yaml.j2` — `KubeNodeConfig.nodeIP.validSubnets` → `192.168.110.0/24`
- `controlplane.yaml.j2` — `cluster.etcd.advertisedSubnets` → `192.168.110.0/24`
- `nodes/controlplane/hyperion-{0,1,2}.yaml.j2` — `Layer2VIPConfig` (`192.168.20.29` →
  `192.168.110.10`, identical on all three — this is the floating pre-CNI control-plane VIP)
- `nodes/controlplane/hyperion-{0,1,2}.yaml.j2` — VLAN3 static addresses (`.240/.241/.242` on
  `192.168.30.0/24` → `192.168.120.0/24`, same last octets)

**Kubernetes (`kubernetes/apps/`):**

- `kube-system/cilium/app/networking.yaml` — LB pool CIDR + kube-api `lbipam.cilium.io/ips` →
  `192.168.110.0/24`
- `network/envoy-gateway/app/envoy.yaml` — 3× `lbipam.cilium.io/ips`
- `network/pihole/app/helmrelease.yaml` — `lbipam.cilium.io/ips`
- `default/qbittorrent/app/helmrelease.yaml` — `lbipam.cilium.io/ips`, plus VLAN3 static IP
- `default/plex/app/helmrelease.yaml` — `lbipam.cilium.io/ips`, `PLEX_ADVERTISE_URL`, and
  `PLEX_NO_AUTH_NETWORKS` (`192.168.10.0/24,192.168.40.0/24` →
  `192.168.10.0/24,192.168.40.0/24,192.168.100.0/24` — **additive, not a replacement**: this
  covers every site's primary/client LAN in the mesh, and the current site keeps existing as its
  own location after the cluster leaves, so `.10` stays listed alongside the new `.100`)
- `network/headscale/app/resources/config.yaml` — `nameservers.global`/`split` (`192.168.20.1` →
  `192.168.110.1`, the cluster VLAN's own gateway, same relationship as today)
- `network/tailscale-router/app/helmrelease.yaml` — `--advertise-routes` includes `192.168.20.0/24`
  → `192.168.110.0/24`
- `kube-system/multus/networks/vpn.yaml` — policy-route gateway `192.168.30.1` → `192.168.120.1`
- `default/prowlarr/app/helmrelease.yaml`, `default/qbittorrent/app/helmrelease.yaml`,
  `o11y/blackbox-exporter/vpn/helmrelease.yaml` — VLAN3 static IPs, `192.168.30.0/24` →
  `192.168.120.0/24` (same last octets)
- `actions-runner-system/actions-runner-controller/runners/home-ops/networkpolicy.yaml` — egress
  deny carve-out for the cluster VLAN, `192.168.20.0/24` → `192.168.110.0/24`. **New on `main`**
  since this table was first written — not caught by the merge (merged cleanly with the stale IP
  baked in, since it didn't exist on this branch to conflict). Left unfixed, CI runners would
  silently lose the ability to reach in-cluster LB services after the move.
- `default/go2rtc/app/helmrelease.yaml` — `lbipam.cilium.io/ips` and a self-referencing WebRTC ICE
  candidate address, both `192.168.20.247` → `192.168.110.247`. **New on `main`** (added
  2026-08-26/27, alongside Frigate's removal — this is the actual UniFi Protect streaming relay
  that replaced it). Same "not caught by the merge" situation as above.

**Checked, no change needed:** `default/prowlarr/app/direct-proxy.yaml` allows `192.168.0.0/16` —
already covers both the old and new ranges.

**Correction:** VLAN3's traffic gets policy-routed through ProtonVPN at the UniFi gateway itself —
that policy rule lives in UniFi, not in this repo, and needs recreating on the new gateway pointed
at the new `192.168.120.0/24` VLAN. It has no relationship to `wireguard-client` (see below); the
two are unrelated "VPN" mechanisms that happen to share a name.

**`network/wireguard-client/app/resources.yaml`** — this is a separate thing entirely: a WireGuard
tunnel to a VPS at `130.162.183.212:51820`, with an nginx sidecar proxying `hs.hera.ac` back to the
in-cluster `headscale` Service. It's the public ingress path for headscale/tailscale, not
VLAN3-related — no Multus annotation, plain pod network, no dependency on the LAN IP scheme either
way. **Open question, not a migration blocker:** whether this is still the live path for
`hs.hera.ac` or whether `cloudflare-tunnel` has superseded it — worth confirming separately from
the move, since if it's stale it's just dead weight either way. If it's still live, the only
new-site requirement is that outbound UDP/51820 isn't blocked by the new gateway's firewall.

---

## 3. This week — before move day

1. **Resolve the remaining open decision in §0** (new site block confirmation — VLAN3 and Frigate
   are already resolved).
2. `talosctl -n hyperion-0 etcd snapshot db.snapshot` (or against whichever node's convenient) —
   take this **right before shutdown on move day**, not now; redo it fresh that day so it reflects
   final state.
3. Back up each node's local Ceph mon data as a raw file copy, off-cluster (laptop/USB), e.g. via
   a debug pod mounting the host path or `talosctl copy`. This isn't an officially supported Rook
   restore path, but it's free insurance for the manual `ceph-objectstore-tool` mon-rebuild-from-OSD
   procedure if it's ever needed.
4. Set up DHCP reservations on the new gateway for the three node MACs (§0.4), the Cilium LB
   pool range excluded from the dynamic DHCP scope, and the VLAN3 (`192.168.120.0/24`) scope.
5. Update the files in §2 with new values on a branch (e.g. `site-migration`), and **keep it
   unmerged through the whole move.** Two different mechanisms apply these, on two different
   schedules:
    - **Talos node config** (`talos/cluster.yaml.j2`, `talos/controlplane.yaml.j2`,
      `talos/nodes/controlplane/*.yaml.j2`) isn't Flux-managed — `just talos apply-node` reads
      straight from your local working tree, so you apply it directly from the branch checkout on
      move day. No merge needed for this part to work.
    - **Kubernetes manifests** (Cilium LB pool, envoy-gateway, headscale, tailscale-router, per-app
      static IPs) _are_ reconciled by Flux the moment they land on `main`. Merging while the cluster
      is still live at the old site would have Flux immediately try to announce new-range LB IPs on
      a network segment where they don't exist yet — breaking working services before the move even
      starts, for no benefit. **Only merge to `main` after the cluster is confirmed healthy on the
      new network** (end of Phase C or D) — see Phase E below.
6. Confirm where `k8s.internal` is actually defined and how to update it.

---

## 4. Move day

### Phase A — before shutdown, at the old site

1. `ceph status` via the rook-ceph toolbox — confirm `HEALTH_OK`, all PGs `active+clean`, no
   in-progress recovery/backfill. Don't proceed if not.
2. `talosctl -n hyperion-0 etcd snapshot db.snapshot` — fresh snapshot, copy it off-cluster.
3. Back up `/var/lib/rook` mon data from all three nodes (see §3.3) — fresh copy.
4. `talosctl etcd status` — confirm 3/3 healthy before powering anything off.
5. Shut down: `just talos shutdown-node hyperion-0` (repeat for -1, -2), then power off switch/NAS.

### Phase B — physical move

Move nodes, switch, NAS together. Reconnect at the new site on the new network (§1). Power on the
switch/NAS first, then all three nodes.

### Phase C — the "gentle" attempt (try this first)

Talos has a live mechanism for this (`AdvertisedPeerController`, which already handles your
nodes' routine DHCP renewals today) — there's a real chance the cluster self-heals now that all
three nodes can see each other again on the new local network, without any wipe.

1. As soon as each node is reachable at its new DHCP-assigned address, apply the branch's updated
   machine config to it: `just talos apply-node hyperion-N` (run from the `site-migration` branch
   checkout — this is the point where `etcd.advertisedSubnets`, `kubelet.nodeIP.validSubnets`, and
   the `Layer2VIPConfig` actually start pointing at the new range). This has to happen before
   convergence can even be assessed — the old config has no valid address to advertise once the
   node's on a different subnet.
2. Give it 10–15 minutes after all three are configured.
3. `talosctl etcd status` (or `-n <any-node-current-ip>` if `k8s.internal` isn't resolvable yet) —
   watching for 3/3 healthy.
4. `kubectl get nodes` — once the API is reachable, confirm all three `Ready`.
5. `ceph status` via toolbox — confirm mons reform quorum and `HEALTH_OK` returns on its own.

**If this converges: skip Phase D entirely.** This is the outcome to hope for — no data was
touched, nothing to restore.

### Phase D — fallback: Talos disaster recovery (only if Phase C doesn't converge)

This is Talos's own documented procedure, not a guess — see source below. It **will** wipe each
touched node's `EPHEMERAL` partition, which is also where Rook's mon data lives by default. Only
do this on nodes that actually failed to rejoin in Phase C — if even one node came up cleanly,
leave it alone; its mon data survives and gives you access to Rook's `restore-quorum` tool
afterward instead of a full from-scratch mon rebuild.

Note: the machine config applied in Phase C step 1 lives on the `STATE` partition, which this
reset does **not** wipe (`EPHEMERAL` only) — no need to reapply it here, it survives.

**Safety gate before starting — this is the one real Ceph data-loss vector in this whole plan:**
confirm `cephClusterSpec.cleanupPolicy.wipeDevicesFromOtherClusters` is `false` on the running
cluster (fixed on `main` in `4f9861a`; make sure that fix has actually merged/reconciled before
Phase D, not just exists in git). With it `true`, if cluster identity continuity ever breaks during
this recovery (the `rook-ceph-mon` secret/fsid not surviving the restore intact — not expected, but
this is exactly the kind of stressful, first-time-doing-it scenario where a mistake happens), Rook
would silently reformat the OSDs it thinks belong to an unrelated old cluster instead of stopping
to ask. OSD data itself is otherwise untouched by every step in this runbook, in both Phase C and
D — this flag is the only path from "recovery going sideways" to "data actually gone."

1. On the node you'll use to re-seed etcd (pick whichever is cleanest):
    ```
    talosctl -n <new-ip> reset --graceful=false --reboot --system-labels-to-wipe=EPHEMERAL
    ```
2. Once it's back up:
    ```
    talosctl -n <new-ip> bootstrap --recover-from=db.snapshot
    ```
3. For the other node(s) that didn't rejoin: same reset — they should join the now-live cluster as
   fresh members automatically (no manual `etcd add-member` needed).
4. `talosctl etcd status` → 3/3, `kubectl get nodes` → all `Ready`.
5. Check Ceph: `ceph status` via toolbox.
    - If at least one node's mon data survived Phase C/D untouched: `kubectl rook-ceph mons
restore-quorum <that-mon-name>`, then let the other mons rejoin.
    - If all three mons' local data was wiped: this needs the manual mon-rebuild-from-OSD
      procedure (`ceph-objectstore-tool --op update-mon-db`) — OSD data is untouched (separate
      physical disks, never wiped by any of this), so the cluster's data is not at risk, but this
      step is genuinely manual and slower. Don't attempt it improvised — pause and work from Ceph's
      own documented procedure at that point rather than from memory.

### Phase E — merge and let Flux reconcile

Only once Phase C or D has the cluster healthy on the new network (etcd 3/3, nodes `Ready`, Ceph
`HEALTH_OK`): merge the `site-migration` branch to `main`. This is the trigger for Flux to pick up
the Kubernetes-side changes (Cilium LB pool, envoy-gateway, headscale, tailscale-router, per-app
static IPs) — `flux get kustomizations -A` should show everything reconciling against the new
range shortly after. This step is folded into §5's verification checklist below.

---

## 5. Post-move verification

- [x] `talosctl etcd status` — 3/3 healthy
- [x] `kubectl get nodes -o wide` — all `Ready`, correct new IPs
- [x] `ceph status` — `HEALTH_OK` (modulo a self-clearing deep-scrub backlog from the 3-week outage)
- [x] Merge `site-migration` → `main` (Phase E) — done, `f0b32b2` (PR #730)
- [x] `flux get kustomizations -A` — everything reconciled against the new range
- [x] Spot-check a couple of `*.hera.ac` hostnames resolve and serve over the new LB IPs
- [x] `k8s.internal` resolves to the new floating VIP
- [x] ProtonVPN policy route + `unifi-vpn-restarter` networkconf ID (§0 item 5) — `a621def`

---

## 6. Sources for the disaster-recovery steps in Phase D

- [Disaster Recovery - Sidero Documentation](https://docs.siderolabs.com/talos/v1.9/build-and-extend-talos/cluster-operations-and-maintenance/disaster-recovery)
- [Disaster Recovery - Rook Ceph Documentation](https://www.rook.io/docs/rook/latest-release/Troubleshooting/disaster-recovery/)
- [kubectl-rook-ceph plugin (`mons restore-quorum`)](https://github.com/rook/kubectl-rook-ceph)

## 7. What's genuinely unverified

- ~~Whether Phase C actually converges for a _simultaneous_ 3-node address change~~ — **answered:
  no, not cleanly.** See §8 — Phase D (reset + recover-from-snapshot) ended up needed on at least
  `hyperion-0`, and the actual restore involved manual `talosctl` intervention beyond what either
  phase scripted. Real-world data point for next time: budget for Phase D, don't expect Phase C
  alone to carry a simultaneous 3-node move.
- Exact Talos machine-config syntax for converting `net0` to a static address — deliberately
  avoided in this plan (using DHCP reservations instead) rather than guessing. Never became
  relevant — DHCP reservations worked as planned.

---

## 8. What actually happened during restore (2026-09-18)

Kept for the next time this happens — none of this was anticipated in the plan above.

- **Phase C didn't cleanly converge.** Nodes needed direct intervention (stale network config
  cleared via `talosctl` on each node), and at least one node (`hyperion-0`) went through a full
  Talos reset + `bootstrap --recover-from=` etcd snapshot restore (Phase D) rather than a clean
  self-heal. An accidental second reset mid-recovery on `hyperion-0` looked like it had destroyed
  the just-recovered state, but turned out to be a hung `reset` that never completed cleanly until
  a physical power-cycle — the etcd data survived intact and didn't need re-bootstrapping.
- **Ceph came up with all 81 PGs stuck `unknown`/`inactive`** even after etcd reached genuine 3/3
  quorum and all nodes were `Ready`. Root cause: OSD pods that had been running since before the
  outage (22+ days, never restarted) were still presenting cephx session tickets signed by the
  pre-outage mon quorum's rotating-key state, which the freshly-reformed mon quorum didn't
  recognize (`verify_authorizer could not get service secret ... secret_id=...`). Clock skew was
  checked and ruled out first. Fix: restart the stale OSD pods (forces fresh cephx auth) — this
  applied at two levels, first to the OSDs' own client-facing auth, then again to OSD-to-OSD
  heartbeat auth for the one OSD that came up after the others. Once genuinely healthy,
  `noout`/`nobackfill`/`norebalance` (set pre-shutdown) were cleared to let final backfill finish.
- **Flux only reconciles what's on `main`.** Obvious in hindsight, but worth stating plainly: until
  `site-migration` merged, the live cluster's `CiliumLoadBalancerIPPool` was still the _old_
  `192.168.20.240/28` block, so `pihole-dns`'s LB IP didn't move until the merge + a manual
  `flux reconcile kustomization cilium --with-source`.
- **Pi-hole's custom DNS records need a full pod restart, not `pihole reloaddns`.** `external-dns`
  correctly wrote the new IPs into `pihole.toml`, but the generated `/etc/pihole/hosts/custom.list`
  (what FTL actually serves from) only regenerates on an FTL process restart. `reloaddns` only
  flushes the cache/blocklists.
- **The `hera.ac` wildcard cert had been dead for 19 days.** Its DNS-01 ACME challenge got
  presented right before shutdown (2026-08-30) and never got a chance to complete since
  cert-manager was powered off for the entire outage; on restore it was just sitting there
  `pending`, not actively retrying. It had actually expired (2026-09-02) partway through the
  outage. This silently broke HTTPS for everything in the `external` Gatus group (10 endpoints)
  until noticed and fixed by deleting the stale `CertificateRequest` to force a clean re-issue.
- **The self-hosted Actions runner's GitHub-side registration was gone.** GitHub deregistered the
  runner scale-set during the 3-week outage; the controller's cached scale-set ID came back with a
  `404 RunnerScaleSetNotFoundException`. Not fixed as part of this migration (out of scope), but
  flagging: if it recurs, the fix is deleting the `AutoscalingRunnerSet` so the controller
  re-registers a fresh scale-set ID.
- **UniFi API keys don't survive a gateway replacement.** The `unifi-vpn-restarter` cronjob's
  stored API key (in 1Password) 401'd against the new controller — expected, but worth noting
  alongside the ProtonVPN `networkconf` ID (§0 item 5) as "new gateway, new credentials" items.
