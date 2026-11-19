# Run production image upgrades with the CLI

Use `plan` to review the target and `apply` to deploy selected images. Run both
from the reviewed release checkout root after completing the
[production upgrade prerequisites](production-upgrade.md#prepare-the-release).
Use the [chart procedure](production-upgrade.md#apply-other-installation-changes)
for protected Installation settings.

Create an owner-only JSON profile outside the checkout. Set
`installationDirectory` to the protected directory that contains `values.yaml`
and `installation.yaml` from the
[installation profile renderer](installation-profiles.md#render-files).
Relative paths inside the profile resolve from the profile's directory.
Relative expert paths resolve from the release checkout.

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

Select one or more `controller`, `broker`, or `runtime` images by digest. Keep
credentials outside the profile. For image upgrades, set `OCC_URL`,
`OCC_SERVICE_KEY_FILE`, and, if needed, `OCC_CA_BUNDLE` as described in the
[upgrade guide](production-upgrade.md#prepare-the-release). The optional `occ`
field selects the matching CLI file. Omit it to use `occ` on `PATH`.

## Run the image upgrade

Review the selected kubeconfig, context, release, and image digests:

```bash
occ installation upgrade plan --profile /secure/occ/upgrade.json
```

The offline preview checks the profile, local inputs, image digests, and
checkout commit. It reads the kubeconfig without showing its contents or digest.
When you select candidate files or other expert options, pass the same options
after `--` to `plan` and `apply`. Review the deployment effects and image digests
before you approve. The preview reads local inputs. Current cluster state and
migration history remain unknown until the upgrade checks the cluster.

Before the first `apply` or `preflight`,
[bind the Installation Secret](production-upgrade.md#bind-the-installation-once).
For an optional advance rehearsal, run:

```bash
occ installation upgrade preflight --profile /secure/occ/upgrade.json
```

Preflight checks the candidate with temporary cluster resources and leaves the
writers running. Use the same reviewed inputs and expert options for `apply`.

When the [maintenance handoff](production-upgrade.md#rehearse-before-the-maintenance-window)
is complete, run:

```bash
occ installation upgrade apply --profile /secure/occ/upgrade.json
```

`apply` reads the current profile and displays its plan again. When input and
output are attached to a terminal, type `yes` to approve the upgrade. For
automation or redirected output, pass `--auto-approve`. The upgrade checks
startup and migration compatibility and confirms preflight cleanup before it
stops writers.
Apply and resume use a private copy of the approved kubeconfig for cluster access.
The copy keeps relative credential and certificate references tied to their original location.

For each fresh `apply`, `preflight`, or `migration check`, the CLI prints
`Evidence: PATH` and an `Inspect:` command before starting the operation.
By default the CLI reserves a private directory beside the profile.
The profile directory must be outside the checkout, belong to the current
user, and allow writes only by that user. To choose a location, pass a fresh
`--evidence-dir` under an existing writable directory you own outside the
checkout. Keep the evidence and any sibling dispatch journal at their original
paths. After completion, [verify the release](production-upgrade.md#verify-the-release).

### Continue after a separate database migration

If `apply` reports a separate database migration pause and exits with status
**3**, the API and worker are stopped. Helm submission waits for verified
migration history. Keep the maintenance window active, other writers and
autoscalers fenced, and the original evidence in place.

[Deploy and verify the database](separate-database-upgrade.md#deploy-the-database)
with the selected controller image and the dedicated migrator credential.
Require a successful `--require-current` check that reports `migration.checked`
with history `completed`. After the Jobs and their Pods are gone, use
[the original run to resume](#recover-an-interrupted-run). Repeat the original
expert options after `--` and add `--migration-history-checked`.

## Check database migration compatibility

Use the profile's controller digest to check the installed database against
reviewed Helm values, including values for a chart-owned configuration change.

```bash
occ installation upgrade migration check \
  --profile /secure/occ/upgrade.json \
  -- --candidate-values /secure/occ/candidate-values.yaml
```

Omit `--candidate-values` to render the profile's `values.yaml`. The command
reads the deployed Helm revision, creates and deletes one migration Job, and
reads its Pod and logs using Kubernetes access. It needs no OCC service key or
`installation.yaml`. The candidate must preserve the deployed initializer's
migrator Secret reference, mounted CA, and connection settings.

Hold Helm and database credential changes while the check runs.
`Migration check passed` reports the recognized history after the Job and Pod
are gone. To apply SQL during maintenance, follow the
[separate migration procedure](separate-database-upgrade.md). If the Job create
outcome is unknown, preserve the original evidence and reconcile the create
before starting another check. Use the [preflight cleanup procedure](production-preflight-cleanup.md)
for recorded resources.

## Recover an interrupted run

Run the printed `Inspect:` command or substitute the path from `Evidence:`
to inspect the recorded state without contacting the cluster:

```bash
occ installation upgrade status /path/to/original/evidence
```

Treat the outcome as unknown if `status` reports missing evidence or an
unresolved Helm intent. A lock marker can outlive its process. Check the
original process and reconcile its submitted requests before another write.
Resume requires the original upgrade evidence. Use the same checkout, profile,
and evidence path:

```bash
occ installation upgrade resume /path/to/original/evidence --profile /secure/occ/upgrade.json
```

Resume asks for `yes` at a terminal. In automation, pass `--auto-approve`.
Append the original expert options and required attestations after `--`.
If the native diagnostic suggests `--resume`, use the `resume` subcommand.
Complete the required checks before passing `--recover-helm`,
`--recovery-reviewed`, or `--migration-history-checked` after `--`.
`apply` refuses those options before prompting or creating evidence.

Follow the [preflight cleanup procedure](production-preflight-cleanup.md) to
clean up resources from an interrupted preflight:

```bash
occ installation upgrade cleanup-preflight /path/to/original/evidence \
  --profile /secure/occ/upgrade.json \
  -- --previous-process-settled --evidence-unrestored
```

Pass expert options after `--`, such as `-- --timeout-seconds 1200`. These
options cannot override the profile's target, source, or image selection or
change the selected operation. Run `scripts/upgrade-production-images --help`
for the native script's options.

Protected Installation configuration uses the
[chart operation](production-upgrade.md#apply-other-installation-changes).
`occ installation upgrade config apply` and `config rollback` direct you to
that procedure. A failed Helm operation can leave an earlier Secret change in
effect. Inspect the recorded effects before recovery, and check committed
database and authentication state before returning to an earlier controller.
Follow [stopped authentication maintenance](auth-maintenance.md) for
authentication changes.
