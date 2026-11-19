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
Relative file paths resolve from the profile's directory.

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

The offline preview checks the profile, digest format, and checkout commit.
It writes no files and makes no cluster calls. Apply checks rendered files,
credentials, and cluster access when it runs.

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
automation or redirected output, pass `--auto-approve`. Review any expert
options after `--`, including overrides of the rendered baseline. The upgrade
checks startup and migration compatibility and confirms preflight cleanup
before it stops writers.

For each fresh `apply`, `preflight`, or `migration check`, the CLI prints
`Evidence: PATH` and an `Inspect:` command before starting the operation.
`apply` also prints a command to resume an interrupted upgrade.
It reserves a new private directory beside the profile by default. The
profile directory must be outside the checkout, belong to the current user,
and allow writes only by that user. Set a fresh `--evidence-dir` to choose
another location for a new run. Keep the evidence and any sibling dispatch
journal at their original paths. After completion,
[verify the release](production-upgrade.md#verify-the-release).

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

A Helm intent marker can record an attempt with an unknown outcome. A lock
marker alone does not establish whether a process is running. Reconcile the
original operation and any submitted requests before using the printed resume
command. Use the same checkout, profile, and evidence path:

```bash
occ installation upgrade resume /path/to/original/evidence --profile /secure/occ/upgrade.json
```

Resume asks for `yes` at a terminal. In automation, pass `--auto-approve`.
Both approvals require the original evidence and any applicable attestations.
Append the original expert options and required attestations after `--`. If the native diagnostic suggests `--resume`, use the `resume` subcommand.
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
