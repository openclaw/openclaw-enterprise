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

The matching legacy file and the canonical file produce the same runtime
configuration and protected identity. That identity can differ from the previous
release even when the Backend ID and registry contents match. When the identity
changes, use the new identity for new admissions. Existing Agent revisions,
attempts, and receipts keep their recorded identity. Only the original owner can
settle that work. Sessions stay with their original configuration.

Before upgrading, inventory live Agent revisions, standing approvals, outstanding
attempts, and prepared provider obligations. Pause new admissions and renewals.
Drain existing work on its original release and sender. Hold the affected cutover
while any original owner or settlement outcome remains unresolved. Preserve
`recoverOnly` so recovery cannot create new authority. Leave uncertain issuance
unreplayed.

Compare each custom policy, including dynamic vetoes, with the built-in rules. If
equivalence is unproven, resume standing access only after fresh, attributable
approval under a policy that enforces the required constraints. Keep Git access
disabled where the built-in rules cannot enforce a required constraint.

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
