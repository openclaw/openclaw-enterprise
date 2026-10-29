---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: Inspect accepted Installation Driver values

- **ID:** RFC-0025
- **Created:** 2026-10-29
- **RFC PR:** [#4092](https://github.com/openclaw/openclaw-enterprise/pull/4092)
- **Related:** [RFC-0022](0022-driver-configuration-contributions.md)

## Summary

Let Installation administrators inspect the startup values accepted by the
selected Drivers. Each Driver implementation owns a pure projection that returns
only values suitable for administrator inspection. Composition retains that
projection with the selected identity. The existing Installation discovery API
and Console display it under the existing authorization check.

## Motivation

The Console says it shows accepted startup settings, but renders JSON Schema.
For example, the Credential Gateway section describes an array of binaries
instead of showing the configured binary paths. The accepted input already exists
in the process's [startup selections](../../apps/controller/src/composition/installation-config.ts),
but registration forwards only the definition and identity.

[RFC-0022](0022-driver-configuration-contributions.md#discovery-preview-and-editing) deliberately excludes
startup values from discovery. This proposal changes that inspection boundary;
the historical RFC remains intact. It does not introduce configuration editing,
persistence, or another startup lifecycle.

## Proposal

Extend `DriverImplementation<T>` with an optional synchronous
`projectStartupConfiguration(input: Readonly<T>)` method. It returns a JSON object
containing the accepted values that the implementation permits administrators to
inspect. The method must be pure: it cannot read credential files, environment
variables, provider state, or network services. It must omit secret material and
replace confidential or opaque sections with an explicit redaction marker.

The projection receives an isolated, deeply immutable copy of the accepted startup
configuration retained by composition, after successful Driver construction. It must not manufacture values from schema defaults or examples.
Constructor defaults that are absent from that input are not represented as
configured values. The UI describes the result as accepted startup values, not a
complete report of runtime state or every effective default.

Bundled Drivers implement the projection beside their validation contract.
Credential file paths and Kubernetes context names can appear as references;
their contents cannot. OpenShell operator resource bodies and other opaque
payloads must be redacted. Package Drivers without a projection report values
unavailable. An absent projection must never expose raw input as a fallback.

Composition computes and copies the projection for the selected Driver identity.
The registry retains only that inspected JSON object, not the raw startup input.
Changing the operator's startup file later does not change the reported values
until the process restarts. Persisted Driver records are not the source of values.
Invalid projection results or projection failures yield unavailable values without
returning exception text or input. Inspection failure must not stop an otherwise
valid Driver from starting.

`GET /installation/driver-configurations` keeps its Installation `administer`
check. Its descriptors add optional `startupConfiguration` for projected values.
Missing values mean inspection is unavailable; `{}` means the available projection
is empty. Confidential sections use a redaction marker rather than disappearing. Existing identity, scope, key, schema, and action
fields retain their meanings. Agent configuration discovery remains unchanged.
There are no new write operations or grants.

The Console renders the projected object in each existing expandable Driver
section. It shows a clear unavailable message when values are absent and explains
that changes require operator-managed startup configuration and a restart.

## Alternatives

Copying raw accepted configuration would expose opaque package and resource
payloads. Schema validation establishes admissibility, not permission to disclose.
A core list of implementation-specific secret fields would duplicate Driver
ownership and miss newly introduced fields. A Driver-owned projection keeps that
decision with the implementation and fails closed when it is unavailable.

## Delivery and verification

Implement the contract, bundled projections, composition registration, response,
and Console together after submitting this proposal for review. Extend integration
coverage through the real startup and authorized API paths. Prove configured
values differ from schemas, missing projections remain unavailable, opaque or
secret values do not appear, and unauthorized callers cannot inspect values.
Change matching Storybook scenarios and browser coverage; inspect rebuilt previews
and record screenshots and an interaction video. Storybook is simulated UI proof.
Update the owning Driver reference, operator guidance, and execution flow.

The accompanying implementation provides this path through the existing startup
loader, registry, API, and Console. Startup/API integration passes with in-memory
persistence; it does not establish live Kubernetes, gateway, or model execution.
The decision remains Proposed pending human review.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-29: Renumber the provisional RFC-0024 to preserve the ID assigned on main.

- 2026-10-29: Propose Driver-owned inspection of accepted startup values.
