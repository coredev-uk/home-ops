{ config, pkgs, ... }:

{
  packages = with pkgs; [
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
