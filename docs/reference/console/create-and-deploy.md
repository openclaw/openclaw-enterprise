# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent and, for supported
Dedicated runtimes, start first-time provisioning from the same form. On an
existing Kubernetes Installation,
start with [production Agent prerequisites](../../guides/deploy/production-agents.md#prepare-each-namespace):
you need a ready Namespace and, for an OpenAI API key, an administrator who can
grant the Agent access to its Secret. Operators must also configure the
versioned provisioning-input keyring for API and worker before inline Secret
values can be accepted. After deployment, [verify this same
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
3. Enter a name that is unique within the Namespace. Choose an execution mode
   and review the starter Configuration JSON. Dedicated uses `codex/gpt-6-astra`;
   embedded uses `openai/gpt-6-astra`. This is the default for new Agents;
   edit the JSON to use another authorized model. Confirm your Installation has
   access to the model you choose. The form requires a JSON
   object. Changing modes updates untouched JSON; use **Reset template** if you
   want to replace your edits. Starter templates omit gateway authentication;
   Kubernetes Compute renders trusted-proxy settings from the Installation's
   [operator-managed proxy trust](../drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication).
   The starter's loopback Control UI origins support direct local access only.
   The OCE native admin link still needs its [explicit opt-in configuration](../../guides/deploy/native-admin.md),
   including the derived Agent HTTPS origin.
4. If you need Slack, use its channel card and select **Dedicated**. Channel
   settings and their plugin entries are included in the inline Configuration
   when first-time provisioning is available. Slack app and bot tokens use the
   generic Secret fields in this form; Slack connectivity is verified after the
   Agent deploys.
5. Choose how the Agent will authenticate to its model. Supported Dedicated
   runtimes can accept a new masked API key value in this create request or an
   existing Secret reference. Ordinary create paths accept existing references or
   save a draft for later setup.
6. Review **Workspace files**. Each field contains its rendered OpenClaw default.
   Edit any of the four files, keep the text to submit that default, or clear a
   field to create an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
7. Select **Create Agent**. For supported first-time provisioning, the Console
   sends one request with the Agent inputs, inline Configuration, new masked
   Secret values or existing Secret references, and workspace files. It opens the
   Agent detail page and follows provisioning through Secret creation,
   Configuration materialization, runtime credentials, and first deployment. For
   ordinary create paths, the Console saves the Configuration first and opens a
   draft Agent on **New revision** with no workload yet. After deployment, use
   the [live workspace editor](../console.md#edit-workspace-files). Pending
   inputs have no update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

| Authentication option            | What you need                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI API key**               | For supported first-time provisioning, either enter a new masked key value or the ID of an existing [OCC Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret) in this Namespace. Existing references require `operate` on that exact Secret; Secret `read` is not required. |
| **ChatGPT service account**      | An account in this Namespace that you can read, an already issued credential, the matching Provider, and dedicated execution. The console does not issue the credential for you. Listing Providers requires Installation `administer`.                                                          |
| **Operator-managed credentials** | An Installation using SSH with embedded OpenClaw. The operator configures the runtime host; OCC does not validate the credentials or model access. See [SSH credentials](../drivers/ssh-compute.md#credentials-and-supported-boundaries).                                                       |

Secret fields are masked, including when a Preset fills them. Configuration
summaries show **OpenAI API key · Secret configured** without the ID or value.
The console does not resolve Secret values into native Configuration. Submitted
new values are kept only in memory until provisioning admission is acknowledged.

Selecting a credential source does not change the configured model or execution
mode, or confirm that the provider accepts it. For API-key deployments, the
Agent's own service principal also needs `operate` on that Secret; ask an
administrator to [grant it before deploying](../../guides/deploy/production-agents.md#grant-the-agent-access-to-its-model-secret).
See [harness authentication](../agents.md#harness-authentication) for the full rules.

If first-time provisioning admission succeeds, the Console clears submitted new
Secret values and follows the returned status. If the response is lost before
acknowledgement, **Retry provisioning request** resubmits the same request ID and
same in-memory payload so the API can recover the saved Agent or reject a changed
plan. After a reload, check the **Agents** list and provisioning status instead
of entering the values again. For ordinary create paths, if the Configuration
saves but Agent creation fails, the form shows its ID and keeps its JSON, Secret
bindings, and execution mode fixed so you can reuse that Configuration.

## Initial runtime credentials

First-time provisioning creates generated transport credentials before admitting
the first revision. For ordinary draft Agents, provision generated transport
credentials before the first deployment and, when Slack is enabled, store its app
and bot tokens as Namespace Secrets bound through the Agent's Configuration.
Model credentials are selected separately through `harnessAuth`.

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

For Slack, bound tokens appear as filled password fields using a synthetic mask.
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
