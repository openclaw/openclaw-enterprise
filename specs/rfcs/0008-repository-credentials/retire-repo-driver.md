---
rfc: index.md
status_note: "Proposed for human review."
---

# Retire the public Repo Driver

This amendment to [RFC-0008](index.md) proposes deleting the public
`RepoDriver` contract and the `repo` capability. Today a registered Repo Driver
can change which repositories an Agent can select, veto standing approval, or
add Compute lifecycle hooks. Built-in GitHub repository policy began as an
opt-in in [PR #5135](https://github.com/openclaw/openclaw-enterprise/pull/5135).
It became the default for configured GitHub installations in
[PR #5184](https://github.com/openclaw/openclaw-enterprise/pull/5184).

## Repository policy and delivery

Remove Repo Driver registration and selection, including independent policy
extensions, veto callbacks, and Compute hooks supplied by Repo Drivers. Use the
built-in policy for every Git-enabled GitHub installation. Bind explicit Git
configuration to the existing unique GitHub Backend ID and validate the ID against
the registry. Without a selected repository, Git stays disabled. A stale
`drivers.repo` cannot enable it.

At file intake, accept the legacy `backend[].drivers.repo` only on the selected
GitHub Backend, when `repo` is the sole member of the `drivers` object and its
value matches `repository.id`. Discard the legacy object before validating the
normalized Backend schema, building runtime configuration, or deriving the
protected configuration identity. Canonical files omit the legacy field. Reject
mismatches, malformed shapes, and extra members. Reject retired inputs in
programmatic Backend definitions and runtime registration, including a legacy
Repo Driver registration that uses the built-in policy's ID.

The OpenClaw Control Plane (OCC) and the worker use the bound policy for catalog,
admission, and renewal. Preserve Namespace IAM, exact grant and profile binding,
finite deadlines, and explicit standing consent. For standing access, recheck
current permission and approval at admission and renewal even when the saved
scope is unchanged.
Native broker delivery and protected delivery keep their own senders. Refuse a
protected request if its sender or authority is unavailable. Never fall back to
native delivery.

## Operator cutover

Use one maintenance window in the existing [production upgrade](../../../docs/guides/deploy/production-upgrade.md)
workflow to prepare, apply, and resume the upgrade. A planned interruption is
acceptable. The upgrade succeeds when each affected Agent returns to its
recorded desired state with its retained data and authorized access.

1. **Prepare while the old release serves Agents.** For each affected Agent,
   record its identity, desired running or stopped state, retained workspace and
   conversation, repository binding, standing approval, and whether its runtime
   supports restart or requires replacement. Inventory credential attempts and
   pending provider cleanup, including obligations for deleted revisions.
   Accept the matching legacy file described above. Identify any custom or
   unknown policy, including dynamic vetoes. If the built-in policy cannot
   enforce a required constraint, refuse preparation while the old release
   continues serving under its existing policy. Name the Agent and the
   constraint. The operator can resolve the incompatibility separately, for
   example by explicitly disabling Git for that binding. Preparation leaves
   the binding unchanged. Where equivalence is unproven, require fresh,
   attributable approval under a policy that enforces the required constraints
   before resuming standing access. Refuse any unresolved incompatibility
   before shutdown and report the Agent and the action it requires.
2. **Pause and settle before replacing the old release.** Pause new admissions
   and renewals, then recheck the inventory. For a runtime that requires its
   original worker, stop the runtime and settle its session before replacing
   that worker. Keep the original worker and sender available to settle all
   pending work under its recorded identity. Matching legacy and canonical
   files produce the same protected identity on the new release, but it can
   differ from the old identity even with the same Backend ID and registry.
   New admissions use the new identity. Existing revisions, attempts, receipts,
   and sessions keep their original identity. Recovery with `recoverOnly` cannot
   issue new authority. If any work remains unsettled, abandon the cutover
   before replacing the owner. Report the owner and pending operation, and
   resume the old release under its existing policy when safe. The original
   owner reconciles uncertain provider operations without replaying them.
3. **Apply the upgrade and restore the recorded state.** Keep intentionally
   stopped Agents stopped. Preserve each Agent's identity, durable workspace
   and conversation, repository binding, and still-valid approval. For a
   running Agent that supports restart, restart it and verify access. For a
   runtime stopped with its original worker, use the normal replacement path
   for the same Agent. Open a fresh authorized session when needed. Never
   transfer a live sender session or extend an expired grant.
4. **Verify before reopening general admissions and renewals.** During
   restoration and verification, admit only the recorded Agents that should
   run. Use their normal authorization and renewal paths under current policy.
   Check readiness, retained state, repository access, and renewal. Report
   each Agent as restored, intentionally stopped, or needing recovery. A ready
   Helm release alone cannot establish these outcomes. If a check fails,
   report the Agent, failed stage, and supported resume action.

## Acceptance criteria

- File and programmatic startup accept valid explicit Git configuration. Verify
  that the matching legacy file and the canonical file produce the same runtime
  configuration and protected identity. Reject malformed or mismatched legacy
  fields, extra members, and retired programmatic registration before Driver
  registration or credential effects. Verify that a canonical file without a
  selected repository starts with Git disabled. Refuse a stale legacy field in
  that case before Driver registration or credential effects.
- Exercise catalog, admission, and worker renewal through their normal callers.
  A late denial or withdrawn approval prevents creation of an Agent revision at
  deployment. When either occurs at renewal, the worker creates no attempt, opens
  no sender session, and delivers no credentials.
- Exercise native and protected delivery independently. After a change in
  protected configuration identity, the new configuration refuses a plan saved
  under the old identity without calling the native sender. The original owner
  settles retained work from the identity recorded with it, even if the Agent
  revision is missing. Missing or mismatched ownership leaves settlement
  unresolved.
- Qualify the upgrade from the supported previous release for both native and
  protected delivery. Start with a running Agent that has an existing
  conversation, a known file in its durable workspace, and a standing grant.
  After the upgrade, continue the same conversation on the same Agent, read the
  file, fetch the expected private ref, and exercise renewal under current
  policy. Verify that a disallowed operation still fails and that an Agent
  previously set to stopped stays stopped. Separately, present an incompatible
  installation and verify that preparation refuses it while the old release
  still serves the Agent.
