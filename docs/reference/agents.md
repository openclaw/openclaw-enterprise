# Agents

An Agent is a named AI workload in a [Namespace](namespaces.md), with its own
identity, revision history, and deployed gateway. Its permissions do not grant
access to another Namespace's resources.

Use a [Preset](presets.md) to copy reusable launch settings into a new Agent draft.

To get one running, [deploy your first Agent](../guides/first-agent.md). For an
existing Agent, see [Compute](../guides/topics/agent-compute.md) for execution
choices, [Agent Revisions](../guides/topics/agent-revisions.md) for changes, or
[Troubleshoot](../guides/topics/agent-troubleshoot.md) if a deployment stalls.

Creating an Agent saves its identity and exact Namespace-owned Configuration
reference with an `active` lifecycle status and a `stopped` desired runtime
state. No workload or model starts, and no revision is created, until an
authorized caller requests deployment. See [identity and deployment](#identity-and-deployment)
for revision, execution, and stop behavior.

## Supported operations

Agent operations are scoped beneath `/namespaces/:namespaceId/agents`. Creation
returns `201`, reads and updates return `200`, and deployment returns `202`
with the newly admitted AgentRevision. Stop and deletion also return `202`;
their Compute effects remain asynchronous. Stop sets the Agent's
`desiredRuntimeState` to `stopped`. Collection reads include only Agents the
caller has an exact `read` grant for. The [API reference](api.md) documents route
schemas, response envelopes, and permissions.

Authorized Agent responses include immutable, read-only `servicePrincipalId`.
Use this value for [Namespace IAM bindings](authorization.md#manage-namespace-policy);
clients must not derive the identity from the Agent ID. Create and update
requests reject a supplied `servicePrincipalId`.

Creation body:

```json
{
  "name": "ticket-triage",
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "executionMode": "dedicated",
  "backendId": null
}
```

Creation requires an existing Namespace in `provisioning` or `ready` status
and a same-Namespace Configuration with `kind: "agent"`. The caller needs
Agent `create` permission in that Namespace and `read` permission on the
exact Configuration. A selected model credential requires separate permissions;
see [Harness authentication](#harness-authentication). [Authentication](authentication.md)
establishes the caller; [authorization](authorization.md) defines its grants.

## Deployment status

The `deploymentId` for status polling is the admitted AgentRevision ID returned
by `POST /namespaces/:namespaceId/agents/:agentId/deploy`. The deploy response
being `202` means OCC admitted immutable revision state and queued work; it does
not mean the workload is ready.

Poll the original deployment work with:

```text
GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId
```

The caller needs read access to that exact AgentRevision. Responses include the
original `deploymentId`, `namespaceId`, `agentId`, a `status`, nullable
`error`, and plugin `warnings`. `queued` means no live worker claim currently owns the original work,
including after a claim lease expires. `running` means a worker claim is still
live. `succeeded` means the original deployment work completed activation or
was already active; it is historical completion evidence, not a live health
probe. `failed` means the original work reached a terminal failed outcome or
completed without activating the requested revision.

Errors use fixed platform codes, messages, and allowlisted `error.data`.
For `CONVERGENCE_DEADLINE_EXCEEDED`, data contains positive `timeoutMs` and may
include `runtimeFailure` with safe `component`, `check`, `checkedAt`, and `code`
fields captured by Compute from that revision's runtime. The primary code and
message remain unchanged. Missing evidence leaves the cause unspecified.
The result is persisted with terminal work and survives runtime deletion or
controller restart. Polling this endpoint reads stored state only; it performs
no runtime, provider, or model probes and requires no Agent `operate` permission.
A successful deployment can include plugin warnings containing a closed code
and admitted `pluginId`; see [Agent plugins](agent-plugins.md#lifecycle). These
warnings record the observed startup result, not live plugin health.
A later deployment admits a new revision with its own deployment status and does
not rewrite the original result.

## Backend association

An Agent can reference one Installation-configured [experimental Backend](backends.md)
through `backendId`. Create omission means `null`; PATCH omission preserves the
saved value, while explicit `null` clears the draft reference. A nonnull ID must
resolve to a configured Backend. No default is inferred. The nullable reference
is returned on both Agent and AgentRevision responses.

The Backend reference is independent of native model names and Harness
selection. An Agent using an OpenAI or Anthropic API key, or a directly supplied
service account token, does not need a Backend. An OCE-issued ChatGPT account
token requires the matching Backend and account when deployment
is requested and again before startup; see [Backend deployment checks](backends.md#agent-association-and-immutable-deployment).
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

See [supported providers and topologies](harness-execution.md#harness-authentication).

For a directly supplied service account token stored in an OCC Secret, use the same
`source` with `"method": "codex_pat"`. Console labels this source **Service Accounts**.
It requires dedicated Codex; no managed account is created.

For an already issued ChatGPT account credential, use
`{ "method": "chatgpt_service_account", "serviceAccountId": "sa_123e4567-e89b-42d3-a456-426614174000" }`.
This requires dedicated Codex and the account's matching `backendId`. Binding
an account does not issue its credential or change the model, Harness, or Backend.

For SSH embedded OpenClaw, use `{ "method": "runtime" }`. The operator supplies
credentials in the protected host environment file; OCC neither reads nor
delivers credentials and performs no authentication/model probe. Agent and
Configuration authorization, topology checks, and process readiness remain
required. No credential-source permission is needed because OCC owns no source.
Kubernetes and Docker reject this method. See [SSH credentials](drivers/ssh-compute.md#credentials-and-supported-boundaries).

API-key and service account token bindings require the actor's exact Secret `operate`. Deployment also
requires the Agent service principal's exact Secret `operate`. ChatGPT binding
requires the actor's exact account `read`, including the current account when
replacing or clearing a binding. There is no implied account grant for the Agent
principal. Each consumer of a shared source is authorized independently.

Deployment freezes binding references; dispatch rechecks source ownership and actor/Agent grants.
Public responses omit credential values and private backend/account metadata. Draft
changes require deployment. A `runtime` snapshot records only its method: host
credential changes can affect existing revisions, and readiness does not prove model access. See
[credential delivery](harness-execution.md#harness-authentication) and
[Secret consumption grants](drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

## Plugin selections

An Agent can own an optional `plugins` map keyed by qualified curated catalog ID,
such as `google-calendar@openai-curated-remote`. Omission at creation enables no
plugins. PATCH omission preserves the saved plugin map, `{}` clears every desired
plugin, and a nonempty map replaces the entire desired plugin set.

Agent create/update validates only structural shape. Catalog membership, native
identity resolution, and approval-policy support are checked when a deployment
starts the revision; unsupported selections fail that startup rather than
partially mutating the Agent. AgentRevision snapshots retain the requested
plugin IDs and policy. See [Agent plugins](agent-plugins.md) for field semantics
and the selected-only runtime contract.

## Workspace files

### Initial contents at creation

`POST /namespaces/:namespaceId/agents` accepts `initialWorkspaceFiles`, an optional
partial map of the four filenames below to strings. Replace the example Configuration ID with yours:

```json
{
  "name": "Support assistant",
  "configurationId": "cfg_12345678-1234-4123-8123-123456789abc",
  "initialWorkspaceFiles": { "AGENTS.md": "Answer support questions.\n", "USER.md": "" }
}
```

Omission or `{}` uses native initialization; omitted filenames keep native
behavior. Empty strings create empty files. Values must satisfy the live-file
Unicode and 16 KiB limits below; other names and non-strings are rejected.
The API preserves whitespace and newlines. Create requests default to 448 KiB,
including JSON escaping; configured controller limits take precedence.

Creation uses existing permissions, stays undeployed, and stages inputs privately
outside Agent, Configuration, and AgentRevision. First deployment applies them
before execution. Completion prevents replay over later edits. Staged bytes are
removed after activation or Agent deletion. Pending inputs have no read/update
API; correction requires deleting and recreating the Agent.

The optional `workspaceDefaultsId` is a SHA-256 defaults identity. Console sends
all four rendered `2026.9.5` defaults with this identity. A stale identity rejects
creation with `409 RESOURCE_CONFLICT`; runtime mismatch blocks initial setup.
See the [workspace guide](../guides/topics/workspace-files.md) and
[setup flow](../flows/workspace-files.md) for recovery and runtime requirements.

### Live file access

Read, create, or replace `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`
in an Agent's live workspace:

```text
/namespaces/:namespaceId/agents/:agentId/workspace/files/:name
```

| Method | Operation                  | Agent permission | Response `data`     |
| ------ | -------------------------- | ---------------- | ------------------- |
| `GET`  | Read the file              | `read`           | `{ name, content }` |
| `PUT`  | Create or replace the file | `operate`        | `{ name, size }`    |

Authenticate with a session or scoped service API key. Session-authenticated
writes must pass the [CSRF checks](authentication.md). The Agent must have an
active revision and a reachable gateway.

`PUT` accepts one `content` field:

```json
{ "content": "You are a support assistant.\n" }
```

`content` must be well-formed Unicode without NUL characters and fit within
16 KiB when encoded as UTF-8. The complete request body is limited to 48 KiB.
Successful requests return `200`; `size` is the written content's UTF-8 byte
count. Successful writes record the Agent, file name, and outcome in the audit log.

| Error                        | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `400 INVALID_REQUEST`        | Invalid file name or content.                        |
| `404 NOT_FOUND`              | The requested Agent or file was not found.           |
| `409 AGENT_DELETING`         | The Agent is being deleted.                          |
| `409 RESOURCE_CONFLICT`      | The Agent is stopping.                               |
| `413 PAYLOAD_TOO_LARGE`      | The request body exceeds 48 KiB.                     |
| `503 DEPENDENCY_UNAVAILABLE` | Workspace access is unavailable.                     |
| `503 UNKNOWN_OUTCOME`        | OCC could not confirm the write or its audit record. |

After `UNKNOWN_OUTCOME`, read the current file before deciding whether to submit
another write.

See [gateway routing](gateway-routing.md) for transport configuration and
[workspace-file setup](../guides/deploy/workspace-routing.md#agent-workspace-files) to enable
access, the [HTTP API](api.md#get-namespacesnamespaceidagentsagentidworkspacefilesname)
for request and response schemas, and the [execution flow](../flows/workspace-files.md)
for implementation details.

## Native admin UI

Trusted operators can open the selected Agent gateway's stock native admin UI
when the Installation enables [Agent native admin UI access](agent-native-admin.md).
The availability route requires exact Agent `administer`; `read` and `operate`
are insufficient. The Agent must be desired running, have an active revision,
and expose a private gateway endpoint through the selected Compute Driver.

The native UI uses the Agent's derived browser host and the existing private
gateway route. The derived host authenticates with the ordinary OCE browser
session cookie under the configured shared cookie parent domain; OCC still
resolves and authorizes the exact Agent before proxying. OCE does not turn
native edits into Configuration changes or AgentRevision snapshots. Redeploy
applies the managed revision again but does not erase all gateway-local state.

## Namespace ownership

An Agent belongs to the Namespace in its creation URL. The controller assigns
that ownership; request bodies cannot select a different Namespace or
Installation.

Names are unique within each Namespace. Cross-Namespace access requires
separate scoped permissions.

You can create an Agent while its Namespace is still `provisioning`. A failed
or deleting Namespace rejects new Agents.

## Identity and deployment

Each Agent has one stable service principal and runs embedded OpenClaw or
dedicated Codex. A deployment request takes no body: it snapshots the saved
draft, and a worker starts it asynchronously. See
[Agent identity and deployment](agents/deployment.md) for the permissions,
snapshot fields, and activation guarantees.

An authorized bodyless `POST /namespaces/:namespaceId/agents/:agentId/stop`
sets desired state to `stopped`. The worker removes execution and routing before
clearing `activeRevisionId`; revision history, credentials, and persistent state
remain. Cleanup includes failed candidate resources and interrupted predecessor
retirement owned by the current Compute. Repeating stop is safe. A later
deployment creates a new revision and sets desired state back to `running`;
you cannot restart an old revision directly.

## Deletion

An authorized bodyless `DELETE /namespaces/:namespaceId/agents/:agentId`
sets `status` to `deleting`, sets desired runtime state to `stopped`, queues
teardown, and returns `202`. A deleting Agent remains readable while work is in
flight, but update, deployment, runtime-credential provisioning, and workspace
writes return `409`. Repeating deletion while the Agent exists converges on the
same queued operation.

The worker reauthorizes the original caller, binds the persisted Agent identity
into Compute, retires every revision, and removes the Agent's runtime credentials
before atomically deleting the Agent, its
revision history, service principal, service-principal API keys, and exact IAM
bindings and restrictions. Kubernetes revision retirement waits for exact
workload Pods and removes Agent-owned compute artifacts, including workspace
data. Namespace-owned Configurations and Secrets survive. After success,
the Agent disappears from reads and its name can be reused. Retryable cleanup
failures leave the Agent in `deleting` while bounded queue retries continue.
Permanent failures fail closed in `failed_permanent`; the Agent remains
`deleting`, and the current API has no requeue or operator recovery path.

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

The request returns `200` with the updated Agent. Update the Configuration's
native nested document through its own exact-resource PATCH endpoint; see
[Configuration CRUD](configuration.md#create-read-update-and-delete). Changing
the Agent reference or Configuration values does not queue Compute work,
change the active revision, or mutate earlier revisions. Agent create and update
accept a Configuration reference, optional execution mode, optional harness authentication
binding and Backend association, and optional Agent-owned plugin selections;
they do not accept an inline configuration document or competing gateway
settings. Multiple Agents can
share the same Configuration;
each deployed Agent still owns its own gateway and stable service principal.

## Current limitations

The public API has no revision mutation/deletion or explicit rollback endpoint.
Brokered model credentials and controller API
authentication for Agent service principals remain unavailable. The optional
[OpenShell SandboxDriver](drivers/openshell-sandbox.md) requires bundled
Kubernetes Compute and dedicated Codex. Stock OpenShell cannot provide all the
required workload credentials; review the documented compatibility limits before
planning a deployment. Other sandbox execution combinations are rejected.

## Failure semantics

- `400 INVALID_REQUEST`: The Backend ID is malformed or empty.
- `400 INVALID_REQUEST`: The plugin map is structurally invalid.
- `404 NOT_FOUND`: The nonempty Backend ID does not name a configured Backend.
- `401`: The session cookie is missing, invalid, expired, or revoked.
- `403`: Your principal lacks the exact permission for the Agent or Namespace.
- `404`: The Namespace or Agent does not exist under the requested parent.
- `404`: The selected Configuration does not belong to the Agent's Namespace.
- `404`: An associated service account does not belong to the Agent's Namespace.
- `409 RESOURCE_CONFLICT`: Harness authentication is missing, the selected
  account has no issued access token, or its Backend binding or topology is incompatible.
- `400 INVALID_REQUEST`: A runtime `modelApiKey` selector is supplied. Use
  `harnessAuth` explicitly.
- `409 RESOURCE_CONFLICT`: Another Agent already uses that name in the same
  Namespace, the Namespace cannot accept new Agents, or a stopping Agent cannot
  accept the requested mutation.
- `409 AGENT_DELETING`: The Agent is deleting and cannot accept update,
  deployment, credential-provisioning, or workspace-write mutations.
- `409 NAMESPACE_NOT_READY`: The backing Namespace infrastructure is not ready
  for deployment.
- `503 DEPENDENCY_UNAVAILABLE`: A selected Harness descriptor, Compute
  implementation, or other required dependency is unavailable.

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
- [Implementation architecture](../ARCHITECTURE.md)
- [Agent lifecycle implementation](../../packages/occ/src/index.ts)
- [HTTP resource schemas](../../packages/contracts/src/api/resources.ts)
- [Local testing](../testing/local.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-23: Removed top-level `Agent.serviceAccountId` checks; use `harnessAuth`. (NOT_IN_SPEC)

- 2026-09-01 08:47: Document nullable providerId selection, immutable revision association, and managed binding admission. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 17:55]: Recast as the current Agent and AgentRevision feature reference; separate procedures and correct Harness and SandboxDriver boundaries. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
