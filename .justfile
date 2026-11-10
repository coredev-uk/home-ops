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

[private]
log lvl msg *args:
    gum log -t rfc3339 -s -l "{{ lvl }}" "{{ msg }}" {{ args }}

[private]
template file *args:
    # SECRETS_PROVIDER=proton-pass resolves the same op:// references from Proton Pass instead:
    # vault/item/field -> pass://vault/item/field, vault/item/section/field -> .../section.field.
    # pass-cli inject only reads references wrapped in double braces, hence the rewrite.
    proton_inject() {
        sed -E \
            -e 's#op://([^/[:space:]]+)/([^/[:space:]]+)/([^/[:space:]]+)/([^/[:space:]]+)#{{{{ pass://\1/\2/\3.\4 }}#g' \
            -e 's#op://([^/[:space:]]+)/([^/[:space:]]+)/([^/[:space:]]+)#{{{{ pass://\1/\2/\3 }}#g' |
            pass-cli inject
    }
    case "${SECRETS_PROVIDER:-1password}" in
        1password) inject=(op inject) ;;
        proton-pass) inject=(proton_inject) ;;
        *)
            just log fatal "Unknown SECRETS_PROVIDER" "value" "${SECRETS_PROVIDER}" "expected" "1password or proton-pass"
            exit 1
            ;;
    esac
    minijinja-cli "{{ file }}" {{ args }} | "${inject[@]}"
