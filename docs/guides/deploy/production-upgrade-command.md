# Run production image upgrades with a private profile

Use `scripts/upgrade-production` from the reviewed release checkout to reuse the
same target, image selection, and rendered installation files across preflight,
upgrade, and recovery. Complete the [production upgrade prerequisites](production-upgrade.md#prepare-the-release)
first. This command runs `scripts/upgrade-production-images`; it keeps that
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

Before the first preflight, [bind the Installation Secret](production-upgrade.md#bind-the-installation-once)
so it carries the required Installation ID annotation.

```bash
scripts/upgrade-production preflight --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/preflight-1
```

The canonical `--preflight-only` flag maps to the `preflight` operation. When
preflight tells you to omit that flag to deploy, use `upgrade` with fresh evidence.

Continue only after preflight succeeds and confirms cleanup. Compare the candidate
manifests and enter the maintenance window. Freeze Helm changes and scaling
automation, stop independent database writers, and settle Agent deployments as
required by the [maintenance handoff](production-upgrade.md#rehearse-before-the-maintenance-window).
Keep reviewed optional arguments, such as candidate-file flags, identical for the upgrade.

```bash
scripts/upgrade-production upgrade --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/upgrade-1
```

Use fresh evidence directories for preflight and upgrade. After an interruption,
reconcile the original operation and preserve its evidence and dispatch journal
before using the same profile, checkout, and upgrade evidence directory:

```bash
scripts/upgrade-production resume --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/upgrade-1
```

If the original upgrade used expert options after `--`, repeat all of them unchanged
on resume. When translating a canonical `--resume` instruction, change the operation
to `resume`, remove only `--resume`, and retain every other option and applicable
recovery attestation. If the command requests `--migration-history-checked`, finish
its migration-history check first. The example below assumes the original upgrade
had no expert options; otherwise include them after `--` before the attestation:

```bash
scripts/upgrade-production resume --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/upgrade-1 -- --migration-history-checked
```

For interrupted preflight cleanup, follow the [cleanup procedure](production-preflight-cleanup.md)
and supply its attestations explicitly:

```bash
scripts/upgrade-production cleanup-preflight --profile /secure/occ/upgrade.json --evidence-dir /secure/occ/preflight-1 -- --previous-process-settled --evidence-unrestored
```

Pass other canonical options after `--`, for example `-- --timeout-seconds 1200`.
Those options cannot replace the profile's target, source, image selection, or
operation. For an unprofiled invocation or all supported options, run
`scripts/upgrade-production-images --help`. A successful preflight does not
authorize a resume or prove a live workload works; complete the [release verification](production-upgrade.md#verify-the-release).
