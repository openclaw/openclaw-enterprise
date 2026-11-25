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

If **Access** is missing, check your Installation administration permission.
A denial while loading or refreshing sharing policy hides the tab. If you're
still on **Access** and deletion hasn't started, the Console opens
**Configuration** with an explanation.

During sharing or removal, you can switch tabs. Navigation waits for the
operation to finish. Reloading or closing the tab asks first. Signing out or
session expiry still leaves the page.

The person gains Namespace discovery and access to this Agent's native
conversations, settings, tools and accessible credentials. They do not
automatically receive separate personal chat identity.

## Recover from a failed or uncertain share

If the Console rejects the Principal ID before submission, correct the ID.
If a policy read or write fails during sharing or removal, **Access** shows
an error. Earlier confirmed Roles or bindings remain. Select **Refresh
sharing**, inspect the direct grants and submit again only if needed. Refresh
cannot confirm what happened to an unanswered request.

## Remove a direct grant

To withdraw one explicit Agent grant, find it under **Direct Agent grants** and
select **Remove binding**. Namespace discovery remains, and other grants, groups
or Installation administration may still provide access. The console does not
delete the person, Agent or Roles. Other Agent controls retain their own permission checks.

## Related

- [Understand the Agent detail page](agent-details.md)
- [Native admin UI access](../../reference/agent-native-admin.md)
