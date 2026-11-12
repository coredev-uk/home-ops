#!/usr/bin/env bash
# Seeds an environment's Nix volume from the image, as the pod's init container
# (kubernetes/apps/t3/environment/app/helmrelease.yaml): the volume is mounted at $SEED_ROOT/nix
# here and at /nix in the server container, so the store outlives restarts and image bumps and a
# devenv shell is built once, not on every start.
#
# `nix copy` into the volume as a chroot store copies only the paths of the image's profile the
# volume lacks and registers them in the volume's own database, so the shells already built there
# stay valid. The volume's profile then points at the image's, which keeps PATH
# (/nix/var/nix/profiles/agent/bin) on the tools this image was built with; a GC root keeps that
# profile, and Nix's automatic garbage collection (nix.conf) drops the ones older images left.
set -euo pipefail

root=${SEED_ROOT:?}
profile=$(readlink -f /nix/var/nix/profiles/agent)

# The image's store is opened read-only: the init container's root filesystem is, and a normal
# open takes a write lock on /nix/var/nix/db.
nix copy --extra-experimental-features read-only-local-store --no-check-sigs \
  --from "local?read-only=true" --to "local?root=$root" "$profile"

profiles=$root/nix/var/nix/profiles
gcroots=$root/nix/var/nix/gcroots
mkdir -p "$profiles" "$gcroots"
ln -sfn "$profile" "$profiles/agent-image-link"
ln -sfn agent-image-link "$profiles/agent"
# Both links are written as they resolve from the server container, where the volume is /nix.
ln -sfn /nix/var/nix/profiles "$gcroots/profiles"

echo "Nix volume holds $(basename "$profile")"
