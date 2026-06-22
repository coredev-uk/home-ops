{ config, pkgs, ... }:

let
  chaski = pkgs.buildGoModule {
    pname = "chaski";
    version = "0.2.0";

    src = pkgs.fetchFromGitHub {
      owner = "home-operations";
      repo = "chaski";
      rev = "0.2.0";
      hash = "sha256-u87DBy6lEzPsQ2O/6fExJqAOK6r5basNz1l79W7iQU4=";
    };

    # The locked devenv nixpkgs currently has Go 1.26.2 while chaski's go.mod
    # requires the next patch release. The code builds cleanly with 1.26.2.
    postPatch = ''
      substituteInPlace go.mod --replace-fail "go 1.26.4" "go 1.26.2"
    '';

    vendorHash = "sha256-tVzSYSZ8eMETrML4ReLZx6P+OcoXbilfYnuFH4VUOyc=";
    subPackages = [ "cmd/chaski" ];
  };
in
{
  packages = with pkgs; [
    chaski
    just
    minijinja
    oxfmt
    vals
    yq
    zizmor
  ];

  dotenv.enable = true;

  env = {
    JUST_UNSTABLE = "1";
    LEFTHOOK_OUTPUT = "false";
    MINIJINJA_CONFIG_FILE = "${config.devenv.root}/.minijinja.toml";
  };

  enterShell = ''
    if [ -f .mise.toml ]; then
      export MISE_TRUSTED_CONFIG_PATHS="${config.devenv.root}"
      mise install -y >/dev/null
      eval "$(mise env -s bash)"
    fi
  '';
}
