---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Shared Driver configuration definitions

- **ID:** RFC-0022
- **Created:** 2026-10-16
- **Last updated:** 2026-10-19
- **Implementation plan:** [TASK-0046](../plans/0046-driver-configuration-contributions.md)

## Decision and scope

Use one typed configuration definition for Installation Driver startup settings
and Agent runtime network-policy settings. Each definition supplies a schema,
complete validation, and field errors for callers and the console. Values retain
their existing owners: operator-managed startup configuration and OCC-managed
SandboxPolicy resources. This shares definition and validation, not persistence;
it does not add Installation hot reconfiguration or a generic configuration store.

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
  validateConfiguration(input: unknown): ConfigurationResult<T>;
}

type ConfigurationResult<T> =
  | { success: true; data: T }
  | { success: false; error: { details: readonly [ErrorDetail, ...ErrorDetail[]] } };
```

`DriverImplementation<T>` uses this definition for startup. Bundled static members
and package exports keep their existing shape; factories receive the validated
`T`. Composition keeps the definition alongside each selected Driver. Update API,
worker, package, and direct-construction callers together; remove legacy `void`
validation. Invalid results or unexpected exceptions fail closed before construction.

Use the installed TypeBox facilities (`Check`/`Errors` from `typebox/value`) and
schema-inferred types. Definitions expose serializable schemas supported by that
installed version; unsupported schemas fail registration. Do not introduce a
separate JSON Schema dialect or validator framework. Collect structural errors
first; run semantic validation only after structural success. Validation is
synchronous, deterministic, and side-effect-free, with no coercion, default
insertion, or field stripping. Closed objects reject unknown fields.

Reuse [ErrorDetail](../../packages/contracts/src/api/common.ts): JSON Pointer
`path`, existing uppercase `code`, an additive optional safe `message`, and only
needed semantic codes such as `INVALID_RANGE` and `OUTSIDE_CEILING`. Configuration
errors supply messages. Keep escaped keys, array indices, root pointers, and
multiple errors at a path. Preserve the wire error-count bound. Messages and paths
must not expose submitted secrets, sensitive dynamic keys, or exception details.
Use `error.details` for preview and mutation refusals; retain mutation error codes.

## Runtime policy integration

Add one optional `networkPolicyConfiguration` definition to the Sandbox Driver
contract, required when its existing `networkPolicy` capability is advertised.
Its value is `{ additions: SandboxNetworkGrant[] }`, using #2599's schema and
semantic rules for IDs, paths, DNS names, and ranges. There is no contribution
registry, scope dispatch, or implementation-name check.

OCC authorizes the exact Agent and policy, validates the definition, then enforces
the current ceiling and wildcard/range capabilities. The Driver checks provider
representability. Keep `admitNetworkPolicy` returning `SandboxPolicySnapshot`;
expected provider refusals throw a shared `ConfigurationValidationError` carrying
`error.details`. Unexpected exceptions fail closed with sanitized diagnostics.
OCC supplies the next version and defaults. Save, revision admission, and worker
rechecks retain current version, immutable snapshot, and application invariants.

## Discovery, preview, and editing

- `GET /installation/driver-configurations` requires Installation `administer` and
  returns selected startup schemas identified by capability, Driver ID, and
  implementation. It never returns startup values or executable validators.
- Existing policy GET adds the selected schema and current edit/apply permission
  availability while retaining its exact read authorization and existing fields.
  Unsupported policy configuration returns no schema; support, editing state, and
  pending work also control available actions.
- Add `POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/validate`
  beside the existing facet routes. Accept save's `{ expectedVersion, additions }`
  envelope, run the same exact `manage_policy`/policy `update` checks and admission,
  and return `ConfigurationResult` in `{ data, meta }` without policy or job writes.

Preview routing validates the envelope and `expectedVersion`, leaving `additions`
for the shared validator. Structurally invalid additions therefore return HTTP 200
with field errors; malformed envelopes retain HTTP 400. Authorization failures,
stale versions, disabled editing, and pending application retain their resource errors. Save repeats admission under its
concurrency checks; preview success grants no future authority. Preserve save/apply
bodies, responses, and attributable mutation and denial audits.

The Installation administration surface inspects schemas. The Agent editor renders
primitive, enum, object, and array fields with schema help and constraints, plus
schema-aware JSON editing for shapes the form cannot render. Descriptions are
text; credentials continue through Secret references. Preserve defaults, ceilings,
recommendations, and Save versus Save and apply. Display field/root errors, retain
failed drafts, discard responses for superseded drafts or versions, and offer
reload/review for conflicts. Validation never marks a draft saved or applied.

## Tradeoffs and required proof

Shared definitions replace duplicated forms and throwing startup validation.
Explicit Sandbox integration keeps existing resource boundaries visible; a generic
registry/store would add dispatch and lifecycle rules without another caller.
TypeBox reuses the installed schema/type tooling instead of adding Zod or another
public library contract.

[TASK-0046](../plans/0046-driver-configuration-contributions.md) owns implementation
and proof: invalid startup never constructs Drivers; previews cannot mutate;
stale versions, revoked permissions, and changed ceilings still refuse save/apply.
The real OpenShell Agent workflow must prove denial, permitted save/application,
and revocation while a second Agent stays denied. Browser and rebuilt Storybook
media must show errors, conflicts, draft retention, and save/application states.
UI fixtures alone do not establish runtime enforcement.

This proposal remains specification-only and unimplemented.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16: Proposed Driver configuration contributions and linked the existing TASK-0046 delivery plan.
- 2026-10-19: Simplified to shared definitions and explicit Sandbox integration on merged #2599; reused field errors and snapshot admission; renumbered RFC-0021 to RFC-0022 after the Runtime contract RFC landed.
