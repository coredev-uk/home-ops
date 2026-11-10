set default-list
set default-script
set quiet
set script-interpreter := ['bash', '-euo', 'pipefail']
set shell := ['bash', '-euo', 'pipefail', '-c']

host := "ubuntu@130.162.183.212"
# renovate: datasource=github-releases depName=juanfont/headscale
headscale_version := "0.29.7"

[confirm('Deploy Headscale and Caddy to the Oracle VPS [y|N] ?')]
[doc('Install or upgrade Headscale on the Oracle VPS and push its config')]
deploy:
    # Status prefix: a purged-but-not-cleaned package ("rc") still reports its old version
    installed="$(ssh {{ host }} "dpkg-query -W -f='\${db:Status-Abbrev}\${Version}' headscale 2>/dev/null || true")"
    if [[ "${installed}" != "ii {{ headscale_version }}" ]]; then
        ssh {{ host }} "curl -fsSL -o /tmp/headscale.deb https://github.com/juanfont/headscale/releases/download/v{{ headscale_version }}/headscale_{{ headscale_version }}_linux_amd64.deb && sudo apt-get install -y -o Dpkg::Options::=--force-confold /tmp/headscale.deb && rm /tmp/headscale.deb"
    fi
    just template "{{ source_directory() }}/headscale/config.yaml.j2" | ssh {{ host }} "sudo install -o root -g headscale -m 0640 /dev/stdin /etc/headscale/config.yaml"
    ssh {{ host }} "sudo install -o root -g headscale -m 0640 /dev/stdin /etc/headscale/policy.hujson" < "{{ source_directory() }}/headscale/policy.hujson"
    ssh {{ host }} "sudo install -o root -g root -m 0644 /dev/stdin /etc/caddy/Caddyfile" < "{{ source_directory() }}/Caddyfile"
    ssh {{ host }} "sudo headscale configtest && sudo systemctl enable headscale && sudo systemctl restart headscale && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy"
    just log info "Deployed Headscale" version "{{ headscale_version }}"

[doc('Mint a 24h reusable tag:talos pre-auth key into 1Password for Talos node registration')]
talos-authkey:
    key="$(ssh {{ host }} "sudo headscale preauthkeys create --tags tag:talos --reusable --expiration 24h")"
    op item edit headscale --vault kubernetes "HEADSCALE_TALOS_AUTHKEY[password]=${key}" >/dev/null
    just log info "Stored Talos auth key" expires 24h

[doc('Mint a 365d Headscale API key for Headplane into 1Password')]
headplane-apikey:
    key="$(ssh {{ host }} "sudo headscale apikeys create --expiration 365d")"
    op item edit headscale --vault kubernetes "HEADPLANE_API_KEY[password]=${key}" >/dev/null
    just log info "Stored Headplane API key" expires 365d
