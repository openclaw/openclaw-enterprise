---
kind: reference/driver
---

# ChannelDriver contract

## Overview

`ChannelDriver` declares provider network destinations, validates configured
credentials and looks up provider identities for an authorized Namespace edit.
OpenClaw Control Plane (OCC) owns caller authorization, credential access, and the
saved Agent or Configuration. The Driver owns the provider request and returns
display candidates with stable provider IDs. It does not send messages
or grant channel access. The current controller selects the bundled Slack
implementation for directory lookup; see [Driver selection](selection.md).

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
Driver identity and `lookupDirectory({ token, kind, query?, cursor?, ids? })`. `kind`
selects users or channels. `ids` resolves saved IDs directly and cannot be
combined with a search query or cursor. The method returns workspace identity, candidates,
an optional next cursor, and `complete`. A returned name is a display hint;
callers save IDs. A missing selected Driver makes lookup unavailable.

The optional `validateCredentials(values, withSecret)` method checks configured
channel credentials before API provisioning or deployment. Its credential reader,
`withSecret(binding, path, validate)`, authorizes the exact same-Namespace binding and supplies its value
to the validation callback. Slack credentials select a ready static OCC-owned
Credential Source for a qualified dedicated Kubernetes Gateway.
OCC resolves the Source through CredentialService and repeats exact caller
authorization, Source ownership and delivery qualification after resolution.
For deployment, OCC also checks that the Agent is Dedicated and still selects
the prepared Configuration generation and exact Source binding before owner
resolution and before the provider request.
Provider calls run before the write
transaction. Deployment admission retains the Configuration and selected Driver
identities that were checked and rejects changes before recording a revision.
Validation does not pin credential versions or revalidate queued work.

## IAM

For validation, OCC admits the caller, checks Agent creation or deployment,
and requires `operate` on the exact same-Namespace Source. OCC checks the qualified
Compute and CredentialService pair and rechecks authority and Source ownership after
CredentialService returns.

The directory API accepts `sourceId` for a ready static Source.
OCC checks Agent create or exact Agent/Configuration update and Source `operate`,
qualifies the selected OCC CredentialService and Kubernetes Compute pair, repeats exact
authority before resolution, and rechecks authority, readiness, and owner after
resolution. The ChannelDriver
receives the value in process and authenticates to its provider. No credential value
appears in an HTTP response, audit event, or Console script. Provider access does not
grant OCC permissions.

## Lifecycle

Composition binds installed Channel Drivers to provider IDs. The worker derives
the enabled providers' current requirements from each saved Agent revision on
every deployment attempt. It does not persist a separate rule snapshot. Lookups are read-only and
make no platform state change. They use the current selected Source and can be
retried after a transient provider failure. Saving a selected ID remains the
Agent or Configuration update's responsibility. A later credential replacement may
change the provider workspace. The interface has no cleanup hook.

## Limits

Validation does not establish runtime connectivity. Provider pagination can
leave a search incomplete; callers must use `nextCursor` before concluding a
name is missing or unique. Exact-ID lookup can leave inaccessible IDs without
a label. `complete` describes provider pagination, not the credential's
visibility into every workspace resource.

## Troubleshooting

If lookup is denied, check the exact edit permission and Source `operate` grant.
If the provider rejects the call, check the selected token and its directory
scopes. If results are incomplete, load the next page or enter a known exact ID.
A successful lookup does not prove the bot can post to a channel.

## Implementations

- [Bundled Slack Channel Driver](slack-channel.md) uses a Slack bot token for
  user and channel directory reads.

## Related

- [SecretDriver contract](secret.md)
- [Credential Sources](../credential-sources.md)
- [Channel directory lookup flow](../../flows/agent-channel-directory.md)
