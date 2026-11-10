# Recover the interrupted Helm candidate

Use this procedure when `upgrade-production-images` submitted its candidate,
Helm reports `pending-upgrade` or `failed`, and initialization completed. It
reapplies that exact candidate through one Helm rollback, then runs the upgrade
command's usual acceptance checks. It does not return to an older application
image or reverse a database migration.

Start from the original checkout and private evidence directory. The original
run must contain an attempt-bound `helm-started` and `helm-attempts/<UUID>/`.
Older evidence without that binding cannot use this procedure. Preserve its
records and follow [manual reconciliation](production-upgrade-recovery.md#resume-an-unfinished-prepared-upgrade).

## Reconcile before recovery

The release owner must confirm all of the following:

- The original helper, Helm client and their children stopped. A pending release
  or disconnected terminal does not prove that they stopped.
- One operator owns the release, the maintenance freeze still applies, and no
  other client will submit Helm changes. Nobody replayed this attempt's effective
  values or recreated its hook objects.
- Partial resource changes have been inspected. Reconcile missing, replaced or
  unexpectedly changed objects before proceeding. Keep the original Installation
  and API/worker Deployments.
- The candidate's [migration history check](production-upgrade-recovery.md#resume-an-unfinished-prepared-upgrade)
  succeeded against the retained database with `history: completed`. Keep that
  result in private evidence. Do not infer database completion from Helm status.

Repeat the original upgrade command and arguments with these additional flags:

```bash
--resume --recover-helm --migration-history-checked --recovery-reviewed
```

`--migration-history-checked` attests to the database check;
`--recovery-reviewed` attests to the stopped clients, exclusive ownership and
resource reconciliation above. The command cannot independently prove these
operator actions. Do not pass the flags when any outcome is uncertain.

## What the command checks

The candidate's exact revision, stored values, ordinary manifests and hook set
must match its original attempt. The command verifies the attempt UUID on the
live hooks, initializer Job and its successful owned Pod. It compares the Job
and Pod specifications, including images and commands, with the candidate.
Missing, deleting, failed or mismatched objects stop recovery. Added commands,
inputs, mounts, probes or lifecycle handlers also stop recovery. Pod and container
security settings must match exactly; absent or null settings match an empty
context. Admission rewrites refuse recovery, even copying an inherited setting
to a container without changing its effect. Declared CPU and memory
requests and limits compare by value, so `1.5Gi` and `1536Mi` are equivalent.
These checks allow API defaults on otherwise unspecified fields; they do not
prove that no admission mutation occurred.

The command reads each resource in its declared namespace (defaulting to the
release namespace), then checks Helm ownership against the original release.
It preserves the original Installation and API/worker identities. It records the observed resource UIDs
and versions, then reads them again before submitting recovery. These are
recovery-time observations, not proof that every object retained its original
UID throughout the interruption. The attempt UUID does not detect a privileged
actor copying the same values and annotations; exclusive ownership remains
required.

An [immutable Installation reference switch](immutable-installation-upgrade.md)
also rechecks both retained Secrets against their prepared UIDs and full data.
Recovery keeps the candidate reference; it does not return to the original Secret.

Resources present only in the recorded predecessor must be absent, including
resources marked `helm.sh/resource-policy: keep`. For example, clearing
`api.channelDirectoryProxyUrl` retires its egress NetworkPolicy and API container
environment entry. Recovery refuses while either remains. Reconcile removals
explicitly while writers are stopped; the recovery command does not delete them.
It checks absence before recording recovery, immediately before rollback, after
rollback and on resume. Read failures do not count as absence.

Retired regular/init container placements and environment entries in retained
containers must be absent before rollback. Changed entries that remain may still have their old values:
Helm can update those. After rollback and on resume, all changed environment
selections must match the candidate. These checks cover whole-resource and
environment or container-placement removals; they do not implement arbitrary
future chart merge rules.
Review other structural chart changes during resource reconciliation.

Changed ordinary resource specs outside the chart's native groups (`v1`, `apps`,
`batch`, `networking.k8s.io` and `rbac.authorization.k8s.io`) must already match
the candidate exactly at all four boundaries. This includes EnvoyProxy placement.
Additional admission defaults also refuse recovery: this path does not normalize
custom-resource schemas. Reconcile through the resource owner or use manual
recovery when exact matching is unavailable.

Only one initializer Job and its ServiceAccount/NetworkPolicy companions are
supported, with pre-install/pre-upgrade events. Post-upgrade or rollback hooks
refuse this recovery path. The command uses stock Helm rollback against the
interrupted candidate revision, without disabling hooks. It creates exactly one
successor revision and does not rerun the initialization hook or migration.

Helm can retain a hook's `Running` status after the actual Job completed, including
in a later rollback revision. Recovery therefore checks the bound Job and Pod,
not only Helm's hook status.

## Keep the recovery records

`helm-attempts/<UUID>/` retains each submission's effective values, render and
intent and observed predecessor. A normal authorized retry gets a new UUID.
If Helm never accepts that retry, resume admits its exact recorded predecessor
at the recorded revision. Staging another attempt does not replace the published
`helm-started` intent. An interrupted first publication can finish only from
identical staged evidence. Do not edit these files or replay values manually.

If interruption leaves staged values in the protected local file before intent
publication, resume refuses them. Reconcile that file with the published
`helm-started` attempt; staging alone does not authorize a new submission.

`helm-recovery/` retains the original release, recovery intent, command output,
result and acknowledged successor. If rollback returns successfully but a later
acceptance check fails, ordinary `--resume` verifies that acknowledged revision
and all recorded resource UIDs, refusing missing, replaced or deleting objects.
Resource-version changes from normal reconciliation are allowed. Acceptance
then continues without submitting Helm again.

An interrupted or failed rollback without acknowledgement is not automatically
replayed, even if a later revision looks healthy. Preserve the evidence and
reconcile with the release owner. Do not remove the recovery directory to retry.
Complete the [remaining verification](production-upgrade.md) separately when the
command cannot safely resume.
