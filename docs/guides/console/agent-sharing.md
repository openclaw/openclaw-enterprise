# Share an Agent with an existing person

Give an existing person access to one Agent with a configured OpenClaw role.
You need Installation administration and the person's already provisioned
**Principal ID**; the console does not create or search for accounts. See
[Agent sharing](../../reference/console/agent-sharing.md) for the exact grants,
runtime prerequisites, and limits.

## Share the Agent

1. Open **Agents**, select the Agent, and find the **Share Agent** section.
2. Enter the existing person's **Principal ID**.
3. Choose an **OpenClaw role**, review the configured and deployed summaries under **Selected role permissions**, and acknowledge its access to shared data and tools.
4. Choose **Share Agent** and read each reported step. Roles must exist in the Agent’s saved `gateway.roles` Configuration; an unavailable catalog disables new assignments. You can share before deployment or while stopped.

The person gains Namespace discovery and Agent read/entry access. Once the role is deployed and the Agent is running, OpenClaw creates their distinct native profile and enforces the selected role. OCE Configuration, deployment, Secret and stop permissions remain separate.

To change their runtime permissions, select a different role beside the direct grant. Existing connections close within 30 seconds; reconnect uses the new role when it exists in the deployed version. Deploy saved role-definition changes to apply their new permissions.

## Recover from a failed or uncertain share

If the Configuration changed after you reviewed its roles, refresh sharing and review the new permissions before saving again. If a later step fails, earlier confirmed Roles or bindings remain. Select
**Refresh sharing** after a failure, inspect the direct grants, and submit again
only if needed. Refresh reports current configuration; it cannot confirm what
happened to an earlier unanswered request.

## Remove a direct grant

To withdraw one explicit Agent grant, find it under **Direct Agent grants** and
select **Remove binding**. Namespace discovery remains, and other grants, groups
may still provide OCE management access. OpenClaw entry requires an explicit person/Agent assignment. The console does not
delete the person, Agent or Roles. People without Installation administration
do not see **Share Agent**, and it is also hidden if a sharing policy read is
denied; their other Agent controls remain governed by their
own permissions.

## Related

- [Understand the Agent detail page](agent-details.md)
- [Native admin UI access](../../reference/agent-native-admin.md)
