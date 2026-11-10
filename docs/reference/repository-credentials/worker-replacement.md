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

No current bundled owner returns `reverification-supported`. The generic contract
permits that result only when an owner can establish the evidence described above;
accepting the value in the API or upgrade helper does not establish implementation
support.

This read does not issue credentials, adopt execution, advance fences or change
`repositoryAccess.state`. A positive result is not a promise of uninterrupted
Git access or credential renewal. Profile names and successful Git requests do
not establish restart support. OpenShell reports `original-worker-required` for
supported held launches and observed-hook previews when their admitted mode and
execution evidence match. Unsupported legacy installation-wide routes return
`unknown`; historical recovery does not establish current support.

The inventory keeps its existing authorization checks: Installation `administer`,
Namespace and Agent `read`, plus Agent `deploy` and revision `read` for eligible
running Agents. OCC reads owners outside the State transaction with one ten-second
observation budget, then reauthorizes and compares the complete fleet and selected
Drivers. A changed inventory refuses the read. The
[upgrade helper](../../guides/deploy/production-upgrade.md#prepare-the-release) rechecks
before stopping writers; operators must still exclude concurrent deployment.

An unreadable saved revision snapshot yields `unknown` for that Agent; the
inventory retains its active revision ID and the rest of the authorized fleet.
Database and identity failures still fail the read. This does not make the
snapshot executable: deployment reads and the upgrade helper's saved-Harness
validation remain strict.

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

Supported OpenShell standing routes also need matching durable installation and
route evidence. The saved execution fingerprint must match the route's observed
execution identity. A recognized finite held launch requires its original worker;
it does not need standing-route evidence.
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

For the first upgrade from a controller that returns inventory without this
assessment, even a revision without repository access cannot establish
`not-applicable`. Stop and settle retained running Agents before preparation, or
use the authorized runtime replacement workflow. A complete inventory with no
retained running revisions needs no assessment. The helper never infers an empty
fleet or bypasses this check to upgrade the controller first.
