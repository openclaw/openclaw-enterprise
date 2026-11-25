# Protected repository metadata

Use [TokenService enrollment](../credential-sources.md#register-a-source) for
model credentials, OAuth and GitHub installation Sources. A qualified selected
Credential Proxy can offer **credential-free repository metadata** for one
approved repository identity read. The sender applies request and response
controls without injecting a credential.

OpenShell is a development integration. See the
[OpenShell qualification requirements](../drivers/openshell-sandbox.md#qualification-contract),
[Credential Proxy overview](../../design/credential-proxy.md) and
[threat model](../security/credential-proxy.md).

## Register a source

1. Wait for the Namespace to become `ready`.
2. Send `POST /namespaces/:namespaceId/credential-sources`. The caller needs
   `credential_source:create` on the Namespace and `agent:operate` on the
   dedicated Agent named by `config.agent_id`.

The selected Proxy must list the type in its catalog. The example requires a
qualified sender and Sandbox that enforce the protected exchange. See
[protected-exchange requirements](../../design/credential-proxy.md#which-checks-does-openshell-provide).

Replace the sample IDs. Execution authority admits every process in that execution.

```json
{
  "name": "widgets-metadata",
  "type": "credential-free-repository-metadata",
  "config": {
    "origin": "https://api.github.com",
    "repository_id": "12345",
    "repository": "acme/widgets",
    "agent_id": "agt_123e4567-e89b-42d3-a456-426614174000",
    "authority": "execution"
  }
}
```

The `201` response includes the Source ID. The origin must return the
repository identity to an unauthenticated request. The built-in authenticated
`GET /repos/{owner}/{repo}` offer backed by a Namespace App signing key has
been retired. If the Installation still has Sources of this type, retire them
through their original owner before removing the `preparedGitHub` block from
`drivers.credential_proxy.configuration`. The updated Proxy cannot revoke
those old issuer tokens.

## Read and list sources

Exact GET requires `credential_source:read`. List requires Namespace `read`
and includes Sources the caller can read.

## Bind a source to an Agent

Set `credentialSources` to a list of up to 64 distinct
`{ "sourceId": "cs_…" }` entries. On update, the list replaces the draft's
bindings. Omit it to keep them or send `[]` to remove them all.

| When                       | Required source permissions                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create or update the Agent | The caller needs the corresponding `agent:create` or `agent:update` and `credential_source:operate` on each current and requested source, including removals.                              |
| Deploy                     | The caller needs `agent:deploy`. Both the caller and the Agent service principal need `credential_source:operate` on each listed source. The worker checks both again before provisioning. |
| Use a protected source     | OCC checks the Agent service principal's current `credential_source:operate` before it selects the operation and again before it authorizes the send.                                      |

[Grant the Agent service principal access to the source](../authorization.md#manage-namespace-policy)
with a Namespace IAM Role and AccessBinding. Each requested Source must be ready with its recorded owner selected.
The Credential Proxy owns these metadata Sources.

Deployment with credential sources requires a selected Sandbox Driver. Staged model or Plugin delivery cannot share an execution with a Proxy-owned metadata Source. For these delivery modes, the revision records each Source's ID, type, and owning Driver ID. For the `widgets-metadata` example, the protected
plan allows `GET /repos/acme/widgets` for that execution and source generation. Follow the
[request to GitHub and its reply](../../flows/credential-source-egress.md#follow-the-metadata-get).
Cloning, pushing or creating a pull request requires a separately admitted
[repository binding](../repository-credentials.md).

## Update a source

Metadata grants are fixed at registration. To
change a grant, register a replacement, update the Agent binding, and deploy.

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

## Errors

| Status                       | Meaning                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`        | Invalid request, catalog field or configuration.                                                                                                                    |
| `403 FORBIDDEN`              | A required permission on the Source or Agent is missing.                                                                                                            |
| `404 NOT_FOUND`              | The exact Namespace lacks the Source or named Agent, or the selected version has no matching withdrawal.                                                            |
| `409 NAMESPACE_NOT_READY`    | Wait for the Namespace to become ready.                                                                                                                             |
| `409 AGENT_DELETING`         | A protected source names an Agent being deleted.                                                                                                                    |
| `409 RESOURCE_CONFLICT`      | The type, Agent, Driver selection or requested operation is incompatible, the source is still referenced, or its state changed. The message describes the conflict. |
| `503 DEPENDENCY_UNAVAILABLE` | A required Driver is unavailable or differs from the recorded owner.                                                                                                |

## Related

- [OAuth connection templates](../connection-templates.md)
- [Protected credential request flow](../../flows/credential-source-egress.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [Credential source withdrawal](../credential-sources/withdrawal.md)
- [Secrets](../../guides/topics/secrets.md) and [Permissions](../cheatsheets/permissions.md)
- [HTTP API: credential sources](../api.md#credential-sources)
