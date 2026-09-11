# Agents

An Agent is a named, persistent resource representing one AI workload inside a
[Namespace](namespaces.md). Each Agent has its own identity and revision
history. Agents in the same Namespace remain separate, and Agents never cross
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
Configuration reference, and identity. It does not start a workload, deploy a
model, or create a revision until an authorized caller explicitly requests
deployment.

## Supported operations

Agent operations are scoped beneath `/namespaces/:namespaceId/agents`. Creation
returns `201`, reads and updates return `200`, and deployment returns `202`
with the newly admitted AgentRevision. Collection reads include only Agents
for which the caller has an exact `read` grant. The [API reference](api.md)
owns route schemas, response envelopes, and permission annotations.

A representative creation body is:

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
exact Configuration. An optional associated service account requires its own
exact `read` permission. [Authentication](authentication.md) establishes the
caller; [authorization](authorization.md) defines its grants.

## Provider association

An Agent can reference one Installation-configured [Provider](providers.md)
through `providerId`. Create omission means `null`; PATCH omission preserves the
saved value, while explicit `null` clears the draft reference. A nonnull ID must
resolve to a configured Provider. No default is inferred. The nullable reference
is returned on both Agent and AgentRevision responses.

The Provider reference is independent of native model names and Harness
selection. Providerless Agents remain supported with native API-key or
independently supplied model credentials. A managed access token requires the
matching Provider and private account binding at admission and reconciliation;
see [Provider deployment checks](providers.md#agent-association-and-immutable-deployment).
Creating an Agent does not create a provider account or issue credentials.

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

## Editable configuration

An Agent's `configurationId` selects exactly one native OpenClaw Configuration
document with `kind: "agent"` in its own Namespace. A PATCH requires
`configurationId`, exact-Agent `update`, and exact-Configuration `read`.
For example, the body below replaces the reference and preserves the current
execution mode, service account, and Provider:

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
accept a Configuration reference, optional execution mode, optional service
account and Provider associations, and optional Agent-owned plugin selections;
they do not accept an inline configuration document or competing gateway
settings. Multiple Agents can
share the same Configuration;
each deployed Agent still owns its own gateway and stable service principal.

## Current limitations

The public API has no Agent deletion operation, revision mutation/deletion,
or explicit rollback endpoint. An Agent therefore prevents deletion of its
Namespace. Editing a Configuration or Agent does not update a running workload;
a new deployment is required. Brokered model credentials and controller API
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
- `409 RESOURCE_CONFLICT`: The associated account has no credential, stores an
  unsupported OAuth credential, or uses a provider-managed access token with
  an unsupported non-Codex or embedded Harness, or lacks a matching Provider
  and private managed-account binding.
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
