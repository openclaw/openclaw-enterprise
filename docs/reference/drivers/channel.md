---
kind: reference/driver
---

# ChannelDriver contract

## Overview

`ChannelDriver` declares provider network destinations, validates configured
credentials and looks up provider identities for an authorized Namespace edit.
OpenClaw Control Plane (OCC) owns caller authorization, Secret access, and the
saved Agent or Configuration. The Driver owns the provider request and returns
bounded display candidates with stable provider IDs. It does not send messages
or grant channel access. Each implementation serves one channel provider; see
[Installation selection](#installation-selection).

## Interface

The required `enableRouting(): readonly NetworkDestinationRule[]` method declares
TCP destinations. It is deterministic, takes no credentials and has no
infrastructure effects. Empty results grant no destinations; exceptions reject
activation. Trusted composition must resolve each enabled provider to exactly
one installed Driver. Compute owns enforcement and cleanup.

The [shared schema and validator](../../../packages/contracts/src/network-destination.ts)
accept DNS rules with `match: exact` or `subdomains`, canonical IPv4/IPv6 IPs,
and canonical network CIDRs. DNS names normalize to lowercase ASCII labels;
`subdomains` excludes the apex. Names cannot contain wildcards, URLs, paths or
ports. Each rule has distinct integer TCP ports from 1 through 65535. Malformed
or unsupported forms fail; implementations cannot ignore them. IP literals
require an explicit matching IP or CIDR rule. Installation address restrictions
still apply. See [Kubernetes enforcement limits](kubernetes-compute/channel-egress.md).

The [shared interface](../../../packages/contracts/src/drivers/channel/index.ts) requires a
Driver identity and `lookupDirectory({ token, context?, kind, query?, cursor?, ids? })`.
`kind` selects users or channels. Optional `context` contains the provider's own
lookup fields: at most eight nonsecret strings of at most 200 characters. Each
Driver declares those fields with `directoryContextSchema()`, a closed JSON
Schema object; OCC refuses to install a Driver whose schema is open or that the
Driver configuration schema rules refuse. OCC validates `context`, an absent one as `{}`, against it before it
reads the Secret, and returns `400 INVALID_REQUEST` with details. A missing or
malformed field is named, for example `/context/team`; an unknown key is
reported as `/context`. A provider without lookup fields declares a closed empty
schema: an empty `context` passes and any key is refused. The Driver owns
authentication and pagination, and can refuse input that a schema cannot
express, such as a cursor from another lookup, with the `invalid_request` reason
and field details. That refusal comes after OCC reads the Secret and calls the
Driver. `ids` resolves saved IDs directly and
cannot be combined with a search query or cursor. The method returns workspace
identity, candidates, an optional next cursor, and `complete`. A returned name
is a display hint; callers save IDs.

The lookup request names its `provider`. OCC sends the request only to the
Driver that composition installed for that provider and does not interpret
`context`. A request without `provider` is a Slack lookup, so clients written
before provider selection keep working. A provider without an installed Driver
returns `501 NOT_IMPLEMENTED`.

The optional `validateCredentials(values, withSecret)` method checks configured
channel credentials before API provisioning or deployment. OCC runs it for every
installed Driver, so each Driver reads only its own provider section and returns
when that section is absent or disabled. `withSecret(binding,
path, validate)` authorizes the exact same-Namespace Secret and supplies its value
only inside the SecretDriver callback. Provider calls run before the write
transaction. Deployment admission retains the Configuration and selected Driver
identities that were checked and rejects changes before recording a revision.
Validation does not pin Secret versions or revalidate queued work.

## Installation selection

`drivers.channel` lists the bundled Channel Drivers to install. Each entry has
an `id` and a closed `configuration` object:

```yaml
drivers:
  channel:
    - id: slack-channel
      configuration: {}
```

| ID              | Provider | Configuration |
| --------------- | -------- | ------------- |
| `slack-channel` | `slack`  | None.         |

If you omit `drivers.channel`, startup installs every bundled Driver with
default configuration. If you supply the list, startup installs only the listed
Drivers. OCC refuses to deploy an Agent that enables a channel whose Driver is
not installed, on every Compute. Kubernetes Compute also refuses that Agent
Configuration at save.
Startup refuses an unknown ID, a repeated ID and unknown or invalid
configuration. OCC directory lookup and Compute admission use the same
installed set.

## IAM

OCC admits the caller, checks Agent creation or the exact Agent or Configuration
edit, and requires `operate` on the caller-specified same-Namespace Secret. The
Console supplies its selected bot Secret. OCC reads the value through the
SecretDriver, then rechecks the required target authority, exact Secret/backend
identity, and selected storage Driver before giving that value to the ChannelDriver in-process. The Driver authenticates
to its provider with the token. No Secret value appears in an HTTP response,
audit event, or Console script. Provider access does not grant OCC permissions.

## Lifecycle

Composition binds installed Channel Drivers to provider IDs. The worker derives
the enabled providers' current requirements from each saved Agent revision on
every deployment attempt. It does not persist a separate rule snapshot. Lookups are read-only and
make no platform state change. They use the current selected Secret and can be
retried after a transient provider failure. Saving a selected ID remains the
Agent or Configuration update's responsibility. A later Secret replacement may
change the provider workspace. The interface has no cleanup hook.

## Limits

Validation does not establish runtime connectivity. Provider pagination can
leave a search incomplete; callers must use `nextCursor` before concluding a
name is missing or unique. Exact-ID lookup can leave inaccessible IDs without
a label. `complete` describes provider pagination, not the credential's
visibility into every workspace resource.

## Troubleshooting

If lookup is denied, check the exact edit permission and Secret `operate` grant.
If the provider rejects the call, check the selected token and its directory
scopes. If results are incomplete, load the next page or enter a known exact ID.
A successful lookup does not prove the bot can post to a channel.

## Implementations

- [Bundled Slack Channel Driver](slack-channel.md) uses a Slack bot token for
  user and channel directory reads.

## Related

- [SecretDriver contract](secret.md)
- [Channel directory lookup flow](../../flows/agent-channel-directory.md)
