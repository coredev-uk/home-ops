#!/usr/bin/env bash
set -euo pipefail

# Incoming arguments
PAYLOAD=${1:-}

# Required environment variables
: "${APPRISE_CHANGE_DETECTION_PUSHOVER_URL:?Pushover URL required}"

echo "[DEBUG] changedetection Payload: ${PAYLOAD}"

# changedetection.io normally posts the rendered notification body directly.
# If an Apprise/custom handler wraps it as a message/body string, merge the
# embedded JSON back into the top-level payload before selecting fields.
PAYLOAD=$(jq -c '
  def parse_json: try fromjson catch null;
  (.message // .body // "") as $embedded |
  ($embedded | parse_json) as $parsed |
  if ($parsed | type) == "object" then . + $parsed else . end
' <<<"${PAYLOAD}")

function _jq() {
    jq -r "${1:?}" <<<"${PAYLOAD}"
}

function field() {
    _jq "${1:?} // empty"
}

function first_field() {
    local value

    for selector in "$@"; do
        value=$(field "${selector}")
        if [[ -n "${value}" && "${value}" != "null" ]]; then
            printf '%s' "${value}"
            return
        fi
    done
}

function notify() {
    local title message url added removed diff

    title=$(first_field '.title' '.watch_title' '.page_title' '.website_title' '.url' '.watch_url')
    title=${title:-changedetection.io}

    url=$(first_field '.url' '.watch_url' '.source_url')
    url=${url:-https://changes.hera.ac}

    added=$(first_field '.diff_added' '.added')
    removed=$(first_field '.diff_removed' '.removed')
    diff=$(first_field '.diff' '.diff_full' '.message' '.body' '.current_snapshot')

    message="<b>${title}</b><br><a href=\"${url}\">${url}</a>"
    if [[ -n "${added}" ]]; then
        message+="<br><br><b>Added</b><br><pre>${added}</pre>"
    fi
    if [[ -n "${removed}" ]]; then
        message+="<br><br><b>Removed</b><br><pre>${removed}</pre>"
    fi
    if [[ -z "${added}${removed}" && -n "${diff}" ]]; then
        message+="<br><br><b>Change</b><br><pre>${diff}</pre>"
    fi

    apprise -vv --title "${title}" --body "${message}" --input-format html \
        "${APPRISE_CHANGE_DETECTION_PUSHOVER_URL}?url=${url}&url_title=View Watch&priority=normal&format=html"
}

function main() {
    notify
}

main "$@"
