# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent and, for supported
Dedicated runtimes, start first-time provisioning from the same form. On an
existing Kubernetes Installation,
start with [production Agent prerequisites](../../guides/deploy/production-agents.md#prepare-each-namespace):
you need a ready Namespace, configured Secret storage, and permission to
create Secrets. First-time provisioning grants access to accepted Secret references;
ordinary draft creation also requires permission to grant the Agent access to its key. After deployment, [verify this same
Agent and revision](../../guides/deploy/production-agents.md#verify-production-workloads).
If you are using [Local Setup](../../guides/quickstart.md) instead, the
[local first-Agent walkthrough](../../guides/first-agent.md) creates a separate
Agent; it does not verify an Agent you create in the console.

## Create an Agent

The Embedded and Dedicated starters enable native Control UI with explicit
`http://127.0.0.1:18789` and `http://localhost:18789` browser origins. Compute
Drivers render gateway authentication from the configured Installation trust
boundary; the starter does not supply a gateway token. Loopback origins alone
do not enable the OCE native admin link. Do not expose the gateway publicly.
Presets and edited Configuration JSON retain their chosen settings.

For the OCE **Open native admin UI** link, complete
[native admin setup](../../guides/deploy/native-admin.md), including trusted-proxy
authentication and the exact Agent HTTPS origin. Enabling the native UI alone
does not make that link available.

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. To reuse a [Preset](../presets.md), choose one, fill its variables, and select
   **Use Preset**. The chooser closes and the form opens with editable settings.
   Select **Start without Preset** to use standard defaults.
3. Enter a name that is unique within the Namespace. Choose **OpenAI** or
   **Anthropic** under **Model provider**. For OpenAI, choose **OpenAI API key**
   or **Service Accounts** under **Authentication method**, then enter that credential.
   For API keys, use [OpenAI API keys](https://platform.openai.com/api-keys). For Service
   Accounts, open [OpenAI admin](https://admin.openai.com/), choose your workspace,
   open **Service accounts**, and create a token with Codex scope. The fields show
   `sk-…` and `at-…` prefix hints respectively; prefixes do not select the method.
   Anthropic uses an API key. Model controls appear after credential entry. **Load models** queries the selected provider and lets
   you choose the gateway's default model; no model is preselected. Choose a
   text-generation model compatible with your runtime. If the list is empty or
   unavailable, retry or select **Enter model ID manually**.
   OpenAI API keys support dedicated Codex and embedded OpenClaw; Service Accounts
   require dedicated Codex. Anthropic uses embedded OpenClaw. The form writes the corresponding native
   model configuration. Credentials remain separate from Configuration JSON.
4. Review the generated Configuration JSON. Changing selections updates model and
   runtime entries while preserving unrelated edits; **Reset template** replaces
   your edits. Confirm your Installation
   has access to the chosen model. Primary and fallback models must use the same
   supported provider and Harness.
   Starter templates omit gateway authentication; Kubernetes Compute renders
   trusted-proxy settings from the Installation's
   [operator-managed proxy trust](../drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication).
   Native admin UI still needs its [explicit opt-in configuration](../../guides/deploy/native-admin.md).
5. If you need Slack, use OpenAI with **Dedicated** and use its channel card. Each token
   menu lets you select a readable Namespace Secret or **Create new Secret...**.
   The modal prefills the binding key and masks the value you enter. Creating a
   Secret stores it immediately, even if you later cancel Agent creation.
   **Apply channel settings** stages settings and bindings into the form;
   cancelling the drawer discards its selections.
   Channel settings, plugin entries, and selected Secret bindings are saved with
   the Configuration when you select **Create Agent**. You can also supply Slack
   credentials from the Agent's **Credentials** tab after creation.
6. Review **Workspace files**. Each field contains its rendered OpenClaw default.
   Edit any of the four files, keep the text to submit that default, or clear a
   field to create an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
7. Select **Create Agent**. For supported Dedicated runtimes, the provisioning
   request contains inline Configuration, saved Secret references, Agent inputs
   and workspace files. Console follows the returned job while the worker
   creates the Configuration and Agent, provisions runtime credentials and
   submits the first deployment. It waits for deployment activation and opens Workspace files for the returned revision. For
   ordinary create paths, the Console saves the Configuration first and opens a
   draft Agent on **New revision** with no workload yet. After deployment, use
   the [live workspace editor](../console.md#edit-workspace-files). Pending
   inputs have no update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

The credential field is masked. Saving creates a Namespace Secret and sends only
its reference to provisioning. The worker creates the Configuration and Agent,
grants exact Secret access, provisions runtime credentials, and admits the first
revision. Ordinary draft creation performs the Configuration, Agent, and exact IAM
grants as separate browser requests and requires IAM administration permission.
The key is never put into Configuration JSON, Agent responses, or browser storage.
A Preset with an existing authentication binding retains that binding; use the
Agent's Credentials tab to change it after creation. API-key and Service Accounts
Presets also keep their provider fixed, including when editing Configuration
JSON. Start without a Preset to select a different provider and credential.

Model discovery requires Agent `create` permission in this Namespace. It sends
the supplied credential to the selected authentication method's official API
without creating a Secret or saving credentials. Service Accounts token discovery (`codex_pat` in the API) validates
the account with OpenAI authentication and lists its Codex models. The selector
determines routing; credential prefixes do not choose an authentication method.
Changing the provider or method clears the credential and model choice;
changing the credential clears the model choice. A returned model is not proof of
runtime compatibility. A model must be selected or entered before saving:
OpenClaw's implicit default does not follow the selected provider.

Discovery runs from the OCC API process. Its network policy must permit HTTPS
to `api.openai.com:443` for OpenAI API keys, `api.anthropic.com:443` for Anthropic,
or both `auth.openai.com:443` and `chatgpt.com:443` for service account tokens.
The Helm chart's default-deny policy does not grant these destinations;
operators must add a destination-scoped API-pod egress policy through their
cluster's network controls. Standard Kubernetes NetworkPolicy accepts IP CIDRs,
not DNS names, so maintain the provider destinations or use the cluster's FQDN
policy support. Without this access, use manual model entry.

Discovery failures distinguish rejected credentials or model-list permissions,
provider rate limits, connectivity failures, and unsupported provider responses.
The console displays recovery guidance and the request ID, without returning the
provider's raw response. A model-list permission failure does not determine
whether that key can run a model; manual entry remains available.

These managed keys require a configured Secret Driver and compatible Compute.
Kubernetes supports both providers; the current Docker development composition
has no managed Secret storage or model-key delivery. Saving a key does not prove
provider acceptance or runtime readiness. See
[harness authentication](../agents.md#harness-authentication).

For ordinary draft creation, saves are separate operations. After a successful step, the form retains its
resource ID and freezes the saved inputs, including the authentication method. Correct a conflicting Agent name or
restore the required permission, then retry to reuse the saved resources. If the
Agent was saved but its model or Slack Secret grant failed, select **Retry credential access** to finish grants on that same Agent, or ask an administrator to check the saved Secret grants.
An uncertain response blocks another creation attempt. Check the displayed saved
IDs and the Agents list before starting again; give the displayed request ID to
your operator if the outcome cannot be established. Leaving the form does not
remove resources that were already saved.

If provisioning admission loses its response, **Retry provisioning request** resubmits
the same request ID and saved Secret references. An acknowledged job is retried through
its returned job URL; accepted inputs remain fixed. Secrets saved before a later
failure remain available and are reused, never deleted automatically. A lost Secret
save response requires checking existing Namespace Secrets before starting again.
See the [provisioning flow](../../flows/agent-provisioning.md) for the API sequence.

## Initial runtime credentials

First-time provisioning creates generated transport credentials automatically.
For ordinary draft Agents, before the first deployment, provision generated transport credentials
and, when Slack is enabled, store its app and bot tokens as Namespace Secrets
bound through the Agent's Configuration. Model credentials are selected
separately during Agent creation through `harnessAuth`; runtime credential
provisioning does not change that key.

Select **Provision generated runtime credentials** to create the transport bundle.
The Kubernetes Driver generates an app-server transport token and a local
gateway password. Kubernetes gateway authentication is trusted-proxy only. The
password is projected only when native Configuration
explicitly selects the supported environment reference; it is never returned by
the credential API. Provisioning checks for existing Agent runtime Deployments
before writing credentials so it does not modify values after a runtime has
started.

The generated credential API uses `GET` and initial `POST {}` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials`. Reading requires
exact Agent `read`; provisioning also requires `operate`. Returned status reports
transport storage only. The server derives Kubernetes names from the admitted
Namespace, Agent, and Installation driver configuration. Generated credential
values never pass through the browser. Audit records contain the actor, target,
action, and outcome, never the values.

Provisioning creates missing whole Secrets before any AgentRevision exists. It
never rotates or overwrites existing credentials. A retry may reuse complete,
owned transport groups. The Kubernetes transport group must contain exactly
`app-server-token` and `gateway-password`. Unexpected keys, foreign ownership,
or malformed values produce a conflict. If a response is lost or a dependency fails, refresh
stored status before explicitly retrying. Already-created Secrets remain in place
even when later storage or audit work fails; there is no automatic retry or
rollback deletion.

On the **Credentials** tab, bound Slack tokens appear as filled password fields using a synthetic mask.
The browser never reads the saved token values. Focus a field to enter a
replacement; leave it empty to keep its existing binding. Missing tokens remain
empty and must be supplied before saving. **Save channel Secrets** requires at
least one new value and a saved binding or new value for each token.

Saving writes only the entered tokens through the Namespace Secret API, creates
exact IAM bindings for the returned Agent `servicePrincipalId`, and saves
gateway environment references in the Agent's Configuration `secretBindings`. It
reuses only Roles with the required permission set. Unchanged tokens and their
bindings are preserved; the mask is never submitted. Entered values clear after
a save attempt or when leaving the tab, and bound fields return to their mask.
Tokens are never stored in local storage, URLs, or native Configuration values. A stored channel Secret confirms storage and binding only; it does not
prove provider acceptance, runtime readiness, or a channel connection.

<span id="deploy-a-saved-draft"></span>

## Deploy a new revision

Open the Agent's new revision and select **Deploy new revision** after generated transport credentials are stored, required channel Secret bindings are saved, and a harness source is selected. The console rereads the Agent and Configuration
and requests deployment through the existing exact-Agent endpoint. A changed draft
requires a refresh. These checks are separate reads, not an atomic compare-and-set.
Teams-enabled drafts cannot deploy through this console path because Teams credential
readiness is not exposed; use the operator deployment workflow for those Agents.

If a deployment response is lost, inspect the Agent's revision history before
trying again; the console does not automatically repeat an uncertain request.
To follow the deployment worker, use the [deployment status API](../agents.md#deployment-status).
The revision view displays the stored deployment failure and, when available,
its startup component, check, code, and observation timestamp. Missing evidence
leaves the cause unspecified; it does not mean the runtime is healthy.
The console does not display live runtime health. Give your operator the
Namespace ID, the Agent ID shown on its detail page, and the full revision ID
in the `revision` query parameter of the page URL after deployment. Ask them to
[verify that exact workload and get a real model response](../../guides/deploy/production-agents.md#verify-production-workloads).
Do not create another Agent to verify this one.
