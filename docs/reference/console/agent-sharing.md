# Share an existing Agent in the console

Installation administrators can share one Agent with a person who already has an
account. Follow the [sharing procedure](../../guides/console/agent-sharing.md);
this page defines the grants, limits, and uncertain outcomes. See the
[console reference](../console.md) for the rest of Agent detail.

## Grants

Installation administrators share an Agent using an existing person's Principal ID.
The console reuses or creates Namespace-scoped Roles for `namespace:read` and,
separately, `agent:read` plus `agent:administer`, bound to the exact Namespace and
Agent. Role reuse requires matching scope and permissions, regardless of name.
Namespace read enables discovery without granting child access. The console
accepts only a `prn_` Principal ID and rejects email addresses before submission.
For a share write, a `404` or a `400` naming `/subjectId` or `/resourceId`
reports that the Principal cannot receive access here or the Agent is unavailable.
It does not identify which. Sharing does not provision or search for accounts.

The acknowledgment covers full native administration of the shared Agent,
including its conversations, settings, tools and accessible credentials. This is
not restricted chat or automatic personal identity for each chat. Sharing does
not grant OCE Configuration, deployment, Secret or Agent stop permissions. The
[native launcher](../agent-native-admin.md) still requires its Installation setup and a supported runtime.

## Direct grants and removal

**Direct Agent grants** lists explicit bindings to this Agent and their Role
permissions. It is not an effective-access report. **Remove binding** deletes
only that binding and preserves Namespace discovery. Other grants, groups and
Installation administration can still provide access; accounts, Roles and
Agents are retained.

## Failures and uncertain outcomes

Policy mutations run sequentially. Confirmed steps remain visible after a later
failure. If the Console rejects the Principal ID before submission, correct it
directly. If a policy request during sharing or removal fails or its outcome
is uncertain, use **Refresh sharing** before another change. Refresh reads
current Roles and bindings when permitted.
Writes never retry automatically. A matching binding shows current access
configuration but cannot confirm the outcome of an earlier request.

While a share or removal runs, Agent detail stays on its page: other
versions, ← Agents, the sidebar, the Namespace selector, Back and Refresh wait, and
the page says "This page stays open until sharing finishes." Tabs still switch.
After **Delete**, the note shows above the deletion row. A reload or tab close
asks first, as it does during a draft's writes. The wait ends when the operation settles.
Session expiry and sign-out still leave the page.

The Console omits **Access** and skips the policy read if it already knows
the person lacks Installation administration. A `403` when loading or
refreshing policy hides the tab. On the current page, **Configuration** opens
if **Access** is still selected and deletion hasn't started. A `403` during
sharing or removal leaves an error in the panel. Agent detail, native
admission and stop retain their own authorization checks. Session expiry
clears the private view.

## Related

- [Sharing procedure](../../guides/console/agent-sharing.md)
- [Native admin UI access](../agent-native-admin.md)
- [Authorization](../authorization.md)
- [Sharing request flow](../../flows/platform-console/agent-sharing.md)
