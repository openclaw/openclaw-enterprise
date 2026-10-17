---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Driver configuration contributions

- **ID:** RFC-0021
- **Created:** 2026-10-16
- **Last updated:** 2026-10-16
- **Implementation plan:** [TASK-0046](../plans/0046-driver-configuration-contributions.md)
- **Related:** [Per-Agent sandbox policies, PR #2599](https://github.com/openclaw/openclaw-enterprise/pull/2599), [Driver architecture](../../docs/design/drivers.md)

## Summary

Extend Driver implementations with typed configuration validation and named
Agent-scoped configuration contributions. Each definition exposes JSON Schema
for documentation and console rendering, plus a validator returning either typed
data or field-addressed issues. OCC owns authorization, resource admission, and
persistence; Drivers own provider constraints. Existing resource workflows retain
revision snapshots and application.

## Motivation

OCE already accepts Driver startup schemas, but semantic validation throws ordinary
errors and the console cannot discover generic configuration descriptions. Adding
a configurable capability currently requires separate schema, error, and form work.

PR #2599 demonstrates the gap: Installation network defaults and per-Agent policy
additions have schemas, but broad validation messages and handwritten controls.
Users need useful field errors while policy admission still enforces the current
operator ceiling, Driver capabilities, and exact resource permissions.

This proposal was checked against `main` at `c655fd7f4ecb4bb9a1f67566e105ba84f04da892`
and #2599 at `bc3ba215dd9927692bc2882ffaf06a35c27fed4a`. The latter is an open
proposal, not evidence of implemented platform behavior.

## Goals and scope

- Describe required configuration, nested types, constraints, and field help once.
- Return detailed structural and semantic errors usable by startup callers and forms.
- Support both Installation schema inspection and the regular Agent policy workflow.
- Preserve current resource ownership, authorization, concurrency, and effect boundaries.

Generic configuration persistence, arbitrary fields in native OpenClaw JSON,
Installation hot reconfiguration, and credential/connectivity probes are outside
scope. Startup values remain operator-managed. This proposal does not accept the
separate policy design in #2599; its final reviewed contract is a delivery dependency.

## Proposal

The current [implementation contract](../../packages/contracts/src/index.ts)
exposes `configurationSchema` and a throwing `validateConfiguration(): void`.
The [Installation loader](../../apps/controller/src/composition/installation-config.ts)
checks the schema with TypeBox, then invokes semantic validation. It reports the
first structural mismatch. [Package loading](../../apps/controller/src/composition/driver-packages.ts)
supports module exports alongside bundled static class members.

In #2599, `SandboxNetworkGrantSchema` already provides TypeBox types and constraints.
`validateSandboxNetworkGrants` adds semantic checks; OCC separately checks the
delegation ceiling. The console hand-builds the policy fields. Reuse these owners
instead of copying provider behavior into core or a second validation subsystem.

### Shared definition and result

Export the following through `packages/contracts/src/index.ts`. Implementation
files stay private; no package subpath exports are needed.

```ts
export interface ConfigurationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export type ConfigurationResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly issues: readonly [ConfigurationIssue, ...ConfigurationIssue[]];
    };

export interface ConfigurationDefinition<T = unknown> {
  readonly configurationSchema: JSONSchema;
  validateConfiguration(input: unknown): ConfigurationResult<T>;
}

export interface ConfigurationContribution<T = unknown> extends ConfigurationDefinition<T> {
  readonly key: string;
  readonly scope: "agent";
}

export interface DriverImplementation<
  TStartup = unknown,
> extends ConfigurationDefinition<TStartup> {
  readonly configurationContributions?: readonly ConfigurationContribution[];
}
```

Paths are relative to the submitted configuration; `[]` denotes the whole object.
Preserve numeric array indices and multiple issues per path. Normalize TypeBox
JSON Pointers using the schema and input, including escaped keys and numeric object
keys; dotted strings are not the contract. Core codes include `required`,
`unknown_field`, `invalid_type`, and `invalid_value`. Semantic codes such as
`invalid_range` and `outside_ceiling` remain stable; prose may improve independently.

Validation is synchronous, deterministic, and side-effect-free. It returns all
independently discoverable structural issues, then semantic issues whose inputs
are valid. It rejects unknown fields in closed objects and performs no implicit
coercion, stripping, or default insertion. JSON Schema defaults are annotations.
Successful data is the validated value consumed by the caller. Unexpected exceptions
or malformed validator results fail startup or the request closed; they are not
converted to success or exposed with stack traces. Messages and paths must not
echo secret values or sensitive dynamic keys.

Use TypeBox to derive types from schemas and share structural issue conversion.
Each definition performs complete validation; callers do not need to remember a
second semantic check. A generic `T` alone does not prove its schema matches: derive
concrete types and preserve the validator/factory pairing during registration.

### Registration and construction

Bundled classes expose the definition statically; packages export its members.
The instance `Driver` identity contract stays unchanged. Change the existing
factory's configuration parameter to the successful startup type:

```ts
interface ExternalDriverModule<TStartup = unknown> extends DriverImplementation<TStartup> {
  createDriver(options: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: TStartup;
    readonly platformState?: NativeIAMStateStore;
    readonly getOperationAbortSignal?: () => AbortSignal | undefined;
  }): unknown;
}
```

Composition retains definitions beside selected instances, keyed by capability
and Driver ID. It validates descriptors before serving requests. Contribution keys
are nonempty and unique within an implementation; `startup` is reserved. Unknown
scopes, duplicate keys, invalid schemas, and unsupported bindings reject registration.
For this delivery, the registered Agent binding is `sandbox-network-policy` on a
Sandbox implementation, routed to the sandbox-policy resource owner. Core depends
on that capability contract, never an OpenShell implementation name.

Schemas must be JSON-serializable, object-rooted, and closed at the root. Treat an
omitted dialect as Draft 2020-12. Support the JSON-compatible vocabulary exercised
by bundled definitions: properties, required fields, dictionaries, primitive types,
enums/constants, numeric/string/array bounds, patterns, composition, and local
references. Register supported formats explicitly. Reject unsupported assertion
keywords and unresolved or remote references rather than ignoring validation.
Allow documented presentation annotations. Validate schema compatibility against
the installed TypeBox version before changing bundled declarations.

Update bundled implementations, installed-package fixtures, direct constructor
checks, API composition, and worker composition together. Legacy `void` results
are unsupported; retain no compatibility fallback. Construction never starts after
a validation failure. Display paths and safe messages in startup diagnostics.

### Sandbox-policy contribution and admission

```ts
export interface SandboxPolicyConfiguration {
  readonly additions: readonly SandboxNetworkGrant[];
}

export interface SandboxPolicyConfigurationContribution extends ConfigurationContribution<SandboxPolicyConfiguration> {
  readonly key: "sandbox-network-policy";
  readonly scope: "agent";
}
```

Wrap #2599's grant-array schema in an object with required `additions`. The
definition handles unique IDs, normalized paths, DNS names, and ordered ranges.
It describes editable intent, not saved versions, application status, or defaults.

Change #2599's existing `SandboxDriver` member to return structured admission:

```ts
admitNetworkPolicy?(
  additions: readonly SandboxNetworkGrant[],
  version: number,
  defaults?: SandboxPolicySnapshot["defaults"],
): ConfigurationResult<SandboxPolicySnapshot>;
```

Its issue paths use the same `{ additions }` root. OCC first authorizes the exact
Agent and policy, validates the contribution, then checks the current ceiling and
advertised wildcard/range support. The Driver validates representability and
returns the snapshot. OCC supplies the server-owned next version and defaults;
the caller cannot replace either. Keep `observeNetworkPolicy`,
`applyNetworkPolicy`, and `readPolicyRecommendations` unchanged. Update every
admission caller, including revision creation and worker rechecks, to consume the
result and preserve existing failure handling.

### OCC wire contracts and routes

Expose schemas, never executable validators or startup values:

```ts
export interface DriverConfigurationDescriptor {
  readonly driverId: string;
  readonly capability: DriverCapability;
  readonly implementation: string;
  readonly key: string;
  readonly scope: "installation" | "agent";
  readonly configurationSchema: JSONSchema;
}

export interface ValidateSandboxPolicyRequest {
  readonly expectedVersion: number;
  readonly configuration: unknown;
}

export type ValidateSandboxPolicyResult =
  ConfigurationResult<SandboxPolicyConfiguration>;

// New OCC method; arguments use the existing resource identifiers.
validateAgentSandboxPolicy(
  principalId: string,
  namespaceId: string,
  agentId: string,
  request: ValidateSandboxPolicyRequest,
): Promise<ValidateSandboxPolicyResult>;
```

The capability field disambiguates the registry's `(capability, id)` identity.
Keep standard `{ data, meta }` response envelopes. Add these operations to the
owning route schemas and generate OpenAPI:

| Operation                                                                 | Authority and result                                                                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /installation/driver-configurations`                                 | Installation `administer`; returns selected startup descriptors, with key `startup` and scope `installation`.               |
| Existing Agent sandbox-policy GET                                         | Preserve #2599's exact read authorization; add its selected contribution descriptor and action availability.                |
| `POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/validate` | Same Agent `manage_policy` and exact policy `update` checks as save; returns a contextual validation result without writes. |

Extend #2599's view, retaining its existing fields:

```ts
export interface SandboxPolicyView {
  readonly policy: SandboxPolicy;
  readonly editingEnabled: boolean;
  readonly ceiling: readonly SandboxNetworkGrant[];
  readonly defaults: SandboxPolicySnapshot["defaults"] | null;
  readonly defaultsRevisionId?: string;
  readonly capability: {
    readonly wildcards: boolean;
    readonly portRanges: boolean;
    readonly live: boolean;
  } | null;
  readonly configuration: DriverConfigurationDescriptor | null;
  readonly permissions: {
    readonly edit: boolean;
    readonly apply: boolean;
  };
}
```

OCC computes permissions from current exact grants. Editing state, pending work,
and Driver support additionally control available actions. Descriptor and capability
are null when the selected Driver has no supported policy contribution. This view
does not authorize mutations or disclose data beyond the existing read boundary.

A well-formed validation request returns HTTP 200 with success or issues. Malformed
envelopes use 400, unauthorized requests use existing authentication/authorization
errors, and stale versions, disabled editing, or pending application use existing
conflicts. Structural or contextual rule refusals identify affected fields; version
and permission failures remain resource errors.

Preserve the existing policy PUT/apply bodies and response resources. Save repeats
admission under its existing concurrency checks. Add optional
`error.configurationIssues: ConfigurationIssue[]` to the shared error schema for
rule refusals during mutations; preserve existing top-level codes and `details`.
Existing `ErrorDetail` has a different pointer/code contract and cannot carry this
shape unchanged. Implement schema and serialization together. Audit successful
mutations and authorization denials through existing attributable paths; validation
does not create policy changes or application jobs.

### Console behavior

Provide an Installation schema inspection view under the existing administration
surface. In the Agent policy editor, initialize `{ additions: policy.additions }`
and render text, number, boolean, enum, object, and array fields from the descriptor.
Use schema titles, descriptions, examples, required fields, and constraints. Render
descriptions as text. A schema-aware JSON editor handles valid shapes the form
renderer cannot present; it uses the same server validator.

Keep #2599's defaults, ceiling, denial/recommendation review, and Save versus Save
and apply controls. Map returned issue paths to fields and summarize root issues.
Only apply validation responses to the exact draft and version submitted; discard
late responses after edits. Keep drafts on failure and present version conflicts
as reload/review actions. Successful validation never marks policy saved or applied.
`writeOnly` metadata is not credential storage; use existing Secret-reference flows.

## Delivery and verification

[TASK-0046](../plans/0046-driver-configuration-contributions.md) owns ordered work,
source touchpoints, and verification. Completion requires both real callers:
validated Driver construction and the Agent policy editor through authorized
validation, save, revision admission, and worker application. Shared types or a
standalone form alone do not satisfy this proposal.

Required proof includes structural and semantic refusals before construction,
unauthorized access, multiple nested issues, validation without writes, stale
versions and revoked permissions, and current ceiling enforcement. The real
OpenShell Agent workflow must demonstrate denial, permitted save/application, and
revocation while a second Agent remains denied. Browser and Storybook evidence
must show meaningful errors, conflicts, and save/application states; simulated
UI evidence does not establish runtime enforcement.

This PR is specification-only. No runtime behavior or integration proof is claimed.
Implementation and RFC revision may proceed in parallel with review, subject to
actual dependency and review holds.

## Rationale and alternatives

**Use TypeBox with a library-neutral result.** OCE and #2599 already use TypeBox
schemas and inferred types. Zod's successful-data/error result and Pydantic's field
metadata provide useful models without requiring new platform dependencies.
[Zod parsing](https://zod.dev/basics), [Pydantic fields](https://docs.pydantic.dev/latest/concepts/fields/),
and [TypeBox](https://github.com/sinclairzx81/typebox) inform this choice.

**Retain throwing validators and handwritten forms.** This avoids a contract change,
but retains incomplete field errors and duplicates configuration knowledge in each
editor. It does not meet the discovery and shared-rendering goals.

**Expose Zod directly.** A Zod schema could generate input JSON Schema and normalize
its errors into this contract, but publishing library instances couples every
Driver and consumer to that dependency. Serializable descriptions and plain results
keep the public boundary stable across authoring tools.

**Use one generic configuration store and apply operation.** This would obscure the
existing policy version, IAM, snapshot, and worker contracts. Reusing those resource
owners provides generic fields without making validation an authority to mutate or
deploy arbitrary configuration.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16: Proposed Driver configuration contributions and linked the existing TASK-0046 delivery plan.
