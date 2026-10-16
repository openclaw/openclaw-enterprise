# Codex OAuth credential storage

This page covers the private `codex-home` subpath of the dedicated Harness claim
described in [Harness storage](storage-and-credentials.md#harness-storage) for
the [Kubernetes Compute Driver](../kubernetes-compute.md).

## Enable device login

The bundled Kubernetes Compute Driver supports **Experimental** Codex device
login. Follow the
[personal login procedure](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)
to sign in and deploy on a supported topology within the
[launch limits](#oauth-launch-limits).

## Private credential directory

OAuth's private `codex-home` directory is excluded from workspace serving and
Sandbox mounts. Only the seed writer and the dedicated Codex workload mount it,
and the Codex workload mounts it as its whole `~/.codex`: the native `auth.json`
with rotated refresh tokens, plus Codex sessions, history, logs, and generated
configuration, all persist across revisions. The seed writer mounts only the
`codex-home` subpath. Before it starts, an init container that receives no
credential creates that directory as uid 1000 with mode `0700`; it replaces any
link or file at that path. The Gateway receives no model credential.

The bundle moves one way and exists in these places:

| Stage        | Object                                           | Who can read it                                                                                                                               | Erased when                                                                                       |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Staged login | Session Secret in the control plane              | Holders of `secret:operate` on that Secret, including through `secretBindings` projection                                                     | Cancelled, touched after expiry, or consumed by the first deployment                              |
| Handoff      | Immutable seed Secret in the execution namespace | Kubernetes principals allowed to `get` Secrets there                                                                                          | After the source is consumed, or revision cleanup                                                 |
| Handoff      | Seed writer pod                                  | No network, because its template has no `openclaw.dev/network-profile` label and the namespace default-deny applies; no service-account token | Deleted with its Job                                                                              |
| Runtime      | `codex-home/auth.json` on the Agent claim        | The dedicated Codex workload, which refreshes it                                                                                              | A non-OAuth revision starts, or the claim is deleted (subject to the StorageClass reclaim policy) |

**Launch scope:** persistent runtime-owned credentials deliberately replace the
planned token broker for P0. Brokerage is separate work in progress. After the
initial handoff, OCC retains a consumed source marker and never restores the
original token pair. Restarts and revisions reopen the current disk bundle.
Loss of the claim or credential file requires a new login and explicit deployment.
This version has no broker-based backup, recovery, or shared refresh ownership.

## Bounded bootstrap Job

The seed writer runs in one revision-scoped Kubernetes Job, with one completion,
parallelism one, `restartPolicy: Never`, `backoffLimit: 2`, and a five-minute
`activeDeadlineSeconds`. Kubernetes may retry failed Pods twice; the deadline
also bounds time spent waiting for scheduling or storage. Compute creates the
Job once and observes its existing conditions on later passes. It does not patch
or recreate a failed Job to reset either budget.
Reobservation accepts equivalent API-canonicalized resource quantities while
rejecting changed limits or requests. Before admitting a Job, Compute retires
any exact owned bootstrap Deployment, re-reading it when a delete conflicts, and
waits for its writer Pods to disappear.
The seed and private claim survive this cutover.

The writer locks the private directory while it validates or installs the bundle
and receipt, then exits. Kernel-owned locking serializes duplicate executions
and releases the lock on process exit. A successful Job means the writer verified
both files; it does not prove provider authentication or a model turn.

After `Complete`, Compute consumes the source and removes the seed Secret first,
retrying transient errors, so a later Job or Pod cleanup failure cannot leave the
token bundle behind. It then deletes the Job with foreground propagation and
waits for its exact Pods to disappear.
Only then does it start Codex. Cleanup interrupted after consumption resumes
from the consumed marker without copying the original tokens again.

A `Failed` condition makes the OCC deployment terminal:
`HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT` for `DeadlineExceeded`, otherwise
`HARNESS_CREDENTIAL_BOOTSTRAP_FAILED`. OCC commits failure and a durable
revision-retirement obligation together. Cleanup retries across worker restarts,
removes the Job, Pods, and seed, and preserves the Agent's claim. No TTL controller
owns cleanup. The failed deployment remains failed; correcting the cause and
explicitly deploying creates a new revision and Job. The source stays claimed,
not consumed, when the Job fails.

While the Job runs, deployment progress reports
`HARNESS_CREDENTIAL_BOOTSTRAP_PENDING`. If the convergence deadline passes on a
pass that observes the running Job, the deployment fails with
`CONVERGENCE_DEADLINE_EXCEEDED` and commits the same retirement obligation, so
the seed does not outlive its revision. If that last pass instead hits a
transient dependency failure such as `KUBERNETES_API_UNAVAILABLE`, the
deployment fails with that code. It still commits the retirement when the
latest readiness code its deployment work recorded was
`HARNESS_CREDENTIAL_BOOTSTRAP_PENDING` and the revision is not the Agent's
active revision.

The tenant worker roles in both Helm charts grant only `get`, `create`, and
`delete` for `batch/jobs`; API identities receive no Job permissions.

## OAuth launch limits

Codex OAuth login is **Experimental**. The launch MVP targets a new Agent's first
deployment with fresh private credential storage. The following limitations are
recorded for follow-up:

- OAuth requires Compute-owned dedicated Codex without a selected Sandbox Driver.
  Admission rejects other topologies before any running workload stops.
- Binding a new login to an Agent with existing storage empties `codex-home`
  before seeding, so previous sessions and history are removed. The seed writer
  creates files exclusively, never follows links, and exits successfully only after
  it re-reads a valid bundle and receipt.
- A revision that does not use OAuth removes `codex-home`. Returning to OAuth
  needs a new login.
- Broker-backed custody, automatic recovery, and shared refresh remain deferred.
  Existing revision reuse does not provide rollback of credential-file changes.
  The [replacement and recovery behavior](storage-and-credentials.md#harness-storage)
  still applies.

The [credential guide](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)
owns staged-login expiry and manual cleanup.
[Device-login verification](#device-login-verification)
distinguishes existing tests from outstanding live runtime proof.

## Device-login verification

`node --test tests/integration/device-authorization-api.test.mjs` exercises device
login, authenticated discovery, and revision submission through the real HTTP/OCC
workflow. It verifies exact actor and Agent scope, cancellation during an exchange,
and credential redaction using simulated provider transport and a test Secret
Driver. `tests/conformance/harness-device-auth.test.mjs` checks the native protocol
adapter. These cases do not prove live OAuth, token refresh, or runtime deployment.
The bootstrap case in `tests/integration/runtime-image-startup.test.mjs` executes
the actual script on local disk and simulates a rotated bundle. Kubernetes
conformance substitutes API observations; neither proves native refresh.
[Kubernetes fixture verification](../../../testing/kubernetes.md#kubernetes-http-fixture)
also covers real Job completion and exhaustion through the API and PostgreSQL
worker with synthetic credentials, not live provider acceptance.

Live first-deploy proof remains outstanding: complete device login, search and
select plugins, deploy a new Agent on the supported topology, and verify a real
Codex model turn. Follow-up proof must cover native token refresh, restart and
revision reuse, reconnect, and another discovery login while the deployed Agent
continues operating. The launch scope and deferred fixes are listed in
[OAuth launch limits](#oauth-launch-limits).
