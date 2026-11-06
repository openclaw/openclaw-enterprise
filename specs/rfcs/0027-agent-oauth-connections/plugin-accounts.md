---
rfc: index.md
---

# Choose a plugin account for a tool call

This companion defines how the Plugin Driver binds accounts and selects a session under [RFC-0027](index.md).

Every credential slot declared by a plugin accepts zero, one or several
compatible saved accounts. The plugin defines how it consumes the credential
and declares its delivery variable. The Agent owner selects source IDs in
Agent setup. A single source ID string also selects one account.

OCC checks each source against the slot and the caller's authority. The worker
gets a distinct placeholder per source, stable across account reordering.
Browser consent adds the saved account to the slot. OpenShell submits the final request and its installed slot binding to Credential Proxy. OCC checks that the selected account belongs to that revision and still has a grant for the requested operation. Token Service resolves its bearer for that send.

With several accounts on an enabled slot, one skill lists source IDs, saved
names and any provider-confirmed email or workspace by plugin and slot. The
model asks the user when several accounts fit.

For MCP, Console lists names discovered per account, reports incomplete
discovery and saves one enablement choice per upstream tool. The worker
compares the complete tool definitions returned by `tools/list` across account
sessions. Accounts share one tool only when every field matches, including
provider metadata. JSON object key order is immaterial. If a name
has conflicting definitions, each distinct definition gets an account-qualified
name. The model can discover which accounts offer each definition.

One bound account accepts native arguments. With several, the worker takes
`{account, arguments}`, checks the chosen definition against that account,
then sends the upstream name and native arguments through its session to the
approved destination. Unknown or ineligible accounts fail before dispatch.

For a CLI slot, the worker supplies the selected placeholder to that command
invocation. One account can be used directly. With several accounts, the
shared skill explains how to name the source. An unknown or withdrawn
source cannot trigger a call through another account. For Google, OCE applies a
shared operation and destination policy. For a browser-connected account, Credential Proxy checks the selected grant and request on each send. Google enforces the scopes of the bearer it receives.

Qualify the change by calling the same tool on two accounts, checking which
account answered each call, then removing one binding and using the other.
With zero bindings the Agent can retain the plugin without a credentialed call.
