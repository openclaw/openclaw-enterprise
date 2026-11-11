# Share an Agent with an existing person

Give an existing person native administration of one Agent from its detail page.
You need Installation administration and the person's already provisioned
**Principal ID**; the console does not create or search for accounts. See
[Agent sharing](../../reference/console/agent-sharing.md) for the exact grants,
runtime prerequisites, and limits.

## Share the Agent

1. Open **Agents**, select the Agent, and open its **Access** tab.
2. Enter the existing person's **Principal ID**.
3. Review the full native administration warning and select the acknowledgment.
4. Choose **Share Agent** and read each reported step.

While the share runs, the page stays open until it finishes, usually within
seconds and at most about 75 s; tabs still switch. Reloading or closing the tab
asks first. Signing out or an expired session still leaves.

The person gains Namespace discovery and access to this Agent's native
conversations, settings, tools and accessible credentials. They do not
automatically receive separate personal chat identity.

## Recover from a failed or uncertain share

If a later step fails, earlier confirmed Roles or bindings remain. Select
**Refresh sharing** after a failure, inspect the direct grants, and submit again
only if needed. Refresh reports current configuration; it cannot confirm what
happened to an earlier unanswered request.

## Remove a direct grant

To withdraw one explicit Agent grant, find it under **Direct Agent grants** and
select **Remove binding**. Namespace discovery remains, and other grants, groups
or Installation administration may still provide access. The console does not
delete the person, Agent or Roles. People without Installation administration
do not see the **Access** tab. If a sharing policy read is denied, the tab is
hidden and the page opens **Configuration** with a note that says why. Their
other Agent controls remain governed by their own permissions.

## Related

- [Understand the Agent detail page](agent-details.md)
- [Native admin UI access](../../reference/agent-native-admin.md)
