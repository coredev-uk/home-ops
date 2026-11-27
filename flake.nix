{
  description = "home-ops development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      # 1Password's op is unfree; it's the only unfree package allowed.
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "1password-cli";
            }
          )
        );

      # Not in nixpkgs: the release binary, statically linked. Renovate does
      # not bump it (it cannot update the hashes), and CI runs this one. To
      # update, set version and the hashes from each release's
      # flate_<version>_<platform>.tar.gz.sha256 asset.
      flate =
        pkgs:
        let
          # 0.8.0: renders Kustomizations sourced from an ArtifactGenerator's ExternalArtifacts
          version = "0.8.0";
          platforms = {
            aarch64-darwin = {
              name = "darwin_arm64";
              sha256 = "b881cfbef651084d0c9b97c6c2d60103022b43a2caeddc1d06febf93c065dd7d";
            };
            aarch64-linux = {
              name = "linux_arm64";
              sha256 = "4ae502e56054ee9c5019995554856c1f6f8f44b3f6fef087704b2d31c27ab9c6";
            };
            x86_64-darwin = {
              name = "darwin_amd64";
              sha256 = "cf78f16c81df6d399558a4e9db8cfc30d16bdf8f18647abd6e04e0e329982cc1";
            };
            x86_64-linux = {
              name = "linux_amd64";
              sha256 = "76940fb6ff060e09a40e1a835fc9c5cd24e18fdd29e4e79382852821e0ac01c2";
            };
          };
          platform = platforms.${pkgs.stdenv.hostPlatform.system};
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "flate";
          inherit version;
          src = pkgs.fetchurl {
            url = "https://github.com/home-operations/flate/releases/download/v${version}/flate_${version}_${platform.name}.tar.gz";
            inherit (platform) sha256;
          };
          sourceRoot = ".";
          installPhase = "install -Dm755 flate $out/bin/flate";
        };
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            # op, signed in by the service account token direnv loads from .env (.envrc)
            pkgs._1password-cli
            # pass-cli, signed in with `pass-cli login`
            pkgs.proton-pass-cli
            # git hooks (home-operations/.github lefthook.common.toml)
            pkgs.actionlint
            pkgs.lefthook
            pkgs.oxfmt
            pkgs.shellcheck
            pkgs.zizmor
            # just recipes and bootstrap
            pkgs.fluxcd
            pkgs.gum
            (pkgs.wrapHelm pkgs.kubernetes-helm { plugins = [ pkgs.kubernetes-helmPlugins.helm-diff ]; })
            pkgs.helmfile
            pkgs.jq
            pkgs.just
            pkgs.kubectl
            pkgs.kustomize
            pkgs.minijinja
            pkgs.talosctl
            pkgs.yq-go
            # rendering and reading images
            pkgs.crane
            (flate pkgs)
          ];

          JUST_UNSTABLE = "1";

          shellHook = ''
            root="$(git rev-parse --show-toplevel)"
            export FLATE_PATH="$root/kubernetes/apps"
            export KUBECONFIG="$root/kubeconfig"
            export MINIJINJA_CONFIG_FILE="$root/.minijinja.toml"
            export TALOSCONFIG="$root/talosconfig"

            # direnv re-runs this on every load; install the git hooks once,
            # lefthook re-syncs them itself when its config changes. CI never
            # commits, and its output would land in captured command output.
            if [ -z "''${CI:-}" ] && [ ! -f "$(git rev-parse --git-path info/lefthook.checksum)" ]; then
              lefthook install
            fi
            unset root
          '';
        };
      });
    };
}
