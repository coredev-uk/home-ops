#!/usr/bin/env bash
# Nightly NixOS build (helmrelease.yaml): update coredev-uk/nixos's flake inputs, build every
# x86_64-linux nixosConfiguration and homeConfiguration, push the outputs to Attic and, only once
# all of that worked, push the new flake.lock to main. The next switch on atlas then finds every
# path either here or on a public cache. darwinConfigurations (poseidon) need macOS: not here.
#
# Runs as root in the pod's Kata VM. The Nix store is persistent: an ext4 image on a Ceph
# volume, loop-mounted over /nix, so a run only fetches and builds what changed and nothing
# heavy lands on the node's disk. Builds run in the Nix sandbox as nixbld users, which cannot
# read /secrets.
# The single-quoted $names are jq's, not the shell's.
# shellcheck disable=SC2016
set -euo pipefail

REPO_HTTPS=https://github.com/coredev-uk/nixos.git
REPO_SSH=git@github.com:coredev-uk/nixos.git
SYSTEM=x86_64-linux
CACHE=coredev
# Paths signed by these are skipped on push: atlas gets them from those caches (nix.conf).
UPSTREAM_KEYS=(cache.nixos.org-1 nix-community.cachix.org-1 nix-citizen.cachix.org-1)
ATTIC_ENDPOINT=http://attic.nix-cache.svc.cluster.local:8080
STORE_IMG=/store/store.img # /store is the nix-cache-builder-store claim
STORE_SIZE=110G            # sparse: Ceph only holds what the store uses
STATUS=/status/status.json # read by the exporter beside Attic
PROFILES=/nix/var/nix/profiles/nix-cache
WORK=/nix/var/nix-cache/work

# Tools the nixos/nix image lacks, pinned to store paths on cache.nixos.org (nixos-unstable
# 31ecbaca). Bump by evaluating nixpkgs#<pkg>.outPath against a newer nixpkgs.
UTIL_LINUX=/nix/store/2lgg8jqyzjp60svh7kmp39kqwnig31p2-util-linux-2.42.4-bin
E2FSPROGS=/nix/store/9l2mjms2iidc51mh6sfyjmhzshxa3v8k-e2fsprogs-1.47.4-bin
JQ=/nix/store/9l0j15jg8634hkb6d4c9y95mpxl0nhrd-jq-1.8.2-bin/bin/jq
ATTIC=/nix/store/ki30bh61j71vp2jih6mfxhmfdiqxrr69-attic-0-unstable-2026-07-06/bin/attic

log() { echo "[nix-cache] $*"; }

started=$(date +%s)
phase=setup
phase_started=$started
durations='{}'
targets='{}'
inputs='{}'
lock_changed=false
inputs_updated=0
commit=""

# Long commands run as background children: bash only acts on a signal between commands, so a
# SIGTERM (job deleted, deadline hit) would otherwise wait for a whole nix build and then be cut
# off by SIGKILL. on_term stops the child, lets Nix clean up, and exits through on_exit, which
# marks the store as cleanly stopped.
child=""
run() {
  "$@" &
  child=$!
  local rc=0
  wait "$child" || rc=$?
  child=""
  return "$rc"
}
on_term() {
  log "stopping on SIGTERM"
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 143
}

# Times the phase that just ended and starts the next one.
next_phase() {
  local now
  now=$(date +%s)
  durations=$("$JQ" -c --arg p "$phase" --argjson d $((now - phase_started)) '.[$p] = $d' <<<"$durations")
  phase=$1
  phase_started=$now
}

# Written on every exit, so a failed run is as visible as a good one.
store_mounted=false
store_checked=false
write_status() {
  local rc=$1 used=0 size=0
  if [ "$store_mounted" = true ]; then
    read -r size used < <(df -B1 --output=size,used /nix | tail -1) || true
  fi
  "$JQ" -n \
    --argjson started "$started" --argjson finished "$(date +%s)" \
    --argjson success "$([ "$rc" = 0 ] && echo true || echo false)" \
    --arg phase "$phase" --argjson durations "$durations" --argjson targets "$targets" \
    --argjson inputs "$inputs" --argjson lock_changed "$lock_changed" \
    --argjson inputs_updated "$inputs_updated" --arg commit "$commit" \
    --argjson store_size "${size:-0}" --argjson store_used "${used:-0}" \
    '{started: $started, finished: $finished, success: $success,
      failed_phase: (if $success then null else $phase end), durations: $durations,
      targets: $targets, inputs: $inputs, lock_changed: $lock_changed,
      inputs_updated: $inputs_updated, commit: $commit,
      store: {size_bytes: $store_size, used_bytes: $store_used}}' \
    >"$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}
CLEAN_MARKER=/mnt/store/.stopped-cleanly
on_exit() {
  local rc=$? failed_phase=$phase
  [ "$rc" = 0 ] || log "failed during '$phase' (exit $rc)"
  next_phase "done"
  phase=$failed_phase
  write_status "$rc" || log "could not write $STATUS"
  # Only once the store passed its check: a VM killed mid-run leaves no marker, and neither does
  # a run stopped while checking a store that was already suspect. The store is mounted without
  # barriers, so this is the one point its contents are flushed through to the Ceph volume:
  # sync writes the image's dirty pages back, `sync FILE` fsyncs the image itself.
  if [ "$store_checked" = true ]; then
    sync
    touch "$CLEAN_MARKER"
    sync
    sync "$STORE_IMG"
  fi
  exit "$rc"
}

# --- mount the persistent store --------------------------------------------------------
nix build --no-link "$UTIL_LINUX" "$E2FSPROGS" "${JQ%/bin/jq}"
trap on_exit EXIT
trap on_term TERM INT
export PATH="$PATH:$UTIL_LINUX/bin:$E2FSPROGS/bin"

# Privileged, but the container's /dev still has no loop nodes.
for i in 0 1 2 3 4 5 6 7; do [ -e /dev/loop$i ] || mknod -m 660 /dev/loop$i b 7 $i; done
[ -e /dev/loop-control ] || mknod -m 660 /dev/loop-control c 10 237

new_image() {
  log "creating $STORE_IMG ($STORE_SIZE, sparse)"
  rm -f "$STORE_IMG"
  truncate -s "$STORE_SIZE" "$STORE_IMG"
  mkfs.ext4 -q -m 0 -L nix-store "$STORE_IMG"
}
mount_image() {
  # A VM killed mid-run leaves the journal to replay; anything e2fsck cannot repair costs a full
  # re-download, not correctness, so start over instead of failing every night.
  local fsck_rc=0
  e2fsck -p "$STORE_IMG" || fsck_rc=$?
  if [ "$fsck_rc" -ge 4 ]; then
    log "e2fsck exit $fsck_rc: store image is damaged"
    new_image
  fi
  mkdir -p /mnt/store
  # Buffered, not --direct-io: direct I/O over virtiofs is slow. The double page cache this
  # costs fits, because the RuntimeClass overhead makes the pod cgroup as big as the VM.
  loop_dev=$(losetup --find --show "$STORE_IMG")
  # discard: space Nix frees is punched out of the sparse image instead of staying allocated.
  # barrier=0: every journal commit and fsync would otherwise flush the image through virtiofs
  # to Ceph (~35ms each); with them the first run spent 96% of its time flushing. The store is
  # a cache: after a VM is killed, the missing clean marker makes the next run check it.
  mount -o noatime,discard,barrier=0 "$loop_dev" /mnt/store
}
unmount_image() {
  umount /mnt/store
  losetup -d "$loop_dev"
}
[ -e "$STORE_IMG" ] || new_image
mount_image

# A store whose last run did not end (VM killed) can hold paths Nix had registered before their
# contents reached the disk. Check every path's contents, then delete the damaged ones and
# everything that refers to them; the build fetches or rebuilds them. Only if that fails does
# the store start over (a full re-download).
if [ -d /mnt/store/nix/store ] && [ ! -e "$CLEAN_MARKER" ]; then
  log "the last run did not stop cleanly: checking the store"
  # To a file, not $(...): a command substitution would hold off on_term until it ends.
  run nix store verify --store 'local?root=/mnt/store' --all --no-trust >/tmp/verify.log 2>&1 || true
  mapfile -t damaged < <(grep -o "path '/nix/store/[^']*' was modified" /tmp/verify.log | cut -d"'" -f2)
  if [ "${#damaged[@]}" -gt 0 ]; then
    log "damaged: ${damaged[*]}"
    if nix-store --store 'local?root=/mnt/store' -q --referrers-closure "${damaged[@]}" >/tmp/doomed.txt &&
      mapfile -t doomed </tmp/doomed.txt &&
      run nix store delete --store 'local?root=/mnt/store' --ignore-liveness "${doomed[@]}"; then
      log "deleted ${#doomed[@]} damaged or dependent paths"
    else
      log "could not delete the damaged paths: starting a new store"
      unmount_image
      new_image
      mount_image
    fi
  fi
fi
store_checked=true
rm -f "$CLEAN_MARKER"
sync

# Bring the image's store into the persistent one (Nix itself, the tools above, and base-system,
# which /etc/passwd, /etc/group and /etc/nix link into), then put the persistent store in place
# of the image's. nix.conf comes from NIX_CONF_DIR=/config, not /etc/nix: a file mounted there
# would land inside base-system and break its hash.
image_profile=$(readlink -f /nix/var/nix/profiles/default)
nix copy --no-check-sigs --to 'local?root=/mnt/store' --all
mount --bind /mnt/store/nix /nix
store_mounted=true
export PATH="$image_profile/bin:$UTIL_LINUX/bin:$E2FSPROGS/bin"
if [ "$(readlink -f /nix/var/nix/profiles/default)" != "$image_profile" ]; then
  nix-env --profile /nix/var/nix/profiles/default --set "$image_profile" >/dev/null
fi
mkdir -p /nix/var/nix/builds "$PROFILES" /nix/var/nix/gcroots/nix-cache
# GC roots for the tools, so a garbage collection in the middle of a run keeps them.
nix build --out-link /nix/var/nix/gcroots/nix-cache/tool \
  "$UTIL_LINUX" "$E2FSPROGS" "${JQ%/bin/jq}" "${ATTIC%/bin/attic}"
log "store: $(df -h --output=used,size /nix | tail -1 | xargs)"

# --- update the flake -----------------------------------------------------------------
next_phase update
rm -rf "$WORK"
git clone --quiet --depth 1 "$REPO_HTTPS" "$WORK"
cd "$WORK"
git remote set-url --push origin "$REPO_SSH"
git config user.name "nix-cache builder"
git config user.email "nix-cache@hera.ac"
old_lock=$(cat flake.lock)
run nix flake update

# Input name -> lastModified, for the dashboard's input age panel.
inputs=$("$JQ" -c '.nodes as $n | .nodes.root.inputs | with_entries(
  .value |= ($n[if type == "array" then .[0] else . end].locked.lastModified // null))
  | with_entries(select(.value != null))' flake.lock)
changes=$("$JQ" -r --argjson old "$old_lock" '.nodes as $n | .nodes.root.inputs | to_entries[]
  | (.value | if type == "array" then .[0] else . end) as $key
  | ($old.nodes[$key].locked.rev // "") as $a | ($n[$key].locked.rev // "") as $b
  | select($a != $b) | "\(.key): \($a[0:7]) -> \($b[0:7])"' flake.lock)
if ! git diff --quiet; then
  lock_changed=true
  inputs_updated=$(grep -c . <<<"$changes" || true)
  log "updated:"$'\n'"$changes"
  # Commit before building, so anything that reads self.rev sees the commit that ships.
  git commit --quiet -a -m "chore(flake): update inputs" -m "$changes"
else
  log "nothing to update"
fi
commit=$(git rev-parse HEAD)

# --- build ----------------------------------------------------------------------------
next_phase build
# One evaluation for both kinds; either may be absent. A plain assignment, so a failed
# evaluation stops the run (a process substitution would not).
target_json=$(nix eval --json --impure --expr "
  let
    f = builtins.getFlake \"git+file://$WORK\";
    on = cs: builtins.filter (n: cs.\${n}.pkgs.stdenv.hostPlatform.system == \"$SYSTEM\") (builtins.attrNames cs);
  in { nixos = on (f.nixosConfigurations or { }); home = on (f.homeConfigurations or { }); }")
mapfile -t hosts < <("$JQ" -r '.nixos[]' <<<"$target_json")
mapfile -t homes < <("$JQ" -r '.home[]' <<<"$target_json")
names=()
installables=()
for h in "${hosts[@]}"; do
  names+=("$h")
  installables+=(".#nixosConfigurations.\"$h\".config.system.build.toplevel")
done
for h in "${homes[@]}"; do
  names+=("$h")
  installables+=(".#homeConfigurations.\"$h\".activationPackage")
done
if [ "${#names[@]}" = 0 ]; then
  log "the flake has no $SYSTEM nixosConfigurations or homeConfigurations"
  exit 1
fi

# One invocation for every target: a package two targets share is built (or fails) once, and
# --keep-going still builds everything that does not depend on a failure.
log "building ${names[*]}"
build_rc=0
run nix build --keep-going --no-link "${installables[@]}" || build_rc=$?

outs=()
failed=0
for i in "${!names[@]}"; do
  name=${names[$i]}
  out=$(nix eval --raw "${installables[$i]}.outPath")
  if nix path-info "$out" >/dev/null 2>&1; then
    # Profile names cannot hold '@' (paul@atlas).
    nix-env --profile "$PROFILES/${name//@/-at-}" --set "$out"
    size=$(nix path-info --closure-size --json --json-format 1 "$out" | "$JQ" '[.[]][0].closureSize')
    outs+=("$out")
    targets=$("$JQ" -c --arg t "$name" --argjson s "$size" '.[$t] = {success: true, closure_bytes: $s}' <<<"$targets")
    log "$name: built"
  else
    failed=1
    targets=$("$JQ" -c --arg t "$name" '.[$t] = {success: false, closure_bytes: null}' <<<"$targets")
    log "$name: failed"
  fi
done
if [ "$failed" != 0 ] || [ "$build_rc" != 0 ]; then
  log "a build failed: nothing is pushed, main keeps the previous flake.lock"
  exit 1
fi

# --- push -----------------------------------------------------------------------------
next_phase push
export XDG_CONFIG_HOME=/tmp/attic
"$ATTIC" login --set-default local "$ATTIC_ENDPOINT" "$(cat /secrets/attic-token)" >/dev/null
# The first run creates the cache, and with it the signing key atlas has to trust; every run
# then reapplies its settings, so they live here rather than in Attic's database alone.
if ! "$ATTIC" cache info "local:$CACHE" >/dev/null 2>&1; then
  log "creating cache $CACHE"
  "$ATTIC" cache create --public "local:$CACHE"
fi
upstream_args=()
for k in "${UPSTREAM_KEYS[@]}"; do upstream_args+=(--upstream-cache-key-name "$k"); done
"$ATTIC" cache configure --public "${upstream_args[@]}" "local:$CACHE"
# attic prints the cache info on stderr.
log "cache $CACHE: $("$ATTIC" cache info "local:$CACHE" 2>&1 | grep -i 'public key' | xargs)"
run "$ATTIC" push "local:$CACHE" "${outs[@]}"
if [ "$lock_changed" = true ]; then
  # A push rejected because main moved fails the run; tomorrow's run starts from the new main.
  GIT_SSH_COMMAND="ssh -i /secrets/deploy-key -o IdentitiesOnly=yes -o UserKnownHostsFile=/config/known_hosts -o StrictHostKeyChecking=yes" \
    git push --quiet origin HEAD:main
  log "pushed $commit to main"
fi

# --- keep the store in bounds ---------------------------------------------------------
next_phase gc
for p in "$PROFILES"/*; do
  case $p in *-link) continue ;; esac # generations of the profile itself
  nix profile wipe-history --profile "$p" --older-than 7d
done
# Collect only when the store is filling up: between nights it keeps compilers and other
# build-only inputs, so tomorrow does not download them again.
read -r size used < <(df -B1 --output=size,used /nix | tail -1)
if [ $((used * 100 / size)) -ge 60 ]; then
  log "store at $((used * 100 / size))%, collecting garbage"
  run nix store gc
fi
log "done"
