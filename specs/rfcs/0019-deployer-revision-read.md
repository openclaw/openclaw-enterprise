---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Deploy grants the deployer read of the revision it admits

- **ID:** RFC-0019
- **Created:** 2026-10-07
- **Last updated:** 2026-10-08
- **RFC PR:** [#1606](https://github.com/openclaw/openclaw-enterprise/pull/1606)
- **Implementation plan:** none; delivery is one pull request,
  [#1605](https://github.com/openclaw/openclaw-enterprise/pull/1605), listed under
  [Delivery](#delivery-and-verification).
- **Related:** [Authorization](../../docs/reference/authorization.md);
  [RFC-0006 Basic RBAC](0006-basic-rbac/interfaces.md) (creation ownership profiles);
  [Agent deployment](../../docs/reference/agents/deployment.md#revisions-and-deployment);
  dogfood finding D94 and console PR
  [#849](https://github.com/openclaw/openclaw-enterprise/pull/849).

<a id="problem-and-decision"></a>

## Summary

When a deploy admits a new AgentRevision, OCC grants the caller exact
`agent_revision:read` on that revision. The grant is an ordinary AccessBinding,
written in the admission transaction through the selected IAM Driver, listed in
the deploy audit event, and removed with the revision. A deny Restriction on
that read still wins: deploy then writes no grant and says so. Nobody else gains
anything: a person who can read or administer the Agent but did not deploy, such
as a Console sharee, still needs their own revision grant. Deploy becomes the
first operation that writes IAM policy for its caller.

## Motivation

A member with Agent `deploy` cannot follow the deployment she starts. IAM grants
are exact, and an `agent_revision` permission applies only to a binding on that
exact revision ([Manage Namespace policy](../../docs/reference/authorization.md#manage-namespace-policy)).
Each deploy creates a revision nobody but an administrator can read, so:

- `GET .../revisions/<new>` and deployment-status polls return `403`;
- runtime status needs revision `read` and fails for "this version";
- the console kept showing the previous version as current and succeeded, and
  since #849 says "v2 was requested; you cannot read its status".

Dogfood rounds reproduced this for a member with Agent read, deploy, operate and
administer, Configuration read and Secret operate, and again through the Console
Share flow. Today an administrator must add one more exact binding after every
deploy, which nobody does in practice.

Granting this leaks nothing. Deploy already requires Agent `deploy`, `read` on the
Configuration the revision snapshots, and `operate` on its Secret and Harness
sources, and its `202` response returns the admitted revision to the caller.
The grant lets her read again what she was shown at admission, plus its
deployment status.

<a id="scope"></a>

## Goals

- A caller who deploys can read the revision her deploy admitted, with no
  administrator step, unless a deny Restriction on that read applies.
  Restrictions keep overriding grants; deploy neither writes an ineffective
  grant nor turns the read deny into a deploy denial.
- The grant is exact, attributable, and visible as ordinary policy: one binding,
  one revision, one subject, in the deploy audit event.
- It appears and disappears atomically with the revision.
- A caller who cannot hold a Namespace binding still deploys, without a grant.
  Any other failure to write the grant fails the deploy closed, with the
  revision rolled back. A Restriction is policy, not a write failure: it is
  detected before any write and reported, never written around.

## Non-goals

- Read of earlier or later revisions the caller did not deploy.
- Any grant for sharees, Agent readers or administrators of the Agent.
- Deriving revision read from other grants at evaluation time.
- Creation ownership profiles, Groups or Namespace-wide grants
  ([RFC-0006](0006-basic-rbac/interfaces.md)).

<a id="design"></a>

## Proposal

**Owner.** OCC's deploy admission
(`OpenClawController.deployAgentWithAuthorization`), which already owns the
transaction that locks the Namespace and Agent, creates the revision, sets the
desired state, queues work and, through the API, appends the deploy audit event.

**Grant.** After the revision row is written, in the same unit of work:

1. If the selected IAM Driver keeps policy outside platform State
   (`namespacePolicyTransaction` is not `platform-unit-of-work`), stop. OCC never
   writes policy around an external IAM Driver.
2. Ask the IAM Driver for the caller's `read` decision on the new revision.
   If it is allowed (for example the bootstrap administrator's
   Installation-wide Role), stop. If it is denied and its evidence names an
   applicable Restriction (`restrictionIds` is not empty), stop: a matching
   Restriction denies even an exact binding
   ([Restrictions](../../docs/reference/authorization.md#restrictions)), so a
   grant could not make the revision readable. The deploy still returns `202`;
   a Restriction denies only the action it names, and an administrator who
   wants to stop deploys restricts `deploy`. No grant is written in either case.
3. Ensure the Namespace Role `role_<namespaceId>_deployed_revision_read`, named
   "Deployed revision read", with exactly `agent_revision:read`. It is created on
   first use and then reused; Roles are immutable, and a Role with that ID but
   other permissions is refused with `409` naming the Role. This follows the
   provisioning precedent (`role_<namespaceId>_agent_secret_operate`).
4. Create `binding_<revisionId>_deployer_read`: subject the caller, that Role,
   target the new revision. The IAM Driver's ordinary checks apply (subject rule,
   target lock, Namespace lock).
5. If the caller cannot be a Namespace binding subject (for example an
   Installation-scoped ServicePrincipal), remove the Role created in step 3, if
   any, and continue the deploy without a grant.

**Audit.** The deploy event lists the binding in `details.grantedAccessBindings`,
with the same fields as `removedAccessBindings` (ID, subject, Role, target). The
provisioning handoff checkpoint event does the same when provisioning deploys.
When no grant was written, the list is omitted and
`details.revisionReadGrantSkipped` says why: `external-iam-policy` (step 1),
`already-readable` or `restricted` (step 2), or `subject-not-bindable` (step 5).
With `restricted`, `details.revisionReadRestrictionIds` lists the Restrictions
from the decision evidence. An audit failure rolls back the grant with the
revision.

**Lifecycle.** Revisions are deleted only when their Agent is deleted. The Agent
deletion finalizer already removes bindings that target the Agent's revisions,
and the accepted delete event lists them in `accessBindingsRemovedOnCompletion`.
Namespace teardown removes all Namespace policy. An administrator can delete the
binding at any time through the Namespace IAM API; the Agent is unaffected. A
Restriction added after the grant overrides it, as it overrides any binding; the
binding stays until it is deleted.

**What still needs grants.** Sharees and other readers of the Agent, revisions
deployed by someone else (including earlier ones), and anything beyond revision
`read`: logs (`read_logs`), runtime status (Agent `operate` and `read`) and
native admin keep their current rules.

```mermaid
sequenceDiagram
  participant Member
  participant API as OCC deploy admission
  participant IAM as IAM Driver (platform State)
  participant Audit
  Member->>API: POST /agents/:id/deploy
  API->>API: authorize deploy, Configuration read, sources; create revision
  API->>IAM: decide read on the new revision
  alt allowed
    IAM-->>API: allowed: no grant (already-readable)
  else denied by a Restriction
    IAM-->>API: restrictionIds: no grant (restricted)
  else denied, no Restriction
    API->>IAM: ensure Role, create exact binding
    IAM-->>API: binding (or subject refused: no grant)
  end
  API->>Audit: deploy event with grantedAccessBindings or the skip reason
  API-->>Member: 202 revision (one transaction)
  Member->>API: GET /revisions/:new
  API-->>Member: 200, or 403 when restricted or not bindable
```

The diagram shows the proposed flow. #1605 implements all three branches,
including `restricted`.

## Delivery and verification

Delivery is [#1605](https://github.com/openclaw/openclaw-enterprise/pull/1605),
gated on this RFC. It changes deploy admission, the deploy and provisioning audit
details, and the authorization reference, permissions cheat sheet, deployment
reference, Agent details guide and Namespace IAM policy flow. The console needs
no change: its "you cannot read this version" paths follow the revision list.

Required outcomes and evidence (#1605):

- A member deploy writes the grant, she reads the new revision and it is the only
  one she can list; she cannot read an administrator's earlier revision; a sharee
  cannot read hers; the event names the binding (PostgreSQL integration test,
  fails on main).
- An administrator's deploy writes no grant and its event says
  `already-readable`; repeated deploys reuse one Role.
- Agent deletion lists the grants among the bindings it removes.
- An Installation-scoped ServicePrincipal deploys without a grant
  (`subject-not-bindable`) and leaves no Role behind; an IAM Driver that keeps
  policy outside platform State gets none (`external-iam-policy`).
- With a matching deny Restriction on `agent_revision` `read` (Installation,
  Namespace or exact-revision scope), a member's deploy returns `202`, writes
  no Role or binding, its event says `restricted` with the Restriction ID, and
  her revision GET stays `403`.

Not yet verified: a live install. The provisioning path is covered by code
review only, because provisioning requires Namespace-wide `create`, which only
administrators hold today.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Keep exact grants only (status quo).** Simple, but every deploy by a member
  needs an administrator, and #849's message is the whole experience.
- **Derive revision read** from Agent `read` plus Configuration `read` at
  evaluation time. It stores nothing, but it adds the first derived rule to the
  evaluator, would follow later Configuration changes rather than the snapshot,
  and contradicts RFC-0006's exact-grant model. It would also expose revisions to
  sharees that hold Configuration read but never deployed.
- **RFC-0006 creation ownership profiles** (`readAdmittedRevisions`). That is the
  long-term direction, but it needs profiles, approval and Groups, deferred past
  0.x. This proposal is its narrowest case, the deployer as the only audience,
  and does not block it: a profile could later grant the same binding to a wider
  audience.
- **Fail admission when a Restriction blocks the read.** It keeps the promise
  "every deployer reads her revision" literally, but a deny on revision `read`
  would then deny `deploy`, an action the Restriction does not name.
- **Write the grant despite a Restriction.** The binding would have no effect,
  and the event would report a grant the caller cannot use.
- **Always write the grant**, even when the caller already reads the revision.
  More uniform, but every administrator deploy would add a binding to the
  Namespace policy list with no effect.
- **A Role per revision.** Avoids a shared Role but doubles the policy rows per
  deploy; one immutable Role per Namespace is enough.

## Unresolved questions

- **Revocation drift.** The grant does not follow later changes to the deployer's
  other grants: if her Configuration read is revoked, she keeps read of revisions
  she already deployed and saw. Binding: an administrator can delete the grant.
  Deciding owner: IAM maintainers, if a stricter rule is wanted.
- **Opting out.** No setting turns the grant off. An Installation that wants exact
  administrator-only revision grants would need one. Deciding owner: product.

## References

- [Authorization](../../docs/reference/authorization.md) and
  [permissions cheat sheet](../../docs/reference/cheatsheets/permissions.md)
- [Agent deployment](../../docs/reference/agents/deployment.md#revisions-and-deployment)
- [Namespace IAM policy flow](../../docs/flows/namespace-iam-policy.md)
- [RFC-0006 interfaces](0006-basic-rbac/interfaces.md), creation ownership profiles
- Implementation: [#1605](https://github.com/openclaw/openclaw-enterprise/pull/1605);
  console explanation: [#849](https://github.com/openclaw/openclaw-enterprise/pull/849)
