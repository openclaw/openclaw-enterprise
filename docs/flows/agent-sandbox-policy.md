---
created: 2026-10-15
updated: "2026-10-20"
last_updated_session: "authoring-run/ee617f7c-b2e1-4dbb-ace9-7908ebc5cfd6"
---

# Agent sandbox policy flow

## Overview

OCC persists governed network additions for one Agent, freezes them at deployment,
and optionally applies a later version through its Sandbox Driver. Denial logs
and provider recommendations supply independent context for a user review.
This trace describes the implemented source; runtime proof has separate limits.

## Entry Points

- Trigger: the console Policy denials tab or `occ agent policy` commands.
- Source: `apps/controller/src/http/sandbox-policy.ts:sandboxPolicyHandlers` and
  `packages/occ/src/index.ts:updateAgentSandboxPolicy` / `applyAgentSandboxPolicy`.
- Assumptions: a ready Namespace, active Agent, exact grants, enabled editing for
  mutations, and an Installation ceiling shared by API and worker.

## Flow

```mermaid
graph TD
  U["User opens Agent settings"] --> Cfg["Discover authorized<br/>owner-bound schemas"]
  Cfg --> Draft["Edit local additions"]
  Draft --> Preview["Preview draft<br/>without writes"]
  Preview -->|errors| Draft
  Preview -->|valid| U2["Review proposal"]
  U2 --> A["OCC save admission<br/>IAM, schema and ceiling"]
  A --> P["PostgreSQL<br/>desired policy version"]
  P --> D["Explicit deployment<br/>immutable snapshot"]
  P --> W["Live application work<br/>exact running revision"]
  W --> C["Persist provider CAS<br/>before mutation"]
  C --> S["Sandbox Driver<br/>apply canonical policy"]
  S --> V["Confirm matching<br/>loaded version"]
  V --> R["Record applied<br/>or unconfirmed failure"]
```

The solid arrows trace source paths, not a claim that all providers are verified.

## Execution Trace

### 1. Admit and persist desired additions

`OpenClawController.discoverConfigurations` filters registry contributions by the
server-selected Driver, scope, and resource-owner read authority. Installation
inspection exposes startup schemas without values. Agent discovery and policy GET
use the same descriptor with owner-generated facet action URLs and current
availability. The registry never selects a Driver from submitted additions.

`validateAgentSandboxPolicy` authorizes the exact Agent and policy, checks the
current editing flag, expected version, and pending application, then runs shared
schema/semantic validation and current ceiling/provider admission. It returns a
configuration result without entering a mutation transaction. Schema and semantic
refusals carry safe `error.details`; stale or unauthorized requests retain their
resource errors. Every later mutation repeats these checks. Ceiling refusal keeps
its Installation-delegation cause; unsupported wildcard/range refusal names the
Driver capability limit. Both retain field details.
`internal/occclient/transport.go:APIError.Error` prints up to 32 public detail
records as escaped JSON and omits records with Unicode control characters, so
CLI callers retain the same field and cause without terminal controls.

`packages/occ/src/index.ts:updateAgentSandboxPolicy` independently authorizes
Agent `manage_policy` and SandboxPolicy `update`, locks the Namespace and Agent,
and checks editing, expected version, pending work, complete ceiling coverage,
and registry-resolved Driver admission. The saved additions come from the admitted snapshot. `apps/controller/src/http/sandbox-policy.ts` records the
nonsecret approved additions with their version in the same transaction.
The required facet argument currently admits `networking` only. Other facets
fail before network policy access. The temporary
`TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing` requires
Installation and Agent administration; Guardrails will replace this switch.

Both state adapters return `sandboxPolicyEditing: false` at Agent creation,
matching the PostgreSQL column default and subsequent reads. The separately
authorized editing operation changes this flag.

`packages/occ/src/state/postgres-state.ts` performs versioned updates. Agent
creation creates its one policy through a database trigger. Constraints enforce
ownership, document shape, immutable application identity, version transitions,
and application revision ownership. Agent deletion cascades policy removal and
cleans its exact IAM access.

### 2. Freeze deployment or enqueue live application

`packages/occ/src/index.ts:deployAgent` freezes the Driver's defaults and additions
into `AgentRevision.sandboxPolicy`. The OpenShell Driver provisions from this
snapshot rather than re-reading changed defaults.

`applyAgentSandboxPolicy` requires the exact active revision and supporting
Driver. It persists a pending application and durable Agent-target work in one
transaction. Neither saving nor enqueueing establishes enforcement.

### 3. Reconcile provider effects

`apps/controller/src/worker/sandbox-policy.ts:reconcileSandboxPolicy` locks the
same lifecycle owners and rechecks current authority, ceiling, Driver identity,
and Compute placement. Shared definition and provider admission are rerun before
provider effects. One pass records the provider CAS version; a later pass
can mutate with that fixed version and operation ID. Provider reads and effects
are bounded by the claim lease. Database and audit failures roll back the pass.

`apps/controller/src/drivers/sandbox/openshell.ts` verifies exact provider
ownership, preserves the Sandbox's static policy and generated access, and uses
native status/UpdateConfig RPCs. A full candidate match plus loaded active version
is required for `applied`. Transient or unknown outcomes retry within limits;
terminal stale work becomes an unconfirmed failure. The worker calls
`failAbandonedSandboxPolicies` inside the same `transactWithQueue` that recovers
exhausted work, so queue failure, application failure, and audit either all commit
or remain recoverable after interruption. A failed live request does
not deploy another revision. Last confirmed live evidence is retained separately.

### 4. Read contextual evidence

`openshell-log-decisions.ts:openShellLogDecision` decorates recognized provider
records. `packages/occ/src/runtime-logs/sandbox.ts` validates them;
`runtime-logs/sanitize.ts` redacts metadata and raw text through the existing
bounded log path. See [runtime logs](agent-runtime-logs.md).

`readAgentSandboxRecommendations` independently checks exact Agent/policy read
and revision ownership before its audited, limited provider read. The OpenShell
Driver projects representable native chunks into untrusted suggestions. The
console editor submits canonical additions through the same mutation path;
native draft approval cannot bypass OCC admission.

`console/driver-configurations.mjs:renderAgentDriverConfigurations` discovers
sections and selects resource-owner controls. `console/configuration-fields.mjs`
renders schema fields and JSON fallback, with safe field/root diagnostics.
`console/agents/sandbox-policy.mjs:renderPolicy` keeps proposed rules local until
preview, review, and save. Superseded preview/read responses cannot overwrite a
newer draft. Policy reads use a separate request sequence: an earlier response
cannot invalidate a newer request. A pending application re-arms polling after
the latest read, including a response discarded after a draft edit.
Failed previews retain the draft and do not mark it saved. The combined save-and-apply action waits for a successful save,
then sends that returned policy version and the exact selected running revision
to the apply route. Save alone leaves running enforcement unchanged. Applying a
previously saved policy is disabled while local edits are unsaved. If application
fails after saving, the alert identifies the saved version rather than implying
that the entire operation was rejected.

`console/agents/sandbox-policy.mjs:mutate` displays rejected saves as focused
alerts and scrolls the reason into view after rendering. Ceiling rejection
preserves the attempted additions for correction without changing saved state.
`console/navigation.mts:createNavigation` admits the `policy` tab in login
destinations, preserving an Agent's Policy denials link after sign-in.

The console reads the policy owner even when discovery returns no descriptor. This
read establishes an unsupported capability or a permission refusal before log and
suggestion reads continue under their own permissions. It cannot leave those reads
waiting for a policy request that never starts.

## Debugging and Verification

- Inspect the desired policy and application with `occ agent policy get`.
  `pending` or `failed` never establishes a successful retry.
- Compare the application revision with the active Agent revision and inspect
  attributable audit evidence before retrying a stale or unconfirmed request.
- [PostgreSQL admission integration](../../tests/integration/postgres-agent-sandbox-policy.test.mjs)
  exercises HTTP/IAM/storage; the [OpenShell runtime lane](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
  owns real enforcement proof. Storybook proves simulated presentation only.

## Related docs

- [Policy reference](../reference/sandbox-policies.md)
- [Operator workflow](../guides/topics/agent-sandbox-policy.md)
- [OpenShell provisioning](openshell-sandbox-provisioning.md)
- [Implementation plan](../../specs/plans/0045-python-sandbox-policy-denials.md)

## Manual Notes

## Changelog

- 2026-10-20 03:48: Complete policy capability reads without discovery metadata and omit terminal controls from CLI diagnostics. (authoring-run/ee617f7c-b2e1-4dbb-ace9-7908ebc5cfd6 - df244b6bd678acad513a02b5eb5d69e13f2d68dc)

- 2026-10-20 01:48: Trace rejection causes, CLI details, and refresh sequencing. (authoring-run/9d1ff825-b9f4-492a-9420-1e316d820e28 - e7e5f3321cb0a8471d74964eba56ddd069a4e4c5)

- 2026-10-19 20:34: Trace shared definitions, contextual discovery, and preview admission in the accompanying implementation. (authoring-run/9b1f7ddf-52fe-46c8-9fa9-fa7a1acfa64a - 7fa0a561df615296a612126d430a4bbfa1124d9c)

- 2026-10-19 14:18: Align Agent creation and reload defaults for policy editing in both state adapters. (authoring-run/a9906404-d12d-4f05-ba24-16be225b527c - 7e677523ba1ad953707b14f6b6c2f041e5ccd6b7)

- 2026-10-19 09:23: Require a policy facet, mark temporary editing admission, and commit exhausted application recovery atomically. (authoring-run/545665b0-3aef-44dc-beb8-492b753b1a13 - bc3ba215dd9927692bc2882ffaf06a35c27fed4a)

- 2026-10-15 17:42: Distinguish local proposals, saved policy, and explicit live application in the console. (authoring-run/11c6d771-178c-4ac7-ae8b-310ebe644daa - a28596ab8)

- 2026-10-15 17:12: Bring rejected policy saves into view and preserve the attempted edit. (authoring-run/b37638d5-3a21-4fe8-99ab-3b9600cfe107 - a28596ab8)

- 2026-10-15 16:14: Trace governed Agent network additions and separate decision evidence. (authoring-run/43cb74b9-e1fe-4fc2-adde-9d932b061d7c - a28596ab8)
