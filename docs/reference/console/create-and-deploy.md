# Create and deploy Agents in the console

Create Agents and supported Dedicated runtimes with the
[platform console](../console.md). Kubernetes needs a
[ready Namespace and Secret storage](../../guides/deploy/production-agents.md#prepare-each-namespace)
to deploy; while it provisions, drafts needing no new Secret or sign-in still save, unless it
[adopts](../namespaces.md#lifecycle) an existing namespace. Creating tokens requires Secret creation permission. Provisioning grants accepted
Secret access; drafts also need Installation `administer` to grant Agent key access; members without it save drafts an administrator finishes. After deployment, [verify the same
Agent and version](../../guides/deploy/production-agents.md#verify-production-workloads).
The [local walkthrough](../../guides/first-agent.md) creates a separate Agent.

## Create an Agent

Starters enable native Control UI at `http://127.0.0.1:18789` and
`http://localhost:18789`. Compute renders gateway authentication from Installation
trust; starters supply no token and reference only the generated
`OPENCLAW_GATEWAY_PASSWORD`. Do not expose the gateway publicly.
**Open Agent UI** requires [native admin setup](../../guides/deploy/native-admin.md):
trusted-proxy authentication and the exact Agent HTTPS origin. Loopback origins alone
are insufficient. Presets and edited Configuration JSON retain their settings.

Experimental Dedicated OpenClaw requires [native worker support](../harness-execution.md#native-worker-support)
and full-facet Sandbox provisioning. The pinned runtime enables it. Compute
initializes private workspace files before Sandbox handoff; the Harness verifies
their completion marker. [Sandbox limits](../../flows/openshell-sandbox-provisioning.md#3-validate-and-serialize-the-sandbox)
block direct Secret-backed model and environment projection. An Installation that
lists only Embedded OpenClaw selects no Sandbox Driver, so Create Agent names that
as the reason Dedicated OpenClaw is disabled.

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. Choose a [Preset](../presets.md), fill its variables, and select **Use Preset**.
   Review defaults and choose an existing or new model Secret.
   **Start with default Preset** loads `default-codex`; **Start without Preset**
   skips Presets.
3. Enter a unique name within the Namespace. Choose **Provider**, then
   **Harness**. OpenAI offers **Codex** by default and **OpenClaw**;
   Anthropic offers only **OpenClaw**. Codex uses Dedicated **Execution mode**. OpenClaw
   starts Embedded without a Sandbox Driver, or Dedicated (OpenAI only; **Runtime details**)
   with one that provisions it. Anthropic OpenClaw stays Embedded.
   For Codex, choose **OpenAI API key**, **Service Accounts**, or **ChatGPT
   OAuth** ([experimental](../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)).
   OpenClaw uses the provider's API key.
   Use [OpenAI API keys](https://platform.openai.com/api-keys), or
   [OpenAI admin](https://admin.openai.com/) → your workspace → **Service accounts**
   to create a token with Codex scope.
   Unless a Preset binds one or you use ChatGPT OAuth, choose a model Secret or
   **Create new Secret...**.
   Choose a model from the starter list or select **Enter model ID manually**.
   **Choose a model from the list** returns. Switching modes retains that provider's listed models; returning with an unlisted custom ID
   requires another selection. Other settings remain.
   No model is preselected.
4. Confirm Installation, credential, and runtime support for the model. Primary
   and fallback models must share a supported provider and Harness. For custom settings,
   open **Advanced settings**. Selection changes preserve unrelated JSON edits;
   **Reset template** replaces them.
5. Under **Repository access**, optionally select up to 16 approved repositories
   and set their [access levels](repository-access.md). Kubernetes supports Codex (Dedicated) and Embedded
   OpenClaw without a Sandbox Driver, not Dedicated OpenClaw. Use Codex for repositories
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
   Provisioning waits for deployment activation or failure, naming the deployment's current wait
   when you can read the deployment.
   Success opens Agent details. If a newer deployment takes over, Create stays open
   and offers no retry or link. The job identifies only the deployment that ended.
   For a failed deployment, open the linked Agent and version and follow its recovery
   guidance. After a Stop, deploy again when ready.
   Ordinary creation saves Configuration first and opens a draft on **Open draft**,
   without a workload. After deployment, use the
   [workspace editor](../console.md#edit-workspace-files). Pending inputs have no
   update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

Before saving, forms and Preset variables survive navigation; passwords clear.
**Cancel** and **Start over** discard the draft, confirming once changed. Saved Agents
and Secrets remain. Sign-out clears drafts; a reload asks first. A refused Create stays a draft
reusing saved resources, except a repository-policy refusal; uncertain outcomes follow save
recovery below.

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
responses, and browser storage. Binding a Secret needs Secret `operate` on it, so each Secret
menu lists a readable Secret without it disabled, with the reason. A new Secret has no `operate`
grant, so where a readable Secret is denied, a Preset's **Create new Secret** is disabled too. With a selected Credential Gateway, supported
Dedicated creation registers the selected Secret as a model
[Credential Source](../credential-sources.md), then provisions with that source.
The Harness receives only a placeholder. The caller also needs source `create`, `read`, and `operate`.
Authentication methods outside the selected gateway catalog remain unavailable.

Presets preselect their authentication method or retain saved bindings.
Method-only Presets require a model Secret. Bound API-key and Service Accounts
Presets fix the provider, including JSON edits; saved service account tokens also fix Codex.
OpenClaw Presets retain their configured Harness independently of execution mode.
Without model runtime policy, Presets keep the default Harness.
Mode changes preserve provider transport settings.
Operator-managed credentials fix OpenClaw across provider changes. Where the Compute Driver
does not supply them (Kubernetes Compute), the form refuses the Preset when it opens and names
what an administrator changes. Start with
`default-codex` to change these choices, or edit authentication later in **Credentials**.

Provider changes reset Harness, credential, and model; authentication changes
reset credential/model. Selecting OpenClaw clears an unsaved PAT and model and
selects API-key auth; JSON edits preserve their explicit model. API-key Harness
changes preserve both. Credential edits preserve the selected model.
The starter list proves neither runtime compatibility nor provider acceptance.

Optional model discovery requires Namespace Agent `create`, sends credentials
upstream without saving them, and lists Codex models for `codex_pat`.

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

Managed keys require a Secret Driver and compatible Compute. Kubernetes supports
both providers; Docker development
has no managed Secret storage or model-key delivery. Saving a key does not prove
provider acceptance or runtime readiness. See
[harness authentication](../agents.md#harness-authentication).

Successful draft saves retain IDs and freeze inputs, including authentication.
Correct names or permissions, then retry failed resources.
If model/Slack Secret grants fail after Agent creation,
select **Retry credential access** or ask an administrator to check its grants.
The same action is safe if the Console saved the Agent but could not confirm its service
principal. It checks the saved Agent before granting access, without creating another Agent.
A member without Installation administration gets no retry: open the saved Agent and
ask an Installation administrator to grant it. If your permissions could not be checked,
select **Retry permission check**.
If the configuration check times out, your entries stay in the form. Select
**Create Agent** again to repeat the check and continue.
If a create response is missing or identifies a different resource, the write may still
have succeeded. Check the displayed IDs and the Agents list before starting again.
For an uncertain Credential Source, select **Check credential registration** to look up
that registration without creating another. Give your operator the request ID if the outcome is unclear.

If the Console cannot confirm a ChatGPT OAuth sign-in started, it blocks another
start in that form. Without the session reference it cannot poll or cancel the
attempt. Follow [interrupted sign-in recovery](../../guides/deploy/credential-lifecycle.md#recover-an-interrupted-codex-sign-in).

After a lost admission response, **Retry provisioning request** resubmits the same
request ID and saved Secret references. Retry acknowledged jobs through their URL;
if refused after an unknown outcome, **Create Agent** resends
the same request. If the result changes or omits a previously observed first deployment
version, the Console keeps the outcome unknown and offers Retry. A refused retry of a failed job shows the API's reason when it names
one, such as a deleted Secret; **Create Agent** then submits a new request. Saved
Secrets are reused, never deleted automatically. After a lost Secret save, check
existing Namespace Secrets before starting again.
**Check credential registration** recovers an uncertain source. If absent,
**Create Agent** retries its name/references; uniqueness fences late commits. **Remove failed credential registration** deletes a source left
`registering`/`deleting`, requiring source `delete`. Retry removal after the gateway's
registration safety window if needed. See the [provisioning flow](../../flows/agent-provisioning.md) for the API sequence.

A failed or stopped first deployment keeps the Agent and its name. Follow the failed
version's recovery guidance. After a Stop, including a Stop before deployment
(`PROVISIONING_CANCELLED`), open the Agent and deploy when ready.

If Agent creation is rejected after Configuration saves, correct the ordinary
zero-binding Agent's editable fields and retry. The retry reuses Configuration
and needs no repository choices or Repo Driver.

An unknown Agent response may mean a successful save; the form hides rejection
actions. Check the **Agents** list and any displayed Configuration ID's
[exact Configuration](../configuration.md#create-read-update-and-delete) before
starting again.

Repository discovery, default and custom access levels, policy checks, and save
recovery are in [Choose repository access in the console](repository-access.md).

## Use repositories and Slack on the same Agent

Combine approved repositories and Slack on one Codex Dedicated Agent with
[the same-Agent sequence](repository-access.md#use-repositories-and-slack-on-the-same-agent).

## Initial runtime credentials

Select model authentication and bind Slack tokens as Namespace Secrets. When
Compute requires them, OCC creates missing transport credentials before saving the first
version; supported Dedicated provisioning does so during creation.
Neither path creates the selected `harnessAuth` model credential or channel tokens.

Kubernetes generates an app-server token and local gateway password, never
returned by the API; gateway authentication is trusted-proxy only. Generation
checks for Agent runtime Deployments to prevent changes after startup.

The credential API retains `GET` and initial `POST {}` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials` for API clients.
Reading requires exact Agent `read`; generation also requires `operate`.
Deploying requires `deploy`. Status reports transport storage only. The browser
receives no generated values. Audit records contain the actor, target, action,
and outcome, never credential bytes.

Generation creates missing whole Secrets before any AgentRevision. It never
rotates existing values and reuses complete, owned groups on retry. Secret
names, shapes, password projection, and delivery per execution mode are in
[Kubernetes runtime credentials](../drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials).
Unexpected keys, foreign ownership, or malformed values cause a conflict. Failed generation creates no Agent revision;
retries reread status. After a lost deployment reply, read version
history. Created Secrets remain after later storage or audit failure. Missing
credentials after an earlier Agent revision require investigation, not regeneration.

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

<a id="deploy-a-new-revision" class="anchor-alias"></a>

## Deploy a new version

Open **Open draft** and select **Deploy new version** after storing
credentials, saving channel Secret bindings, and selecting harness authentication.
To change plugins, edit **Plugins**, select **Save plugin selections**, then
deploy. Deployment uses saved Configuration, plugins, and [Gateway managed mode](../agent-native-admin.md#gateway-managed-mode); it does
not redeploy or roll back viewed snapshots. Each accepted deployment creates a new
Agent revision, even when the Configuration generation is unchanged. Earlier versions
retain their snapshots; see the
[Plugins tab guide](../../guides/console/configuration-plugins-and-files.md#plugins-tab).

The console rereads Agent and Configuration before admission. Refresh if
generation, association, authentication, plugins, or managed mode changed since loading.
These reads are not atomic with admission.
Teams-enabled drafts cannot deploy through this console path because Teams credential
readiness is not exposed; use the operator deployment workflow for those Agents.

A refused deployment creates no Agent revision. The console shows any reason
the API names, such as a Configuration setting Compute cannot serve or a grant the
Agent's service principal lacks. Your own denial and unexplained conflicts keep
the console's guidance.

After a lost response, inspect **Versions** before retrying; the console does not
repeat uncertain requests. **Deployment activity** follows the latest visible
deployment; use the
[deployment status API](../agents.md#deployment-status) for a specific Agent revision.
Missing startup evidence leaves the cause unspecified. Stored evidence and
[on-demand diagnostics](../../guides/console/agent-details.md#browse-versions-or-create-a-new-version)
(Slack configuration, authentication, and connectivity when supported) do not
prove serving or a model response. Give your operator Namespace ID, Agent ID, and the full Agent revision ID from the URL's
`revision` query parameter. Ask them to
[verify that exact workload and get a real model response](../../guides/deploy/production-agents.md#verify-production-workloads).
Do not create another Agent to verify this one.
