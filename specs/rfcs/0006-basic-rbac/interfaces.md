---
rfc: index.md
---

# RBAC interfaces

Read the [current-source and release-scope amendment](index.md#current-source-amendment--2026-09-24)
before applying this original proposal. Its broader invocation scope is deferred
past 0.x; the requirements below are not implementation acceptance.

This [proposal](index.md) builds on existing exact-action IAM. The policy
catalog, units and outcomes below are selected proposed contracts. OCC facade
routes, wire DTOs and response codes remain unresolved.

## Permissions and targets

The proposed immutable twenty-role catalog contains these exact bundles:

| Role ID                         | Resource kind  | Actions                       |
| ------------------------------- | -------------- | ----------------------------- |
| `account_member`                | Installation   | `read`                        |
| `namespace_viewer`              | Namespace      | `read`                        |
| `configuration_creator`         | Configuration  | `create`                      |
| `configuration_reader`          | Configuration  | `read`                        |
| `configuration_editor`          | Configuration  | `read, update, delete`        |
| `secret_user`                   | Secret         | `read, operate`               |
| `service_account_reader`        | ServiceAccount | `read`                        |
| `agent_creator`                 | Agent          | `create`                      |
| `agent_viewer`                  | Agent          | `read`                        |
| `agent_revision_reader`         | AgentRevision  | `read`                        |
| `agent_content_reader`          | Agent          | `read, read_content`          |
| `agent_collaborator`            | Agent          | `read, invoke, read_content`  |
| `agent_editor`                  | Agent          | `read, update, write_content` |
| `agent_operator`                | Agent          | `read, deploy, operate`       |
| `access_administrator`          | Installation   | `read, administer`            |
| `repository_assigner`           | Agent          | `read, assign_repository`     |
| `repository_user`               | Agent          | `use_repository`              |
| `audit_reader`                  | Agent          | `read_audit`                  |
| `audit_retention_administrator` | Installation   | `manage_audit_retention`      |
| `installation_administrator`    | Multiple       | Retained bundle below         |

The retained `installation_administrator` bundle contains:

| Resource kind                 | Actions                                             |
| ----------------------------- | --------------------------------------------------- |
| Installation                  | `administer, read`                                  |
| Namespace                     | `create, read, delete`                              |
| Configuration, ServiceAccount | `create, read, update, delete`                      |
| Secret                        | `create, read, update, delete, operate`             |
| Agent                         | `create, read, update, deploy, operate, administer` |
| AgentRevision                 | `read`                                              |

Agent `read` covers Agent metadata and status. `invoke` submits an ordinary turn.
`read_content` covers eligible workspace, conversation/run history and results.
`write_content` covers eligible workspace changes. `update` changes configuration.
`deploy/operate` control lifecycle. Agent `administer` denotes approved access
administration, not the initial human Installation gate. Repository assignment
and widening require `assign_repository`. Use requires the owning Agent's
`use_repository`. History needs `read_audit`, separately from content. Installation
administration and the retained administrator bundle imply neither content nor audit.

Current [deployment-status polling](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/packages/contracts/src/api/routes.ts#L616-L630)
requires `read` on the exact admitted AgentRevision. Agent `read` or `deploy/operate`
does not grant that access. The existing [status contract](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/agents.md#deployment-status)
distinguishes `202` admission from saved historical completion, not live health or
protected History. Approved creation profiles govern exact revision grants as specified below.

A subject is `{ kind: "identity", id: string }` or
`{ kind: "group", id: string }`. State resolves authentic identities and parentage.
Groups contain direct human members, never Agent ServicePrincipals. A scoped
identity or Group cannot cross its Namespace. Only the exact owning Agent
ServicePrincipal may receive `repository_user` on that Agent. Other catalog grants
use an eligible identity or matching-scope Group. Roles are immutable bundles.
Deny-only Restrictions override matching grants.

`IAMPolicyGrantV1` contains `subject`, fixed `role`, and exactly one target:

| Target tag             | Complete fields                                                   | Allowed scope                                                                 |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `resource`             | `resource: ResourceRef`                                           | Exact resource matching a role's resource kind, excluding both creator roles. |
| `collection`           | `resourceKind: "agent" \| "configuration"`, `namespaceId: string` | Matching creator only, on the exact Namespace-parent sentinel.                |
| `namespace_agents`     | `namespaceId: string`                                             | `audit_reader` for Agents in that Namespace only.                             |
| `retained_agent_audit` | `namespaceId: string`, `agentId: string`                          | `audit_reader` for retained exact-Agent history only.                         |

`agent_creator` and `configuration_creator` require their matching `collection`
target on the exact Namespace-parent sentinel. `ResourceRef` contains
`kind: ResourceKind`, `id: string`, and optional `namespaceId: string`. State must
verify the singleton Installation or exact Namespace parentage. Target-scope
validation does not itself authorize a grant.

The historical audit exception requires authentic State/History parentage. It is
not ordinary access to deleted objects or another ACL store. Exact resource grants
do not broaden the multi-kind administrator bundle beyond their target.

Creation ownership profiles contain `namespaceId`, `subject`,
`configurationRoles: readonly "configuration_editor"[]`,
`agentRoles: readonly ("agent_collaborator" | "agent_editor" | "agent_operator")[]`,
and `readAdmittedRevisions: boolean`. Administrator-approved profiles atomically
grant only newly created exact objects. Deployment grants its approved ownership
audience exact read of the new admitted revision. Existing-object and source
permissions are never bypassed.

Namespace discovery needs explicit Namespace `read`. Configuration, Secret and
ServiceAccount companions stay exact. Secret `read/operate` grants metadata and
source use, never provider-material disclosure. Personal setup needs no broad
administrator or credential-mutation grant. Create the Agent without repositories,
grant its known ServicePrincipal exact source-use and repository-use permissions,
then assign repositories.

## Policy administration

OCC exposes the catalog and proposed `readPolicy`, `applyChange` and
`readPolicyOperation` facades. General administration requires current human
Installation `administer`. Authentication supplies the actor. State supplies the
Installation and validates subjects and exact parentage. OCC depends on the
selected capability, not Native implementation identity. Unsupported Drivers
reject explicitly without Native fallback.

The proposed Driver contract binds original-State units:

```ts
export interface IAMPolicyAdministrationV1 {
  readonly version: "iam-policy-v1";
  bindPolicy(token: IAMPolicyReadTransactionTokenV1): Promise<IAMPolicyReadUnitV1>;
  bindPolicy(token: IAMPolicyWriteTransactionTokenV1): Promise<IAMPolicyUnitV1>;
}
export interface IAMPolicyReadUnitV1 {
  readPolicy(): Promise<IAMPolicyViewV1>;
  authorizeCurrent(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}
export interface IAMPolicyUnitV1 extends IAMPolicyReadUnitV1 {
  prepareChange(change: IAMPolicyChangeV1): Promise<IAMPolicyCandidateV1>;
  authorizeCandidate(
    candidate: IAMPolicyCandidateV1,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision>;
  acceptCandidate(
    candidate: IAMPolicyCandidateV1,
    recovery: IAMLocalAdministratorEvidenceV1,
  ): Promise<PreparedIAMPolicyReceiptV1>;
}
```

Read/write tokens, account/resource/recovery evidence and candidates are opaque
branded handles, authenticated by their original owners. They are not caller
DTOs. [Original-State ordering](architecture.md#original-state-transaction) owns
custody, lock intent, candidate acceptance and commit.

An administration change has `kind: "administration"`, `operationRef: string`,
`expectedPolicyRevision: number`, and `commands: readonly IAMPolicyCommandV1[]`.
The selected contract requires a bounded ordered batch with one operation,
digest and revision outcome. Numeric bounds remain an implementation gate.
The complete command variants are:

| `kind`                          | Other fields                                                   |
| ------------------------------- | -------------------------------------------------------------- |
| `create_group`                  | `namespaceId?: string`, `name: string`                         |
| `rename_group`                  | `groupId: string`, `name: string`                              |
| `add_member` or `remove_member` | `groupId: string`, `principalId: string`                       |
| `grant`                         | `subject`, `role`, `target` from `IAMPolicyGrantV1`            |
| `revoke_grant`                  | `bindingId: string`                                            |
| `add_restriction`               | `restriction: IAMPolicyRestrictionV1`                          |
| `replace_restriction`           | `restrictionId: string`, `restriction: IAMPolicyRestrictionV1` |
| `remove_restriction`            | `restrictionId: string`                                        |
| `set_creation_profile`          | `profile: IAMCreationOwnershipProfileV1`                       |
| `remove_creation_profile`       | `profileId: string`                                            |

Restrictions contain optional `namespaceId: string`, `action: PermissionAction`,
`resourceKind: ResourceKind`, optional `resourceId: string`, and `effect: "deny"`.
Administrative commands cannot enroll identities or supply account evidence.
Creation profiles do not define personal/team context commands.

Internal `human_account` changes carry the same operation/revision fields plus
`account: IAMAccountPolicyEvidenceV1`, `enrollPrincipal: boolean`, and
`grants: readonly IAMAccountRoleGrantV1[]`. A grant selects either
`role: { kind: "catalog", id: IAMFixedRoleIdV1 }` with a policy target, or
`role: { kind: "existing", id: string }` with an exact `resource` target.
Internal `resource_creation` changes carry the operation/revision fields and
`resource: IAMResourcePolicyEvidenceV1`. State loads approved ownership profiles.
Only the owning transaction participant submits these internal variants.

`IAMPolicyViewV1` exposes `driverId: string`, `revision: number`, and readonly
arrays `catalog: IAMFixedRoleDefinitionV1[]`, `groups: Group[]`,
`memberships: GroupMembership[]`, `roles: Role[]`, `bindings: AccessBinding[]`,
`restrictions: Restriction[]`, and `creationProfiles` containing each profile with
`id: string`. Catalog entries contain `id: IAMFixedRoleIdV1`, `name: string` and readonly
permissions with `action: PermissionAction` and `resourceKind: ResourceKind`.

## Policy outcomes and recovery

A candidate's safe result contains optional `principalId: string` and readonly
string arrays `groupIds`, `bindingIds`, `restrictionIds`, `creationProfileIds`.
These identifiers confer no committed authority.

`IAMPolicyReceiptV1` contains string fields `operationRef`, `commandDigest`,
`driverId`, `actorPrincipalId`, numeric `beforeRevision` and `afterRevision`,
`result: IAMPolicyCandidateResultV1`, plus readonly string arrays `auditRefs` and
`narrowingRefs`. Prepared and committed receipts add their respective `state` tag.
The complete proposed result union is:

```ts
export type IAMPolicyChangeResultV1 =
  | CommittedIAMPolicyReceiptV1
  | { readonly state: "conflict"; readonly currentRevision?: number }
  | { readonly state: "denied"; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "unknown"; readonly operationRef: string };
```

For example, an acknowledged original commit returns `state: "committed"` with
its complete receipt. The same operation/digest can recover that receipt only
after current authorization, preserving its original before/after revisions even
when the policy head advances. Changed content under that operation conflicts.
A denied caller cannot use receipt lookup to bypass current authorization.

Own-uncommitted results remain prepared. An uncertain COMMIT or absent retained
receipt stays unknown. Caller snapshots cannot mint committed authority. Recovery
uses retained acceptance evidence, without automatic replay or destructive
compensation. Exact facade transport, digest encoding and receipt-retention
mechanics remain owner work rather than implied wire defaults.

## Account lifecycle consumption

[Human sign-in](https://github.com/openclaw/openclaw-enterprise/pull/246) owns stable
Principal identity, immutable provider-instance/subject association, local and
external-only accounts, methods, browser/CLI sessions and complete repair. RBAC
consumes authoritative status, immutable account incarnation and authentication
version across every controller.

Administrator-led enrollment is grant-free. Disable denies new authentication and
existing-session use. Re-enable revives none. Login adds no repository/connector
grant, implicit signup or same-email linking. Local withdrawal covers every login
method. Identity-provider disable alone does not withdraw OCC sessions.

Internal compatibility routes preserve previously provisioned service-key account
clients. Complete repair covers the sorted affected-account set, and candidate
policy retains a usable local-password administrator under Groups and Restrictions.
The [shared transaction](architecture.md#original-state-transaction) consumes the
account owner's evidence rather than creating a second account writer.

## Agent invocation

`AgentInvocation` provides ordinary submit, status, result and cancel through the
actual private Gateway and Harness adapter. Exact route and DTO signatures remain
unresolved. Required authorization is:

| Operation    | Current exact requirement                                                                 |
| ------------ | ----------------------------------------------------------------------------------------- |
| Submit       | Agent `invoke` and content-baseline eligibility.                                          |
| Safe status  | Agent `read`, plus original requester or Agent `operate`. Excludes prompt/result content. |
| Result       | Agent `read_content` and audience eligibility.                                            |
| Cancel-own   | Active original human and Agent `invoke`.                                                 |
| Cancel-other | Agent `operate`.                                                                          |

Durable State binds requester, context/version, exact Agent/revision/ServicePrincipal,
selected IAM/policy revision, authority generation and original deadline. It also
binds event/digest/idempotency, dispatch attempt, runtime turn/result reference and
outcome. Actual runtime owns dispatch/cancel. Lifecycle reconciliation is not
invocation Work. [Separate fences](invocation-and-content.md#dispatch-and-reply-fences)
govern duplicates, unknown outcomes and native reply custody. Protective withdrawal
survives ordinary permission removal.

## Connector admission

Authenticate the enrolled non-Agent connector ServicePrincipal bound to app,
tenant/workspace and generation. Accept only that owner's verified transport,
immutable sender, conversation kind, explicit mention, event/logical-message
identities, digest and original reply handle. OCC resolves current bindings,
selects DM/team context and commits authorized admission with audit.

Missing/stale registration, lost ownership, denial, unavailable admission, exception
or timeout prevents default dispatch. Preserve the native invocation/reply handle.
Caller names, profiles, identity labels and destinations confer no authority.
[Native ingress](invocation-and-content.md#native-ingress-and-runtime) owns supported
message forms and the image-pinned hook.

## Repository assignments

Extend the existing repository-binding owner. An immutable assignment ID binds the
Agent ServicePrincipal, selected Driver and resolved provider/repository/grant/profile
within the Namespace registry ceiling. Human `assign_repository` and owning-SP
`use_repository` are both required for assignment or widening. Resolve the complete
selection through the existing repository Driver. Explicitly select `git-read`
for new assignments unless deliberately widened.

Changed tuples receive new IDs. Removal publishes withdrawal. Deploy, session open
and renewal recheck current assignment/use. Freeze the resolved tuple and original
deadline in the revision, and index sessions by assignment ID and authority
generation. The [credential Driver consumed by identity](https://github.com/openclaw/openclaw-enterprise/pull/247)
owns scopes, minting, protocol and cleanup. There is no second repository ACL store.

## Owner decisions

These selected guarantees still need exact producing and consuming contracts:

- OCC/State, IAM and connector owners must close versioned context placement,
  schema and commands without mistaking creation profiles for context records.
- OCC/content and Installation owners must define finite real-route/profile mapping,
  narrow-action cutover and offered combinations. Unsupported mappings deny.
- Connector/OCC owners must define complete audience evidence and membership-change
  withdrawal procedures before qualifying shared delivery.
- Invocation, identity and credential owners must bind concurrent operations to
  their original requester and preserve final currentness after waits.
- State/runtime/native-delivery owners must settle dispatch and submission fence
  lifetime without audit-erasure-dependent replay.
- Identity/egress/Compute owners must fix event, clock/skew, expiry, cadence and
  closure-reserve mechanisms before claiming [withdrawal bounds](security.md#withdrawal-and-failure).

Unknown placement, signatures, routes and mechanics remain open. Closure requires
real consumers and consequential evidence in [delivery](delivery.md), not fabricated
DTOs or a relaxed guarantee.
