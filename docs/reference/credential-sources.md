# Credential sources

A credential source registers a Namespace Secret with the Installation's
selected [Credential Gateway](drivers/credential-gateway.md). The gateway keeps
its own copy of the value and applies it outside the Agent workload, so the
Harness never receives the real credential. An Agent uses a source through
[`harnessAuth`](agents.md#harness-authentication).

Credential sources require a selected Credential Gateway. The only
implementation is the [OpenShell Credential Gateway](drivers/openshell-credential-gateway.md),
which supports one source type, `openai`, for dedicated Codex model
authentication. OpenShell is not a supported production Agent path; see its
[remaining blockers](drivers/openshell-sandbox.md#current-upstream-preconditions).

## Register a source

1. Wait for the Namespace to become `ready`.
2. [Create a Secret](drivers/kubernetes-secret.md#create-a-namespace-owned-secret)
   that holds the value, and keep its `ref`.
3. Send `POST /namespaces/:namespaceId/credential-sources`. The caller needs
   `credential_source:create` on the Namespace and `secret:operate` on every
   referenced Secret:

   ```json
   {
     "name": "openai-production",
     "type": "openai",
     "secrets": {
       "api_key": {
         "kind": "secret",
         "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
         "id": "sec_123e4567-e89b-42d3-a456-426614174000"
       }
     }
   }
   ```

A successful request returns `201` with the source metadata. Its `id` starts
with `cs_`, and `ref` is the reference used in Agent bindings. The response
includes the gateway's `status` but never a credential value.

The request fields are:

- `name`: required; unique within the Namespace.
- `type`: required; a type from the gateway catalog. Unknown types fail with
  `404` before any gateway call.
- `config`: optional nonsecret strings keyed by catalog field name.
- `secrets`: Secret references keyed by catalog field name. Each Secret must
  belong to the same Namespace.

OCC rejects unknown fields and missing required fields before it reads any
Secret. It reads each value through the Secret Driver, sends the values to the
gateway, and stores only the Secret references. OCC records the source as
`registering` before the gateway call. If the gateway rejects the registration,
OCC deletes any copy and the record. If the call fails without an answer, such as
on a timeout, a copy may still appear later, so the record stays listed as
`deleting`; send DELETE to remove it.

## Read and list sources

`GET /namespaces/:namespaceId/credential-sources/:credentialSourceId` requires
exact `read`. It returns the record plus live `status` from the gateway:
`ready`, `pending`, `failed`, or `absent`, with an optional `reason`. If the
gateway cannot answer, `status` is `failed` with a fixed reason; the read still
succeeds.

`GET /namespaces/:namespaceId/credential-sources` requires `read` on the
collection and returns only sources on which the caller has exact `read`. Lists
do not call the gateway and omit `status`.

The record's `state` is `registering`, `ready`, or `deleting`. A source left
`registering` by an interrupted request never becomes usable; delete it to
remove any gateway copy. A `registering` or `deleting` source cannot be
bound or deployed.

## Bind a source to an Agent

Set the Agent's binding to
`{ "method": "credential_source", "sourceId": "cs_…" }`. The caller needs
`credential_source:operate` on the exact source. Deployment also requires the
Agent's service principal to have `operate` on it; grant it with a
[Namespace IAM](authorization.md#manage-namespace-policy) Role and an exact
`credential_source` AccessBinding. The principal needs no permission on the
underlying Secret. The worker rechecks both grants before it
provisions the revision. See [Harness execution](harness-execution.md#harness-authentication)
for the supported topology.

While a Credential Gateway is selected, deployment rejects `api_key`,
`codex_pat`, and `chatgpt_service_account` bindings with `409`. Guided Agent
provisioning does not yet accept credential sources; create the Agent, then
deploy it.

## Replace or delete a source

There is no update operation. To change the credential, register a new source,
update and redeploy each Agent, and delete the old source after its revisions
retire. Updating the underlying Secret does not change the gateway's copy.

`DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId`
requires exact `delete` and returns `204`:

- It returns `409` while an Agent draft, active revision, or pending deployment
  references the source.
- It marks the record `deleting` before it asks the gateway to remove its copy.
  A gateway failure returns `503` and leaves the record `deleting`. Send the same
  request again; an already-removed copy counts as deleted.
- Within 70 seconds of registration, deletion removes the copy but returns `503`
  and keeps the record, because a timed-out registration could still create a
  copy. Retry after that window.

While a source exists, including one in `deleting`, its Namespace cannot be
deleted, and its referenced Secrets cannot be deleted.

## Errors

| Status                       | Meaning                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`        | The body or a field name is malformed.                                                               |
| `403 FORBIDDEN`              | A required `credential_source` or `secret` permission is missing.                                    |
| `404 NOT_FOUND`              | The source, Secret, or type is not in the exact Namespace or catalog, or a catalog field is invalid. |
| `409 NAMESPACE_NOT_READY`    | The Namespace is not `ready`.                                                                        |
| `409 RESOURCE_CONFLICT`      | The source is still referenced, or it changed during deletion.                                       |
| `503 DEPENDENCY_UNAVAILABLE` | No Credential Gateway is selected, the Secret Driver cannot read values, or the gateway call failed. |

## Related

- [CredentialGatewayDriver contract](drivers/credential-gateway.md)
- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Secrets](../guides/topics/secrets.md) and [Permissions](cheatsheets/permissions.md)
- [HTTP API: credential sources](api.md#credential-sources)
