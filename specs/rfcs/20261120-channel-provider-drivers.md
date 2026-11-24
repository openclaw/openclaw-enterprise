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

Today OpenClaw Control Plane (OCC) uses one Channel Driver for every channel
directory lookup, so it cannot serve a second provider such as Microsoft Teams.
With this change, OCC keeps one Channel Driver for each provider and sends each
lookup to the Driver of the provider that the request names. A request without a
provider goes to Slack, so existing clients keep working. Each Driver declares
the lookup fields that its provider needs, and OCC checks a request against them
before it reads the credential. An optional `drivers.channel` Installation
setting selects the Drivers. Slack is the only bundled provider.

## Motivation

The [channel egress RFC](20261118-channel-egress.md) already gives Kubernetes
Compute one Channel Driver for each provider, to allow each Agent's channel
traffic. OCC does not have that list. It selects one `channel` Driver and uses
it for every directory lookup and credential check.

Other providers need inputs that Slack does not. A Microsoft Teams directory
lookup, for example, needs the application ID, the tenant ID and the selected
Team, and its Gateways need operator-approved storage hosts. No current contract
lets a provider declare such lookup fields or Driver settings, so they would
end up in the shared API or in the Compute configuration.

## Goals

- OCC and Kubernetes Compute use the same Channel Drivers.
- A lookup reaches only the Driver of the provider that it names.
- Each Driver declares its provider's lookup fields, and OCC checks them.
- Existing Slack lookups, which name no provider, keep working.
- A Driver's settings belong to its Driver selection, not to other Drivers.

## Non-goals

- Drivers for other providers, such as Microsoft Teams. A separate change can
  add one on this contract.
- Third-party Channel Driver packages. Only bundled Drivers are selectable.
- Typed Secrets. A Secret is not bound to one provider; see
  [Rationale](#rationale-and-alternatives).
- Changes to how channel traffic is allowed. Each Channel Driver still declares
  its provider's hosts, and Envoy allows only those hosts. An optional
  [channel proxy](../../docs/reference/drivers/kubernetes-compute/channel-egress.md#upstream-proxy-configuration)
  only forwards the traffic that Envoy allows.

## Proposal

### Driver selection

At startup, the controller builds a list that maps each provider to its Driver,
for example `slack` to the Slack Driver. It gives the same list to OCC and to
Kubernetes Compute. OCC refuses a list that repeats a provider or a Driver.

The optional `drivers.channel` Installation setting selects the bundled Drivers:

```yaml
drivers:
  channel:
    - id: slack-channel
      configuration: {}
```

| Selection       | Provider | Configuration |
| --------------- | -------- | ------------- |
| `slack-channel` | `slack`  | None.         |

Without `drivers.channel`, the controller installs every bundled Driver. With
it, the controller installs only the listed Drivers. OCC then refuses to deploy
an Agent that enables another provider, on every Compute, because it can neither
check that provider's credentials nor own its traffic. Kubernetes Compute also
refuses such an Agent Configuration at save. Each Driver's
configuration has a closed schema, so startup refuses unknown fields. A later
provider can add its own settings, such as Teams storage hosts.

### Directory lookup

A lookup request can name its `provider`. A request without one goes to Slack,
so clients written before this change, including a Console tab that is open
during an upgrade, keep working. OCC checks the caller and the Secret as it does
today, then selects the Driver for the provider. If no Driver is installed for
the provider, OCC returns `501 NOT_IMPLEMENTED`, as it does today when no
Channel Driver is installed.

Optional `context` holds the provider's lookup fields, such as a tenant ID. Each
Driver declares these fields with `directoryContextSchema()`, a closed JSON
Schema. OCC checks `context` against it before it reads the Secret. A request
that does not match gets `400 INVALID_REQUEST`, which names a missing or
malformed field and reports an unknown key as `/context`. Slack declares no
fields, so an empty `context` passes and any key is refused. A Driver can still
refuse input that a schema cannot express, such as a cursor from another
lookup; that refusal comes after OCC reads the Secret and calls the Driver.

### Credential checks at deployment

At deployment, OCC runs the credential check of every installed Driver. Each
Driver checks only its own provider's settings and skips them when the
provider is off. If an installed Driver or its check changes before the
revision is recorded, OCC refuses the deployment.

## Interface changes

### APIs

| Change  | Operation                                                 | Behavior and contract change                                                                                                                                                  |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed | `POST /namespaces/{namespaceId}/channel-directory/lookup` | Optional `provider`; without it, the lookup goes to Slack. Optional `context`: at most eight nonsecret strings. An uninstalled provider returns `501 NOT_IMPLEMENTED`. |

### IAM

No changes. A lookup still needs edit permission on its target and `operate` on
the same-Namespace Secret.

### Database entities

No changes.

### Driver contracts

- [`ChannelDriver`](../../packages/contracts/src/drivers/channel/index.ts) gets
  the required `directoryContextSchema(): JSONSchema`, a closed object schema
  for the provider's lookup fields. OCC refuses to install a Driver without it,
  or with a schema that is open or that the Driver configuration schema rules
  refuse.
- `ChannelDirectoryLookupInput` gets the checked
  `context?: Readonly<Record<string, string>>`. It does not get `provider`.
- `ChannelDirectoryError` gets the `invalid_request` reason, with optional field
  details. OCC returns it as `400 INVALID_REQUEST`.
- `ChannelProviderDriver` moves to the top-level index of the contracts package.
- `installChannelDrivers` replaces the single `channel` Driver selection.
- `validateCredentials` must read only its own provider's settings.

## Simplifications

OCC uses the provider list that Compute already has. It does not need a combined
Driver that forwards each request to the correct provider.

## Acceptance Criteria

- **AC-1 — A lookup reaches one provider:** With two providers installed, a
  lookup through the API reaches only the named provider's Driver, with its
  context. A lookup for an uninstalled provider returns `501 NOT_IMPLEMENTED`.
- **AC-2 — Requests without a provider go to Slack:** A search or saved-ID
  lookup without `provider` reaches the Slack Driver.
- **AC-3 — OCC checks declared lookup fields:** A lookup that misses a required
  field, or sends a value the schema refuses, gets `400 INVALID_REQUEST` that
  names the field. OCC does not read the Secret or call the provider. Any key
  in a Slack lookup's context is refused the same way.
- **AC-4 — Selection controls installation:** With an empty `drivers.channel`,
  OCC refuses to deploy an Agent that enables Slack, on SSH Compute as on
  Kubernetes Compute, which also refuses to save that Configuration. An Agent
  with Slack off still deploys. Unknown or malformed settings stop startup.
- **AC-5 — Every installed credential check gates deployment:** With two
  providers installed, deployment runs both checks. A change to either Driver
  or its check before the revision is recorded refuses the deployment.

## Delivery and verification

The [implementation plan](../plans/20261120-channel-provider-drivers.md) records
delivery and the tests for each criterion. AC-1 to AC-3 run through the real API,
OCC and Slack Driver, with an HTTP stand-in for Slack. AC-4 runs through the
real Installation loader, the API, and the Kubernetes and SSH Compute Drivers.
AC-5 runs through real deployment admission.

## Rationale and alternatives

- **Add `provider` to the Driver input.** Each Driver would get a field that the
  controller already decides, and a combined Driver would have to forward each
  request. Rejected.
- **Require `provider` in the API.** Existing Slack clients do not send it, so
  their lookups would fail with `400` after an upgrade. Rejected after
  maintainer review.
- **A separate API body for each provider.** The API and OCC would change for
  each new provider. Rejected.
- **Drivers check `context` in their own code.** Each Driver repeats the same
  checks, and nothing can read which fields a provider needs. Rejected after
  maintainer review.
- **One schema for the whole channel setup,** including Agent configuration and
  Secret bindings. The native plugin already owns the `channels.*` schema, and
  the Console editors cannot be built from such a schema, so nothing would use
  it. A later proposal can extend the method if something needs it.
- **Name the method `provideConfiguration()`.** That name suggests the Driver's
  Installation settings. `directoryContextSchema()` says what it covers.
- **Bind a Secret to one provider.** Secrets have no type. A caller with
  `operate` on a Secret can already use it in any provider's Agent
  configuration, so a lookup with another provider gives no new access. A
  Secret type is a separate decision.

## References

- [Driver selection](../../docs/reference/drivers/selection.md)
- [Plugin Driver installation](../../packages/occ/src/index.ts), an existing
  case of one Driver for each entry (`installPluginDrivers`)
