# octo-sts

GitHub Actions workflows that act as `bot-cecil[bot]` (Renovate, release tags, flake updates, sona-go's release and branch jobs) get their token from [octo-sts](https://github.com/octo-sts/app), self-hosted at `https://octo-sts.hera.ac` (`kubernetes/apps/actions-runner-system/octo-sts`). No repository holds bot-cecil's private key: octo-sts does, from the 1Password item `bot-cecil` (`GITHUB_BOT_APP_ID`, `GITHUB_BOT_APP_PRIVATE_KEY`), and mints short-lived installation tokens for a workflow's GitHub Actions OIDC token. It accepts no other issuer.

A workflow job asks for a token with `id-token: write` and:

```yaml
- uses: octo-sts/action@f603d3be9d8dd9871a265776e625a27b00effe05 # v1.1.1
  id: app-token
  with:
      domain: octo-sts.hera.ac
      scope: ${{ github.repository }}
      identity: renovate
```

`identity` names a trust policy in the same repository, `.github/chainguard/<identity>.sts.yaml`, read from its default branch, so a policy works only once it's merged. Each one pins the OIDC `subject` (with immutable subject claims, `repo:coredev-uk@64542347/<repo>@<repo id>:ref:refs/heads/main`, or `...:environment:<name>` for a job in an environment, which keeps the environment's protection rules as the gate) and the `workflow_ref` of the one workflow it serves, and lists the permissions the token gets. bot-cecil must also be installed on the repository and hold those permissions.

Policies: `.github/chainguard/{renovate,tag}.sts.yaml` here, `flake-update` in coredev-uk/nixos (its `flake-update.yml` opens the per-input update pull requests that Clarence merges), `renovate` in coredev-uk/clarence and coredev-uk/jellyfin-hera-tv, and one per workflow in coredev-uk/sona-go.

One-time setup:

- Immutable OIDC subject claims on each repository (`gh api -X PUT repos/coredev-uk/<repo>/actions/oidc/customization/sub -F use_default=true -F use_immutable_subject=true`; repositories created after July 15, 2026 have them already).
- A Cloudflare WAF custom rule, first in the list, that skips the remaining custom rules, rate limiting, managed rules and Super Bot Fight Mode for `(http.host eq "octo-sts.hera.ac" and http.request.uri.path eq "/sts/exchange")`. Without it, GitHub-hosted runners' Azure addresses get a challenge page instead of a token.
