#!/usr/bin/env bash
# The container's entrypoint (Containerfile), run under tini: prepares the persistent directories
# and starts T3. HOME, T3CODE_HOME, PI_CODING_AGENT_DIR and the listen address come from the
# HelmRelease (kubernetes/apps/t3/environment/app/helmrelease.yaml).
set -euo pipefail

: "${HOME:?}" "${T3CODE_HOME:?}" "${PI_CODING_AGENT_DIR:?}"
mkdir -p "$HOME" "$T3CODE_HOME" "$PI_CODING_AGENT_DIR"

# T3 keeps clones and worktrees, caches and on-demand tools (its headless Chrome) under
# T3CODE_HOME, which is the backed-up state volume. Link them to the work volume (/work, not
# backed up) and the pod's cache volume instead; the HelmRelease mounts both outside /data so
# the runtime never creates root-owned mount points inside it. A real directory left by an
# earlier layout is kept as it is.
link() {
  mkdir -p "$2"
  [[ -e "$1" || -L "$1" ]] || ln -s "$2" "$1"
}
link "$T3CODE_HOME/worktrees" /work/worktrees
link "$T3CODE_HOME/projects" /work/projects
link "$T3CODE_HOME/caches" /var/cache/agent/t3-caches
link "$T3CODE_HOME/tools" /var/cache/agent/t3-tools

# omp's AGENTS.md and skills are owned by the image, not by the state volume: replace them on
# every start so an image bump reaches existing environments, and so edits made in a pod do not
# survive a restart (change them in containers/t3/omp/ instead).
cp /opt/omp/AGENTS.md "$PI_CODING_AGENT_DIR/AGENTS.md"
rm -rf "${PI_CODING_AGENT_DIR:?}/skills"
cp -r /opt/omp/skills "$PI_CODING_AGENT_DIR/skills"

args=(serve --no-browser)
[[ -n "${T3CODE_HOST:-}" ]] && args+=(--host "$T3CODE_HOST")
[[ -n "${T3CODE_PORT:-}" ]] && args+=(--port "$T3CODE_PORT")

# T3 prints a one-time pairing block on every start (startupAccess.ts, formatHeadlessServeOutput:
# the ready line, then Connection string, Token, Pairing URL, App link, a blank line, the QR code
# rows and a blank line). The token would land in the cluster's log store, so drop everything
# from the first credential line through the end of the block, keeping the ready line. Mint
# pairing links with `t3 auth pairing create` instead.
#
# The filter runs as a process substitution so that t3 stays the exec'd process and receives
# tini's signals. It is Debian's mawk, which reads a pipe in whole blocks and sat on the logs
# until 4 KiB had arrived: -W interactive makes it read and write line by line.
filter() {
  mawk -W interactive '
    /^Connection string: / { skip = 1; next }
    skip && (/^Token: / || /^Pairing URL: / || /^App link: /) { next }
    skip && ($0 == "" || /^[ ▀▄█]+$/) { next }
    { skip = 0; print }
  '
}

exec t3 "${args[@]}" > >(filter) 2>&1
