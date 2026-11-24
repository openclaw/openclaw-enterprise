---
status: Proposed
implementation_status: Implemented
author: miguelbranco80
---

# Proposal: Per-provider Channel Drivers in OCC

- **ID:** RFC-20261120-channel-provider-drivers
- **Created:** 2026-11-20
- **Last updated:** 2026-11-24
- **Implementation plan:** [RFC-20261120-channel-provider-drivers plan](../plans/20261120-channel-provider-drivers.md)
- **Related:** [RFC-20261118-channel-egress](20261118-channel-egress.md),
  [ChannelDriver contract](../../docs/reference/drivers/channel.md)

## Summary

OpenClaw Control Plane (OCC) installs one Channel Driver for each channel
provider, the same provider-to-Driver set that Kubernetes Compute already
receives. A directory lookup names its provider, and OCC sends the request only
to that provider's Driver. A lookup without a provider is a Slack lookup, so
existing Slack clients keep working. Each Channel Driver declares the schema of
its provider's lookup fields, and OCC validates a lookup's optional `context`
against it before any credential read or provider call.
Installation YAML gets an optional `drivers.channel` list that selects the
bundled Channel Drivers and carries their configuration. Slack is the only
bundled provider; the contract prepares OCC for more, such as Microsoft Teams.

## Motivation

[RFC-20261118-channel-egress](20261118-channel-egress.md) maps each enabled
provider to exactly one installed Channel Driver for Compute admission and
egress. OCC still selects a single `channel` Driver for directory lookup and
credential validation. That shape assumes one provider.

Other providers need inputs that Slack does not. A Microsoft Teams directory
lookup, for example, needs the application ID, the tenant ID and the selected
Team, and its Gateways need operator-approved storage hosts. No current contract
lets a provider declare such lookup fields or Driver settings, so they would
end up in the shared API or in the Compute configuration.

## Goals

- OCC and Compute use the same provider-to-Driver set from trusted composition.
- A lookup reaches only the Driver of the provider that it names.
- Each provider defines and validates its own lookup fields.
- Existing Slack lookup requests, which name no provider, keep working.
- Channel Driver configuration has one owner: its Driver selection.

## Non-goals

- Drivers for other providers, such as Microsoft Teams. A separate change can
  add one on this contract.
- Third-party Channel Driver packages. Only bundled Drivers are selectable.
- Typed Secrets. A Secret is not bound to one provider; see
  [Rationale](#rationale-and-alternatives).
- Changes to destination rules, Envoy enforcement or listener allocation. An
  [Agent Gateway channel proxy](../../docs/reference/drivers/kubernetes-compute/channel-egress.md#upstream-proxy-configuration)
  applies to each provider's destinations unchanged; Channel Drivers still
  declare them.

## Proposal

### Composition

Trusted composition builds one `ChannelProviderDriver` (`{ provider, driver }`)
for each selected Channel Driver. It gives the same frozen list to Kubernetes
Compute and to OCC. OCC refuses a list that repeats a provider or a Driver
identity, as it does for Plugin Drivers.

`drivers.channel` is an optional list of bundled selections:

```yaml
drivers:
  channel:
    - id: slack-channel
      configuration: {}
```

| Selection       | Provider | Configuration         |
| --------------- | -------- | --------------------- |
| `slack-channel` | `slack`  | Empty, closed schema. |

If the list is absent, composition installs every bundled Driver with default
configuration. If the list is present, composition installs only the listed
Drivers; an Agent that enables another provider fails admission because no
Driver resolves it. Each Driver declares a closed configuration schema, so
startup refuses unknown fields. The startup configuration inspection reports
the accepted values, like other Driver selections. A later provider's selection
can carry its own settings, such as Teams storage hosts.

### Directory lookup

A request without `provider` is a Slack lookup, so clients written before
provider selection, including a Console tab open during an upgrade, keep
working. OCC authorizes the caller and the Secret as it does today, then
selects the provider's Driver. An uninstalled provider is unavailable, not a
provider error.

Optional `context` carries the provider's own lookup fields, such as a tenant
ID. The shared API defines only its bounded shape. Each Driver declares its
provider's fields with `directoryContextSchema()`, a JSON Schema like Driver
configuration schemas. OCC validates `context`, an absent one as `{}`, against
it before the Secret read and returns `400 INVALID_REQUEST` with the refused
field paths. Slack declares a closed empty schema, so any context is refused.
The Driver keeps only checks that a schema cannot express, such as a cursor
from another lookup.

### Credential validation and deployment admission

OCC runs `validateCredentials` for each installed Driver that implements it. A
validator reads only its own provider's configuration section and returns when
that section is absent or disabled. Deployment admission records the installed
Driver list and validator identities that it checked, and it refuses the
deployment if they changed before the revision is recorded.

## Interface changes

### APIs

| Change  | Operation                                                 | Behavior and contract change                                                                                                                                                                    |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed | `POST /namespaces/{namespaceId}/channel-directory/lookup` | Search and ID hydration bodies accept optional `provider`; omitted means `slack`. Optional `context` holds at most eight nonsecret strings. An uninstalled provider returns `501 NOT_IMPLEMENTED`. |

### IAM

No changes. Lookup still requires the target edit permission and `operate` on
the exact same-Namespace Secret.

### Database entities

No changes.

### Driver contracts

- [`ChannelDriver`](../../packages/contracts/src/drivers/channel/index.ts)
  gains the required `directoryContextSchema(): JSONSchema`. It describes the
  provider's lookup fields; OCC validates `context` against it. OCC refuses to
  install a Channel Driver without it.
- `ChannelDirectoryLookupInput` gains the validated
  `context?: Readonly<Record<string, string>>`, and no `provider` field.
- `ChannelDirectoryError` gains the `invalid_request` reason, with optional
  field details, which OCC returns as `400 INVALID_REQUEST`.
- `ChannelProviderDriver` moves to the contracts package's top-level index.
- `installChannelDrivers` replaces single-Driver `channel` selection.
- `validateCredentials` must read only the Driver's own provider section.

## Simplifications

OCC reuses the provider mapping that Compute already has, instead of a
composite Driver that dispatches internally and reports every provider's
destinations as its own.

## Acceptance Criteria

- **AC-1 — Lookup reaches one provider:** Given two installed providers, when
  an authorized caller looks up one provider through the real API, then only
  that provider's Driver receives the request, with its context. A lookup for
  an uninstalled provider returns `501 NOT_IMPLEMENTED`. Verify with the OCC
  API channel directory integration test.
- **AC-2 — Provider-less requests stay Slack:** When a caller omits `provider`
  in a search or ID hydration request, then the Slack Driver serves it. Verify
  with the OCC API channel directory integration test.
- **AC-3 — Drivers declare their lookup fields:** When a lookup omits a field
  that its provider's Driver declares as required, or sends a value that the
  schema refuses, OCC returns `400 INVALID_REQUEST` naming the field, without a
  credential read or provider call. A Slack lookup, with or without `provider`,
  that has any context is refused the same way. Verify with the OCC API channel
  directory integration test.
- **AC-4 — Selection controls installation:** Given an empty `drivers.channel`
  list, when an Agent enables Slack, then routing resolution refuses it.
  Unknown or malformed configuration fails startup. Verify with the Channel
  Driver startup integration test.

## Delivery and verification

The [implementation plan](../plans/20261120-channel-provider-drivers.md)
records delivery. AC-1 to AC-3 pass through the real Fastify API, OCC and the
Slack Driver, with an HTTP fixture at the Slack boundary; AC-4 passes through
the real Installation loader.

## Rationale and alternatives

- **Provider field in the Driver input.** Every Driver would receive a field
  that composition already decides. It also needs a composite Driver to
  dispatch. Rejected.
- **Require `provider` in the API.** Existing Slack clients omit it; requiring
  it turns their searches and saved-ID lookups into `400` responses after an
  upgrade. Rejected after maintainer review.
- **Typed provider fields in the API.** The API and OCC would change for each
  new provider. Rejected.
- **Drivers check their own context in code.** Each Driver repeats key and
  format checks, and nothing can read which fields a provider requires.
  Rejected after maintainer review.
- **One schema for the whole channel setup,** including Agent configuration
  and Secret bindings. The native plugin already owns the `channels.*` schema,
  and the Console editors cannot be rendered from it, so nothing would read it.
  A later proposal can extend the method if a caller needs it.
- **Name `provideConfiguration()`.** It suggests the Driver's Installation
  configuration; `directoryContextSchema()` states what it covers.
- **Bind a Secret to one provider.** Secrets are untyped. A caller with
  `operate` on a Secret can already bind it into any provider's Agent
  configuration and deploy it, so a lookup with another provider grants no new
  authority. A Secret type is a separate decision.

## References

- [Driver selection](../../docs/reference/drivers/selection.md)
- [Plugin Driver installation](../../packages/occ/src/index.ts), the existing
  multi-Driver precedent (`installPluginDrivers`)
