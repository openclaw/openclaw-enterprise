# Agent revisions

Use revisions to apply Agent configuration changes and check what was deployed.
Saving a Configuration or changing which Configuration an Agent uses does not
change a running Agent. Each accepted deployment creates a new, immutable
revision; a worker activates it later. Multiple Agents can share a Configuration,
but you must deploy each Agent that should use the change.

## Update and deploy

Use the [OCC CLI](../cli.md#connect-to-your-installation) with an identity that
can read the Agent, read and update its Configuration, and deploy the exact
Agent. The Namespace must be `ready`. Reading revision history requires
permission to read the returned revisions. The selected model credential may
require [additional permissions](../../reference/agents.md#harness-authentication).
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
   accepted request creates another revision.

4. Check whether the worker selected that revision:

   ```bash
   occ agent get "$AGENT_ID" --output json |
     jq '{desiredRuntimeState, activeRevisionId}'
   ```

   `activeRevisionId` should match the revision ID from deployment. If it does
   not, run `occ agent deployment-status "$AGENT_ID" '<revision-id>'` to see
   where work stopped. The [deployment status reference](../../reference/agents.md#deployment-status)
   defines each result. An active revision does not prove that the model
   responds; use the [runtime verification guide](../deploy/production-agents.md#verify-production-workloads).

## Inspect an earlier revision

In the console, open the Agent's **Configuration** tab and choose a revision
from the **AgentRevision** selector. **Selected by Agent** identifies the active
revision. **New revision** shows the current Configuration. Viewing an older
revision does not select it for deployment. The [HTTP API](../../reference/api.md#agent-revisions)
also lists and reads revisions; the CLI has no revision history command.

The public API has no rollback operation. To return to an earlier configuration,
restore the settings you need from your saved source file, using the older
revision for comparison, then deploy. A Sandbox Driver can transform the
configuration before the revision is stored, so avoid copying its snapshot
wholesale. The new deployment uses current permissions and dependencies; Secret
references do not restore earlier credential values. See the
[revision contract](../../reference/agents/deployment.md#revisions-and-deployment)
for what it captures.
