---
status: Proposed
implementation_status: Partially implemented
author: kevinlin-openai
---

# Proposal: Discoverable Driver configuration contributions

- **ID:** RFC-0022
- **Created:** 2026-10-16
- **Last updated:** 2026-10-20
- **Implementation plan:** [TASK-0046](../plans/0046-driver-configuration-contributions.md)

## Decision and scope

Use one typed configuration definition for Installation Driver startup settings
and Agent runtime network-policy settings. A generic contribution registry exposes
available configuration to the console and dispatches by `scope` and `key`. Each
definition supplies a schema and semantic checks that return field errors. The
platform owns structural validation. Values retain
their existing owners: operator-managed startup configuration and OCC-managed
SandboxPolicy resources. This shares definition and validation, not persistence;
it does not add Installation hot reconfiguration or a generic configuration store.
Integrating the operator ceiling with configuration discovery is deferred to a
separate RFC; existing ceiling enforcement remains required.

[PR #2599](https://github.com/openclaw/openclaw-enterprise/pull/2599) merged on
2026-10-19 at `141515257737cccdb75137fabbeec707915856af`. Its
[policy workflow](../../docs/reference/sandbox-policies.md) supplies the runtime
caller. Today [Driver startup validation](../../apps/controller/src/composition/installation-config.ts)
reports the first schema mismatch, then calls a throwing semantic validator;
policy fields are handwritten. Shared definitions remove that duplication without
changing policy ownership, authorization, or application.

## Definition and validation

Export through the existing contracts entry point:

```ts
interface ConfigurationDefinition<T> {
  readonly configurationSchema: JSONSchema;
  validateConfiguration(input: Readonly<T>): readonly ErrorDetail[];
}

type ConfigurationResult<T> =
  | { success: true; data: T }
  | { success: false; error: { details: readonly [ErrorDetail, ...ErrorDetail[]] } };
```

`DriverImplementation<T>` uses this definition for startup. Bundled static members
and package exports keep their existing shape; factories receive the validated
`T`, not a replacement value returned by a Driver. Composition keeps the definition
alongside each selected Driver. Update API,
worker, package, and direct-construction callers together; remove legacy `void`
validation. An empty error list means semantic success. Malformed lists and
unexpected exceptions fail closed before construction. `ConfigurationResult<T>`
is the platform result used by preview; it is not the Driver callback contract.

Use the installed TypeBox facilities (`Check`/`Errors` from `typebox/value`) and
schema-inferred types. Definitions expose serializable schemas supported by that
installed version; unsupported schemas fail registration. Do not introduce a
separate JSON Schema dialect or validator framework. Collect structural errors
once per admission call; invoke semantic checks only after structural success,
with an isolated, frozen copy. The platform validates the returned error list and
returns the original input on success. It does not validate replacement data or
compare returned configuration values. Independent constructor entry points retain
their own admission checks. Validation is
synchronous, deterministic, and side-effect-free, with no coercion, default
insertion, or field stripping. Closed objects reject unknown fields.

Reuse [ErrorDetail](../../packages/contracts/src/api/common.ts): JSON Pointer
`path`, existing uppercase `code`, an additive optional safe `message`, and only
needed semantic codes such as `INVALID_RANGE` and `OUTSIDE_CEILING`. Configuration
errors supply messages. Keep escaped keys, array indices, root pointers, and
multiple errors at a path. Preserve the wire error-count bound. Messages and paths
must not expose submitted secrets, sensitive dynamic keys, or exception details.
Use `error.details` for preview and mutation refusals; retain mutation error codes.

## Contribution registry and dispatch

Extend the implementation contract with named contributions:

```ts
interface ConfigurationContribution<T = unknown> extends ConfigurationDefinition<T> {
  readonly scope: "installation" | "agent";
  readonly key: string;
}

interface DriverImplementation<TStartup = unknown> extends ConfigurationDefinition<TStartup> {
  readonly configurationContributions?: readonly ConfigurationContribution[];
}
```

Composition registers each selected Driver's startup definition as
`(installation, startup)` and its declared contributions alongside it. Registry
identity is `(capability, driverId, scope, key)`; implementation names are metadata,
not dispatch keys. Keys are nonempty, unique per scope within an implementation,
and stable across its instances. `startup` is reserved for composition.

OCC registers resource-owner bindings by `(capability, scope, key)`. A binding
selects the applicable Driver from server-owned resource context and supplies
read, preview, save, and apply operations that the owner supports. The registry
resolves the exact contribution and binding before dispatch; it never chooses a
Driver from untrusted configuration values. Unknown scopes, duplicate identities,
unsupported schemas, or contributions without a binding fail registration.
Unsupported request identities fail explicitly without fallback.

This delivery binds Installation startup inspection for selected Drivers and
`(sandbox, agent, sandbox-network-policy)` to SandboxPolicy. Additional bindings
extend this same registry; they require an existing resource owner and its IAM
and lifecycle integration, not a new generic persistence layer. The existing
Configuration Driver continues to render native runtime configuration.

## Runtime policy integration

A Sandbox implementation advertising `networkPolicy` must contribute
`(agent, sandbox-network-policy)`, with value `{ additions: SandboxNetworkGrant[] }`.
Use #2599's schema and semantic rules for IDs, paths, DNS names, and ranges. Resolve
this definition through the registry. Dispatch uses the Sandbox capability and
contribution key, without an OpenShell implementation-name check.

OCC authorizes the exact Agent and policy, validates the definition, then enforces
the current ceiling and wildcard/range capabilities. The Driver checks provider
representability. Keep `admitNetworkPolicy` returning `SandboxPolicySnapshot`;
expected provider refusals throw a shared `ConfigurationValidationError` carrying
`error.details`. Unexpected exceptions fail closed with sanitized diagnostics.
OCC supplies the next version and defaults. Save, revision admission, and worker
rechecks retain current version, immutable snapshot, and application invariants.

## Discovery, preview, and editing

OCC exposes one `discoverConfigurations(principalId, context)` method. Its context
is tagged by `scope`: Installation uses the server-selected singleton; Agent uses
`namespaceId` and `agentId`. It resolves selected Drivers, filters registered
contributions by scope and owner authorization, and returns contextual descriptors.
Both HTTP discovery routes use this method and return
`{ data: { configurations: [...] }, meta }` with one descriptor shape:

```ts
interface DriverConfigurationDescriptor {
  readonly capability: DriverCapability;
  readonly driverId: string;
  readonly implementation: string;
  readonly scope: "installation" | "agent";
  readonly key: string;
  readonly configurationSchema: JSONSchema;
  readonly binding: "installation-startup" | "sandbox-policy";
  readonly actions: Partial<
    Record<
      "read" | "validate" | "save" | "apply",
      {
        readonly method: "GET" | "POST" | "PUT";
        readonly href: string;
        readonly available: boolean;
      }
    >
  >;
}
```

Bindings supply same-origin resource URLs, methods, and current availability;
Drivers cannot supply executable UI or arbitrary action URLs. `binding` selects
the owner's request envelope and lifecycle controls, while the schema drives
fields. Extending the binding catalogue requires its owner adapter; another
Driver using a supported binding requires no new console form or dispatch branch.

- `GET /installation/driver-configurations` requires Installation `administer`.
  It discovers all selected startup definitions, with scope `installation` and
  key `startup`. Entries support schema inspection, with no API mutation actions.
- `GET /namespaces/{namespaceId}/agents/{agentId}/driver-configurations` first
  authorizes the exact Agent read, then includes only applicable contributions
  whose owner-specific read checks pass. An empty list means none are available
  to that caller. Each SandboxPolicy facet gets its own contextual action URLs;
  when facets share a Driver and contribution, distinguish them by their read URL.
- Existing policy GET retains its fields and exact read authorization and includes
  the same contextual descriptor when supported; otherwise it omits the descriptor.
  Discovery never returns startup values or
  executable validators. Runtime values come from the authorized owner read.
- Add `POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/validate`.
  It resolves `(agent, sandbox-network-policy)` through the registry and accepts
  save's `{ expectedVersion, additions }` envelope. Run the same exact
  `manage_policy`/policy `update` checks and admission; return `ConfigurationResult`
  in `{ data, meta }` without policy or job writes.

Every action repeats authorization and resolves the current server-selected
Driver and binding. Discovery availability is a UI hint, not an authorization
capability. Support, editing state, and pending work also control availability.
The registry routes to existing owners; generic write endpoints are unnecessary.

Preview routing validates the envelope and `expectedVersion`, leaving `additions`
for the shared validator. Structurally invalid additions therefore return HTTP 200
with field errors; malformed envelopes retain HTTP 400. Authorization failures,
stale versions, disabled editing, and pending application retain their resource errors. Save repeats admission
under its concurrency checks; preview success grants no future authority. Preserve save/apply
bodies, responses, and attributable mutation and denial audits.

The console discovers sections from these descriptors instead of enumerating
Driver implementations or contribution keys. Installation administration inspects
schemas; the Agent editor uses owner controls and renders
primitive, enum, object, and array fields with schema help and constraints, plus
schema-aware JSON editing for shapes the form cannot render. Descriptions are
text; credentials continue through Secret references. Preserve defaults, ceilings,
recommendations, and Save versus Save and apply. Display field/root errors, retain
failed drafts, discard responses for superseded drafts or versions, and offer
reload/review for conflicts. Validation never marks a draft saved or applied.

## Tradeoffs and required proof

Shared definitions replace duplicated forms and throwing startup validation.
The registry makes available configuration discoverable across Drivers and scopes,
while explicit owner bindings preserve resource boundaries. A separate generic
store would duplicate persistence and lifecycle authority.
TypeBox reuses the installed schema/type tooling instead of adding Zod or another
public library contract.

[TASK-0046](../plans/0046-driver-configuration-contributions.md) owns implementation
and proof: invalid startup never constructs Drivers; previews cannot mutate;
stale versions, revoked permissions, and changed ceilings still refuse save/apply.
Discovery must prove authorized filtering, distinct Driver/facet routing, rejected
registrations, and UI rendering without implementation-specific forms. The real
OpenShell Agent workflow must prove denial, permitted save/application,
and revocation while a second Agent stays denied. Browser and rebuilt Storybook
media must show errors, conflicts, draft retention, and save/application states.
UI fixtures alone do not establish runtime enforcement.

The accompanying implementation provides both scopes, shared validation, owner
bindings, and schema-driven editing. [TASK-0046](../plans/0046-driver-configuration-contributions.md)
records the focused real Agent policy lifecycle passing without skips and the
remaining delivery work. Independent review, media publication, and merge remain
separate gates; local implementation and proof do not establish release readiness.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16: Proposed Driver configuration contributions and linked the existing TASK-0046 delivery plan.
- 2026-10-19: Simplified to shared definitions and explicit Sandbox integration on merged #2599; reused field errors and snapshot admission; renumbered RFC-0021 to RFC-0022 after the Runtime contract RFC landed.
- 2026-10-19: Restored the generic contribution registry, scope/key dispatch, and contextual UI discovery; deferred ceiling configuration integration to a separate RFC.

- 2026-10-20: Assigned structural validation and accepted input ownership to the platform; Driver semantic callbacks return only field errors.
