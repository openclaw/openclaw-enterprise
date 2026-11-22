# Credential sources

A Credential Source identifies access to an external system. It can reference a credential or authorize an operation that needs no credential. It records who owns that access and the conditions under which OCE may use it. Selecting a Source does not grant access by itself or expose credential material.

The [credential design](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md) proposes one lifecycle for model and plugin credentials. The design is still in progress. The following section describes its intended behavior; [implementation status](#implementation-status) records which parts are available.

## Intended credential flow

1. **Select a consumer.** An operator chooses a model provider or a plugin connection. The consumer identifies the endpoint and operations it needs.
2. **Connect a Source.** TokenService owns the Source and credential. A provider preset or approved Connection Template limits where the credential may be sent. The Agent receives permission to use the Source, not permission to read the credential.
3. **Admit the policy.** OCC checks the consumer's requested destinations against the Installation's network ceiling and the Source's credential authority. It prepares two separate policies:
   - **Network access policy:** which executable may contact which host and ports, with request restrictions where required. A consumer can request network access without a credential.
   - **Credential injection policy:** which of those requests may use each Source. For a plugin, this is the intersection of the plugin's requested endpoints and the destinations authorized by its Source and Connection Template. A template cannot grant network access by itself.
4. **Save the deployment.** OCC records the Source references, bindings, and admitted policies in the Agent revision. The revision contains no credential value.
5. **Prepare delivery.** Compute creates an idle Sandbox. Worker verifies the deploying actor's and Agent's Source permissions and gives Credential Proxy a resolver limited to that Source. Proxy obtains the credential from TokenService and prepares its delivery. Sandbox enforces network access; Credential Proxy enforces credential injection. Their paired implementations may combine configuration privately.
6. **Start the Agent.** Compute waits for the admitted network policy and credential delivery to be ready. Worker checks Source authorization again before activation. Sandbox starts the Harness, and Compute exposes user traffic after runtime readiness. The Harness can use the approved credential route without receiving the real credential.
7. **Maintain access.** The intended lifecycle includes credential updates, delivery updates, withdrawal, and retirement. These operations must preserve Source authority and remove delivery access when it is retired. Their current availability is listed below.

The intended guided Create Agent flow uses this same admission: it registers or selects the credential Source, grants the Agent access, derives the required network and injection policies from the selected model, and deploys. It does not require the operator to create an Agent draft through a separate API path. Current guided-creation support is recorded below.

See the [Source ownership](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/credential-source-ownership.md), [deployment policy](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md#prepare-an-agent-revision), and [worker delivery](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/worker-credential-configuration.md) proposals for design details.

## Implementation status

This table separates implemented behavior from work remaining in the proposed design. Existing delivery paths are documented under [other delivery modes](credential-sources/other-delivery-modes.md).

| Capability                      | Current implementation                                                                                                                                                   | Remaining work                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Source registration and custody | Managed static Source creation, reading, update, and deletion through TokenService.                                                                                      | Extend selected TokenService lifecycle support to other credential types.                                                    |
| Model provider coverage         | First deployment of an explicit OpenAI Responses model is implemented for dedicated OpenClaw and Codex with OCC TokenService and the paired OpenShell Sandbox and Proxy. | Anthropic, other model providers, completions, custom endpoints, and runtime qualification for each supported path.          |
| Authentication methods          | Existing PAT, ServiceAccount, OAuth, and embedded-runtime authentication have their own delivery paths.                                                                  | Move each applicable model authentication path to TokenService and Credential Proxy, with end-to-end verification.           |
| Network and injection policy    | OCC derives separate network and per-binding injection policies for the supported model route.                                                                           | Apply the same admission to plugin connections, approved Connection Templates, and each selected credential binding.         |
| Guided creation and Console     | The ordinary Agent API can bind a managed Source and save a network grant before deployment.                                                                             | Guided creation returns `409` until it can admit network policy and grant Source access. Qualify the complete Console flow.  |
| Replacement and retry           | Stop removes the current Sandbox and binding before a fresh deployment.                                                                                                  | Replace an active managed-credential deployment and recover without requiring Stop.                                          |
| Credential updates              | A static credential can change while no active managed revision uses the Source.                                                                                         | Active updates currently return `409`; notify serving delivery copies, verify their versions, and support recovery.          |
| Withdrawal and retirement       | Source DELETE removes TokenService custody after blocking references are removed.                                                                                        | Active withdrawal currently returns `409`; retire retained OpenShell Provider copies as well as the Source.                  |
| Enforcement qualification       | Compute checks applied network policy and Proxy readiness before launch.                                                                                                 | Qualify executable, credential presentation, destination, method, path, and target identity for each Sandbox and Proxy pair. |

Current OpenShell limits: executable rules also include descendant processes; placeholder substitution is not restricted to the exact Bearer presentation; and attach, detach, and activation address a Sandbox by name, so they can reach a replacement with the same name. These limits do not redefine the intended policy contract.

## Register a source

For example, register an OpenAI API key as a managed static Source with `POST /namespaces/:namespaceId/credential-sources`:

```json
{
  "name": "Model access",
  "type": "static",
  "config": { "provider_preset": "openai" },
  "secret": { "opaque": "<credential>" }
}
```

The caller needs `credential_source:create` on a ready Namespace. The response contains the Source ID and sanitized metadata, never the credential. See [managed static sources](credential-sources/managed-static.md) for the complete API and first-deployment example. Registration for [other delivery modes](credential-sources/other-delivery-modes.md#register-a-source) uses the selected owner's catalog and may require Secret references.

## Read and list sources

Exact GET requires `credential_source:read`. List requires Namespace `read` and includes only Sources the caller may read. A Source's saved `ready` state does not establish whether a particular deployment can use it. [Other delivery modes](credential-sources/other-delivery-modes.md#read-and-list-sources) may include live Gateway or refresh status.

## Bind a source to an Agent

Set `credentialSources` to the Source IDs the Agent may use. For model authentication, select the same Source in `harnessAuth`:

```json
{
  "credentialSources": [{ "sourceId": "cs_..." }],
  "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
}
```

The caller needs the corresponding Agent permission and `credential_source:operate` on each affected Source. Deployment requires both the caller and the Agent service principal to have `credential_source:operate` on each Source. Grant the Agent access with a [Namespace Role and AccessBinding](authorization.md#manage-namespace-policy). A Source ID grants no authority by itself.

OCC saves each Source's ID, type, and owner identity in the Agent revision. A managed Source identifies its TokenService instance; a Gateway or Proxy Source identifies its Driver. See [other delivery modes](credential-sources/other-delivery-modes.md#bind-a-source-to-an-agent) for their binding and provisioning rules.

## Update a source

Send PATCH with `credential_source:update`. [Managed static updates](credential-sources/managed-static.md#update-a-source) replace the write-only credential or change its provider association. [Other source types](credential-sources/other-delivery-modes.md#update-a-source) have their own update and recovery rules. Current delivery-update limitations are in [implementation status](#implementation-status).

## Rotate a refresh source

See [refresh source rotation](credential-sources/other-delivery-modes.md#rotate-a-refresh-source) for the existing Gateway refresh path.

## Withdraw a source from an Agent

Withdrawal removes an Agent's access without deleting the Source. See [withdrawal](credential-sources/withdrawal.md) and [implementation status](#implementation-status).

## Delete a source

DELETE requires `credential_source:delete` and returns `409` while blocking references remain. See [managed static deletion](credential-sources/managed-static.md#delete-a-source) or [other deletion behavior](credential-sources/other-delivery-modes.md#delete-a-source). Current delivery-copy retirement work is listed in [implementation status](#implementation-status).

## After a Credential Gateway change

See [Gateway ownership after selection changes](credential-sources/other-delivery-modes.md#after-a-credential-gateway-change).

## Errors

See [source errors](credential-sources/other-delivery-modes.md#errors) and the operation-specific [managed static reference](credential-sources/managed-static.md).

## Related

- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Connection Templates](connection-templates.md)
- [Credential Proxy](drivers/credential-proxy.md)
