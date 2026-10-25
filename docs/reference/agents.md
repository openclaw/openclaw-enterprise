# Agents

An Agent is a named AI workload in a [Namespace](namespaces.md). It has its own
identity, Agent revision history, and gateway. Its permissions do not grant
access across Namespaces.

Use a [Preset](presets.md) to copy launch settings into an Agent draft.

[Deploy your first Agent](../guides/first-agent.md), choose
[Compute](../guides/topics/agent-compute.md), manage
[versions](../guides/topics/agent-revisions.md), or
[troubleshoot deployment](../guides/topics/agent-troubleshoot.md).

Creation saves identity and exact Namespace-owned Configuration with `active`
status and `stopped` desired runtime state. No Agent revision is
created and no workload or model starts until an authorized caller requests
[deployment](#identity-and-deployment).

## Supported operations

Operations beneath `/namespaces/:namespaceId/agents` return `201` for creation,
`200` for reads/updates, and `202` for deployment, stop, or deletion. Deployment
returns the saved Agent revision (`AgentRevision`). Stop sets
`desiredRuntimeState` to `stopped`. Lists require each Agent's exact `read`.
See [API schemas, envelopes, and permissions](api.md).

Responses include immutable `servicePrincipalId` for
[Namespace IAM bindings](authorization.md#manage-namespace-policy). Do not derive
it from the Agent ID; create/update reject caller-supplied values.

Creation body:

```json
{
  "name": "ticket-triage",
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "executionMode": "dedicated",
  "backendId": null
}
```

Creation requires a `provisioning` or `ready` Namespace, a same-Namespace
Configuration with `kind: "agent"`, Namespace Agent `create`, and exact
Configuration `read`. See [Harness authentication](#harness-authentication)
for credential permissions and [authorization](authorization.md) for grants.

### Unreadable saved settings

For unreadable saved settings, Agent and Agent revision list/detail GETs omit them
without defaults, keep readable metadata and siblings, and add
`configurationReadError` with `code: "SAVED_CONFIGURATION_UNREADABLE"` and the
affected `field`. Authorization and strict mutation/runtime validation are unchanged;
query failures still fail requests. See the
[Console warning](../guides/console/agent-details.md#unreadable-saved-settings).

## Deployment status

The `deploymentId` is the saved AgentRevision ID from
`POST /namespaces/:namespaceId/agents/:agentId/deploy`. A `202` confirms that OCC
saved and queued the version. It does not confirm workload readiness. Poll with:

```text
GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId
```

This requires exact AgentRevision `read`, not Agent `operate`.
Responses include `deploymentId`, `namespaceId`, `agentId`, `status`, nullable
`error`, plugin `warnings`, nullable `progress`, and nullable `cleanup`.

- `queued`: not claimed yet.
- `running`: claimed, no result yet, also between attempts.
- `succeeded`: original work activated the version or found it already selected.
- `failed`: terminal failure or completion without activation.

Pending `progress.lastAttempt` contains the latest exact-work result's
allowlisted `code`, fixed `message`, and `at`; repeated deferrals record once,
except [refused-candidate stops](agents/deployment.md#pending-deployment-progress).
Null means no bound evidence. Maintenance and cleanup
results are excluded. `progress.nextAttemptAt` is the earliest queued
eligibility, not a promised start; null while claimed. Terminal `progress`
is null. Results describe recorded checks, not runtime health.

Nullable `cleanup` reports retirement’s `status` (same meanings) and queued
`nextAttemptAt`.
Deployment failure remains terminal. Terminal preparation errors retain
`error.data.preparation` under schema limits (identities, reasons, scheduling, exits, timestamps),
excluding raw output and credentials.

Errors have fixed codes, messages, and allowlisted `error.data`.
`CONVERGENCE_DEADLINE_EXCEEDED` data includes `timeoutMs` and optional
`runtimeFailure` (`component`, `check`, `checkedAt`, `code`) from that version
(unknown values read `UNRECOGNIZED`); missing evidence leaves the cause
unspecified. Held failures end deployment early:
`RUNTIME_AUTHENTICATION_FAILED` (rejected credential), `RUNTIME_CPU_STARVED`, `RUNTIME_MODEL_PROBE_TIMEOUT`,
`RUNTIME_MODEL_PROBE_FAILED`, `RUNTIME_LOGIN_FAILED`, `RUNTIME_STARTUP_FAILED`,
or `WORKSPACE_SETUP_REFUSED`; fix and redeploy. A dedicated gateway that refuses its
own CLI fails with
[`AGENT_GATEWAY_UNAUTHORIZED`](agents/deployment.md#pending-deployment-progress). `RUNTIME_MODEL_PROBE_FAILED` adds
[`runtimeFailure`](agents/deployment.md#model-check-failure-cause). Success can include [plugin warnings](agent-plugins.md#lifecycle)
with a closed code and `pluginId`.

Polling reads only persisted state. Terminal results survive runtime deletion
and controller restart; later deployments cannot rewrite them.

### Current runtime diagnostics

A bodyless `POST` to
`/namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId/diagnostics`
requests fresh checks for the specified Agent revision ID. It requires Agent read and operate
plus AgentRevision read. It returns an Agent revision ID, observation time, and at
most 32 checks. Kubernetes reports held startup failures and probes Slack
configuration, authentication, and connectivity without sending. Missing Pods
yield `unknown`; unavailable evidence yields `503`. The call changes no stored
state and proves no model response. On OpenShell the `agent` check is always
`unknown`; use deployment status and [Harness logs](../guides/topics/agent-troubleshoot.md#read-openshell-sandbox-and-supervisor-logs). See the [diagnostics flow](../flows/agent-deployment-diagnostics.md).

## Backend association

An Agent can reference one Installation-configured [experimental Backend](backends.md)
through `backendId`, a nullable reference returned on Agent and AgentRevision
responses. Create/PATCH omission, `null`, and ID validation follow the
[association rules](backends.md#agent-association-and-immutable-deployment);
no default is inferred.

The reference is independent of native model names and Harness selection.
OpenAI or Anthropic API keys and directly supplied service account tokens need
no Backend. An OCE-issued ChatGPT account token requires the matching Backend and
account at deployment request and again before startup.
Creating an Agent does not create a provider account or issue credentials.

## Harness authentication

`harnessAuth` selects how an Agent obtains model credentials. Creation
omission stores `null`; PATCH omission preserves the binding and explicit `null`
clears it. Both supported topologies require a valid binding at deployment.
A managed source must belong to the Agent's exact Namespace:

```json
{
  "harnessAuth": {
    "method": "api_key",
    "source": {
      "kind": "secret",
      "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
      "id": "sec_123e4567-e89b-42d3-a456-426614174000"
    }
  }
}
```

For a service account token, use `"method": "codex_pat"` with its Secret `source`.
This requires dedicated Codex.

Personal [Codex OAuth device login](../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)
is **Experimental**. Bind the returned credential source with
`{ "method": "credential_source", "sourceId": "cs_…" }`.

For an already issued ChatGPT account credential, use
`{ "method": "codex_pat", "source": { "kind": "service_account", "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000", "id": "sa_123e4567-e89b-42d3-a456-426614174000" } }`.
This requires dedicated Codex and the account's matching `backendId`. Binding
an account does not issue its credential or change the model, Harness, or Backend.

**Development upgrade limitation:** migration `0049` rejects retained
`chatgpt_service_account` bindings in Agent drafts, any historical AgentRevision,
or provisioning plans, and rolls back without converting them. No API deletes a
Agent revision or provisioning request on its own: delete each affected Agent, which
also deletes its Agent revisions and requests, and create it again after the upgrade.
Changing the binding does not clear historical Agent revisions. For a request that
never created an Agent, see
[clear legacy bindings](settings/operations.md#clear-legacy-managed-pat-bindings-before-0049).

For dedicated Codex with a Credential Gateway, use
`{ "method": "credential_source", "sourceId": "cs_…" }`; see
[credential sources](credential-sources.md#bind-a-source-to-an-agent) for grants.
It must also be listed in `credentialSources`.

For SSH embedded OpenClaw, use `{ "method": "runtime" }`. The operator supplies
credentials in the protected host environment file; OCC neither reads nor
delivers them and performs no authentication or model probe, so readiness does
not prove model access. The snapshot records only the method, so host credential
changes can affect existing versions. Agent and Configuration authorization,
topology checks, and process readiness remain required; no credential-source
permission is needed. Kubernetes and Docker reject this method. See
[SSH credentials](drivers/ssh-compute.md#credentials-and-supported-boundaries).

API-key and imported PAT bindings require the actor's exact Secret `operate`. That includes
the Secret the Agent already uses: every draft update checks it, including one that replaces it. Deployment also
requires the Agent service principal's exact Secret `operate`. Managed PAT binding
requires the actor's exact account `read`, including the current account on every draft update. There is no implied account grant for the Agent
principal. Each consumer of a shared source is authorized independently.

Deployment freezes binding references; dispatch rechecks source ownership and
actor/Agent grants. Draft changes take effect only on deployment. Public
responses omit credential values and private backend/account metadata. See
[supported providers, topologies, and credential delivery](harness-execution.md#harness-authentication) and
[Secret consumption grants](drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

## Plugin selections

An Agent can own an optional `plugins` map keyed by qualified curated catalog ID,
such as `google-calendar@openai-curated-remote`. Omission at creation enables no
plugins. PATCH omission preserves the saved plugin map, `{}` clears every desired
plugin, and a nonempty map replaces the entire desired plugin set.

Create/update validates only structural shape. Catalog membership, native
identity resolution, and approval-policy support are checked when deployment
starts the version; unsupported selections fail that startup without partially
mutating the Agent. AgentRevision snapshots retain the requested plugin IDs and
policy. See [Agent plugins](agent-plugins.md) for field semantics
and the selected-only runtime contract.

## Workspace files

An Agent's workspace holds `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.
See [Agent workspace files](agents/workspace-files.md) for request shapes,
limits, permissions, and errors.

### Initial contents at creation

Creation accepts optional `initialWorkspaceFiles` and `workspaceDefaultsId`.
First deployment applies them once; pending inputs have no read/update API. See
[initial contents](agents/workspace-files.md#initial-contents-at-creation).

### Live file access

`GET` and `PUT` on `/namespaces/:namespaceId/agents/:agentId/workspace/files/:name`
read (Agent `read`) or replace (Agent `operate`) one file in the live workspace.
See [live file access](agents/workspace-files.md#live-file-access).

## Native admin UI

Trusted operators can open the selected Agent gateway's stock native admin UI
when the Installation enables [Agent native admin UI access](agent-native-admin.md).
The availability route requires exact Agent `administer`; `read` and `operate`
are insufficient. The Agent must be desired running, have a selected version,
and expose a private gateway endpoint through the selected Compute Driver.

A derived per-Agent browser host proxies to the private gateway route using the
OCE session cookie under the shared cookie parent domain; OCC still authorizes
the exact Agent ([session boundary](agent-native-admin.md#shared-session-boundary)).
Native edits do not become Configuration changes or AgentRevision snapshots,
and redeploy does not erase all gateway-local state
([drift](agent-native-admin.md#native-authority-and-drift)).

## Namespace ownership

An Agent belongs to the Namespace in its creation URL; request bodies cannot
select a different Namespace or Installation. Names are unique within each
Namespace, and cross-Namespace access requires separate scoped permissions.
A failed or deleting Namespace rejects new Agents.

## Identity and deployment

Each Agent has one stable service principal and runs embedded OpenClaw or
dedicated Codex. A deployment request takes no body: it snapshots the saved
draft, and a worker starts it asynchronously. See
[Agent identity and deployment](agents/deployment.md) for permissions,
snapshot fields, and activation guarantees.

An authorized bodyless `POST /namespaces/:namespaceId/agents/:agentId/stop`
sets desired state to `stopped`. The worker removes execution and routing, then
clears `activeRevisionId`; version history, credentials, and persistent state
remain. Cleanup includes failed candidate resources and interrupted predecessor
retirement owned by the current Compute. Repeating stop is safe. To resume,
deploy a new version; old versions cannot be restarted. See
[stop and resume](agents/deployment.md#stop-and-resume).

## Deletion

A bodyless `DELETE /namespaces/:namespaceId/agents/:agentId` requires exact-Agent
`delete`, sets `status: deleting` and desired state `stopped`, queues teardown,
and returns `202`. Reads remain available; updates, deployment, credential
provisioning, and workspace writes return `409`. Repeated DELETE leaves queued
or running work unchanged.

The worker reauthorizes the caller, binds the saved identity to
Compute, retires every version, and removes runtime credentials. It
atomically deletes the Agent, its Agent revisions, service principal, API keys, and
exact IAM bindings and restrictions. Kubernetes retirement waits for owned Pods
and removes owned artifacts, including workspace data. Namespace Configurations
and Secrets survive. Deletion releases its name;
[repository cleanup](repository-credentials.md#repo-driver-contract) continues independently.

Permanent failure or exhausted attempts leave the Agent `deleting`.
After a fix, the initiating caller can repeat DELETE to
reset attempts; OCC and the worker recheck permission. Another
permitted actor gets `403`, audited with the `initiatingActorId`, until the
initiator loses permission, then takes over. Prior failure audits remain and
each retry is audited, as in [Namespace recovery](namespaces.md#failure-semantics-and-limitations).

## Editable configuration

An Agent's `configurationId` selects exactly one native OpenClaw Configuration
document with `kind: "agent"` in its own Namespace. A PATCH requires
`configurationId`, exact-Agent `update`, and exact-Configuration `read`.
This replaces the reference, preserving execution mode, harness binding, and Backend:

```json
{
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000"
}
```

Edit the Configuration's native document through its own exact-resource PATCH
endpoint ([Configuration CRUD](configuration.md#create-read-update-and-delete)). Changing
the Agent reference or Configuration values does not queue Compute work,
change the selected version, or mutate earlier versions. Create/update
reject inline configuration and competing gateway settings. Agents can share a Configuration;
deployed Agents keep separate gateways and stable service principals.

## Current limitations

The public API has no Agent revision mutation/deletion or explicit rollback endpoint.
Controller API authentication for Agent service principals remains unavailable.
The [OpenShell SandboxDriver](drivers/openshell-sandbox.md) requires Kubernetes Compute with dedicated Codex or worker-capable native OpenClaw. Its Credential Gateway mediates model sources; direct Secret delivery remains unsupported. Check its compatibility limits.

## Failure semantics

- `400 INVALID_REQUEST`: The Backend ID is malformed or empty, the plugin map is
  structurally invalid, or a runtime `modelApiKey` selector is supplied (use
  `harnessAuth`).
- `404 NOT_FOUND`: The nonempty Backend ID does not name a configured Backend.
- `401`: The session cookie is missing, invalid, expired, or revoked.
- `403`: Your principal lacks the exact permission for the Agent or Namespace.
- `404`: The Namespace or Agent does not exist under the requested parent, or
  the selected Configuration or associated service account is not in the Agent's
  Namespace.
- `409 RESOURCE_CONFLICT`: Harness authentication is missing, the selected
  account has no issued access token, or its Backend binding or topology is incompatible.
- `409 SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED`: The account has no access token,
  and the Installation has no ChatGPT Backend to issue one.
- `409 RESOURCE_CONFLICT`: Another Agent already uses that name in the same
  Namespace, the Namespace cannot accept new Agents, or a stopping Agent cannot
  accept the requested mutation.
- `409 AGENT_DELETING`: The Agent is [deleting](#deletion) and rejects the
  mutation.
- `409 NAMESPACE_NOT_READY`: The backing Namespace infrastructure is not ready
  for deployment.
- `503 DEPENDENCY_UNAVAILABLE`: A selected Harness descriptor, Compute
  implementation, or other required dependency is unavailable.
- `503 RUNTIME_CREDENTIALS_CLUSTER_RBAC`: The cluster denied the API
  ServiceAccount access to the Agent's runtime credential Secrets or Deployment
  preflight. An operator must [grant the tenant RoleBindings](../guides/deploy/production-agents.md#grant-tenant-rolebindings).

## Related

- [Deploy your first Agent](../guides/first-agent.md)
- [Agent Revisions](../guides/topics/agent-revisions.md)
- [Workspace files](../guides/topics/workspace-files.md)
- [Troubleshoot Agents](../guides/topics/agent-troubleshoot.md)
- [Development and production deployment](../guides/deploy.md)
- [Harness execution](harness-execution.md)
- [Namespaces](namespaces.md)
- [Controller worker](controller.md)
- [Namespace Configuration and immutable snapshots](configuration.md)
- [Service accounts](service-accounts.md)
- [Agent plugins](agent-plugins.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [IAM](authorization.md)
- [Controller configuration](settings.md)
- [Platform architecture](../design.md)
- [Agent lifecycle implementation](../../packages/occ/src/index.ts)
- [HTTP resource schemas](../../packages/contracts/src/api/resources.ts)
- [Local testing](../testing/local.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-25: Moved workspace file request details to [Agent workspace files](agents/workspace-files.md).

- 2026-09-23: Removed top-level `Agent.serviceAccountId` checks; use `harnessAuth`. (NOT_IN_SPEC)

[Agents reference documentation history](agents/history.md) preserves the older dated entries.
