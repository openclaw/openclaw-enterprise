# Agents

An Agent is a named, persistent resource representing one AI workload inside a
[Namespace](namespaces.md). Each Agent has its own identity and revision history and cannot cross
Namespace boundaries.

```text
Namespace: support
├── Agent: ticket-triage
│   ├── Service principal: unique to ticket-triage
│   └── Gateway: unique to deployed ticket-triage
└── Agent: customer-help
    ├── Service principal: unique to customer-help
    └── Gateway: unique to deployed customer-help
```

Creating an Agent records its platform resource, exact Namespace-owned
Configuration reference, identity, and a `stopped` desired runtime state. It does not start a workload, deploy a
model, or create a revision until an authorized caller explicitly requests
deployment.

## Supported operations

Agent operations are scoped beneath `/namespaces/:namespaceId/agents`. Creation
returns `201`, reads and updates return `200`, and deployment returns `202`
with the newly admitted AgentRevision. Stop also returns `202`, with the Agent's
`desiredRuntimeState` set to `stopped`; Compute shutdown remains asynchronous.
Collection reads include only Agents
for which the caller has an exact `read` grant. The [API reference](api.md)
owns route schemas, response envelopes, and permission annotations.

Creation body:

```json
{
  "name": "ticket-triage",
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "executionMode": "dedicated",
  "providerId": null
}
```

Creation requires an existing Namespace in `provisioning` or `ready` status
and a same-Namespace Configuration with `kind: "agent"`. The caller needs
Agent `create` permission in that Namespace and `read` permission on the
exact Configuration. A selected harness credential source requires its own exact permissions; see
[harness authentication](#harness-authentication). [Authentication](authentication.md) establishes the
caller; [authorization](authorization.md) defines its grants.

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
A successful deployment can include plugin warnings containing a closed code
and admitted `pluginId`; see [Agent plugins](agent-plugins.md#lifecycle). These
warnings record the observed startup result, not live plugin health.
A later deployment admits a new revision with its own deployment status and does
not rewrite the original result.

## Provider association

An Agent can reference one Installation-configured [Provider](providers.md)
through `providerId`. Create omission means `null`; PATCH omission preserves the
saved value, while explicit `null` clears the draft reference. A nonnull ID must
resolve to a configured Provider. No default is inferred. The nullable reference
is returned on both Agent and AgentRevision responses.

The Provider reference is independent of native model names and Harness
selection. Providerless Agents remain supported with an OpenAI API-key harness binding. A managed access token requires the
matching Provider and private account binding at admission and reconciliation;
see [Provider deployment checks](providers.md#agent-association-and-immutable-deployment).
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

For an already issued ChatGPT account credential, use
`{ "method": "chatgpt_service_account", "serviceAccountId": "sa_123e4567-e89b-42d3-a456-426614174000" }`.
This requires dedicated Codex and the account's matching `providerId`. Binding
an account does not issue its credential or change the model, Harness, or Provider.

For SSH embedded OpenClaw, use `{ "method": "runtime" }`. The operator supplies
credentials in the protected host environment file; OCC neither reads nor
delivers credentials and performs no authentication/model probe. Agent and
Configuration authorization, topology checks, and process readiness remain
required. No credential-source permission is needed because OCC owns no source.
Kubernetes and Docker reject this method. See [SSH credentials](drivers/ssh-compute.md#credentials-and-supported-boundaries).

API-key binding requires the actor's exact Secret `operate`. Deployment also
requires the Agent service principal's exact Secret `operate`. ChatGPT binding
requires the actor's exact account `read`, including the current account when
replacing or clearing a binding. There is no implied account grant for the Agent
principal. Each consumer of a shared source is authorized independently.

A deployment freezes the binding and, for managed methods, resolved reference metadata.
A `runtime` snapshot contains only its method. Operator changes to host credentials
can affect an existing revision without redeployment; readiness does not prove model access. Dispatch
reauthorizes the admitted actor and required Agent grants, and checks source
ownership again. Public responses expose safe references only. Backend Secret
names, provider workspace IDs, upstream identities, and credential values remain
private. Changing a draft requires a later explicit deployment. See
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

## Namespace ownership

An Agent belongs to the Namespace in its creation URL. The controller assigns
that ownership; request bodies cannot select a different Namespace or
Installation.

Names are unique within one Namespace. Two different Namespaces can each own an
Agent with the same name, but neither can read or operate the other's Agent
without its own scoped permissions.

You can create an Agent while its Namespace is still `provisioning`. A failed
or deleting Namespace rejects new Agents.

## Identity and deployment

Each Agent has one stable service principal and explicitly selects embedded OpenClaw or dedicated Codex execution. A bodyless deployment request admits an immutable revision; the separate worker activates it asynchronously. See [Agent identity and deployment](agents/deployment.md) for credential boundaries, admission permissions, snapshot fields, and activation guarantees.

An authorized bodyless `POST /namespaces/:namespaceId/agents/:agentId/stop`
sets desired state to `stopped`. The worker removes execution and routing before
clearing `activeRevisionId`; revision history, credentials, and persistent state
remain. Cleanup includes failed candidate resources and interrupted predecessor
retirement owned by the current Compute. Repeating stop is safe. A later deployment admits a new revision and sets
desired state back to `running`; stop does not restart an old revision directly.

## Editable configuration

An Agent's `configurationId` selects exactly one native OpenClaw Configuration
document with `kind: "agent"` in its own Namespace. A PATCH requires
`configurationId`, exact-Agent `update`, and exact-Configuration `read`.
This replaces the reference, preserving execution mode, harness binding, and Provider:

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
binding and Provider association, and optional Agent-owned plugin selections;
they do not accept an inline configuration document or competing gateway
settings. Multiple Agents can
share the same Configuration;
each deployed Agent still owns its own gateway and stable service principal.

## Current limitations

The public API has no Agent deletion operation, revision mutation/deletion,
or explicit rollback endpoint. An Agent therefore prevents deletion of its
Namespace. Editing a Configuration or Agent does not update a running workload;
a new deployment is required. Stop retains Agent-owned persistent data and does
not destroy credentials. Brokered model credentials and controller API
authentication for Agent service principals remain unavailable. The optional
[OpenShell SandboxDriver](drivers/openshell-sandbox.md) is supported with the
bundled Kubernetes Compute Driver and dedicated Codex; other sandbox execution
combinations are rejected.

## Failure semantics

- `400 INVALID_REQUEST`: The Provider ID is malformed or empty.
- `400 INVALID_REQUEST`: The plugin map is structurally invalid.
- `404 NOT_FOUND`: The nonempty Provider ID does not name a configured Provider.
- `401`: The session cookie is missing, invalid, expired, or revoked.
- `403`: Your principal lacks the exact permission for the Agent or Namespace.
- `404`: The Namespace or Agent does not exist under the requested parent.
- `404`: The selected Configuration does not belong to the Agent's Namespace.
- `404`: An associated service account does not belong to the Agent's Namespace.
- `409 RESOURCE_CONFLICT`: Harness authentication is missing, the selected
  account has no issued access token, or its Provider binding or topology is incompatible.
- `400 INVALID_REQUEST`: A removed top-level `serviceAccountId` or runtime
  `modelApiKey` selector is supplied. Use `harnessAuth` explicitly.
- `409 RESOURCE_CONFLICT`: Another Agent already uses that name in the same
  Namespace, or the Namespace cannot accept new Agents.
- `409 NAMESPACE_NOT_READY`: The backing Namespace infrastructure is not ready
  for deployment.
- `503 DEPENDENCY_UNAVAILABLE`: A selected Harness descriptor, Compute
  implementation, or other required dependency is unavailable.

## Related

- [Quickstart](../guides/quickstart.md)
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

- 2026-09-01 08:47: Document nullable providerId selection, immutable revision association, and managed binding admission. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 17:55]: Recast as the current Agent and AgentRevision feature reference; separate procedures and correct Harness and SandboxDriver boundaries. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
