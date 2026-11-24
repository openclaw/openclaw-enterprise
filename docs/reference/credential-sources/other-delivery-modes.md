# Other credential delivery modes

The Source API accepts named Secret references for protected metadata Sources
offered by the selected Credential Proxy. For model credentials, OAuth, and
GitHub installation Sources, see [TokenService enrollment](../credential-sources.md#register-a-source).

For a dedicated Agent, the **OpenClaw Gateway Pod** reads its admitted channel
credentials and any configured Gateway password from Kubernetes Secrets.
The Harness receives the model credential projection separately. Embedded
execution combines Gateway and Harness in one workload. See
[runtime credential placement](../drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials).

- A **prepared GitHub token** Source (`github-app-metadata`) permits one protected metadata read. The configured issuer reads the approved App signing key from an administrator-supplied Namespace Secret under the selected Secret Driver. The ordinary native Git path uses a TokenService-managed GitHub App Client.
- A **credential-free repository metadata** Source permits an admitted repository identity read without credential injection. Request and response controls still apply.

OpenShell is a development integration. See the
[OpenShell qualification requirements](../drivers/openshell-sandbox.md#qualification-contract),
[Credential Proxy overview](../../design/credential-proxy.md) and
[threat model](../security/credential-proxy.md).

## Register a source

1. Wait for the Namespace to become `ready`.
2. For a Secret-backed source, [create a Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret) and keep its `ref`.
3. Send `POST /namespaces/:namespaceId/credential-sources`. The caller needs
   `credential_source:create` on the Namespace and `secret:operate` on each
   referenced Secret. A protected metadata source requires `agent:operate`
   on the active, dedicated Agent named by `config.agent_id` in that Namespace.

The protected GitHub metadata example requires a qualified sender and Sandbox that enforce the protected exchange. Stock OpenShell does not provide this path; see [protected-exchange requirements](../../design/credential-proxy.md#which-checks-does-openshell-provide).

Replace the sample IDs and Secret reference. Execution authority admits every process in that execution.

```json
{
  "name": "widgets-metadata",
  "type": "github-app-metadata",
  "config": {
    "app_id": "1001",
    "installation_id": "2002",
    "repository_id": "12345",
    "repository": "acme/widgets",
    "agent_id": "agt_123e4567-e89b-42d3-a456-426614174000",
    "authority": "execution"
  },
  "secrets": {
    "private_key": {
      "kind": "secret",
      "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
      "id": "sec_123e4567-e89b-42d3-a456-426614174000"
    }
  }
}
```

The `201` response includes the Source ID. The type must appear in the selected
Proxy's catalog. Invalid fields or a cross-Namespace Secret reference fail before
the issuer reads credentials. OCC records `registering` before it configures
the issuer. If that operation fails, delete the Source to withdraw its issuer grant.

## Read and list sources

Exact GET requires `credential_source:read`. A prepared Source can have record
state `ready` and status `pending` while its token is being prepared. List
requires Namespace `read` and includes only Sources the caller can read.

## Bind a source to an Agent

Set `credentialSources` to a list of up to 64 distinct
`{ "sourceId": "cs_…" }` entries. On update, the list replaces the draft's
bindings. Omit it to keep them or send `[]` to remove them all.

| When                       | Required source permissions                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create or update the Agent | The caller needs the corresponding `agent:create` or `agent:update` and `credential_source:operate` on each current and requested source, including removals.                              |
| Deploy                     | The caller needs `agent:deploy`. Both the caller and the Agent service principal need `credential_source:operate` on each listed source. The worker checks both again before provisioning. |
| Use a protected source     | OCC checks the Agent service principal's current `credential_source:operate` before it releases material and again before it authorizes the send.                                          |

[Grant the Agent service principal access to the source](../authorization.md#manage-namespace-policy)
with a Namespace IAM Role and AccessBinding. The Agent needs no permission on the
underlying Secret. Each requested source must be ready and its recorded owner
selected. Newly registered metadata sources belong to the Credential Proxy.

Deployment with credential sources requires a selected Sandbox Driver. For these delivery modes, the revision records each Source's ID, type, and owning Driver ID. For the `widgets-metadata` example, the protected
plan allows `GET /repos/acme/widgets` for that execution and source generation. Follow the
[request to GitHub and its reply](../../flows/credential-source-egress.md#follow-the-metadata-get).
Cloning, pushing or creating a pull request requires a separately admitted
[repository binding](../repository-credentials.md).

## Update a source

Prepared and credential-free metadata grants are fixed at registration. To
change a grant, register a replacement, update the Agent binding, and deploy.

## Rotate a refresh source

For OAuth renewal, use the [TokenService Source lifecycle](../credential-sources.md).
Prepared metadata Sources refuse on-demand rotation.

## Withdraw a source from an Agent

Withdrawal revokes a source from an Agent's selected version while the version
keeps running, and the source cannot be deleted until a redeploy replaces that
version. [Credential source withdrawal](../credential-sources/withdrawal.md)
covers the request, its retries, and maintenance.

## Delete a source

`DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId`
requires exact `delete` and returns `204`:

- It returns `409 RESOURCE_CONFLICT` while an Agent draft, selected version, pending deployment, or queued/running provisioning request references the source. Wait for provisioning, remove the binding and redeploy, or delete the Agent.
- When only a queued/running withdrawal attempt or retry series blocks it, the `409` is `CREDENTIAL_WITHDRAWAL_IN_PROGRESS`. A withdrawal that never confirms keeps its series queued for up to about an hour, even after redeployment; the request no longer applies once the selected version drops the source. Wait for the series to finish, or delete the Agent: completed deletion drops that work.
- OCC marks the record `deleting` before cleanup. Deletion requires the Proxy that owns the Source.
- For a prepared GitHub source, `409 CREDENTIAL_TOKEN_UNSETTLED` means a token
  it issued may still be valid: GitHub's answer to an issue or revocation was lost.
  The record stays `deleting`. Retry after the time in the message, at most 72
  minutes after the attempt. A refused issue with no token does not block deletion.
  While the worker is revoking a token, deletion waits up to 25 seconds for GitHub's answer.
  While a source exists, including one in `deleting`, its Namespace cannot be
  deleted, and its referenced Secrets cannot be deleted.

## Errors

| Status                       | Meaning                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`        | Invalid request, catalog field, configuration or cross-Namespace Secret reference, or an unlisted Harness source.                                                   |
| `403 FORBIDDEN`              | A required permission on the source, Secret or Agent is missing.                                                                                                    |
| `404 NOT_FOUND`              | The exact Namespace lacks the source, Secret or named Agent, or the selected version has no matching withdrawal.                                                    |
| `409 NAMESPACE_NOT_READY`    | Wait for the Namespace to become ready.                                                                                                                             |
| `409 AGENT_DELETING`         | A protected source names an Agent being deleted.                                                                                                                    |
| `409 RESOURCE_CONFLICT`      | The type, Agent, Driver selection or requested operation is incompatible, the source is still referenced, or its state changed. The message describes the conflict. |
| `503 DEPENDENCY_UNAVAILABLE` | A required Driver or issuer is unavailable, an issuer operation failed, or the selected Driver differs from the recorded owner.                                     |

## Related

- [OAuth connection templates](../connection-templates.md)
- [Protected credential request flow](../../flows/credential-source-egress.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [Credential source withdrawal](../credential-sources/withdrawal.md)
- [Secrets](../../guides/topics/secrets.md) and [Permissions](../cheatsheets/permissions.md)
- [HTTP API: credential sources](../api.md#credential-sources)
