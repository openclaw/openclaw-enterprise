# Create and deploy Agents in the console

Use the [platform console](../console.md) to create Agents and provision supported
Dedicated runtimes. Kubernetes requires a
[ready Namespace and Secret storage](../../guides/deploy/production-agents.md#prepare-each-namespace).
Creating tokens requires Secret creation permission. Provisioning grants accepted
Secret access; ordinary draft creation also requires permission to grant Agent
key access. After deployment, [verify the same
Agent and revision](../../guides/deploy/production-agents.md#verify-production-workloads).
The [local walkthrough](../../guides/first-agent.md) creates a separate Agent.

## Create an Agent

Starters enable native Control UI at `http://127.0.0.1:18789` and
`http://localhost:18789`. Compute renders gateway authentication from Installation
trust; starters supply no token and reference only the generated
`OPENCLAW_GATEWAY_PASSWORD`. Do not expose the gateway publicly.
**Open native admin UI** requires [native admin setup](../../guides/deploy/native-admin.md):
trusted-proxy authentication and the exact Agent HTTPS origin. Loopback origins alone
are insufficient. Presets and edited Configuration JSON retain their settings.

Experimental Dedicated OpenClaw requires [native worker support](../harness-execution.md#native-worker-support)
and full-facet Sandbox provisioning. The pinned runtime lacks this support;
Console withholds Dedicated until an operator declares a compatible custom image.
[Sandbox delivery limits](../../flows/openshell-sandbox-provisioning.md#3-validate-and-serialize-the-sandbox)
still block initial workspace files and Secret-backed environment projection.

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. Choose a [Preset](../presets.md), fill its variables, and select **Use Preset**.
   Review defaults and choose an existing or new model Secret.
   **Start with default Preset** loads `default-codex`; **Start without Preset**
   skips Presets.
3. Enter a unique name within the Namespace. Choose **Provider**, then
   **Harness**. OpenAI offers **Codex** by default and **OpenClaw**;
   Anthropic offers only **OpenClaw**. **Execution mode** is Dedicated for Codex,
   and selecting OpenClaw starts in Embedded mode. For OpenAI OpenClaw, a supported
   Installation also offers **Dedicated** under **Runtime details**. Anthropic
   OpenClaw stays Embedded.
   For Codex, choose **OpenAI API key**, **Service Accounts**, or **ChatGPT
   OAuth** ([experimental](../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)).
   OpenClaw uses the provider's API key.
   Use [OpenAI API keys](https://platform.openai.com/api-keys), or
   [OpenAI admin](https://admin.openai.com/) → your workspace → **Service accounts**
   to create a token with Codex scope.
   Choose a model Secret or **Create new Secret...**.
   New Secrets persist after cancellation.
   Choose a model from the starter list or select **Enter model ID manually**.
   **Choose a model from the list** returns. Switching modes keeps a model
   available in the current provider's list; a custom ID outside that list requires
   a new selection when returning. Other settings are preserved.
   No model is preselected.
4. Confirm the Installation, credential, and runtime support the chosen model. Primary and fallback
   models must use the same supported provider and Harness. For custom settings,
   open **Advanced settings**. Selection changes preserve unrelated JSON edits;
   **Reset template** replaces them.
5. Under **Repository access**, optionally select up to 16 approved repositories
   and set their access levels. Kubernetes supports Codex (Dedicated) or OpenClaw
   (Embedded), without a Sandbox Driver. Dedicated OpenClaw requires a Sandbox
   Driver, so repository credentials remain unsupported. Use Codex for repositories
   with Slack.

6. If you need Slack, select **Dedicated** execution and use its channel card.
   Each token menu selects a readable Namespace Secret or **Create new Secret...**.
   **Apply channel settings** stages settings and bindings into the form;
   cancelling the drawer discards its selections.
   Settings and Secret bindings are saved with the Configuration;
   plugin selections belong to the Agent. You can also supply Slack
   credentials from the Agent's **Credentials** tab after creation.
7. Optionally configure plugins below or open **Advanced settings** for
   Configuration JSON and **Workspace files**. Presets prefill overrides;
   omitted files use OpenClaw defaults. Keep or edit each file, or clear its field
   for an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
8. Select **Create Agent** to submit Configuration, Secret references, Agent inputs,
   repositories, and workspace files for supported Dedicated provisioning.
   After provisioning, Console opens Agent details while deployment continues.
   Follow startup and failures with **Deployment activity → Refresh deployment**.
   Ordinary creation saves Configuration first and opens a draft on **Create new version**,
   without a workload. After deployment, use the
   [workspace editor](../console.md#edit-workspace-files). Pending inputs have no
   update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

Before saving, selected Preset forms keep variables across Back/Forward; passwords
clear. Leaving a default or no-Preset form discards unsaved state. Saved Agents and Secrets remain. **Start over** confirms discard.
Reload, page exit, and sign-out clear local drafts. Once saving begins, navigation
does not retain partial-save or uncertain-outcome state; follow save recovery below.

For Codex plugins, open **Configure plugins**. With the
[OpenAI curated catalog](../drivers/plugin-bundled.md#selection-and-catalogs),
you can browse and select supported plugins without a discovery token. Their tool
inventory and account access are unknown. In hosted mode, select **Service Accounts** with
**Codex** and choose a PAT Secret, or enter a token under **Plugin discovery token
(optional)**. **Previous page** and **Next page** fetch hosted pages; **Filter this
page** filters locally. PAT catalog search is unavailable.
Select a plugin to load tools, then **Add**. Use toggles and **Tool policy** for
overrides. **Configured plugins** includes selections from other pages. **Done** closes the modal;
**Create Agent** saves changes.

[Discovery](../../flows/agent-plugins.md#credential-scoped-discovery) requires
permission to use any selected Secret. The server reads its value without returning
it to the browser. Credential, provider, and Harness changes clear results; **Plugin
selections JSON** preserves selections separately from Configuration. Check permissions
or outbound access on failure, then retry. Editing follows installation capabilities
and the [policy contract](../agent-plugins.md); browsing proves no runtime permission.

Credentials are masked Namespace Secrets, excluded from Configuration JSON, Agent
responses, and browser storage.

Presets preselect their authentication method or retain saved bindings.
Method-only Presets require a model Secret. Bound API-key and Service Accounts
Presets fix the provider, including JSON edits; saved service account tokens also fix Codex.
OpenClaw Presets retain their configured Harness independently of execution mode.
Without model runtime policy, Presets keep the default Harness.
Mode changes preserve provider transport settings.
Operator-managed credentials fix OpenClaw across provider changes. Start with
`default-codex` to change these choices, or edit authentication later in **Credentials**.

Provider changes reset Harness, credential, and model; authentication changes
reset credential/model. Selecting OpenClaw clears an unsaved PAT and model and
selects API-key auth; JSON edits preserve their explicit model. API-key Harness
changes preserve both. Credential edits preserve the selected model.
The starter list proves neither runtime compatibility nor provider acceptance.

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

Successful draft-save steps retain IDs and freeze inputs, including authentication.
Correct conflicting names or permissions, then retry those resources.
If model/Slack Secret grants fail after Agent creation,
select **Retry credential access** or ask an administrator to check its grants.
Uncertain responses block another attempt: check displayed IDs and the Agents list;
give the request ID to your operator if the outcome remains unknown.

If provisioning admission loses its response, **Retry provisioning request** resubmits
the same request ID and saved Secret references. An acknowledged job is retried through
its job URL; if that retry is refused after an unknown outcome, **Create Agent** resends
the same request. A refused retry of a failed job shows the API's reason when it names
one, such as a deleted Secret; **Create Agent** then submits a new request. Saved
Secrets are reused, never deleted automatically. After a lost Secret save, check
existing Namespace Secrets before starting again.
See the [provisioning flow](../../flows/agent-provisioning.md) for the API sequence.

Repository discovery is independent of model authentication. Small catalogs offer
**Add**; larger ones support search and paging.
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

Failed rediscovery retains unsaved repository choices for retry and across
navigation in explicitly selected Preset forms.
**Create Agent** stays blocked until discovery succeeds and filters choices against
current policy.

Only `503 REPOSITORY_OPTIONS_UNAVAILABLE` with no selected repositories permits
saving a draft; provisioning requires successful discovery.
Other failures, including generic `503`, throttling and connection errors, block
both writes and offer retry. Denial and Namespace lifecycle conflict remain
distinct. Each subsequent write rechecks authorization.

If Agent creation is rejected after the Configuration saves, correct an ordinary
zero-binding Agent's editable fields and retry directly. The
retry reuses the saved Configuration and does not depend on repository choices
or a Repo Driver.

After a known rejection of a repository-scoped Agent, **Reload repository choices**
clears selections and search, resets pagination, reveals results, and refreshes
Namespace policy while retaining the saved Configuration. Retry requires at least
one approved repository; an empty catalog cannot turn this attempt into an ordinary
Agent. Failed reloads disable creation and show the Configuration ID. Expiry returns
to sign-in. **Start a new draft** opens a new form without deleting the Configuration.

If the Agent response is unknown, the save may have succeeded: the form hides
the known-rejection actions. Besides the **Agents** list, check any displayed
Configuration ID's
[exact Configuration](../configuration.md#create-read-update-and-delete) before
starting again.

## Use repositories and Slack on the same Agent

Select **Codex**, **Dedicated**, the approved repositories and an explicit access level.
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

Select model authentication and bind Slack tokens as Namespace Secrets. When
Compute requires them, OCC creates missing transport credentials before first
revision admission; supported Dedicated provisioning does so during creation.
Neither path creates the selected `harnessAuth` model credential or channel tokens.

The Kubernetes Driver generates an app-server token and local gateway password,
which the API never returns; gateway authentication is trusted-proxy only. Generation checks for Agent runtime Deployments before writing
so it cannot change values after startup.

The credential API retains `GET` and explicit initial `POST {}` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials` for API clients.
Reading requires exact Agent `read`; generation also requires `operate`.
Deploying requires `deploy`. Status reports transport storage only. The browser
receives no generated values. Audit records contain the actor, target, action,
and outcome, never credential bytes.

Generation creates missing whole Secrets before any AgentRevision. It never
rotates existing values and reuses complete, owned groups on retry. Secret
names, shapes, password projection, and delivery per execution mode are in
[Kubernetes runtime credentials](../drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials).
Unexpected keys, foreign ownership, or malformed values cause a conflict. Failed generation creates no revision;
retries reread status. A lost deployment reply requires revision-history
readback. Created Secrets remain after later storage or audit failure. Missing
credentials after a historical revision require investigation, not regeneration.

On the **Credentials** tab, Slack token fields use the same Secret picker as
creation; [Channel Secrets](../../guides/console/channels-and-credentials.md#channel-secrets)
lists the save requirements. The browser never reads saved token values.

Saving writes only Configuration `secretBindings` and exact IAM bindings for
the changed Secret references. It reuses only Roles with the required permission
set. Unchanged token bindings are preserved.
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
the most recent visible deployment; use the
[deployment status API](../agents.md#deployment-status) for an exact revision.
Missing startup evidence leaves the cause unspecified. Stored evidence and
[on-demand diagnostics](../../guides/console/agent-details.md#browse-versions-or-create-a-new-version)
(Slack configuration, authentication, and connectivity when supported) do not
prove serving or a model response. Give your operator the Namespace ID, Agent ID, and full
revision ID from the page URL's `revision` query parameter. Ask them to
[verify that exact workload and get a real model response](../../guides/deploy/production-agents.md#verify-production-workloads).
Do not create another Agent to verify this one.
