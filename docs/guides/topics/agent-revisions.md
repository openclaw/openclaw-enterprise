# Agent revisions

An **Agent revision** (`AgentRevision`) is the saved resource for one requested
Agent version. It stores the Agent's configuration and execution settings. These
saved values cannot change. An accepted deployment creates this resource and
queues work; it does not mean that the workload or its route is ready.

Saving a Configuration or changing which Configuration an Agent uses does not
change a running Agent. Deploy again to apply the changes. Multiple Agents can
share a Configuration, but you must deploy each Agent that should use the change.

## Update and deploy

Use the [OCC CLI](../cli.md#connect-to-your-installation) with an identity that
can read the Agent, read and update its Configuration, and deploy the exact
Agent. Deploying also needs `operate` on each bound Secret or credential source,
including an API-key or token model Secret; other
[model credentials](../../reference/agents.md#harness-authentication) have their
own requirements. Deployment status and version history need `agent_revision`
`read` on each Agent revision by ID. Without a broader Role, an administrator
must bind it after each deployment. OCC refuses a Namespace-scoped binding of a
Role that grants access only to Agent revisions. The Namespace must be `ready`.
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

   Save the returned Agent revision `id`, version number, and
   `configurationGeneration`. An accepted request means the control plane stored
   the version and queued deployment; it does not mean the Agent is running.
   If the response is lost, check version history before retrying: a second
   accepted request creates another version. An empty history can mean you
   lack `read` on the new Agent revision; ask an administrator before retrying.

4. Check the deployment until it reports `succeeded` or `failed`:

   ```bash
   occ agent deployment-status "$AGENT_ID" '<revision-id>'
   occ agent get "$AGENT_ID" --output json |
     jq '{desiredRuntimeState, activeRevisionId}'
   ```

   `queued` and `running` are not final; run the command again. The
   [deployment status reference](../../reference/agents.md#deployment-status)
   defines each result. After `succeeded`, `activeRevisionId` should equal the
   Agent revision ID. This field identifies the selected version. The worker can
   set it before the runtime or its route is ready, and a failed
   deployment can leave it set to the failed version
   ([details](../../reference/agents/deployment.md#the-active-revision-after-a-failed-deployment)).
   A succeeded deployment does not prove that the model responds; use the
   [runtime verification guide](../deploy/production-agents.md#verify-production-workloads).

## Guarded first deployment and receipt recovery

To deploy a saved Agent only at its reviewed Configuration ID and generation, use:

```sh
occ --namespace NAMESPACE_ID agent deploy-first AGENT_ID \
  --configuration CONFIGURATION_ID --generation 1 --key review-1
```

This calls `POST /namespaces/:namespaceId/agents/:agentId/deploy-first` with
`expectedConfigurationId`, `expectedGeneration`, and `key`. Fresh admission requires
no revision history, stopped desired state, and the exact saved Configuration binding
and generation. Other deployment requirements still apply. A conflict creates no
revision. Ordinary bodyless `deploy` continues to admit later versions.

The key is nonsecret, has 1–128 ASCII characters, starts with a letter or digit, and
otherwise permits letters, digits, `.`, `_`, `~`, and `-`. Keep it with the reviewed
Configuration ID and generation. It belongs to this Installation, caller, Namespace,
Agent, and operation. Older servers reject the named route; clients do not fall back.

If the reply is lost, run:

```sh
occ --namespace NAMESPACE_ID agent recover-first-deployment AGENT_ID \
  --configuration CONFIGURATION_ID --generation 1 --key review-1
```

Recovery uses the bodyless
`GET /namespaces/:namespaceId/agents/:agentId/deploy-first/:key/:expectedConfigurationId/:expectedGeneration`.
It requires current exact Agent `deploy` and reviewed Configuration `read` authority.
It returns only the original revision ID, owning IDs, Configuration generation, and
admission time. It does not queue work, create credentials, or grant access. Recovery
still works after an intentional redeploy or a change to the Agent's Configuration.
Responses use `Cache-Control: no-store`, including a missing receipt (`null`).
A miss cannot prove an in-flight request failed and does not authorize a resend.
GET generations and the CLI `--generation` flag use decimal digits from `1` through
`9007199254740991`, without leading zeros or hexadecimal notation. A larger value is invalid.

Enabled Slack uses the same credential validation as ordinary deployment. After an
authorized receipt miss, fresh preparation can read bound Secrets and contact the
provider. Genuinely concurrent fresh requests can repeat this preparation, even
though only one revision can commit. An early miss requires only the receipt
permissions; it does not prove that fresh admission is authorized or will succeed.
A matching committed receipt needs only current Agent `deploy` and reviewed
Configuration `read`, with no Secret, provider, model, or work calls. An initially
fresh contender may already have prepared credentials before a matching winner
commits. Once it observes the matching receipt under the Agent lock, it performs
no additional fresh work.

Registered Drivers are trusted application code. Custom Channel Drivers use the
same authorized credential reader; there is no separate first-deployment allowlist.
See the [admission flow](../../flows/agent-deployment-diagnostics.md#guarded-first-admission).

<span id="inspect-an-earlier-revision" class="anchor-alias"></span>

## Inspect an earlier version

In the console, use **Viewing version** on the Agent page. **Selected for service**
marks the version selected by OCC. Choosing a version opens its read-only
snapshot. **Open draft** in the header, or **Draft** in the picker, opens the
current saved Configuration. **Deploy new version** uses those saved settings
and Agent plugin selections. Browsing an older version does not deploy it.

The **Deployment** tab contains the latest visible deployment activity, the
viewed version's deployment record, and **Run diagnostics for this version**.
Pending deployments, startup warnings, and incomplete cleanup also show a
message above the tabs. **Logs** retains the viewed version's runtime output.
**Workspace files** and **Access** apply to the whole Agent.

The [HTTP API](../../reference/api.md#agent-revisions) also lists and reads
Agent revisions; `occ agent revisions "$AGENT_ID"` lists them. Lists hold
summaries, newest first, 50 to a page (`limit` up to 100). Pass `meta.nextCursor`
as `cursor` (or `occ agent revisions --cursor`) for older ones. The console's
**Load older versions** appends the next page to the picker. Read the Agent
revision by ID to get its saved settings. OCC never prunes Agent revisions.

The **Plugins** tab shows saved Agent selections in the draft and the selections
stored in a saved version. Save draft plugin policies before deploying;
editing Configuration JSON does not update these Agent-owned selections.

The public API has no rollback operation. To return to an earlier configuration,
restore the settings you need from your saved source file, using the older
version for comparison, then deploy. A Sandbox Driver can transform the
configuration before the version is stored, so avoid copying its snapshot
wholesale. The new deployment uses current permissions and dependencies; Secret
references do not restore earlier credential values. See the
[Agent revision contract](../../reference/agents/deployment.md#revisions-and-deployment)
for what it captures.
