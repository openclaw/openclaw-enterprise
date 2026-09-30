# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent and provision supported
Dedicated runtimes. On Kubernetes, check the
[production Agent prerequisites](../../guides/deploy/production-agents.md#prepare-each-namespace):
a ready Namespace and configured Secret storage. New tokens require
Secret creation permission. First-time provisioning grants access to accepted
Secret references; ordinary draft creation also requires permission to grant
Agent key access. After deployment, [verify this same
Agent and revision](../../guides/deploy/production-agents.md#verify-production-workloads).
The [local walkthrough](../../guides/first-agent.md) creates a separate Agent.

## Create an Agent

Embedded and Dedicated starters enable native Control UI at
`http://127.0.0.1:18789` and `http://localhost:18789`. Compute renders gateway
authentication from Installation trust; starters supply no gateway token.
Do not expose the gateway publicly. **Open native admin UI** requires
[native admin setup](../../guides/deploy/native-admin.md): trusted-proxy authentication
and the exact Agent HTTPS origin. Loopback origins alone are insufficient.
Presets and edited Configuration JSON retain their settings.

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. To reuse a [Preset](../presets.md), choose one, fill its variables, and select
   **Use Preset**. Review defaults and choose an existing or new model Secret.
   Select **Start without Preset** for standard defaults.
3. Enter a unique name within the Namespace. Choose **Provider**, then
   **Harness**. OpenAI offers **Codex** by default and **OpenClaw**;
   Anthropic offers only **OpenClaw**. **Execution mode** is Dedicated for Codex,
   Embedded for Anthropic OpenClaw, and selectable for OpenAI OpenClaw. Dedicated
   OpenClaw is experimental. Verify its runtime supports native worker inference;
   released images may not.
   For Codex, choose **OpenAI API key** or **Service Accounts**. OpenClaw uses
   the provider's API key.
   For API keys, use [OpenAI API keys](https://platform.openai.com/api-keys). For
   Service Accounts, open [OpenAI admin](https://admin.openai.com/), choose your
   workspace, open **Service accounts**, and create a token with Codex scope.
   Choose an existing model credential Secret or **Create new Secret...**.
   It saves immediately, even if you cancel Agent creation.
   Choose a model from the starter list or select **Enter model ID manually**.
   The list appears before credential entry without a preselected model. Confirm
   credential and runtime support; credentials stay outside Configuration.
4. Confirm your Installation has access to the chosen model. Primary and fallback
   models must use the same supported provider and Harness. For custom settings,
   open **Advanced settings**. Selection changes preserve unrelated JSON edits;
   **Reset template** replaces them.
5. Under **Repository access**, optionally select up to 16 approved repositories
   and set their access levels. Kubernetes supports Codex (Dedicated) or OpenClaw
   (Embedded), without a Sandbox Driver. Use Codex for Slack. Leave repositories
   unselected to create an ordinary Agent without repository access.

6. If you need Slack, use OpenAI with the **Codex** harness and its channel card.
   Each token menu selects a readable Namespace Secret or **Create new Secret...**.
   New Secrets persist even if you cancel Agent creation.
   **Apply channel settings** stages settings and bindings into the form;
   cancelling the drawer discards its selections.
   Channel settings and selected Secret bindings are saved with the Configuration;
   plugin selections belong to the Agent. You can also supply Slack
   credentials from the Agent's **Credentials** tab after creation.
7. Optionally configure plugins as described below, or open **Advanced settings**
   to review Configuration JSON and **Workspace files**. Preset workspace
   overrides prefill their matching fields; omitted files use OpenClaw defaults.
   Edit any of the four files, keep the text to submit that default, or clear a
   field to create an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
8. Select **Create Agent**. Supported Dedicated runtimes submit inline Configuration,
   Secret references, Agent inputs, repositories, and workspace files for provisioning.
   After provisioning, Console opens Agent details while deployment continues.
   Follow startup and failures with **Deployment activity → Refresh deployment**.
   Ordinary creation saves Configuration first and opens a draft on **Create new version**,
   without a workload. After deployment, use the
   [workspace editor](../console.md#edit-workspace-files). Pending inputs have no
   update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

Before saving, Preset variables and forms survive navigation; passwords clear.
Leaving a form started without a Preset discards its unsaved state. Saved Agents and
Secrets remain. **Start over** confirms discard. Reload, page exit, and sign-out
clear local drafts. After saving begins, navigation does not retain partial-save
or uncertain-outcome form state; follow save recovery below.

For Codex plugins, open **Configure plugins**. With the
[OpenAI curated catalog](../drivers/plugin-bundled.md#selection-and-catalogs),
you can browse and select supported plugins without a discovery token. Their tool
inventory and account access are unknown. In hosted mode, select **Service Accounts** with
**Codex** and choose a PAT Secret, or enter a token under **Plugin discovery token
(optional)**. **Previous page** and **Next page** fetch hosted pages; **Filter this
page** filters locally. PAT catalog search is unavailable.
Select a plugin to load tools, then **Add**. Use toggles and **Tool policy** for
overrides. **Configured plugins** includes selections from other pages. **Done**
closes the modal; **Create Agent** saves changes.

[Discovery](../../flows/agent-plugins.md#credential-scoped-discovery) requires
permission to use any selected Secret. The server reads its value without returning
it to the browser. Credential, provider, and Harness changes clear results; **Plugin
selections JSON** preserves selections separately from Configuration. Check permissions
or outbound access on failure, then retry. Editing follows installation capabilities
and the [policy contract](../agent-plugins.md); browsing proves no runtime permission.

Credentials are masked Namespace Secrets, excluded from Configuration JSON, Agent
responses, and browser storage. Provisioning creates exact grants; ordinary drafts
require IAM administration permission.

Presets with only an authentication method preselect that method and require a
model credential Secret selection. Presets with saved authentication bindings
retain them. Bound API-key and Service Accounts Presets
fix the provider, including JSON edits; saved service account tokens also fix Codex.
Operator-managed credentials fix OpenClaw across provider changes. Start without a
Preset to change these choices, or edit authentication later in **Credentials**.

Provider changes reset Harness, credential, and model; authentication-method changes
reset credential/model. Switching an unsaved PAT to OpenClaw selects API-key auth
and clears token/model. API-key Harness changes preserve both. Credential edits
preserve model selection. Select or enter a model before saving; the starter list
does not prove runtime compatibility or provider acceptance.

The optional model-discovery API requires Namespace Agent `create`, sends
credentials upstream without saving them, and lists Codex models for `codex_pat`.
Console selection needs no discovery.

Configure Helm `api.modelDiscoveryCidrs` with provider IPv4 `/32` hosts, then
upgrade. This grants only API Pods TCP 443 egress; Harness rules are unchanged.
Destinations: `api.openai.com` (OpenAI API key), `api.anthropic.com` (Anthropic),
or `auth.openai.com` plus `chatgpt.com` (`codex_pat`). Defaults grant none.
Operators must refresh addresses when DNS changes, or supply a cluster-specific
FQDN policy. Standard NetworkPolicy cannot match DNS names or distinguish
services sharing an IP.

Failures distinguish credential/model-list rejection, rate limits, connectivity,
and invalid responses. Errors include request IDs, never upstream response bodies.
Listing rejection does not prove model execution is denied; manual entry remains
available.

These managed keys require a configured Secret Driver and compatible Compute.
Kubernetes supports both providers; the current Docker development composition
has no managed Secret storage or model-key delivery. Saving a key does not prove
provider acceptance or runtime readiness. See
[harness authentication](../agents.md#harness-authentication).

Draft creation saves Configuration and Agent separately. After an interrupted
reply, **Try again** attempts each pending create once with the same
[request identity](../configuration.md#recover-an-interrupted-create) and inputs,
reusing resources. Retries are manual. Uncertain outcomes freeze inputs,
even after later permission or validation errors; saved settings also stay fixed.

If Agent creation succeeds but model/Slack Secret grants fail, select **Retry
credential access** or ask an administrator to check its grants. Request keys
cover Configuration and Agent creates, not Secret saves or IAM grants.

Keep the form open: refresh, navigation, or sign-out loses recovery. Cancellation
does not prove rollback or delete saved resources. Inspect unresolved writes before
restarting; share available request IDs with your operator.

If provisioning admission loses its response, **Retry provisioning request** resubmits
the same request ID and saved Secret references. An acknowledged job is retried through
its returned job URL; accepted inputs remain fixed. Secrets saved before a later
failure remain available and are reused, never deleted automatically. A lost Secret
save response requires checking existing Namespace Secrets before starting again.
See the [provisioning flow](../../flows/agent-provisioning.md) for the API sequence.

Repository discovery is independent of model authentication. Select up to 16 approved
repositories. Small catalogs offer **Add**; larger ones support search and paging.
Suggestions favor repositories you recently saved in this browser and Namespace,
then sort alphabetically.

**Default repository access** starts at **Contributor** for code pushes, PRs,
and issue management. Choose **Read-only**, or customize Contributor to turn off
issue management. Added repositories inherit the default; expand a repository card
to choose a custom level or **Use Agent default** to restore inheritance. Custom choices stay
fixed when the default changes, even if they matched it. Invalid combinations stay
visible and must be repaired or removed before saving. Overrides never widen silently.

The server resolves selections against current Namespace policy on save and
deployment. Push and PR permissions remain bundled; see
[access levels](../repository-credentials/access-levels.md) for token permissions,
merges, and the API contract. Edit saved drafts in **Create new version** >
**Repositories**; admitted revisions stay unchanged. Save or cancel edits before
navigating away; returning to the tab can refresh the session and discard them.
An interrupted save may still complete; inspect the saved draft before retrying.

Failed rediscovery and navigation retain unsaved repository choices.
**Create Agent** stays blocked until discovery succeeds and filters choices against
current policy. **Start over** discards selections.

Only `503 REPOSITORY_OPTIONS_UNAVAILABLE` with no selected repositories permits
saving a draft; provisioning requires successful discovery.
Other failures, including generic `503`, throttling and connection errors, block
both writes and offer retry. Denial and Namespace lifecycle conflict remain
distinct. Each subsequent write rechecks authorization.

If the Configuration saves but Agent creation fails, its JSON and Secret bindings
stay fixed. After an initial rejection without repository bindings, correct the
editable Agent fields and retry with a new Agent request key. This reuses the
Configuration without depending on repository choices or a Repo Driver.

After a known rejection of a repository-scoped Agent, **Reload repository choices**
clears selections and search, resets pagination, reveals results, and refreshes
Namespace policy while retaining the saved Configuration. Retry requires at least
one approved repository; an empty catalog cannot turn this attempt into an ordinary
Agent. Failed reloads disable creation and show the Configuration ID. Expiry returns
to sign-in. **Start a new draft** opens a new form without deleting the Configuration.

An interrupted Agent reply keeps the submitted repository selection fixed and
offers **Try again** with the same request identity. Repository reload and
new-draft actions remain unavailable, including after a later permission denial;
only a confirmed initial rejection permits changing those inputs.

## Use repositories and Slack on the same Agent

Select **Dedicated**, the approved repositories and an explicit access level.
Configure Slack and select its saved token Secrets in the creation form, then
choose a compatible model-authentication source. With supported provisioning
and successful repository discovery, **Create Agent** queues setup and follows
the first deployment. The worker creates the Configuration and Agent, grants
access to the final Secret references, and provisions transport credentials.
Check that the returned revision belongs to this Agent and retains its repository
selections. An ordinary draft requires model and channel credential setup and **Deploy new version**
from its detail page.

Operators must prepare the
[repository installation](../../guides/repository-credentials/installation.md),
Namespace approvals, runtime images, networking, model credential and exact-Agent
grant, plus a Slack app with Socket Mode and channel membership. Slack requires a
[channel proxy](../drivers/kubernetes-compute/networking-and-isolation.md).
Verify this Agent and revision: admission proves neither channel connectivity nor
repository operations. Repository permissions do not change Harness filesystem or
approval policy; review both before demonstrating edits.

## Initial runtime credentials

Select model authentication and bind any Slack tokens as Namespace Secrets.
When Compute requires generated credentials, OCC creates missing transport
credentials before first revision admission. Supported Dedicated Agent creation
does so during provisioning. Neither path creates the selected `harnessAuth`
model credential or channel tokens.

The Kubernetes Driver generates an app-server token and local gateway password.
Gateway authentication is trusted-proxy only. The password is projected only
when native Configuration selects the supported environment reference; the API
never returns it. Generation checks for Agent runtime Deployments before writing
so it cannot change values after startup.

The credential API retains `GET` and explicit initial `POST {}` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials` for API clients.
Reading requires exact Agent `read`; generation also requires `operate`.
Deploying requires `deploy`. Status reports transport storage only. The server derives Kubernetes names from the admitted
Namespace, Agent, and Installation driver configuration. The browser receives no generated values. Audit records contain the actor, target,
action, and outcome, never credential bytes.

Generation creates missing whole Secrets before any AgentRevision. It never
rotates existing values and reuses complete, owned groups on retry. Dedicated
Agents keep `app-server-token` and `gateway-password` in separate CP Secrets;
Compute delivers only the transport token to the Harness. Embedded Agents use
one tenant-local group with both keys. Unexpected keys, foreign ownership, or
malformed values cause a conflict. Failed generation creates no revision;
retries reread status. A lost deployment reply requires revision-history
readback. Created Secrets remain after later storage or audit failure. Missing
credentials after a historical revision require investigation, not regeneration.

On the **Credentials** tab, Slack token fields use the same Secret picker as the
creation and channel-editing flows. Select a readable Namespace Secret or
**Create new Secret...**. The browser never reads saved token values. Missing
tokens must be bound before saving. **Save channel Secrets** requires at least
one changed selection and a saved binding for each token.

Saving writes only Configuration `secretBindings` and exact IAM bindings for
the changed Secret references. It reuses only Roles with the required permission
set. Unchanged token bindings are preserved. Switching a picker changes which
Secret is referenced; it does not overwrite an existing shared Secret value.
Tokens are never stored in local storage, URLs, or native Configuration values.
A stored channel Secret confirms storage and binding only; it does not prove
provider acceptance, runtime readiness, or a channel connection.

<span id="deploy-a-saved-draft"></span>

## Deploy a new revision

Open **Create new version**, then select **Deploy new version** after storing
credentials, saving channel Secret bindings, and selecting harness authentication.
To change plugins, edit **Plugins**, select **Save plugin selections**, then
deploy. This action uses the saved Configuration and Agent plugin map; it does
not redeploy or roll back a viewed snapshot. Every accepted request creates an
immutable revision, even at the same Configuration generation. Earlier versions
retain their snapshots; see the
[Agent detail guide](../../guides/console/agent-details.md#plugins-tab).

Before admission, the console rereads the Agent and Configuration. If
generation, association, authentication, or plugin selections changed since
the draft loaded, refresh. These reads are not atomic with admission.
Teams-enabled drafts cannot deploy through this console path because Teams credential
readiness is not exposed; use the operator deployment workflow for those Agents.

If a deployment response is lost, inspect **Versions** before retrying; the
console does not repeat an uncertain request. **Deployment activity** follows
the most recent visible deployment's persisted status; use the
[deployment status API](../agents.md#deployment-status) for an exact revision.
The viewed version shows stored startup evidence; missing evidence leaves the
cause unspecified. [Current observations](../../guides/console/agent-details.md#follow-deployment-activity)
can request limited checks for that version, including Slack configuration,
authentication, and connectivity when supported. They do not prove serving or
a model response. Give your operator the Namespace ID, Agent ID, and full
revision ID from the page URL's `revision` query parameter. Ask them to
[verify that exact workload and get a real model response](../../guides/deploy/production-agents.md#verify-production-workloads).
Do not create another Agent to verify this one.
