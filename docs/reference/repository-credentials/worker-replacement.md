# Repository access across worker replacement

`occ installation deployment-inventory` reports an optional
`repositoryWorkerRestart` for each assessed active revision. Its selected Compute
and Sandbox owners read the saved revision and existing execution evidence:

| Disposition                | Meaning                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `original-worker-required` | The identified repository execution depends on its original worker's launch witness.                                                                  |
| `reverification-supported` | The owner recognizes durable evidence and supports verification after replacement. The replacement must still verify the actual execution and fences. |
| `not-applicable`           | The revision has no repository access, or its identified delivery owner establishes that this worker dependency does not apply.                       |
| `unknown`                  | Evidence is missing, inconsistent or unsupported, or observation fails.                                                                               |

This read does not issue credentials, adopt execution, advance fences or change
`repositoryAccess.state`. A positive result is not a promise of uninterrupted
Git access or credential renewal. Profile names and successful Git requests do
not establish restart support. OpenShell classifies the admitted mode and exact
execution evidence; held launches and observed-hook previews require the original
worker when identified.

The inventory keeps its existing authorization checks: Installation `administer`,
Namespace and Agent `read`, plus Agent `deploy` and revision `read` for eligible
running Agents. OCC reads owners outside the State transaction with one ten-second
observation budget, then reauthorizes and compares the complete fleet and selected
Drivers. A changed inventory refuses the read. The
[upgrade helper](../../guides/deploy/production-upgrade.md#prepare-the-release) rechecks
before stopping writers; operators must still exclude concurrent deployment.

The optional `ComputeDriver.repositoryWorkerRestartDisposition(revision, signal)`
operation receives the immutable revision. Kubernetes Compute delegates to
`SandboxRepositoryAccess.repositoryWorkerRestartDisposition(context)`, passing
the revision, owned Namespace and cancellation signal. Both operations return
one disposition without exposing owner IDs, fingerprints or provider data.

Kubernetes Compute verifies Namespace ownership through a read-only Kubernetes
request before calling its Sandbox owner or reporting `not-applicable`. The
assessment makes no repository or Sandbox provider calls. Missing methods or a
mismatched Driver selection produce `unknown`. Kubernetes reports `not-applicable`
only when repository credentials and the egress plan's `repositoryGit` and
`repositoryGitAuthorization` are absent. Unsupported delivery modes, including
broker delivery, remain `unknown`.

OpenShell standing routes need matching durable installation and route evidence.
The saved execution fingerprint must match the route's observed execution identity.
A recognized finite held launch can also require its original worker.
The ten-second API budget ignores late results. Cancellation after a queued
connection acquisition starts no SQL; cancellation during a transaction prevents
further reads while permitting rollback and connection cleanup. It does not
physically cancel in-flight PostgreSQL evidence queries, which retain their four-second
statement and one-second lock timeouts.

For controller-only upgrades, the helper accepts only `not-applicable` and
`reverification-supported` for retained running revisions. It refuses other or
omitted values before stopping either writer. Stop and settle affected Agents
under an authorized interruption, or plan normal revision replacement. A missing
endpoint or denied inventory does not establish an empty fleet. Runtime upgrades
keep their explicit replacement and dispatch journal.
