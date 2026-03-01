{ config, pkgs, ... }:

{
  packages = with pkgs; [
    age
    curl
    fluxcd
    gum
    helmfile
    just
    jq
    krew
    kubectl
    kubernetes-helm
    kustomize
    lefthook
    minijinja
    mise
    pipx
    sops
    talosctl
    uv
    yamlfmt
    yq-go
  ];

  env = {
    JUST_UNSTABLE = "1";
    LEFTHOOK_OUTPUT = "false";
    MINIJINJA_CONFIG_FILE = "${config.devenv.root}/.minijinja.toml";
  };

  enterShell = ''
    export KREW_ROOT="${config.devenv.root}/.devenv/krew"
    export PATH="$KREW_ROOT/bin:$PATH"

    if ! command -v kubectl-krew >/dev/null 2>&1; then
      krew install krew >/dev/null
    fi

    if ! command -v kubectl-browse_pvc >/dev/null 2>&1; then
      kubectl krew install browse-pvc >/dev/null
    fi

    if [ -f .mise.toml ]; then
      export MISE_TRUSTED_CONFIG_PATHS="${config.devenv.root}"
      mise install -y >/dev/null
      eval "$(mise env -s bash)"
    fi
  '';
}
