---
rfc: ./index.md
---

# Manage sandbox domain access per Agent

An administrator opens an Agent's **Network** page, enters a domain, and chooses
**Allow** or **Deny**. OCE applies the rule to that running sandbox and shows
when it takes effect. The rule covers processes in the sandbox, including tools
and their child processes. The Agent keeps its revision and conversation.

## Decision

Extend the existing SandboxPolicy and network editor with one rule shape:

```json
{ "domain": "index.crates.io", "action": "allow", "ports": [443] }
```

Port 443 is the default. An administrator can select another port, such as 80
for a configured Debian mirror. A deny overrides inherited ordinary allows.
Installation-wide mandatory restrictions and OCE-managed model, Git and other
credential routes retain their owners. A conflicting edit explains which
policy controls the destination.

The Network page shows inherited and Agent rules, their effective result, and
the last confirmed application. Administrators can search, add, change and
remove rules. Existing IAM controls who can edit an Agent's policy. The page is
available automatically for supported sandboxes. New access requires an
explicit allow rule.

## Contract changes

The existing `SandboxNetworkGrant` requires an executable and represents
allows only. Extend the SandboxPolicy schema and Sandbox Driver admission to
represent a sandbox-wide domain rule and its allow/deny action. Reuse the
existing policy version, worker, `applyNetworkPolicy` and
`observeNetworkPolicy` operations.

For protected Agents, Sandbox must compose the change with the current
credential policy and preserve its managed routes. Credential Proxy must
confirm the supervisor's loaded policy and the matching successor credential
installation before OCC reports **Applied**. Add only the receipt or
confirmation operation that the existing Driver interfaces cannot express.
An uncertain write stays pending until the original operation is reconciled.
A stale version cannot overwrite a newer rule.

## Acceptance

On one running sandbox, deny a domain, allow it from the Console, verify a
fresh connection succeeds, then deny it and verify a fresh connection fails.
Check the effective port, child-process access, inherited-rule precedence,
another Agent's isolation, unchanged runtime identity, and continued authorized
model and Git use. A replacement, concurrent edit or lost provider reply must
produce an accurate status without repeating an uncertain write. Existing
connections may outlive a deny.

The [current implementation proposal](https://github.com/openclaw/openclaw-enterprise/pull/5908)
uses a narrower executable-specific download policy. It needs revision to
implement this domain policy and qualification on the selected Sandbox and
Credential Proxy pair.
