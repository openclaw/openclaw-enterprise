# Create a Namespace in the console

Create a Namespace to separate a team's Agents, Secrets, and access rules.
Sign in with a provisioned account that has Namespace `create` permission in
the Installation. No model credentials are needed.

1. Open **Namespaces** in the sidebar and select **Create Namespace**. Creation
   is available even when you have no readable Namespaces; the API checks your
   permission when you submit. If you do not administer the Installation, it is
   a secondary action: creating a Namespace then needs a role that grants it.
2. Enter a name unique within this Installation, then select **Create Namespace**.
   Names are 1 to 200 characters with no tabs, line breaks, or other control
   characters; the form refuses other names before submitting. Names cannot
   currently be changed. Cancel or press Escape before submitting to leave
   without creating anything.
3. **Namespace created** confirms that the request succeeded. Select **Open
   Agents** to use the new Namespace, or **Done** to return to its card. If
   your access does not include viewing the new Namespace, the confirmation
   says so and offers only **Done**; ask an Installation administrator for access.
4. Select **Refresh** on Namespaces to check readiness. Provisioning continues
   asynchronously. You can save Agent drafts while it provisions, but deployment
   waits for readiness. See [Namespace lifecycle](../../reference/namespaces.md#lifecycle).

The form creates an ordinary OCE Namespace. To select an existing Kubernetes
namespace, use the [API](../../reference/namespaces.md#ownership-and-supported-operations)
with Installation administration and operator-prepared infrastructure.

## Recover from a failed or uncertain request

A name conflict preserves the input: choose another name and submit again.
Deleted Namespaces reserve their names. A permission denial asks you to contact
an administrator and disables resubmission. After you close the form,
**Create Namespace** stays disabled until you select **Refresh** or reload the page.

While creation is pending, the form cannot be dismissed. If the response is
interrupted or unconfirmed, submission stays disabled. Select **Check
Namespaces** and look for your entered name before making another attempt.
If you cannot read the result, ask an administrator to check it. There is no
automatic creation retry.
