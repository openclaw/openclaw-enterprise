# Create and deploy Agents in the console

Create a saved Agent draft, provision initial Kubernetes runtime credentials, and request its first deployment from the [platform console](../console.md). Start by signing in and selecting the intended Namespace.

## Create an Agent

Select **Create Agent** from the Agents page to create one Namespace-owned Agent.
Enter an Agent name and review the prefilled native Configuration JSON. The
editable starter matches the selected execution mode: dedicated uses
`codex/gpt-5.1`; embedded uses `openai/gpt-5.1`. These are examples, not discovered
Installation defaults or a guarantee of model access. Review the model and
provision the required credentials before deployment. Changing execution mode
updates untouched JSON; use **Reset template** to replace your edits. The form
requires valid JSON with an object at its root.

Use the Slack and Microsoft Teams cards to configure initial channels before creating
the Agent. Their settings update the same Configuration JSON, including the required
plugin entries. No channel request is sent until you submit **Create Agent**. Enabled
channels require Dedicated execution. Slack credentials can be provisioned from the saved Agent draft; Teams credential provisioning remains an operator procedure.

Workspace files cannot be initialized during creation: the backend accepts files
only after the Agent has an active revision and a reachable gateway. Create and
deploy the Agent, then open **Workspace files** to load or create the four supported
files. The creation form does not store unsaved file contents.

Choose an optional Provider and service account from the select lists. Provider
discovery requires Installation `administer`; service accounts are readable
accounts in the selected Namespace. Select the two associations independently.
Unavailable or loading lists show their status. You can leave either association
unset; the form does not accept freeform association IDs.

Submitting creates a same-Namespace `kind: "agent"` Configuration from the JSON,
then submits `POST /namespaces/:namespaceId/agents` with its returned ID and the
selected execution mode and associations. If the Configuration saves but Agent
creation fails, its ID remains visible and the saved JSON and execution mode are fixed.
Correct the name or associations and retry to reuse that Configuration. These are separate
API writes; failure does not remove the saved Configuration or retry automatically.
If a write’s reply is interrupted or unavailable, its outcome is unknown. The
form disables further creation until you leave or refresh it. Inspect the Agent
and Configuration collections before starting again; a lost response can follow
a successful write.
Successful creation opens the Agent detail page at
`/console/agents/:agentId?...&revision=draft`. It does not
admit an AgentRevision, deploy a workload, or prove runtime health.

## Initial runtime credentials

Before an Agent's first deployment, open its saved draft and provision the runtime
credentials. This path supports the Kubernetes Compute Driver's native per-Agent
OpenAI API key and optional Slack Socket Mode credentials. It does not replace
Provider-managed ServiceAccount credentials or Configuration Secret bindings.

Enter the OpenAI API key and, when Slack is enabled, its app and bot tokens.
The server generates independent gateway and app-server transport tokens and a
local gateway password. The password is projected only when native Configuration
explicitly selects the supported environment reference; it is never returned by
the credential API.
Inputs are masked and cleared after submission; the browser does not store them
in local storage, URLs, or Configuration. The API returns only whether each
complete, correctly owned credential group is stored. **Stored** does not mean
the provider accepted a credential or that a gateway is connected.

The API uses `GET` and `POST` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials`. Reading requires
exact Agent `read`; provisioning also requires `operate`. The server derives all
Kubernetes names from the admitted Namespace, Agent, and Installation driver
configuration. Credential values are transient API inputs and are stored only in
the Agent-owned Kubernetes Secrets; audit records contain the actor, target,
action, and outcome, never the values.

Provisioning creates missing whole Secrets before any AgentRevision exists.
It never rotates or overwrites existing credentials. A retry may reuse complete,
owned groups; supplying a different value for an existing group is a conflict.
Malformed or foreign Secrets require operator investigation. If a response is
lost or a dependency fails, refresh stored status before explicitly retrying.
Already-created Secrets remain in place even when later storage or audit work
fails; there is no automatic retry or rollback deletion.

## Deploy a saved draft

Open the Agent's saved draft and select **Deploy saved draft** after all required
credential groups show stored status. The console rereads the Agent and Configuration
and requests deployment through the existing exact-Agent endpoint. A changed draft
requires a refresh. These checks are separate reads, not an atomic compare-and-set.
Teams-enabled drafts cannot deploy through this console path because Teams credential
readiness is not exposed; use the operator deployment workflow for those Agents.

An accepted deployment opens **Workspace files**. Admission does not establish
runtime readiness; retry file loading after the gateway starts. If the deployment
reply is lost, inspect the Agent and revision history before another attempt.
The console does not replay an uncertain deployment automatically.
