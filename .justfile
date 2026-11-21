#!/usr/bin/env -S just --justfile

set minimum-version := '1.55.0'

set default-list
set default-script
set lazy
set quiet
set script-interpreter := ['bash', '-euo', 'pipefail']
set shell := ['bash', '-euo', 'pipefail', '-c']

# Bootstrap Recipes
[group('Bootstrap')]
mod bootstrap "bootstrap"

# Kube Recipes
[group('Kube')]
mod kube "kubernetes"

# Talos Recipes
[group('Talos')]
mod talos "talos"

# Oracle VPS Recipes
[group('Oracle')]
mod oracle "oracle"

[private]
log lvl msg *args:
    gum log -t rfc3339 -s -l "{{ lvl }}" "{{ msg }}" {{ args }}

# pass:// references resolve from Proton Pass (a signed-in pass-cli), then op:// references from
# 1Password (op, signed in by the service account token in .env). pass-cli inject only reads
# references wrapped in double braces, which minijinja would render itself, so they're wrapped
# after it. Output without pass:// references never calls pass-cli.
[private]
template file *args:
    rendered="$(minijinja-cli "{{ file }}" {{ args }})"
    if [[ "${rendered}" == *pass://* ]]; then
        rendered="$(sed -E 's#pass://[^[:space:]"]+#{{{{ & }}#g' <<<"${rendered}" | pass-cli inject)"
    fi
    op inject <<<"${rendered}"
