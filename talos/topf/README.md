# Topf Experiment

This is a parallel Topf configuration for the existing Talos cluster. It does not replace the current `talos/*.j2` flow yet.

## Current Assessment

Topf is usable enough to prototype against this repo, but it is still early-stage. The upstream docs explicitly warn that APIs, config format, and CLI flags may change between releases. It also does not handle Kubernetes upgrades; keep using the existing `just talos upgrade-k8s` flow for that.

The main fit for this setup is Topf's lifecycle orchestration around Talos apply, bootstrap, reset, render, config generation, and Talos upgrades. The config model also maps cleanly onto the current common, control-plane, and per-node Talos patches.

## VALS Notes

Topf evaluates VALS references in non-template YAML files after optional SOPS decryption. Template files ending in `.tpl` are rendered with Go templates and skip VALS evaluation, so secret references should stay in plain `.yaml` files.

This experiment stores the existing Talos secrets as VALS references in `secrets.yaml` so Topf should reuse the current cluster identity instead of generating a new `secrets.yaml`.

Rendering currently requires a working 1Password/VALS environment because `secrets.yaml` resolves `ref+op://...` references. The local ignored `.secrets.env` can provide `OP_SERVICE_ACCOUNT_TOKEN` for this.

## Commands

```bash
topf --topfconfig talos/topf/topf.yaml render --output talos/topf/output
topf --topfconfig talos/topf/topf.yaml apply --dry-run
topf --topfconfig talos/topf/topf.yaml talosconfig
topf --topfconfig talos/topf/topf.yaml kubeconfig
topf --topfconfig talos/topf/topf.yaml upgrade --dry-run
```

Convenience recipes are also available as `just talos topf-*` once the local `just` supports the repo's `set default-script` syntax.
