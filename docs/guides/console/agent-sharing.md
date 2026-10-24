# Share an Agent with an existing person

Give an existing person access to one Agent with a configured OpenClaw role.
You need Installation administration and the person's already provisioned
**Principal ID**; the console does not create or search for accounts. See
[Agent sharing](../../reference/console/agent-sharing.md) for the exact grants,
runtime prerequisites, and limits.

## Share the Agent

1. Open **Agents**, select the Agent, and open its **Access** tab.
2. Enter the existing person's **Principal ID**.
3. Choose an **OpenClaw role**, review the configured and deployed summaries under **Selected role permissions**, and acknowledge its access to shared data and tools.
4. Choose **Share Agent** and read each reported step. Roles must exist in the Agent’s saved `gateway.roles` Configuration; an unavailable catalog disables new assignments. You can share before deployment or while stopped.

While the share runs, the page stays open until it finishes, usually within
seconds; each request has a 15-second timeout; tabs still switch. Reloading or closing the tab
asks first. Signing out or an expired session still leaves.

The person gains Namespace discovery, Agent read and OpenClaw entry with the
selected role. Their native profile is personal when configured roles are
deployed; the Agent’s files, plugins and provider accounts remain shared.
To open OpenClaw yourself, assign your own Principal ID a role here.

## Recover from a failed or uncertain share

If the Configuration changed after you reviewed its roles, refresh sharing and review the new permissions before saving again. If a later step fails, earlier confirmed Roles or bindings remain. Select
**Refresh sharing** after a failure, inspect the direct grants, and submit again
only if needed. Refresh reports current configuration; it cannot confirm what
happened to an earlier unanswered request.

## Remove a direct grant

To withdraw one explicit Agent grant, find it under **Direct Agent grants** and
select **Remove binding**. Namespace discovery remains, and other grants, groups
or Installation administration may still provide OCE management access. OpenClaw entry requires an explicit person/Agent assignment. The console does not
delete the person, Agent or Roles. People without Installation administration
do not see the **Access** tab, and it is also hidden if a sharing policy read is
denied; their other Agent controls remain governed by their
own permissions.

## Related

- [Understand the Agent detail page](agent-details.md)
- [Native admin UI access](../../reference/agent-native-admin.md)
