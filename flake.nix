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
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Not in nixpkgs: the release binary, statically linked. Renovate does
      # not bump it (it cannot update the hashes); CI pins its own
      # FLATE_VERSION in .github/workflows/ci.yaml. To update, set version and
      # the hashes from each release's flate_<version>_<platform>.tar.gz.sha256
      # asset.
      flate =
        pkgs:
        let
          version = "0.6.5";
          platforms = {
            aarch64-darwin = {
              name = "darwin_arm64";
              sha256 = "76274be5ef8b016e80ea0abf7b6f612adc76a89f7613d2e7f7e3550af5b9e186";
            };
            aarch64-linux = {
              name = "linux_arm64";
              sha256 = "7f514814890df4a095887943ae606be1a8af878606b7bd0575efe75402cd38dc";
            };
            x86_64-darwin = {
              name = "darwin_amd64";
              sha256 = "4b1dcefb4613b4c02f3374c8fc8d4082d42d893f4303daa16e24e37d58bccb78";
            };
            x86_64-linux = {
              name = "linux_amd64";
              sha256 = "37eb0cd91a6752340754375743aa616c263cd8367ce594abd42ee955e1ec0099";
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
          # 1Password's op is left to the system: NixOS's programs._1password
          # wrapper is what the desktop app integration trusts
          packages = [
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
            # rendering and reading images (reviewing-pull-requests skill)
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
            # lefthook re-syncs them itself when its config changes
            if [ ! -f "$(git rev-parse --git-path info/lefthook.checksum)" ]; then
              lefthook install
            fi
            unset root
          '';
        };
      });
    };
}
