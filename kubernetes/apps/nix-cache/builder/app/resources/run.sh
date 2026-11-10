#!/usr/bin/env bash
# NixOS cache builder (helmrelease.yaml), every 30 minutes: build every x86_64-linux
# nixosConfiguration and homeConfiguration of coredev-uk/nixos at each commit it has not built
# yet, on main and on every open pull request from a branch of that repository (BOT Cecil's
# nightly flake-update one among them), push whatever built to Attic, and report the result on
# the commit as the `nix-cache` status, which main's ruleset requires before a pull request
# merges. The next switch on atlas then finds every path either here or on a public cache.
# darwinConfigurations (poseidon) need macOS: not here. It never writes to the repository.
#
# Runs as root in the pod's Kata VM. The Nix store is persistent: an ext4 image on a Ceph
# volume, loop-mounted over /nix, so a run only fetches and builds what changed and nothing
# heavy lands on the node's disk. Builds run in the Nix sandbox as nixbld users, which cannot
# read /secrets. i686-linux builds (Steam's 32-bit graphics stack) run under qemu-i386: the VM's
# kernel has no 32-bit support, so they otherwise fail with "Exec format error".
# The single-quoted $names are jq's, not the shell's.
# shellcheck disable=SC2016
set -euo pipefail

REPO=coredev-uk/nixos
REPO_HTTPS=https://github.com/$REPO.git
STATUS_CONTEXT=nix-cache
DASHBOARD=https://grafana.hera.ac/d/nix-cache
# A commit that failed is built again after this long (12h), for failures that were the
# network's or the VM's rather than the commit's.
RETRY_AFTER=43200
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
OPENSSL=/nix/store/gvglnxscmvx4mh9my0cy0xgi0l1z6l9s-openssl-3.5.9-bin/bin/openssl
CURL=/nix/store/5lpg7j8y8lf8c4zv318yi4rmgyn5yhip-curl-8.22.0-bin/bin/curl
ATTIC=/nix/store/ki30bh61j71vp2jih6mfxhmfdiqxrr69-attic-0-unstable-2026-07-06/bin/attic
QEMU_I386=/nix/store/lxv8rdcy5mg92q74ia507z4sl2017xs6-qemu-user-static-x86_64-unknown-linux-musl-11.1.2/bin/qemu-i386

log() { echo "[nix-cache] $*"; }

started=$(date +%s)
phase=setup
phase_started=$started
durations='{}'
inputs='{}'
# Commit -> {success, finished, targets} for what this run built.
results='{}'

# --- GitHub, as the bot-cecil App ------------------------------------------------------
b64url() { "$OPENSSL" base64 -A | tr '+/' '-_' | tr -d '='; }
app_jwt() {
  local now unsigned
  now=$(date +%s)
  unsigned="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url).$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' \
    $((now - 60)) $((now + 540)) "$(cat /secrets/github-app-client-id)" | b64url)"
  printf '%s.%s' "$unsigned" \
    "$(printf '%s' "$unsigned" | "$OPENSSL" dgst -sha256 -sign /secrets/github-app-private-key | b64url)"
}
# github TOKEN METHOD PATH [BODY]
github() {
  local data=()
  [ $# -lt 4 ] || data=(--data "$4")
  "$CURL" -fsS --retry 3 -X "$2" -H "Authorization: Bearer $1" \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
    "${data[@]}" "https://api.github.com$3"
}
# A token for this one repository that can read its code and pull requests and set commit
# statuses, nothing else the App may do. Minted per use: one lasts an hour, a build longer.
github_token() {
  local jwt id
  jwt=$(app_jwt)
  id=$(github "$jwt" GET "/repos/$REPO/installation" | "$JQ" -r .id)
  github "$jwt" POST "/app/installations/$id/access_tokens" \
    "{\"repositories\":[\"${REPO#*/}\"],\"permissions\":{\"contents\":\"read\",\"pull_requests\":\"read\",\"statuses\":\"write\"}}" |
    "$JQ" -r .token
}
# set_status COMMIT STATE DESCRIPTION; a failure to report never fails the build.
set_status() {
  local body
  body=$("$JQ" -nc --arg s "$2" --arg d "$3" --arg c "$STATUS_CONTEXT" --arg u "$DASHBOARD" \
    '{state: $s, description: $d, context: $c, target_url: $u}')
  github "$(github_token)" POST "/repos/$REPO/statuses/$1" "$body" >/dev/null ||
    log "could not set the $STATUS_CONTEXT status on $1"
}

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

# Times the phase that just ended and starts the next one. A run builds and pushes once per
# commit, so the phases' times add up.
next_phase() {
  local now
  now=$(date +%s)
  durations=$("$JQ" -c --arg p "$phase" --argjson d $((now - phase_started)) '.[$p] += $d' <<<"$durations")
  phase=$1
  phase_started=$now
}

# Written on every exit once there is something to build, so a failed run is as visible as a
# good one. refs keeps each branch's latest built commit: main, and the open pull requests.
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
    --arg phase "$phase" --argjson durations "$durations" --argjson inputs "$inputs" \
    --argjson prev "$prev" --argjson heads "$heads" --argjson results "$results" \
    --argjson store_size "${size:-0}" --argjson store_used "${used:-0}" \
    '($prev.refs // {}) as $old
    | {started: $started, finished: $finished, success: $success,
      failed_phase: (if $success then null else $phase end), durations: $durations,
      last_success: (if $success then $finished else $prev.last_success end),
      commits_built: ($results | length),
      refs: ($heads | with_entries(.key as $ref | .value as $sha | .value =
        (if $results[$sha] then $results[$sha] + {sha: $sha}
         else ([$old[] | select(.sha == $sha)][0] // null) end))
        | with_entries(select(.value != null))),
      inputs: (if $inputs == {} then ($prev.inputs // {}) else $inputs end),
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

# --- what to build ---------------------------------------------------------------------
# Before the store is mounted, so a run with nothing new costs a few API calls.
nix build --no-link "$UTIL_LINUX" "$E2FSPROGS" "${JQ%/bin/jq}" "${OPENSSL%/bin/openssl}" "${CURL%/bin/curl}"
prev=$(cat "$STATUS" 2>/dev/null || echo '{}')
token=$(github_token)
# Branch -> commit: main, and every open pull request into main from a branch of this repository
# (a fork's code never runs here).
heads=$({
  github "$token" GET "/repos/$REPO/commits/main" | "$JQ" -c '{main: .sha}'
  github "$token" GET "/repos/$REPO/pulls?state=open&base=main&per_page=100" |
    "$JQ" -c --arg repo "$REPO" \
      'map(select(.head.repo.full_name == $repo) | {key: "pr-\(.number)", value: .head.sha}) | from_entries'
} | "$JQ" -sc add)
# Each commit once (a branch and main can point at the same one), skipping those built before
# under any branch, unless that failed RETRY_AFTER ago.
mapfile -t todo < <("$JQ" -r --argjson prev "$prev" --argjson now "$(date +%s)" --argjson retry "$RETRY_AFTER" '
  [($prev.refs // {})[]] as $built
  | [to_entries[] | . as $h
    | select([$built[] | select(.sha == $h.value
        and (.success or $now - (.finished // 0) < $retry))] | length == 0)]
  | unique_by(.value)[] | "\(.key) \(.value)"' <<<"$heads")
if [ "${#todo[@]}" = 0 ]; then
  log "nothing new to build"
  exit 0
fi
for t in "${todo[@]}"; do
  log "to build: $t"
  set_status "${t#* }" pending "Building atlas's system and home into the binary cache"
done

# --- mount the persistent store --------------------------------------------------------
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
  "$UTIL_LINUX" "$E2FSPROGS" "${JQ%/bin/jq}" "${OPENSSL%/bin/openssl}" "${CURL%/bin/curl}" \
  "${ATTIC%/bin/attic}" "${QEMU_I386%/bin/qemu-i386}"
log "store: $(df -h --output=used,size /nix | tail -1 | xargs)"

# 32-bit x86 ELF executables go to the static qemu-i386; Nix already counts i686-linux among
# its platforms. F opens the interpreter now, so it runs inside the sandbox, where its path is
# not mounted. The kernel decodes the \x escapes itself: they must reach it as text.
[ -e /proc/sys/fs/binfmt_misc/register ] || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-i386 ]; then
  i386_magic='\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x03\x00'
  i386_mask='\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
  echo ":qemu-i386:M::$i386_magic:$i386_mask:$QEMU_I386:F" >/proc/sys/fs/binfmt_misc/register
fi

# --- build each commit ------------------------------------------------------------------
attic_ready=false
all_ok=true

# commit_result COMMIT SUCCESS TARGETS DESCRIPTION: record it for status.json and report it on
# the commit (GitHub cuts descriptions at 140 characters).
commit_result() {
  results=$("$JQ" -c --arg c "$1" --argjson s "$2" --argjson t "$3" --argjson f "$(date +%s)" \
    '.[$c] = {success: $s, finished: $f, targets: $t}' <<<"$results")
  [ "$2" = true ] || all_ok=false
  log "$1: $4"
  set_status "$1" "$([ "$2" = true ] && echo success || echo failure)" "${4:0:140}"
}

# push_outputs PATH...: whatever built goes to Attic, even when another target failed.
push_outputs() {
  next_phase push
  if [ "$attic_ready" = false ]; then
    export XDG_CONFIG_HOME=/tmp/attic
    "$ATTIC" login --set-default local "$ATTIC_ENDPOINT" "$(cat /secrets/attic-token)" >/dev/null
    # The first run creates the cache, and with it the signing key atlas has to trust; every
    # run then reapplies its settings, so they live here rather than in Attic's database alone.
    if ! "$ATTIC" cache info "local:$CACHE" >/dev/null 2>&1; then
      log "creating cache $CACHE"
      "$ATTIC" cache create --public "local:$CACHE"
    fi
    local upstream_args=() k
    for k in "${UPSTREAM_KEYS[@]}"; do upstream_args+=(--upstream-cache-key-name "$k"); done
    "$ATTIC" cache configure --public "${upstream_args[@]}" "local:$CACHE"
    # attic prints the cache info on stderr.
    log "cache $CACHE: $("$ATTIC" cache info "local:$CACHE" 2>&1 | grep -i 'public key' | xargs)"
    attic_ready=true
  fi
  run "$ATTIC" push "local:$CACHE" "$@"
}

# build_commit BRANCH COMMIT: build every target at COMMIT in one invocation, so a package two
# targets share is built (or fails) once, and --keep-going still builds everything that does
# not depend on a failure.
build_commit() {
  local ref=$1 sha=$2 dir="$WORK/$2" build_rc=0 targets='{}' target_json i name out size
  local hosts=() homes=() names=() installables=() outs=() built=() failed=()
  next_phase build
  # Authenticated GitHub API calls for the flake's GitHub inputs: anonymous ones share the home
  # IP's 60 an hour. A fresh token, as the store check or an earlier commit can outlast one.
  # NIX_CONFIG adds to nix.conf for this process only; builds never see it.
  NIX_CONFIG="access-tokens = github.com=$(github_token)"
  export NIX_CONFIG
  rm -rf "$dir"
  if ! { git init --quiet "$dir" &&
    git -C "$dir" fetch --quiet --depth 1 "$REPO_HTTPS" "$sha" &&
    git -C "$dir" checkout --quiet FETCH_HEAD; }; then
    commit_result "$sha" false '{}' "Could not fetch the commit"
    return
  fi
  if [ "$ref" = main ]; then
    # Input name -> lastModified, for the dashboard's input age panel.
    inputs=$("$JQ" -c '.nodes as $n | .nodes.root.inputs | with_entries(
      .value |= ($n[if type == "array" then .[0] else . end].locked.lastModified // null))
      | with_entries(select(.value != null))' "$dir/flake.lock")
  fi
  # One evaluation for both kinds; either may be absent.
  if ! target_json=$(nix eval --json --impure --expr "
    let
      f = builtins.getFlake \"git+file://$dir\";
      on = cs: builtins.filter (n: cs.\${n}.pkgs.stdenv.hostPlatform.system == \"$SYSTEM\") (builtins.attrNames cs);
    in { nixos = on (f.nixosConfigurations or { }); home = on (f.homeConfigurations or { }); }"); then
    commit_result "$sha" false '{}' "Evaluation failed; the builder's log has the error"
    return
  fi
  mapfile -t hosts < <("$JQ" -r '.nixos[]' <<<"$target_json")
  mapfile -t homes < <("$JQ" -r '.home[]' <<<"$target_json")
  for name in "${hosts[@]}"; do
    names+=("$name")
    installables+=("$dir#nixosConfigurations.\"$name\".config.system.build.toplevel")
  done
  for name in "${homes[@]}"; do
    names+=("$name")
    installables+=("$dir#homeConfigurations.\"$name\".activationPackage")
  done
  if [ "${#names[@]}" = 0 ]; then
    commit_result "$sha" false '{}' "No $SYSTEM nixosConfigurations or homeConfigurations"
    return
  fi

  log "$ref ($sha): building ${names[*]}"
  run nix build --keep-going --no-link "${installables[@]}" || build_rc=$?
  for i in "${!names[@]}"; do
    name=${names[$i]}
    out=$(nix eval --raw "${installables[$i]}.outPath")
    if nix path-info "$out" >/dev/null 2>&1; then
      # A GC root per branch and target. Profile names cannot hold '@' (paul@atlas).
      nix-env --profile "$PROFILES/${ref}__${name//@/-at-}" --set "$out" >/dev/null
      size=$(nix path-info --closure-size --json --json-format 1 "$out" | "$JQ" '[.[]][0].closureSize')
      outs+=("$out")
      built+=("$name")
      targets=$("$JQ" -c --arg t "$name" --argjson s "$size" '.[$t] = {success: true, closure_bytes: $s}' <<<"$targets")
    else
      failed+=("$name")
      targets=$("$JQ" -c --arg t "$name" '.[$t] = {success: false, closure_bytes: null}' <<<"$targets")
    fi
  done

  if [ "${#outs[@]}" -gt 0 ] && ! push_outputs "${outs[@]}"; then
    commit_result "$sha" false "$targets" "Built ${built[*]}, but the push to the binary cache failed"
  elif [ "${#failed[@]}" -gt 0 ] || [ "$build_rc" != 0 ]; then
    commit_result "$sha" false "$targets" "Failed: ${failed[*]:-a dependency}; built and cached: ${built[*]:-none}"
  else
    commit_result "$sha" true "$targets" "Built and cached: ${built[*]}"
  fi
  rm -rf "$dir"
}

for t in "${todo[@]}"; do
  build_commit "${t%% *}" "${t#* }"
done

# --- keep the store in bounds -----------------------------------------------------------
next_phase gc
for p in "$PROFILES"/*; do
  case $p in *-link) continue ;; esac # generations of the profile itself
  ref=${p##*/}
  ref=${ref%%__*}
  if "$JQ" -e --arg r "$ref" 'has($r) | not' <<<"$heads" >/dev/null; then
    # A merged or closed pull request's outputs (or a name from before branches had profiles).
    rm -f "$p" "$p"-*-link
  else
    nix profile wipe-history --profile "$p" --older-than 7d
  fi
done
# Collect only when the store is filling up: between runs it keeps compilers and other
# build-only inputs, so the next one does not download them again.
read -r size used < <(df -B1 --output=size,used /nix | tail -1)
if [ $((used * 100 / size)) -ge 60 ]; then
  log "store at $((used * 100 / size))%, collecting garbage"
  run nix store gc
fi
log "done"
if [ "$all_ok" != true ]; then
  next_phase build # reported as the failed phase
  exit 1
fi
