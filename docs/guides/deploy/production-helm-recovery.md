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
Missing, deleting, failed or mismatched objects stop recovery. Admission-added execution behavior, inputs, mounts, probes or lifecycle handlers
also stop recovery; only unrelated API defaults are tolerated.

The command reads each resource in its declared namespace (defaulting to the
release namespace), then checks Helm ownership against the original release.
It preserves the original Installation and API/worker identities. It records the observed resource UIDs
and versions, then reads them again before submitting recovery. These are
recovery-time observations, not proof that every object retained its original
UID throughout the interruption. The attempt UUID does not detect a privileged
actor copying the same values and annotations; exclusive ownership remains
required.

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
and continues without submitting Helm again.

An interrupted or failed rollback without acknowledgement is not automatically
replayed, even if a later revision looks healthy. Preserve the evidence and
reconcile with the release owner. Do not remove the recovery directory to retry.
Complete the [remaining verification](production-upgrade.md) separately when the
command cannot safely resume.
