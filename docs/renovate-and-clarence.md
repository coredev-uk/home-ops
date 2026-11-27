# Renovate and Clarence

Renovate (`.renovaterc.json5`, run every two hours by `.github/workflows/renovate.yaml` as `bot-cecil[bot]`) opens the update pull requests; it never merges them. Clarence (`kubernetes/apps/clarence`, the `bot-clarence` GitHub App) does: it rules on each Renovate pull request (code checks, then the Jev model on the release notes), labels it `verdict/*`, and merges what its policy passes one at a time (`state/*` follows it from queued to live), then waits for the Flux Kustomizations and HelmReleases it touched to apply the merge commit, soaks, and opens a revert pull request and halts merging if the deploy is unhealthy. Changes under `.github/workflows/` are verified by CI on `main` instead. Clarence scans the old and new image of each image update with Trivy against the in-cluster Trivy server (`kubernetes/apps/clarence/trivy`): an update whose new image drops HIGH or CRITICAL CVEs the old one has gets `kind/security` and goes ahead in the merge line, and the daily report lists those CVEs in the images the cluster runs. The policy is `kubernetes/apps/clarence/clarence/app/policy-home-ops.json`; while a scope's mode is `shadow` Clarence only labels and comments. The same Deployment runs controllers for `coredev-uk/sona-go`, `coredev-uk/clarence` and `coredev-uk/nixos` ([below](#coredev-uknixos)).

Every open pull request gets one Clarence card, edited in place: the verdict, what it deploys, the checks, Jev's reading and a timeline from queue to live. Its checkboxes (re-run, hold, merge, explain) act within about 20 seconds when `coredev-uk` ticks them; GitHub's webhook wakes Clarence sooner. Separate comments appear only when something needs you: an unhealthy deploy, a revert or a dequeue.

Mention Clarence at the start of a comment (only `coredev-uk`; `@bot-clarence help` answers anyone):

| Comment                                                   | Effect                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `@bot-clarence merge`                                     | Queue it for merge at its current head                            |
| `@bot-clarence merge --allow destructive,image`           | Same, accepting those checks' blocking findings (`health` too)    |
| `@bot-clarence merge at 03:00` · `after #570` · `--batch` | Same, scheduled                                                   |
| `@bot-clarence cancel`                                    | Take it out of the queue                                          |
| `@bot-clarence revert`                                    | On a merged pull request: open a revert pull request and queue it |
| `@bot-clarence reclassify`                                | Ask Jev again and rerun the checks                                |
| `@bot-clarence status`                                    | The ruling, checks, queue position, health gate and deploy state  |
| `@bot-clarence explain`                                   | Which parts of the release notes drive each flagged Jev answer    |
| `@bot-clarence hold` · `@bot-clarence unhold`             | Never merge this pull request / undo that                         |
| `@bot-clarence help`                                      | Every command and the card checkbox it matches                    |

Clarence answers a command with a reaction, and the reason goes on the card's timeline: 👀 queued, in progress · 👍 done · 🚀 merged · 👎 refused, or cancelled by you · 😕 failed or not understood. Only `status`, `explain` and `help` reply with a comment.

After an unhealthy deploy, fix it, `@bot-clarence merge` or close the revert, then remove `state/unhealthy` from the original pull request.

## coredev-uk/nixos

Paul's Nix flake has no Renovate: its updates are one pull request per flake input (`flake-update/<input>`), opened as `bot-cecil[bot]` by that repository's `flake-update.yml` in Renovate's shape (its update table, the `<!-- rebase-check -->` box, the `stop-updating` label). Renovate's own Nix manager can't do this: it updates only inputs pinned to a revision, or every input at once. Its controller, `clarence-nixos` (policy `policy-nixos.json`, one replica, no Kubernetes access), rules on them like any other, with these differences:

- Only `flake.lock` is a `merge` scope; every other file is `shadow`. Each update is a `digest`, so Jev is not asked. The policy's `flakeLock` makes Clarence read the lock at the head and the merge base, check that the update table names exactly the inputs it moves, and hold each input until its locked commit (`lastModified`) is old enough: 48 hours for `nixpkgs` and `unstable`, none for Paul's own repositories (`ade`, `macos-wallpapers`, `sona`), 72 hours for the rest (`releaseAge`, matched by input name). A young one is pinned with `stop-updating`, which the update workflow honours, so a branch that moves daily settles and merges.
- It merges once `evaluate`, `flake-checker`, `atlas`, `poseidon` and `hermes` pass on the pull request, one at a time (`verify.maxInFlight: 1`), and counts the merge only when the same five pass on `main` (`verify.timeoutMinutes: 360`; the Hosts job's own limit is 300), so `main` still builds before the next merge. If it doesn't, Clarence reverts and halts merging. Nothing is deployed.
- Its Hosts workflow failures are explained on the pull request (`failureNotes` in `policy-nixos.json`).
- GitHub's webhook deliveries for it arrive at the home-ops controller, which forwards them to `clarence-nixos` (`webhook.peers` in `policy-home-ops.json`).

One-time setup for it, in order:

- Pin a Clarence image that has `flakeLock` and own-repository `failureNotes` (merge the `clarence/pin/clarence` proposal) before this directory's `policy-nixos.json` and the `failureNotes` move out of `policy-home-ops.json` roll out: the older image refuses `flakeLock`, and refuses a `failureNotes` repository that is a webhook peer.
- `bot-cecil` (Contents and Pull requests write, for the octo-sts policy `flake-update`) and `bot-clarence` (the permissions in Clarence's `docs/clarence.md`, Actions write included for the rebase dispatch) are already installed on `coredev-uk/nixos`, for the old flake update and the failure notes; check that, and merge the nixos pull request that adds `.github/chainguard/flake-update.sts.yaml` before its workflow's first run, since octo-sts reads a policy from the default branch.
- The `bot-clarence` App's webhook (`https://clarence.hera.ac/webhook`) already delivers `coredev-uk/nixos` events to the home-ops controller (for the failure notes); the new peer entry makes it forward them. On `coredev-uk/nixos`, `main`'s ruleset requires `evaluate`, `flake-checker`, `atlas`, `poseidon` and `hermes`, and only `bot-clarence` bypasses it. No Renovate secret is needed: the update workflow has no Renovate.
- Close the old all-inputs `flake-update` pull request, if one is open, and delete its branch.
