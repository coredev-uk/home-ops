#!/usr/bin/env bash
# The nixos runner (helmrelease.yaml): one GitHub Actions job of coredev-uk/nixos per pod, ARC's
# ephemeral runner, run as root in the pod's Kata VM. The Nix store persists between jobs: an
# ext4 image on a Ceph volume, loop-mounted over /nix, so a job only fetches and builds what
# changed. Builds run in the Nix sandbox as nixbld users. i686-linux builds (Steam's 32-bit
# graphics stack) run under qemu-i386: the VM's kernel has no 32-bit support, so they otherwise
# fail with "Exec format error".
set -euo pipefail

STORE_IMG=/store/store.img # /store is the nixos-runner-store claim
STORE_SIZE=110G            # sparse: Ceph only holds what the store uses
CLEAN_MARKER=/mnt/store/.stopped-cleanly
GCROOTS=/nix/var/nix/gcroots/nixos-runner

log() { echo "[nixos-runner] $*"; }

# Tools the nixos/nix image lacks, from nixpkgs-unstable: the runner follows upstream's releases
# there, which GitHub requires of a runner that cannot update itself.
mapfile -t mount_tools < <(nix build --no-link --print-out-paths nixpkgs#util-linux.bin nixpkgs#e2fsprogs.bin)
export PATH="$PATH:${mount_tools[0]}/bin:${mount_tools[1]}/bin"

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
  # A VM killed mid-job leaves the journal to replay; anything e2fsck cannot repair costs a full
  # re-download, not correctness, so start over instead of failing every job.
  local fsck_rc=0
  e2fsck -p "$STORE_IMG" || fsck_rc=$?
  if [ "$fsck_rc" -ge 4 ]; then
    log "e2fsck exit $fsck_rc: store image is damaged"
    new_image
  fi
  mkdir -p /mnt/store
  # Buffered, not --direct-io: direct I/O over virtiofs is slow.
  loop_dev=$(losetup --find --show "$STORE_IMG")
  # discard: space Nix frees is punched out of the sparse image. barrier=0: every journal commit
  # and fsync would otherwise flush the image through virtiofs to Ceph. The store is a cache:
  # after a VM is killed, the missing clean marker makes the next job check it.
  mount -o noatime,discard,barrier=0 "$loop_dev" /mnt/store
}
unmount_image() {
  umount /mnt/store
  losetup -d "$loop_dev"
}
[ -e "$STORE_IMG" ] || new_image
mount_image

# A store whose last job did not end cleanly can hold paths Nix had registered before their
# contents reached the disk. Check every path, then delete the damaged ones and everything that
# refers to them; the next build fetches or rebuilds them. Only if that fails does the store
# start over.
if [ -d /mnt/store/nix/store ] && [ ! -e "$CLEAN_MARKER" ]; then
  log "the last job did not stop cleanly: checking the store"
  nix store verify --store 'local?root=/mnt/store' --all --no-trust >/tmp/verify.log 2>&1 || true
  mapfile -t damaged < <(grep -o "path '/nix/store/[^']*' was modified" /tmp/verify.log | cut -d"'" -f2)
  if [ "${#damaged[@]}" -gt 0 ]; then
    log "damaged: ${damaged[*]}"
    if nix-store --store 'local?root=/mnt/store' -q --referrers-closure "${damaged[@]}" >/tmp/doomed.txt &&
      mapfile -t doomed </tmp/doomed.txt &&
      nix store delete --store 'local?root=/mnt/store' --ignore-liveness "${doomed[@]}"; then
      log "deleted ${#doomed[@]} damaged or dependent paths"
    else
      log "could not delete the damaged paths: starting a new store"
      unmount_image
      new_image
      mount_image
    fi
  fi
fi
rm -f "$CLEAN_MARKER"
sync

# Marks the store cleanly stopped: the one point its contents are flushed through to the Ceph
# volume (the mount has no barriers). sync writes the image's dirty pages back, `sync FILE`
# fsyncs the image itself.
# shellcheck disable=SC2329 # run by the EXIT trap below
on_exit() {
  local rc=$?
  sync
  touch "$CLEAN_MARKER"
  sync
  sync "$STORE_IMG"
  exit "$rc"
}
trap on_exit EXIT

# Bring the image's store into the persistent one (Nix itself, the tools above, and base-system,
# which /etc/passwd, /etc/group and /etc/nix link into), then put the persistent store in place
# of the image's. nix.conf comes from NIX_CONF_DIR=/config, not /etc/nix: a file mounted there
# would land inside base-system and break its hash.
image_profile=$(readlink -f /nix/var/nix/profiles/default)
nix copy --no-check-sigs --to 'local?root=/mnt/store' --all
mount --bind /mnt/store/nix /nix
if [ "$(readlink -f /nix/var/nix/profiles/default)" != "$image_profile" ]; then
  nix-env --profile /nix/var/nix/profiles/default --set "$image_profile" >/dev/null
fi
mkdir -p /nix/var/nix/builds "$GCROOTS"

# The job's tools, rooted (tool, tool-1, …) so a garbage collection in the middle of a build
# keeps them, and put first on PATH.
nix build --out-link "$GCROOTS/tool" \
  nixpkgs#github-runner nixpkgs#attic-client nixpkgs#jq nixpkgs#gh nixpkgs#pkgsStatic.qemu-user \
  "${mount_tools[@]}"
for t in "$GCROOTS"/tool*; do PATH="$(readlink -f "$t")/bin:$PATH"; done
export PATH="$image_profile/bin:$PATH"
log "store: $(df -h --output=used,size /nix | tail -1 | xargs)"

# 32-bit x86 ELF executables go to the static qemu-i386; Nix already counts i686-linux among
# its platforms. F opens the interpreter now, so it runs inside the sandbox, where its path is
# not mounted. The kernel decodes the \x escapes itself: they must reach it as text.
[ -e /proc/sys/fs/binfmt_misc/register ] || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-i386 ]; then
  i386_magic='\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x03\x00'
  i386_mask='\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
  echo ":qemu-i386:M::$i386_magic:$i386_mask:$(command -v qemu-i386):F" >/proc/sys/fs/binfmt_misc/register
fi

# One job, then the pod ends (ARC's ephemeral runner). The job's steps inherit this PATH, with
# nix, git, attic, jq and gh on it. In the background, so TERM (the pod being deleted) reaches
# the runner and the store is still marked clean on the way out.
export RUNNER_ROOT=/runner RUNNER_ALLOW_RUNASROOT=1
Runner.Listener run --jitconfig "$ACTIONS_RUNNER_INPUT_JITCONFIG" &
runner=$!
trap 'kill -TERM "$runner" 2>/dev/null || true' TERM INT
rc=0
wait "$runner" || rc=$?
# A TERM interrupts the first wait: wait again for the runner to wind its job down.
if kill -0 "$runner" 2>/dev/null; then
  rc=0
  wait "$runner" || rc=$?
fi
exit "$rc"
