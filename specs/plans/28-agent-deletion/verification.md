# Agent deletion and revision teardown: verification

[Implementation plan](index.md). Original record; decisions and status are preserved.

- Conformance: delete an Agent with no revisions, with an admitted but undeployed
  revision, and with a deployed active revision. Assert `202`, the audit events,
  repeat deletion while work is nonterminal, and denial without `delete` permission.
- Credentials and k3d: assert zero-revision credential deletion; directly delete
  running embedded and dedicated Agents with an immutable runtime image. Assert
  finalization waits for exact Pods, and credential Secrets,
  PVCs, Services, ServiceAccounts, revision ConfigMaps, and Agent NetworkPolicies
  are gone while sibling resources survive. Assert idempotent absence and
  fail-closed unsupported Drivers.
- Race: attempt update, deploy, credential provisioning, and a workspace write
  against a `deleting` Agent and assert each is rejected; assert no revision can
  be admitted after teardown enumerates revisions.
- Retry: fail `retireRevision` once, then assert the retry completes and the rows
  are gone; restart the worker with a fresh SSH Driver and prove binding precedes
  retirement.
- Isolation: assert a sibling Agent, its revisions, and its ServicePrincipal
  survive, and that the Namespace's Configurations and Secrets are untouched.
- Privilege and immutability: assert `occ_app` cannot delete an Agent, revision,
  or identity directly, that revision `UPDATE` is still rejected after the
  trigger change, and that `EXECUTE` on the function is denied to `PUBLIC`.
- Finalization: assert an expired or stolen lease deletes nothing, and that
  success evidence is recorded even though the work row is removed.
- Orphan checks: assert no `iam_access_bindings` or `iam_restrictions` rows
  reference the deleted Agent or its revisions, and no `occ.apikey` row
  references its ServicePrincipal.
- Namespace: delete the last Agent and its Configurations, then assert
  `deleteNamespace` reaches the tombstone through the lifecycle trigger.
- PostgreSQL integration per [database setup](../../../docs/testing/postgresql.md),
  migrating with the migrator role and running as the limited application role, to
  prove the privilege model is sufficient.
- Real-runtime Kubernetes teardown per
  [cluster setup](../../../docs/testing/kubernetes.md), asserting the workload, gateway,
  route, and claims are gone while operator-owned Namespace resources remain.
