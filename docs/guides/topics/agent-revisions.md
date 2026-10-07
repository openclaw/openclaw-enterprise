# Agent revisions

Use revisions to apply Agent configuration changes and check what was deployed.
Saving a Configuration or changing which Configuration an Agent uses does not
change a running Agent. Each accepted deployment creates a new, immutable
revision; a worker activates it later. Multiple Agents can share a Configuration,
but you must deploy each Agent that should use the change.

## Update and deploy

Use the [OCC CLI](../cli.md#connect-to-your-installation) with an identity that
can read the Agent, read and update its Configuration, and deploy the exact
Agent. Deploying also needs `operate` on each bound Secret or credential source,
including an API-key or token model Secret; other
[model credentials](../../reference/agents.md#harness-authentication) have their
own requirements. Deployment status and revision history need `agent_revision`
`read` on each exact revision. Without a broader Role, an administrator must
bind it after each deployment; a Namespace-scoped binding of a revision-only
Role is refused. The Namespace must be `ready`.
The commands below also use `jq`.

1. Set the Namespace and Agent IDs and find the Agent's Configuration:

   ```bash
   export OCC_NAMESPACE='<namespace-id>'
   export AGENT_ID='<agent-id>'
   CONFIGURATION_ID="$(occ agent get "$AGENT_ID" --output json | jq -r .configurationId)"
   occ configuration get "$CONFIGURATION_ID" --output json |
     jq '{values: .values}' > configuration-update.json
   ```

2. Edit `configuration-update.json`. Keep the entire `values` document: the
   update replaces it, so any setting you omit is deleted. Omit `secretBindings`
   to preserve the existing bindings; send `{}` only if you mean to clear them.
   Never put credential values in the file. Use
   [Secret references and bindings](../../reference/configuration/secrets.md).

3. Save the Configuration and review its new generation. Then deploy:

   ```bash
   occ configuration update "$CONFIGURATION_ID" --file configuration-update.json
   occ agent deploy "$AGENT_ID" --output json
   ```

   Save the returned revision `id`, revision number, and
   `configurationGeneration`. An accepted request means the control plane stored
   the revision and queued deployment; it does not mean the Agent is running.
   If the response is lost, check revision history before retrying: a second
   accepted request creates another revision. An empty history can mean you
   lack `read` on the new revision; ask an administrator before retrying.

4. Check the deployment until it reports `succeeded` or `failed`:

   ```bash
   occ agent deployment-status "$AGENT_ID" '<revision-id>'
   occ agent get "$AGENT_ID" --output json |
     jq '{desiredRuntimeState, activeRevisionId}'
   ```

   `queued` and `running` are not final; run the command again. The
   [deployment status reference](../../reference/agents.md#deployment-status)
   defines each result. After `succeeded`, `activeRevisionId` should equal the
   revision ID. The worker can set it before the runtime is ready, and a failed
   deployment can leave it set to the failed revision
   ([details](../../reference/agents/deployment.md#the-active-revision-after-a-failed-deployment)).
   A succeeded deployment does not prove that the model responds; use the
   [runtime verification guide](../deploy/production-agents.md#verify-production-workloads).

## Inspect an earlier revision

In the console, open the Agent's **Versions** list. **Current version** marks
the revision selected by OCC; selecting a version shows its read-only details
beside the list. **Create new version** opens the current saved Configuration;
**Deploy new version** uses those saved settings and Agent plugin selections.
Viewing an older version does not select it for deployment. The
[HTTP API](../../reference/api.md#agent-revisions)
also lists and reads revisions; `occ agent revisions "$AGENT_ID"` lists them.

The **Plugins** tab shows the saved Agent selections in **Create new version** and the
frozen selections in an admitted revision. Change and save draft plugin policies
before deploying; editing the reusable Configuration JSON does not update these
Agent-owned selections.

The public API has no rollback operation. To return to an earlier configuration,
restore the settings you need from your saved source file, using the older
revision for comparison, then deploy. A Sandbox Driver can transform the
configuration before the revision is stored, so avoid copying its snapshot
wholesale. The new deployment uses current permissions and dependencies; Secret
references do not restore earlier credential values. See the
[revision contract](../../reference/agents/deployment.md#revisions-and-deployment)
for what it captures.
