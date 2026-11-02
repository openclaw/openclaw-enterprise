# Write a Driver contract

Use the [Driver contract template](../assets/reference-driver.md) when writing or updating a base Driver contract under
`docs/reference/drivers/`. Document the shared capability rather than a concrete
backend. Inspect the exported interface and its actual callers before asserting
behavior. Preserve existing guarantees and incoming anchors when reorganizing a
page; update affected links when an anchor must change.

Use these second-level sections in this order. Add third-level sections
for core operations and optional extensions. Answer the relevant prompts below;
state unsupported behavior explicitly instead of inventing a method or guarantee.

## Overview

Explain the Driver's purpose, its caller, and its observable result. Name what
OCC, this Driver, adjacent Drivers, and external systems own. State current
support and selection scope, linking the shared selection reference. Distinguish
implemented behavior from target design.

## Interface

Link the exported types. Group members under **Properties** and then **Methods**.
In each table, put required members before optional members. Use the exported
type to determine whether the requirement is `Required` or `Optional`. For an
optional member, describe the default or fallback and which features are
unavailable when it is absent. Do not describe an optional member as required
for a feature. For each method, explain the caller, inputs, result, side effects,
and failures that affect the caller.

Do not duplicate an entire source interface merely to list fields. Include a
small shared-contract example when it clarifies a boundary; keep backend setup
commands in implementation pages.

## IAM

Identify who authenticates callers and who authorizes the exact operation.
Describe the applicable Installation, Namespace, Agent, revision, or other
resource scope, the acting identity, and when authority must be rechecked.
Separate platform authorization from backend credentials and external authority.
State which secret values or safe references cross the boundary and what must
never be returned or logged. Explain denial, revocation, and unavailable-authority
behavior; link canonical IAM policy instead of copying it.

## Lifecycle

Use a Mermaid sequence diagram to show who calls whom and in what order.
Distinguish Driver-instance selection, construction, startup, and shutdown from
the lifecycle of managed resources. Do not imply a destructor exists when the
interface has none. Explain relevant admission, preparation, readiness,
activation, update, stop, retirement, and deletion stages, including callers and
handoffs to other Drivers. Cover idempotency, retry ownership, cancellation,
partial failures, compensation, and the evidence required before proceeding.
State which identity/configuration is frozen and what remains live.

## Configuration

Explain the shared configuration boundary: who supplies the inputs, how they are
validated, and when changes take effect. Distinguish Installation settings from
per-resource configuration and runtime method inputs. Link shared selection and
configuration discovery rules. If the contract defines no common settings, say
so and omit the empty table. Otherwise, use the template's Setting, Type,
Requirement, and Value, default, and constraints columns. Put required settings
first and use only `Required` or `Optional` in the Requirement column. Describe
defaults and omission behavior in the last column. Separate tables by
configuration scope. Document implementation-specific fields and examples in a
`reference/driver/impl` page using the [implementation template](../assets/reference-driver-impl.md).

## Limits

State precise unsupported operations, compositions, or guarantees. Distinguish
shared restrictions from backend limits and development from production support.
Explain selection changes or removal where relevant. Link implementation pages
for their specific quotas, topology constraints, or dependencies.

## Troubleshooting

Describe common contract-level symptoms, the discriminating check, recovery,
and evidence that recovery succeeded. Separate invalid inputs, authorization
denials, dependency failures, and not-ready results. Keep backend error messages
and commands in their implementation references; do not invent failure codes.

## Implementations

List current concrete implementations and link their pages. Add a short support
boundary where useful and link existing comparison matrices. Do not mix flows,
adjacent Driver contracts, or setup instructions into this list.

## Related

Link the owning feature reference, shared selection rules, relevant source
callers, runtime flows, and verification guides. Test fixtures, environment
variables, and coverage notes belong in testing documentation.

## Capability-specific prompts

These are coverage prompts, not new runtime obligations:

- **Compute:** Namespace versus revision operations; gateway versus Harness
  ownership; activation order; readiness; logging; credential helpers; optional
  preflight, endpoints, maintenance, and selected-Driver hooks.
- **Sandbox:** facets; configuration transforms; retained Compute isolation;
  optional Harness provisioning; workload requirements; stable resource identity;
  revision and Namespace cleanup, including an absent workload.
- **Configuration:** validation versus authorization; immutable identity and
  generations; admitted snapshots versus later storage edits; compensation.
- **IAM:** identity lookup versus authorization; decision evidence; missing or
  ambiguous identity; policy freshness, Restrictions, and revocation.
- **Secret:** storage identity versus delivery reference; CRUD and resolution;
  value exposure; effects on already-running consumers.
- **ServiceAccount:** platform versus provider account; separate account creation
  and credential issuance; private bindings; revocation; unsupported rotation.
- **Plugin:** catalog discovery versus selection; admission and snapshots;
  preparation versus installation; approval policy; exported methods versus
  bundled implementation helpers.

## Check the page

Before handoff, verify source claims, relative links, heading anchors, navigation,
formatting, and the repository word budget. Reference checks do not establish
runtime proof. Follow repository rules for documentation-only validation.
