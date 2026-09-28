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
   **Anthropic** under **Provider**, then choose **Harness**. OpenAI defaults to
   **Codex** and also offers **OpenClaw**; Anthropic currently offers only
   **OpenClaw**. **Execution mode** follows the harness: Dedicated for Codex,
   Embedded for OpenClaw.
   With OpenAI and Codex, choose **OpenAI API key** or **Service Accounts** under
   **Authentication method**. OpenClaw uses the selected provider's API key.
   For API keys, use [OpenAI API keys](https://platform.openai.com/api-keys). For
   Service Accounts, open [OpenAI admin](https://admin.openai.com/), choose your
   workspace, open **Service accounts**, and create a token with Codex scope.
   The fields show `sk-…` and `at-…` hints; prefixes do not select the method.
   Choose a model from the starter list or select **Enter model ID manually**.
   The list appears before credential entry, with no preselected model.
   It is intentionally hardcoded pending a future discovery iteration; confirm
   your credential and runtime support your choice.
   The form writes the corresponding native model configuration. Credentials
   remain separate from Configuration JSON.
4. Confirm your Installation has access to the chosen model. Primary and fallback
   models must use the same supported provider and Harness. For custom settings,
   open **Advanced settings**. Selection changes preserve unrelated JSON edits;
   **Reset template** replaces them.
5. Optional: under **Repository access**, select up to 16 repositories approved
   for this Namespace. Select one authorization level shared by every chosen
   repository. Kubernetes supports Codex (Dedicated) or OpenClaw (Embedded),
   without a Sandbox Driver. Use Codex when this Agent also
   needs Slack. Leave every repository unselected for an ordinary Agent without
   repository access.

6. If you need Slack, use OpenAI with the **Codex** harness and use its channel card. Each token
   menu lets you select a readable Namespace Secret or **Create new Secret...**.
   Creating a Secret stores it immediately, even if you later cancel Agent creation.
   **Apply channel settings** stages settings and bindings into the form;
   cancelling the drawer discards its selections.
   Channel settings, plugin entries, and selected Secret bindings are saved with
   the Configuration when you select **Create Agent**. You can also supply Slack
   credentials from the Agent's **Credentials** tab after creation.
7. Optionally open **Advanced settings** to review Configuration JSON, Secret bindings,
   plugin selections, and **Workspace files**. Each field contains its rendered OpenClaw default.
   Edit any of the four files, keep the text to submit that default, or clear a
   field to create an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
8. Select **Create Agent**. For supported Dedicated runtimes, Console follows provisioning as the worker
   saves the selected settings, creates the Agent and runtime credentials, and
   submits deployment. After activation it opens that revision's Workspace files. For
   ordinary create paths, the Console saves the Configuration first and opens a
   draft Agent on **New revision** with no workload yet. After deployment, use
   the [live workspace editor](../console.md#edit-workspace-files). Pending
   inputs have no update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

Credentials are masked and stored as Namespace Secrets, never Configuration JSON,
Agent responses, or browser storage. Ordinary draft creation requires IAM
administration permission to grant access to those Secrets.

Presets retain their authentication binding. API-key and Service Accounts Presets
fix the provider, including JSON edits; saved service account tokens also fix Codex.
Operator-managed credentials fix OpenClaw across provider changes. Start without a
Preset to change these choices, or edit authentication later in **Credentials**.

Model discovery requires Namespace Agent `create` permission. It sends the supplied
credential to the selected method's official API without saving it. Service Accounts
(`codex_pat`) authenticate with OpenAI and list Codex models. The selected method,
not the credential prefix, determines routing. Provider changes reset the harness,
credential, and model; authentication-method changes reset credential and model.
Switching an unsaved service account token to OpenClaw selects API-key authentication
and clears token/model. API-key harness changes preserve both; credential edits
clear the model. Select or enter a model before saving. Discovery does not establish
runtime compatibility or provider acceptance.

The OCC API process needs destination-scoped HTTPS egress to `api.openai.com:443`
for OpenAI API keys, `api.anthropic.com:443` for Anthropic, or both
`auth.openai.com:443` and `chatgpt.com:443` for service account tokens. Helm's
default-deny policy does not grant these destinations. Operators must maintain
provider IP CIDRs or use their cluster's FQDN policy support; standard NetworkPolicy
does not accept DNS names. Manual model entry remains available without discovery.

Failures distinguish rejected credentials/model-list permissions, rate limits,
connectivity, and unsupported responses. Recovery guidance includes the request ID,
never the raw provider response. A listing denial does not prove model execution
is denied; manual entry remains available.

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

Repository discovery is independent of model authentication. The Console submits
opaque references and never requests GitHub App or token configuration. Choose
**Read-only** (`git-read`) or **Contributor** (`git-full`), which includes pushes,
pull requests, and issue creation and management. **Customize access** lets you
turn off issue management (`git-write`) when that profile is approved. Push and
pull request permissions are bundled together. The control is disabled when the
selected repositories do not share both writable profiles; its explanation states
whether issue management is required or unavailable. The selected permissions
remain visible when the pane is closed. Changing repositories never silently
upgrades a customized grant; an unavailable selection must be chosen again.
The pane also explains that token-bounded GraphQL permits merges and
ref changes; native push allowlists do not constrain API writes. Repository
administration and workflow permissions remain excluded. See
[access levels](../repository-credentials/access-levels.md) for exact permissions.
When several repositories are selected, the form offers only levels allowed by
all of them and always submits the chosen level explicitly. The server rechecks
current Namespace policy when it creates the Agent and again when it admits a
deployment.

Only `503 REPOSITORY_OPTIONS_UNAVAILABLE` permits a fresh ordinary draft to
continue without repository bindings: Agent-create authorization succeeded, but
optional repository discovery is unavailable. Even on a provisioning-capable Dedicated runtime, this exception saves only a draft; retry discovery before provisioning. Other failures, including generic
`503`, throttling and connection errors, block **Create Agent** before either
write and offer retry. Denial and Namespace lifecycle conflict remain distinct.
This preflight does not replace authorization on either subsequent write.

If the Configuration saves but Agent creation fails, the form shows its ID and
keeps its JSON and Secret bindings fixed. After a known rejection of an ordinary
zero-binding Agent, correct the editable Agent fields and retry directly. The
retry reuses the saved Configuration and does not depend on repository choices
or a Repo Driver.

After a known rejection of a repository-scoped Agent, **Reload repository choices**
clears selections and refreshes Namespace policy while retaining the saved
Configuration. Retry requires at least one current repository and a shared
explicit access level; empty results cannot turn this attempt into an ordinary
Agent. Failed reloads keep creation disabled and the Configuration ID visible.
Expiry returns to sign-in. **Start a new draft** opens a new form and leaves the
Configuration saved. Neither action deletes saved resources.

If the Agent response is lost or otherwise unknown, the save may have succeeded.
The form disables further creation and does not expose the known-rejection
recovery actions. Check the **Agents** list and, if the form showed a
Configuration ID, the
[exact Configuration](../configuration.md#create-read-update-and-delete) before
starting again. If you cannot determine the outcome, give the displayed request
ID, if available, to your operator.

## Use repositories and Slack on the same Agent

Select **Dedicated**, the approved repositories and an explicit access level.
Configure Slack and select its saved token Secrets in the creation form, then
choose a compatible model-authentication source. With supported provisioning
and successful repository discovery, **Create Agent** queues setup and follows
the first deployment. The worker creates the Configuration and Agent, grants
access to the final Secret references, and provisions transport credentials.
Check that the returned revision belongs to this Agent and retains its repository
selections. An ordinary draft requires credential setup and **Deploy new revision**
from its detail page.

Outside the Console, an operator must prepare the
[repository installation](../../guides/repository-credentials/installation.md),
Namespace approvals, runtime images and networking; supply a managed model
credential and its exact-Agent access grant; and install a Slack app with Socket
Mode and the required channel membership. Slack also needs the configured
[channel proxy](../drivers/kubernetes-compute/networking-and-isolation.md).
Deployment admission is not a live channel connection or repository operation.
Verify this same Agent and revision before presenting the live demo.
Repository write permission does not change the Harness's filesystem or approval
policy. Review those settings separately before demonstrating code edits.

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
