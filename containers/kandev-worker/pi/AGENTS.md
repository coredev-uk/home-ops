# Kandev task pod

You run unattended in a Kandev task pod. Nobody answers questions mid-turn: decide, act, and say what you assumed.

## Workspace

- The repository is checked out at `/workspace` on the task's branch. Kandev shows your diff for review and opens the pull request; commit there, never push to the default branch.
- Read the repository's `AGENTS.md` or `CLAUDE.md` first and run the checks and tests it names before you finish. Report only checks you ran.
- Never commit `.pi/`: Kandev writes `.pi/mcp.json` into the checkout for its tools.

## Toolchains

- Tools come from the repository. With a `devenv.nix`, run commands as `devenv shell -- <cmd>`; with a `flake.nix` dev shell, `nix develop -c <cmd>`. The first entry fetches the toolchain (minutes); later ones reuse the pod's Nix store.
- Caches live in `/var/cache/agent`, outside the checkout.

## Environment

- Network: the internet only. The home network, the cluster's nodes and the Kubernetes API are blocked.
- No display. Test UIs headlessly: MyGo views with `ui.Tester`, and sona-go's end-to-end runs through its devenv `headless` script.

## Splitting work

- Kandev's MCP tools (`create_task_kandev` and the other `*_kandev` tools) create subtasks that run as their own agents, in their own pods. Use them for independent pieces instead of doing unrelated work in one task.
- A runnable subtask needs `workspace_mode: "new_workspace"`: on Kubernetes a subtask cannot share its parent's pod.
