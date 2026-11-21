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
accepts only a `prn_` Principal ID and rejects an email address before any
request; the API validates subjects and targets, and an unknown Principal ID is
reported as such. Sharing does not provision or search for accounts.

The acknowledgment covers full native administration of the shared Agent,
including its conversations, settings, tools and accessible credentials. This is
not restricted chat or automatic personal identity for each chat. Sharing does
not grant OCE Configuration, deployment, Secret or Agent stop permissions. The
[native launcher](../agent-native-admin.md) still requires its Installation setup and a supported runtime.

## Direct grants and removal

**Direct Agent grants** groups explicit bindings to this Agent by subject. The
console shows the OpenClaw Control Plane (OCC) human account display name when
available, or the full Principal ID otherwise. Two Principals can have the same
display name and still have separate rows. Expand a row to see the full,
selectable subject ID and each binding's Role, permissions, and ID. Service
Principals, groups, and other identities appear separately.

The optional name read requires a current human Installation administrator,
the trusted Console origin, and read access to the exact Namespace and Agent.
With guarded human authentication, it returns only stored names for accounts
whose Principal has a direct binding to this Agent. A name equal to the account
email is not shown. The Console does not search for people or list accounts.
A denied or failed name read does not change the grants or the available actions.

For a Principal, **Open Agent UI · administer** means a listed Role grants
exact-Agent `administer`. Otherwise **Chat access · operate** means a listed
Role grants exact-Agent `operate`. The badge is not a launch link; **Open chat**
remains in the Agent header when available to the signed-in user. A Role name or read grant does not determine the
label. A binding whose Role is not listed remains visible. These labels are not
an effective-access report and do not confirm that the Agent UI is available.

For a human Principal, a Role that grants only `agent:read` shows **View Agent in
OCC**. This grant lets the person read the Agent's OCC record, not open native
chat or the Agent UI. Listing the Agent also requires Namespace read access.
Expand **Technical details** to see the raw permission and the Role and binding
IDs. Other Roles keep their permissions visible in the expanded Principal row.

**Remove binding** deletes only the selected binding and preserves Namespace
discovery. Other grants, groups, and Installation administration can still
provide access; accounts, Roles, and Agents are retained.

## Failures and uncertain outcomes

Policy mutations run sequentially. Confirmed steps remain visible after a later
failure. After an uncertain response, **Refresh sharing** reads current Roles
and bindings before another change is allowed; writes never retry automatically.
A matching binding proves present configuration, not the outcome of an earlier
request. While a share or removal runs, Agent detail stays on its page: other
versions, ← Agents, the sidebar, the Namespace selector, Back and Refresh wait, and
the page says "This page stays open until sharing finishes." Tabs still switch.
After **Delete**, the note shows above the deletion row. A reload or tab close
asks first, as it does during a draft's writes. The wait ends with the last
request, usually within seconds and at most about 75 s. Session expiry and
sign-out still leave the page. The console omits the Access tab for people who
are not Installation administrators, so it never reads (and the API never audits
a denial of) sharing policy for them; Agent detail, native admission and stop
retain their own authorization checks. An expired session clears the private
view as usual.

## Related

- [Sharing procedure](../../guides/console/agent-sharing.md)
- [Native admin UI access](../agent-native-admin.md)
- [Authorization](../authorization.md)
- [Sharing request flow](../../flows/platform-console/agent-sharing.md)
