# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent and, for supported
Dedicated runtimes, start first-time provisioning from the same form. On an
existing Kubernetes Installation,
start with [production Agent prerequisites](../../guides/deploy/production-agents.md#prepare-each-namespace):
you need a ready Namespace and, for an OpenAI API key, an administrator who can
grant the Agent access to its Secret for ordinary draft deployments. First-time
provisioning grants access to the accepted Secret references automatically. After deployment, [verify this same
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
4. If you need Slack, select **Dedicated** and use its channel card. Each token
   menu lets you select a readable Namespace Secret or **Create new Secret...**.
   The modal prefills the binding key and masks the value you enter. Creating a
   Secret stores it immediately, even if you later cancel Agent creation.
   **Apply channel settings** stages settings, plugin entries and Secret bindings
   into the form; cancelling the drawer discards its selections.
   You can also supply Slack credentials from the Agent's **Credentials** tab
   after creation.
5. Choose how the Agent will authenticate to its model. For an API key, save it
   through the existing Secrets API and enter the returned Secret ID. Ordinary
   create paths also let you save a draft for later setup.
6. Review **Workspace files**. Each field contains its rendered OpenClaw default.
   Edit any of the four files, keep the text to submit that default, or clear a
   field to create an empty file. The browser submits LF newlines. See
   [initial contents](../agents.md#initial-contents-at-creation) for limits.
7. Select **Create Agent**. For supported Dedicated runtimes, the provisioning
   request contains inline Configuration, saved Secret references, Agent inputs
   and workspace files. Console follows the returned job while the worker
   creates the Configuration and Agent, provisions runtime credentials and
   submits the first deployment. It then opens the ordinary Agent deployment
   view for the returned revision. For
   ordinary create paths, the Console saves the Configuration first and opens a
   draft Agent on **New revision** with no workload yet. After deployment, use
   the [live workspace editor](../console.md#edit-workspace-files). Pending
   inputs have no update API; see [workspace recovery](../../guides/topics/workspace-files.md#set-files-when-creating-an-agent).

| Authentication option            | What you need                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI API key**               | The ID of an existing [OCC Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret) in this Namespace. You need `operate` on that exact Secret; Secret `read` is not required. Enter the Secret ID, not the key.          |
| **ChatGPT service account**      | An account in this Namespace that you can read, an already issued credential, the matching Provider, and dedicated execution. The console does not issue the credential for you. Listing Providers requires Installation `administer`.    |
| **Operator-managed credentials** | An Installation using SSH with embedded OpenClaw. The operator configures the runtime host; OCC does not validate the credentials or model access. See [SSH credentials](../drivers/ssh-compute.md#credentials-and-supported-boundaries). |

The Secret ID input is masked, including when a Preset fills it. Configuration
summaries show **OpenAI API key · Secret configured** without the ID. The console
does not resolve Secret values into native Configuration. Slack's Secret modal
clears entered values after a save attempt. Provisioning receives references only.

Selecting a credential source does not change the configured model or execution
mode, or confirm that the provider accepts it. The Agent's own service principal
also needs `operate` on its API-key Secret. First-time provisioning grants this
access to accepted Secrets before deploying. For an ordinary draft Agent, ask an
administrator to [grant it before deploying](../../guides/deploy/production-agents.md#grant-the-agent-access-to-its-model-secret).
See [harness authentication](../agents.md#harness-authentication) for the full rules.

If saving a Secret succeeds but another save or provisioning fails, the saved
namespace Secret remains available. Console reuses its reference on retry and
does not delete it automatically. If a Secret save response is lost, check the
namespace Secrets before submitting that value again.

If provisioning admission loses its response, **Retry provisioning request**
resubmits the same request ID and accepted inputs. Once a job is acknowledged,
Console follows its status URL and can retry a failed job without changing its
inputs. Successful steps retain their resource IDs; uncertain external writes
need recovery before that step can run again. Saving a Secret does not prove
that the provider accepts it or that an integration works.

For ordinary create paths, the Console grants the new Agent `operate` on token
Secrets selected through the Slack menus using
[Namespace IAM](../authorization.md#manage-namespace-policy). If a grant fails
after Agent creation, the form blocks another creation attempt and offers
**Open Agent Credentials**. The Agent and Configuration remain saved; ask an
administrator to check exact Secret grants before deploying.

If the Configuration saves but ordinary Agent creation fails, the form shows its
ID and keeps its JSON, Secret bindings, and execution mode fixed so you can reuse
that Configuration. If the response is lost, creation may have succeeded; check
the Agents list and the saved Configuration before starting again.

## API sequence

First [save each Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret)
with `POST /namespaces/{namespaceId}/secrets` and keep its returned `data.ref`.
Then submit `POST /namespaces/{namespaceId}/agents/provision`. This example uses
a previously saved model credential; replace the example Namespace and Secret
IDs with the returned reference and generate one stable request ID per submission:

```json
{
  "requestId": "req_123e4567-e89b-42d3-a456-426614174002",
  "name": "Support agent",
  "executionMode": "dedicated",
  "configuration": {
    "kind": "agent",
    "values": {
      "agents": {
        "defaults": {
          "model": "codex/gpt-6-astra",
          "models": {
            "codex/gpt-6-astra": { "agentRuntime": { "id": "codex" } }
          }
        }
      }
    }
  },
  "harnessAuth": {
    "method": "api_key",
    "source": {
      "kind": "secret",
      "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
      "id": "sec_123e4567-e89b-42d3-a456-426614174001"
    }
  }
}
```

For Slack or another integration, put the saved `data.ref` in the appropriate
`configuration.secretBindings` entry and configure the corresponding channel.
The [binding reference](../configuration/secrets.md#secret-bindings) defines the
shape. No secret values are included in the provisioning request.

HTTP `202` returns `data.provisioning.workId` and `data.provisioning.url`.
Poll that URL until the job succeeds or fails. Success includes `agentId` and
`revisionId` and means deployment was submitted; follow ordinary deployment
status for activation. Use the same request ID for uncertain admission and the
job's retry endpoint for a known failed job. Neither operation recreates saved
Secrets. Later deployments use `POST /namespaces/{namespaceId}/agents/{agentId}/deploy`.

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
