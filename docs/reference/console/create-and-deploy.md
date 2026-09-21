# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent, prepare its
credentials, and request deployment. On an existing Kubernetes Installation,
start with [production Agent prerequisites](../../guides/deploy/production-agents.md#prepare-each-namespace):
you need a ready Namespace and, for an OpenAI API key, an administrator who can
grant the Agent access to its Secret. After deployment, [verify this same
Agent and revision](../../guides/deploy/production-agents.md#verify-production-workloads).
If you are using [Local Setup](../../guides/quickstart.md) instead, the
[local first-Agent walkthrough](../../guides/first-agent.md) creates a separate
Agent; it does not verify an Agent you create in the console.

## Create an Agent

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. Enter a name that is unique within the Namespace. Choose an execution mode
   and review the starter Configuration JSON. Dedicated uses `codex/gpt-6-astra`;
   embedded uses `openai/gpt-6-astra`. This is the default for new Agents;
   edit the JSON to use another authorized model. Confirm your Installation has
   access to the model you choose. The form requires a JSON
   object. Changing modes updates untouched JSON; use **Reset template** if you
   want to replace your edits.
3. If you need Slack or Microsoft Teams, use the channel cards and select
   **Dedicated**. Channel settings and their plugin entries are saved with the
   Configuration when you select **Create Agent**. You can provision Slack
   credentials in the console after creation; Teams credentials and deployment
   use the [operator workflow](../../guides/deploy/production-agents.md#configure-the-agent-runtime).
4. Choose how the Agent will authenticate to its model. Use one of the options
   below, or choose **None** to save a draft and select a method later. A draft
   without a compatible method cannot be deployed.
5. Select **Create Agent**. A successful save opens the Agent detail page on
   **Saved draft**. No revision or workload exists yet. You can create or edit
   [workspace files](../console.md#edit-workspace-files) after deployment, once
   the gateway is reachable; the creation form does not save file contents.

| Authentication option            | What you need                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI API key**               | The ID of an existing [OCC Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret) in this Namespace. You need `operate` on that exact Secret; Secret `read` is not required. Enter the Secret ID, not the key.          |
| **ChatGPT service account**      | An account in this Namespace that you can read, an already issued credential, the matching Provider, and dedicated execution. The console does not issue the credential for you. Listing Providers requires Installation `administer`.    |
| **Operator-managed credentials** | An Installation using SSH with embedded OpenClaw. The operator configures the runtime host; OCC does not validate the credentials or model access. See [SSH credentials](../drivers/ssh-compute.md#credentials-and-supported-boundaries). |

Selecting a credential source does not change the configured model or execution
mode, or confirm that the provider accepts it. For API-key deployments, the
Agent's own service principal also needs `operate` on that Secret; ask an
administrator to [grant it before deploying](../../guides/deploy/production-agents.md#grant-the-agent-access-to-its-model-secret).
See [harness authentication](../agents.md#harness-authentication) for the full rules.

If the Configuration saves but Agent creation fails, the form shows its ID and
keeps its JSON and execution mode fixed. Correct the Agent name or selections and
retry to reuse that Configuration. The two saves are separate; a failed Agent
save does not remove the Configuration. If a response is lost, the save may have
succeeded. The form disables further creation until you leave or refresh it.
Check the **Agents** list and, if the form showed a Configuration ID, the
[exact Configuration](../configuration.md#create-read-update-and-delete) before
starting again. If you cannot determine the outcome, give the displayed request
ID, if available, to your operator.

## Initial runtime credentials

Before an Agent's first deployment, provision generated transport credentials
and, when Slack is enabled, store its app and bot tokens as Namespace Secrets
bound through the Agent's Configuration. Model credentials are selected
separately through `harnessAuth`; this form does not accept an OpenAI API key.

Select **Provision generated runtime credentials** to create the transport bundle.
The server generates independent gateway and app-server transport tokens and a
local gateway password. The password is projected only when native Configuration
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
owned transport groups; a foreign or malformed Secret is a conflict that requires
operator investigation. If a response is lost or a dependency fails, refresh
stored status before explicitly retrying. Already-created Secrets remain in place
even when later storage or audit work fails; there is no automatic retry or
rollback deletion.

For Slack, enter the masked app and bot tokens and select **Save channel
Secrets**. The console stores each token through the Namespace Secret API, creates
exact IAM bindings for the returned Agent `servicePrincipalId`, and saves
gateway environment references in the Agent's Configuration `secretBindings`. It
reuses only Roles with the required permission set. The tokens are cleared after
submission and are never stored in local storage, URLs, or native Configuration
values. A stored channel Secret confirms storage and binding only; it does not
prove provider acceptance, runtime readiness, or a channel connection.

## Deploy a saved draft

Open the Agent's saved draft and select **Deploy saved draft** after generated transport credentials are stored, required channel Secret bindings are saved, and a harness source is selected. The console rereads the Agent and Configuration
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
