# Share an existing Agent in the console

Installation administrators can share one Agent with a person who already has an
account. Follow the [sharing procedure](../../guides/console/agent-sharing.md);
this page defines the grants, limits, and uncertain outcomes. See the
[console reference](../console.md) for the rest of Agent detail.

## Grants

Installation administrators share an Agent using an existing person's Principal ID.
The console reuses or creates Namespace-scoped Roles for `namespace:read` and,
separately, `agent:read` plus `agent:use`, bound to the exact Namespace and
Agent. Role reuse requires matching scope and permissions, regardless of name.
Namespace read enables discovery without granting child access. The console
accepts only a `prn_` Principal ID and rejects an email address before any
request; the API validates subjects and targets, and an unknown Principal ID is
reported as such. Sharing does not provision or search for accounts.

The administrator chooses any configured role from the active OpenClaw revision and can inspect its permission summary. The assignment is stored on the exact person/Agent binding. The acknowledgment covers that role's access to shared data and tools. Native profiles are distinct, but this does not isolate files, processes, plugins or provider accounts. Sharing does
not grant OCE Configuration, deployment, Secret or Agent stop permissions. The
[native launcher](../agent-native-admin.md) still requires its Installation setup and a supported runtime.

## Direct grants and removal

**Direct Agent grants** lists explicit bindings to this Agent, OCE permissions and the assigned OpenClaw role. Changing the role updates the existing binding atomically; old proxy connections close within 30 seconds, and reconnect applies the new native profile role. It is not an effective-access report. **Remove binding** deletes
only that binding and preserves Namespace discovery. Other grants can still provide OCE management access; an explicit runtime assignment is always required for OpenClaw entry. Accounts, Roles and Agents are retained.

## Failures and uncertain outcomes

Policy mutations run sequentially. Confirmed steps remain visible after a later
failure. After an uncertain response, **Refresh sharing** reads current Roles
and bindings before another change is allowed; writes never retry automatically.
A matching binding proves present configuration, not the outcome of an earlier
request. The console omits the sharing panel for people who are not Installation
administrators, so it never reads (and the API never audits a denial of) sharing
policy for them; Agent detail, native admission and stop retain their own
authorization checks. An expired session
clears the private view as usual.

## Related

- [Sharing procedure](../../guides/console/agent-sharing.md)
- [Native admin UI access](../agent-native-admin.md)
- [Authorization](../authorization.md)
- [Sharing request flow](../../flows/platform-console/agent-sharing.md)
