---
rfc: ../rfcs/20261120-channel-provider-drivers.md
---

# Implementation plan: Per-provider Channel Drivers in OCC

- **ID:** RFC-20261120-channel-provider-drivers
- **Delivery status:** Implemented; in review
- **Authority:** [Per-provider Channel Drivers proposal](../rfcs/20261120-channel-provider-drivers.md)
- **Source baseline:** `b9517748410b346b10a97fea7e20d81916ae9c1c`

## Outcome and scope

OCC installs the same provider-to-Driver set that Kubernetes Compute receives,
and each directory lookup reaches only its provider's Driver. Lookup requests
without a provider keep reaching Slack. Each Driver declares the schema of its
lookup `context`, and OCC validates against it. Installation YAML selects the bundled Channel Drivers
with an optional `drivers.channel` list.

Slack is the only bundled provider in this change. The contract prepares for
more providers, such as Microsoft Teams; their Drivers are separate changes.

## Delivery

- Contracts: add the required `ChannelDriver.directoryContextSchema()`, add
  optional `context` to `ChannelDirectoryLookupInput`, export
  `ChannelProviderDriver`, and add the `invalid_request` directory reason with
  field details.
- API: accept optional `provider` and `context` in the lookup body. The route
  treats an omitted provider as `slack` and maps `invalid_request` to
  `400 INVALID_REQUEST`.
- OCC: `installChannelDrivers` replaces `channel` selection and refuses a Driver
  without a lookup schema. Directory lookup dispatches by provider and validates
  `context` against the Driver's schema before it reads the Secret. Deployment
  admission runs and rechecks every installed validator, and refuses an Agent that
  enables a channel without an installed Driver, on every Compute.
- Composition: parse `drivers.channel`, build the provider set with
  `createChannelProviders`, and give it to OCC and Kubernetes Compute.
- Slack Driver: declare empty closed schemas for its Installation configuration
  and its lookup context.

## Proof

| Criterion | Test                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| AC-1–AC-3 | `tests/integration/occ-api-channel-directory.test.ts`: "Channel directory lookup reaches only the named provider's Driver" |
| AC-4      | `tests/integration/channel-driver-startup.test.ts`                                                                              |
| AC-5      | `tests/integration/occ-api.test.mjs`: "ordinary deployment admits only the Configuration and Drivers whose channels were validated" |

Existing deployment admission, Secret, Console and real-cluster Slack lookup
tests now install Channel Drivers per provider and keep their assertions.
