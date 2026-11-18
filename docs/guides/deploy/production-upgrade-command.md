# Run production image upgrades with the CLI

Run from the reviewed release checkout root so relative paths keep their meaning.
Use `occ installation upgrade` to reuse the
same target, image selection, and rendered installation files across planning,
preflight, upgrade, and recovery. Complete the [production upgrade prerequisites](production-upgrade.md#prepare-the-release)
first. The CLI uses the private profile adapter for `scripts/upgrade-production-images`; it keeps that
command's authorization, compatibility, locking, evidence, and recovery checks.
It upgrades selected images; the canonical command still refuses protected settings changes.

Create an owner-only JSON file outside the checkout. `installationDirectory`
points to the protected directory containing the current `values.yaml` and
`installation.yaml`, such as the output from the [installation profile renderer](installation-profiles.md#render-files).
Relative file paths resolve from the operator profile's directory.

```bash
umask 077
cat > /secure/occ/upgrade.json <<'JSON'
{
  "kubeconfig": "kubeconfig",
  "context": "reviewed-production-context",
  "namespace": "openclaw-system",
  "release": "oce",
  "installationDirectory": "rendered",
  "sourceRevision": "<full-reviewed-40-character-git-sha>",
  "occ": "bin/occ",
  "images": {
    "controller": "registry.example/controller@sha256:<64-lowercase-hex>"
  }
}
JSON
```

Select one or more `controller`, `broker`, or `runtime` images. Keep credentials
out of the profile. Set `OCC_URL`, `OCC_SERVICE_KEY_FILE`, and, if needed,
`OCC_CA_BUNDLE` as described in the [upgrade guide](production-upgrade.md#prepare-the-release).
The optional `occ` field names the matching CLI file; omit it to use `occ` on
`PATH`.

Review the offline plan. It validates the private profile and shows the selected target, source, rendered directory, and image components without contacting the cluster or writing state.

```bash
occ installation upgrade plan --profile /secure/occ/upgrade.json
```

Before the first preflight, [bind the Installation Secret](production-upgrade.md#bind-the-installation-once)
so it carries the required Installation ID annotation.

```bash
occ installation upgrade preflight --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/preflight-1
```

The canonical `--preflight-only` flag maps to the `preflight` operation. Change
the operation, remove only `--preflight-only`, and retain every other original
expert option after `--` so preflight checks the same candidate. When preflight
tells you to omit that flag to deploy, use `upgrade` with fresh evidence and the
same expert options.

Continue only after preflight succeeds and confirms cleanup. Compare the candidate
manifests and enter the maintenance window. Freeze Helm changes and scaling
automation, stop independent database writers, and settle Agent deployments as
required by the [maintenance handoff](production-upgrade.md#rehearse-before-the-maintenance-window).
Keep reviewed optional arguments, such as candidate-file flags, identical for the upgrade.

```bash
occ installation upgrade --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/upgrade-1
```

Use fresh evidence directories for preflight and upgrade. After an interruption, inspect the original private evidence without contacting the cluster:

```bash
occ installation upgrade status --evidence-dir /secure/occ/upgrade-1
```

Status reports local markers only. A Helm intent marker does not prove Helm completed; a lock marker does not prove a process is running. Reconcile the original operation and preserve its evidence and dispatch journal before using the same profile, checkout, and upgrade evidence directory:

```bash
occ installation upgrade resume --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/upgrade-1
```

If the original upgrade used expert options after `--`, repeat all of them unchanged
on resume. When translating a canonical `--resume` instruction, change the operation
to `resume`, remove only `--resume`, and retain every other option and applicable
recovery attestation. If the command requests `--migration-history-checked`, finish
its migration-history check first. The example below assumes the original upgrade
had no expert options; otherwise include them after `--` before the attestation:

```bash
occ installation upgrade resume --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/upgrade-1 -- --migration-history-checked
```

For interrupted preflight cleanup, follow the [cleanup procedure](production-preflight-cleanup.md)
and supply its attestations explicitly:

```bash
occ installation upgrade cleanup-preflight --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/preflight-1 -- --previous-process-settled --evidence-unrestored
```

Pass other canonical options after `--`, for example `-- --timeout-seconds 1200`.
Those options cannot replace the profile's target, source, image selection, or
operation. For an unprofiled invocation or all supported options, run
`scripts/upgrade-production-images --help`. A successful preflight does not
authorize a resume or prove a live workload works; complete the [release verification](production-upgrade.md#verify-the-release).

Protected Installation configuration is a separate [chart-owned operation](production-upgrade.md#apply-other-installation-changes). `occ installation upgrade config apply` and `config rollback` direct you there and exit without writes. A failed Helm operation can leave an earlier Secret change in effect; inspect recorded effects and use the chart operation to restore the original configuration. Before returning to an earlier controller, check compatibility with committed database and authentication state. Use [stopped authentication maintenance](auth-maintenance.md) for authentication changes.
