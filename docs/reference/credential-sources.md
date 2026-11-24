# Credential sources

A Credential Source identifies access to an external system. It can reference a credential or authorize an operation that needs no credential. It records who owns that access and the conditions under which OCE may use it. Selecting a Source does not grant access by itself or expose credential material.

The [credential design](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md) proposes one lifecycle for model and plugin credentials. The design is still in progress. The following section describes its intended behavior; [implementation status](#implementation-status) records which parts are available.

## Intended credential flow

1. **Select a consumer.** An operator chooses a model provider or a plugin connection and selects its credential once at that consumer. A model uses `harnessAuth`; a Plugin uses its named connection. The consumer identifies the endpoint and operations it needs.
2. **Connect a Source.** TokenService owns the Source and credential. A provider preset or Connection Template limits where the credential may be sent. The proposed Plugin Source association pins the immutable `(templateId, version)` pair. The Agent receives permission to use the Source, not permission to read the credential.
3. **Admit the policy.** OCC checks the consumer's requested destinations against the Installation's network ceiling and the Source's credential authority. It prepares two separate policies:
   - **Network access policy:** which executable may contact which host and ports, with request restrictions where required. A consumer can request network access without a credential.
   - **Credential injection policy:** which of those requests may use each Source. For a plugin, this is the intersection of the plugin's requested endpoints and the destinations authorized by its Source and Connection Template. A template cannot grant network access by itself.
4. **Save the deployment.** OCC derives the unique Source references from the model and Plugin selections, then records them with the admitted bindings and policies in the Agent revision. The revision contains no credential value.
5. **Prepare delivery.** Compute creates an idle Sandbox. Worker verifies the deploying actor's and Agent's Source permissions and gives Credential Proxy a resolver limited to that Source. For OCC-owned material, Proxy resolves the authorized credential and initializes a delivery copy when needed. For a compatible native TokenService, the intended path attaches the existing Provider without transferring material. Sandbox enforces network access; Credential Proxy enforces credential injection. Their paired implementations may combine configuration privately.
6. **Start the Agent.** Compute waits for the admitted network policy and credential delivery to be ready. Worker checks Source authorization again before activation. Sandbox starts the Harness, and Compute exposes user traffic after runtime readiness. The Harness can use the admitted credential route without receiving the real credential.
7. **Maintain access.** TokenService owns issuance, renewal, forced refresh, status, and removal of credential material. After it commits or renews a credential, it notifies Credential Proxy with the Source reference and credential version, when known, without sending material. If a delivery resource exists, Proxy resolves only the authorized Source, updates the resource, and acknowledges delivery after every serving copy can use the resolved version. Withdrawal and retirement remove delivery access under the Source authority.

The target removes the `CredentialGatewayDriver` and `CredentialRefreshDriver` contracts and their `drivers.credential_gateway` and `drivers.credential_refresh` selections after their consumers move to TokenService and Credential Proxy.

The intended guided Create Agent flow uses this same admission: it registers or selects the credential Source, grants the Agent access, derives the required network and injection policies from the selected model, and deploys. It does not require the operator to create an Agent draft through a separate API path. Current guided-creation support is recorded below.

See the [Source ownership](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/credential-source-ownership.md), [deployment policy](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md#prepare-an-agent-revision), and [worker delivery](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/worker-credential-configuration.md) proposals for design details.

## Implementation status

This table separates implemented behavior from work remaining in the proposed design. Existing delivery paths are documented under [other delivery modes](credential-sources/other-delivery-modes.md).

| Capability                      | Current implementation                                                                                                                                                                                                                    | Remaining work                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source registration and custody | TokenService creates, updates, and deletes managed static Sources. OCC reads and lists the authorized Source catalog.                                                                                                                     | Extend selected TokenService lifecycle support to other credential types.                                                                                                          |
| Credential selection            | The direct Agent API requires the model Source in both `harnessAuth` and `credentialSources`; Plugin selection is checked against that list.                                                                                              | Declare each credential once at its consumer and derive the revision Source set during admission.                                                                                  |
| Model provider coverage         | First deployment of an explicit OpenAI Responses model is implemented for dedicated OpenClaw and Codex with OCC TokenService and the paired OpenShell Sandbox and Proxy.                                                                  | Anthropic, other model providers, completions, custom endpoints, and runtime qualification for each supported path.                                                                |
| Delivery ownership              | The OCC TokenService path initializes an OpenShell Provider with a credential delivery copy.                                                                                                                                              | Attach a compatible native TokenService Provider directly without copying its material.                                                                                            |
| Driver composition              | OCC admission requires credential delivery and the selected Sandbox in one registration.                                                                                                                                                  | Compose compatible Credential Proxy and Sandbox implementations without requiring shared registration; retire legacy delivery selection.                                           |
| Authentication methods          | PAT, ServiceAccount, OAuth refresh, and embedded-runtime authentication retain their existing delivery paths.                                                                                                                             | Move each applicable model authentication path to TokenService and Credential Proxy, with end-to-end verification.                                                                 |
| Codex OAuth                     | OCC owns temporary device-login sessions; provider exchange and grant handling still use Credential Refresh Driver and Credential Gateway.                                                                                                | Move grant custody and renewal to the selected TokenService Driver and model delivery to Proxy. Qualify account presentation, renewal, and recovery.                               |
| Network and injection policy    | OCC derives separate network and per-binding injection policies for the supported model route.                                                                                                                                            | Apply the same admission to each selected Plugin connection binding.                                                                                                               |
| Native HTTP credential delivery | OpenShell prepares frozen HTTP bindings. Bindings can share a Source with separate credential environments. MCP is refused.                                                                                                               | Integrate pinned Template authority and Plugin admission. Verify allowed and denied requests from a deployed Agent.                                                                |
| Connection Templates            | Static Bearer and OAuth templates can be managed in Console or through the API. Static templates store allowed HTTP destinations but have no Source association or credential delivery.                                                   | Associate an immutable `(templateId, version)` with a Source and integrate each consumer with admission and delivery.                                                              |
| Plugin connections              | OCC's existing TokenService registrar and issuer manage saved OAuth grants; the selected TokenService Driver does not yet own them. The connections list uses the latest manual template; Agent attachment is not implemented.            | Pin Plugin Source authority to an immutable `(templateId, version)` and integrate connection delivery with the common policy and Proxy flow.                                       |
| Guided creation and Console     | The ordinary Agent API can bind a managed Source and save a network grant before deployment. Guided creation with a managed Source returns `409`.                                                                                         | Admit network policy and grant Source access during guided creation; qualify the complete Console flow.                                                                            |
| Replacement and retry           | Stop removes the current Sandbox and its Proxy attachment. The OpenShell Proxy retires its owned Provider and profile after the last binding is removed.                                                                                  | Replace an active managed-credential deployment and recover without requiring Stop.                                                                                                |
| Credential updates              | Active staged Sources allow replacement. TokenService commits, then notifies Proxy. OpenShell updates existing Providers and checks readiness. A failed PATCH returns `503`; the Agent API can retry delivery.                            | Qualify rotation in the same running Harness.                                                                                                                                      |
| Withdrawal and retirement       | Staged withdrawal denies Agent use and confirms a `REVOKED` detach receipt or Sandbox absence. The Source and other Agents remain usable. Proxy retires the last Provider and profile; Source DELETE retires them before custody removal. | Qualify live withdrawal and recover previously retained copies if an Installation restarts without the Proxy selected.                                                             |
| Enforcement qualification       | Compute checks applied network policy and Proxy readiness during preparation.                                                                                                                                                             | Recheck both immediately before starting the Harness. Qualify executable, credential presentation, destination, method, path, and target identity for each Sandbox and Proxy pair. |

Each binding needs a distinct credential environment. Bindings at the same host and port need disjoint endpoint paths. OpenShell refuses overlapping Plugin grants and routes that would narrow the installed Sandbox defaults outside the model destination. The model's saved broad grant must be unique at its host and port. Additional Plugin or credential-free routes cannot share that grant's executable, host, and port. Compute refuses staged launch with Secret-based model authentication.

OpenShell cannot restrict placeholder injection to HTTPS, so a matching plaintext HTTP request can receive the credential. Executable rules include descendant processes, substitution is not restricted to exact Bearer presentation, and attach, detach, and activation address a Sandbox by name. These limits do not redefine the intended policy contract.

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

The current direct Agent API requires `credentialSources` to list the selected Source IDs. For model authentication, it also requires the same Source in `harnessAuth`. See [implementation status](#implementation-status) for removing this duplicate input:

```json
{
  "credentialSources": [{ "sourceId": "cs_..." }],
  "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
}
```

The caller needs the corresponding Agent permission and `credential_source:operate` on each affected Source. Deployment requires both the caller and the Agent service principal to have `credential_source:operate` on each Source. With OCC-managed transactional Native IAM, deployment can create a missing exact Agent grant when the caller may operate the Source. Otherwise, grant the Agent access with a [Namespace Role and AccessBinding](authorization.md#manage-namespace-policy). A Source ID grants no authority by itself.

OCC saves each Source's ID, type, and owner identity in the Agent revision. A managed Source identifies its TokenService instance; a Gateway or Proxy Source identifies its Driver. See [other delivery modes](credential-sources/other-delivery-modes.md#bind-a-source-to-an-agent) for their binding and provisioning rules.

## Update a source

Send PATCH with `credential_source:update`. [Managed static updates](credential-sources/managed-static.md#update-a-source) replace the write-only credential or change its provider association. [Other source types](credential-sources/other-delivery-modes.md#update-a-source) have their own update and recovery rules. Current delivery-update limitations are in [implementation status](#implementation-status).

## Retry credential delivery

Send `POST /namespaces/:namespaceId/agents/:agentId/credentials/push` with `{"sources":"all"}` or a `sources` array of 1–64 distinct Source IDs. OCC selects Credential Proxy bindings from the deployed Agent revision and excludes a binding as soon as OCC records its withdrawal. The caller needs `agent:operate` on that exact Agent and `credential_source:update` on every selected Source. The Agent service principal must still have `credential_source:operate` on each Source. OCC rejects the whole request if any selected Source is ineligible or unauthorized, before it notifies Proxy or resolves a credential.

If the Agent service principal has lost Source access, ask an Installation administrator to restore its `credential_source:operate` grant, then retry credential delivery.

The response has one result per selected Source: `succeeded`, `resolution_failed`, or `delivery_failed`. Backend failures appear in these results with HTTP `200`; they do not hide successful results or roll back the credential held by TokenService. Retry does not replace the Source credential. A retry for a shared Source can affect other Agents bound to it. See the [lifecycle flow](../flows/credential-source-lifecycle.md#retry-delivery) for execution.

## Rotate a refresh source

See [refresh source rotation](credential-sources/other-delivery-modes.md#rotate-a-refresh-source) for the existing Gateway refresh path.

## Withdraw a source from an Agent

Withdrawal removes an Agent's access without deleting the Source. See [withdrawal](credential-sources/withdrawal.md) and [implementation status](#implementation-status).

## Delete a source

DELETE requires `credential_source:delete` and returns `409` while blocking references remain. See [managed static deletion](credential-sources/managed-static.md#delete-a-source) or [other deletion behavior](credential-sources/other-delivery-modes.md#delete-a-source). Managed static deletion retires the selected OpenShell Proxy’s delivery copy first; a failure returns `503` and retains the Source for retry. See [implementation status](#implementation-status) for remaining limits. To disconnect a saved OAuth account, use `DELETE /namespaces/:namespaceId/connections/:credentialSourceId`; Source DELETE is not account disconnect. See [Connection Templates](connection-templates.md).

## After a Credential Gateway change

See [Gateway ownership after selection changes](credential-sources/other-delivery-modes.md#after-a-credential-gateway-change).

## Errors

See [source errors](credential-sources/other-delivery-modes.md#errors) and the operation-specific [managed static reference](credential-sources/managed-static.md).

## Related

- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Connection Templates](connection-templates.md)
- [Credential Proxy](drivers/credential-proxy.md)
