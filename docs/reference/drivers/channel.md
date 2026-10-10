# ChannelDriver contract

## Overview

`ChannelDriver` validates configured credentials and looks up provider identities for an authorized Namespace edit.
OpenClaw Control Plane (OCC) owns caller authorization, Secret access, and the
saved Agent or Configuration. The Driver owns the provider request and returns
bounded display candidates with stable provider IDs. It does not send messages
or grant channel access. The current controller selects the bundled Slack
implementation for directory lookup; see [Driver selection](selection.md).

## Interface

The [shared interface](../../../packages/contracts/src/index.ts) requires a
Driver identity and `lookupDirectory({ token, kind, query?, cursor?, ids? })`. `kind`
selects users or channels. `ids` resolves saved IDs directly and cannot be
combined with a search query or cursor. The method returns workspace identity, candidates,
an optional next cursor, and `complete`. A returned name is a display hint;
callers save IDs. A missing selected Driver makes lookup unavailable.

The optional `validateCredentials(values, withSecret)` method checks configured
channel credentials before API provisioning or deployment. `withSecret(binding,
path, validate)` authorizes the exact same-Namespace Secret and supplies its value
only inside the SecretDriver callback. Without a binding it fails, unless the
selected Compute Driver sets `operatorProvisionedSecrets` because it cannot
deliver OCC Secrets; then it returns without calling `validate`, except for
names that a bound Secret could not target, which still fail. Provider calls
run before the write transaction. Validation does not pin Secret versions or
revalidate queued work.

## IAM

OCC admits the caller, checks Agent creation or the exact Agent or Configuration
edit, and requires `operate` on the caller-specified same-Namespace Secret. The
Console supplies its selected bot Secret. OCC reads the value through the
SecretDriver, then rechecks authority and Secret identity
before giving that value to the ChannelDriver in-process. The Driver authenticates
to its provider with the token. No Secret value appears in an HTTP response,
audit event, or Console script. Provider access does not grant OCC permissions.

## Lifecycle

The controller selects one ChannelDriver at startup. Lookups are read-only and
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
