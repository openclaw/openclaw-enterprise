# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent, prepare its
credentials, and request deployment. On an existing Kubernetes Installation,
start with [production Agent prerequisites](../../guides/deploy/production-agents.md#prepare-each-namespace):
you need a ready Namespace, configured Secret storage, and permission to
create Secrets and grant the Agent access to its key. After deployment, [verify this same
Agent and revision](../../guides/deploy/production-agents.md#verify-production-workloads).
If you are using [Local Setup](../../guides/quickstart.md) instead, the
[local first-Agent walkthrough](../../guides/first-agent.md) creates a separate
Agent; it does not verify an Agent you create in the console.

## Create an Agent

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. To reuse a [Preset](../presets.md), choose one, fill its variables, and select
   **Use Preset**. The chooser closes and the form opens with editable settings.
   Select **Start without Preset** to use standard defaults.
3. Enter a name that is unique within the Namespace. Choose **OpenAI** or
   **Anthropic** under **Model provider**, then enter its **API key**. Model controls
   appear after key entry. **Load models** queries the selected provider and lets
   you choose the gateway's default model; no model is preselected. Choose a
   text-generation model compatible with your runtime. If the list is empty or
   unavailable, retry or select **Enter model ID manually**.
   OpenAI supports the existing dedicated Codex and embedded OpenClaw modes;
   Anthropic uses embedded OpenClaw. The form writes the corresponding native
   model configuration. API keys remain separate from Configuration JSON.
4. Review the generated Configuration JSON. Changing selections updates model and
   runtime entries while preserving unrelated edits; **Reset template** replaces
   your edits. Confirm your Installation
   has access to the chosen model. Primary and fallback models must use the same
   supported provider and Harness.
   Starter templates omit gateway authentication; Kubernetes Compute renders
   trusted-proxy settings from the Installation's
   [operator-managed proxy trust](../drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication).
   Native admin UI still needs its [explicit opt-in configuration](../../guides/deploy/native-admin.md).
5. If you need Slack, use OpenAI with **Dedicated** execution and its channel
   card. Channel settings are saved with the Configuration. Provision Slack
   credentials after creation.
6. Review **Workspace files**. Each field contains its rendered OpenClaw default.
   Edit any of the four files, keep the text to submit that default, or clear a
   field to create an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
7. Select **Create Agent**. A successful save opens the Agent detail page on
   **New revision**. No revision or workload exists yet. OCC privately stages the
   initial contents for application before the first deployment runs. After
   deployment, use the [live workspace editor](../console.md#edit-workspace-files).
   Pending inputs have no update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

The key field is masked. Saving creates a Namespace Secret, the Configuration,
and the Agent, then grants that Agent's service principal `operate` on the exact
Secret through the existing IAM APIs. This requires Secret creation and IAM
administration permissions in addition to Agent and Configuration creation.
The key is never put into Configuration JSON, Agent responses, or browser storage.
A Preset with an existing authentication binding retains that binding; use the
Agent's Credentials tab to change it after creation.

Model discovery requires Agent `create` permission in this Namespace. It sends
the supplied key to the selected provider's official model-list API without
creating a Secret or saving credentials. Changing the provider clears the key;
changing the key clears the model choice. A returned model is not proof of
runtime compatibility. A model must be selected or entered before saving:
OpenClaw's implicit default does not follow the selected provider.

Discovery runs from the OCC API process. Its network policy must permit HTTPS
to `api.openai.com:443` or `api.anthropic.com:443` for the selected provider.
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

The saves are separate operations. After a successful step, the form retains its
resource ID and freezes the saved inputs. Correct a conflicting Agent name or
restore the required permission, then retry to reuse the saved resources. If the
Agent was saved but its Secret grant failed, finish the grant on that same Agent.
An uncertain response blocks another creation attempt. Check the displayed saved
IDs and the Agents list before starting again; give the displayed request ID to
your operator if the outcome cannot be established. Leaving the form does not
remove resources that were already saved.

## Initial runtime credentials

Before an Agent's first deployment, provision generated transport credentials
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
