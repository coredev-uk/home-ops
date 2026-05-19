#!/usr/bin/env bash
set -euo pipefail

# Incoming arguments
PAYLOAD=${1:-}

# Required environment variables
: "${APPRISE_CHANGE_DETECTION_PUSHOVER_URL:?Pushover URL required}"

echo "[DEBUG] changedetection Payload: ${PAYLOAD}"

function _jq() {
    jq -r "${1:?}" <<<"${PAYLOAD}"
}

function notify() {
    local title message url

    title=$(_jq '.title // "changedetection.io"')
    message=$(_jq '.message // .body // "Change detected"')
    url=$(_jq '.url // .watch_url // "https://changes.hera.ac"')

    apprise -vv --title "${title}" --body "${message}" --input-format html \
        "${APPRISE_CHANGE_DETECTION_PUSHOVER_URL}?url=${url}&url_title=View Watch&priority=normal&format=html"
}

function main() {
    notify
}

main "$@"
