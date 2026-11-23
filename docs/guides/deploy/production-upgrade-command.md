# Run production image upgrades with the CLI

Use `plan` to review the target and `apply` to deploy selected images. Run both
from the reviewed release checkout root after completing the
[production upgrade prerequisites](production-upgrade.md#prepare-the-release).
Use the [chart procedure](production-upgrade.md#apply-other-installation-changes)
for protected Installation settings.

Create an owner-only JSON profile outside the checkout. Set `context` to the
name of a kubeconfig context whose cluster has an HTTPS `server` URL. Keep
the kubeconfig in an owner-only regular file under a directory protected
from other writers. Set `installationDirectory` to the protected directory that contains `values.yaml` and `installation.yaml`
from the [installation profile renderer](installation-profiles.md#render-files).
Relative paths for the kubeconfig, rendered Installation, and CLI resolve from
the profile directory. Relative expert paths resolve from the release checkout.

For a published release, open the approved, successful
[Enterprise Containers run](published-images.md#check-publication-and-source)
for the checkout commit on `main`. In the run's artifacts, select
`container-publication-<run-id>-<attempt>` for the approved attempt. Extract it
into a fresh directory. Confirm that `runId`, `attempt`, and `sourceSha` in
both entries of `publication.json` match the run you selected. The CLI trusts
the receipt you supply.

Save the receipt beside the profile and set `imagePublication` to the filename
alone. You or root must own the directory and regular receipt file. Group and
others must have no write access to either. Modes `0600` and `0644` both work
for the receipt. The CLI requires the controller entry to name
`ghcr.io/openclaw/openclaw-enterprise-controller` and the runtime entry to name
`ghcr.io/openclaw/openclaw-enterprise-runtime`. It checks the SHA-256 format
of both digests, the shared run and attempt, and the source and tag against
`sourceRevision`. Review both images and the Agent redeployment in the plan
before approving `apply`.

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
  "imagePublication": "publication.json"
}
JSON
```

Set `images.broker` to a digest when repository credentials are enabled. Omit it
when they are disabled. With `imagePublication`, do not set `images.controller`
or `images.runtime`. For another registry or package destination, omit
`imagePublication` and set the verified destination digests explicitly in
`images.controller` and `images.runtime`. Without `imagePublication`, you can
select one or more `controller`, `broker`, or `runtime` digests in `images`.
Repository-enabled upgrades require both controller and broker digests. Keep
credentials outside the profile.
For image upgrades, set `OCC_URL`,
`OCC_SERVICE_KEY_FILE`, and, if needed, `OCC_CA_BUNDLE` as described in the
[upgrade guide](production-upgrade.md#prepare-the-release). The optional `occ`
field selects the matching CLI file. Omit it to use `occ` on `PATH`. The documented
build writes `bin/occ` under the release checkout. To use that file from a profile
outside the checkout, set `occ` to its absolute path or copy it into the profile
directory and use the copied file's relative path.

The receipt source, `sourceRevision`, and checkout HEAD must match. An older
matching checkout might not support `imagePublication`. Use that checkout's
documented explicit image selection. Keep the command, chart and selected images
on the same source commit.

## Run the image upgrade

`plan` checks `HELM_DRIVER` offline and requires it to be unset or `secret`.
Apply, preflight, migration check, migration apply, and resume read Helm history
from Kubernetes Secrets in the selected cluster. If your release uses SQL or
ConfigMaps, stop here and keep the existing store. For these commands, unset
`HELM_KUBETOKEN`, `HELM_KUBEASUSER`, and `HELM_KUBEASGROUPS`. Configure
credentials and any required impersonation in the selected kubeconfig so Helm
and kubectl use the same settings.

`status` reads local evidence. Preflight cleanup uses Kubernetes directly.

Review the selected kubeconfig, context, release, and image digests:

```bash
occ installation upgrade plan --profile /secure/occ/upgrade.json
```

The offline preview uses local `kubectl` to decode the kubeconfig. It checks
the profile, local inputs, image digests, and checkout commit. It reports whether
the selected context uses a CA file, an inline CA, or system roots. Profiled
operations warn before dispatch if the context disables server certificate
verification.

Profiled operations refuse an `auth-provider` entry on the selected user.
For live operations, including cleanup, use a token or client certificate
when kubectl preferences are enabled, even if no kuberc file exists. The helper
allows exec credential plugins only when your approved environment already
disables preferences. If the helper refuses active kubectl preferences, follow
your approved upgrade procedure and credential policy.

When you select candidate files or other expert options, pass the same options
after `--` to `plan` and `apply`. Review the deployment effects and image digests
before you approve. Plan, apply, and preflight refuse changes to protected
settings that they can detect in local files. Current cluster state and
migration history remain unknown until the upgrade checks the cluster.

With `--controller-compatibility-results FILE`, `plan` and a new `apply` check
the PostgreSQL report and the selected controller digest before approval.
Live preflight must still match the report to the installed controller.
Qualify [recovery](production-upgrade-recovery.md) separately.

Before the first `apply` or `preflight`,
[bind the Installation Secret](production-upgrade.md#bind-the-installation-once).
For an optional advance rehearsal, run:

```bash
occ installation upgrade preflight --profile /secure/occ/upgrade.json
```

Confirm that preflight checks and cleanup succeeded. Preflight leaves writers
running. If it reports that retained Agent revisions require their original
worker and exits 1, resolve the blocker through the
[maintenance handoff](production-upgrade.md#rehearse-before-the-maintenance-window).
Follow that handoff before applying.

If preparation needs different data in an immutable Installation Secret,
[stage a successor](immutable-installation-upgrade.md) and select it with
`--candidate-values`. If a prepared attempt still needs to write to the
recorded immutable Secret, [keep the maintenance freeze and stop](#stop-when-the-recorded-installation-secret-is-immutable).

If Certificate admission fails, inspect `preflight-certificates.err` in the
attempt's protected evidence. For a webhook timeout, check the cert-manager
webhook Service, its endpoints, and reachability from the Kubernetes API server.

Use fresh evidence and the same reviewed inputs and expert options for `apply`:

```bash
occ installation upgrade apply --profile /secure/occ/upgrade.json
```

`apply` reads the current profile and displays its plan again. When input and
output are attached to a terminal, type `yes` to approve the upgrade. For
automation or redirected output, pass `--auto-approve`. The upgrade checks
startup and migration compatibility and confirms preflight cleanup before it
stops writers.
Profiled commands use a private kubeconfig copy for Kubernetes requests.
Apply, migration apply, and resume recheck the kubeconfig and any explicit CA after approval.
The CLI embeds the checked bytes from a CA file in the copy. Client credential
references and commands use their original locations. Migration apply, resume, and cleanup bind
the recorded kubeconfig and explicit CA bytes. When the context uses system roots,
changes to the host trust store can affect later recovery commands.

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

Use [migration apply](separate-database-upgrade.md#apply-and-verify-the-prepared-migration)
with the original run and profile:

```bash
occ installation upgrade migration apply /path/to/original/evidence \
  --profile /secure/occ/upgrade.json
```

Repeat the original expert options after `--`. Review the original run and
the warning about irreversible SQL. Type `yes` at a terminal or pass
`--auto-approve` before `--`. After verification and Job cleanup,
[resume the original run](#recover-an-interrupted-run) with the same expert
options and `--migration-history-checked`.

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
The Job uses the installed NetworkPolicy; it does not validate candidate egress rules.

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

Status compares two reads of local markers. Run it again if the markers changed
during inspection. For standalone preflight, it reports recorded startup checks
and any original-worker blocker. A startup marker alone leaves the final
preflight outcome unknown. Standalone preflight exits without preparing an
upgrade. Resolve any blocker and use fresh evidence for `apply`.

Treat missing evidence and unresolved Helm intent as uncertain outcomes. A lock
marker can outlive its process. Check the original process and reconcile its
submitted requests before another write. Resume requires the original prepared
upgrade evidence. Use the same checkout, profile, and evidence path:

```bash
occ installation upgrade resume /path/to/original/evidence --profile /secure/occ/upgrade.json
```

For a publication profile, resume and separate migration apply use the pair
recorded in the original run. You can recover if the local publication file
moves or changes.

Resume previews the selected trust mode and the writes that may still occur.
It can write the recorded local `installation.yaml`, replace data in the live
mutable Installation Secret, or switch the Helm release to the recorded
immutable Installation Secret. Treat those effects as possible even when the
local files already match the candidate.

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
that procedure. A failed or interrupted Helm operation can leave an earlier
Installation Secret change in effect. Inspect the recorded effects before
recovery. Before returning to an earlier controller, check its compatibility
with committed database and authentication state.
Follow [stopped authentication maintenance](auth-maintenance.md) for
authentication changes.

### Stop when the recorded Installation Secret is immutable

If a prepared upgrade still needs to write different data to the recorded
Installation Secret and that Secret is now immutable, stop. Resume requires the
original candidate and recorded Secret UID, so replacing the Secret or changing
the candidate cannot resolve the refusal.

Keep the maintenance freeze and preserve the original inputs and evidence.
The API or worker may already be stopped. Have the release owner reconcile
the state of the writers, the Helm release, and the database migration before
choosing a separate recovery.
