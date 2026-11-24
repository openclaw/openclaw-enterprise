# Credential sources

A Credential Source identifies access to an external system. It can reference a credential or authorize an operation that needs no credential. It records who owns that access and the conditions under which OCE may use it. Selecting a Source does not grant access by itself or expose credential material.

## Intended credential flow

In the proposed 1.0 flow, operators select a Source at its consumer, such as model authentication or a named Plugin connection.
OCC checks Source access and saves admitted bindings with separate network access and credential injection policies.
Compute prepares delivery with the Credential Proxy and Sandbox, then starts the Harness after the Worker authorizes activation.
The Harness receives a placeholder. TokenService maintains the credential and notifies the Proxy when the usable value changes.

The same flow applies to guided Agent creation. See [Credential Design 1.0](../../specs/rfcs/20261124-credential-design-1-0/index.md) for enrollment, policy, and delivery. The status below records the paths available today.

## Implementation status

The table describes **main before the 1.0 cutover**. The submitted
[cutover candidate](https://github.com/openclaw/openclaw-enterprise/pull/7224)
retires Credential Gateway and Credential Refresh selection: Installation or
Backend settings for either Driver are rejected. The database cutover refuses
active Gateway delivery, related unsettled work, or an unexpired pending device login. Once
its checks pass, it drops all old Gateway Source records and
their draft bindings. It does not transfer credentials to TokenService or clean
up external Workspace Providers or profiles. Operators must enroll replacement
Sources through TokenService and use the selected Credential Proxy and Sandbox
for delivery. Plugin OAuth serving remains deferred to
[#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673).

Other delivery modes and their cutover limits are documented under
[other delivery modes](credential-sources/other-delivery-modes.md).

| Capability                      | Current implementation                                                                                                                                                                                                         | Remaining work                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source registration and custody | TokenService creates, updates, and deletes managed static Sources. OCC reads and lists the authorized Source catalog.                                                                                                          | Extend selected TokenService lifecycle support to other credential types.                                                                                                          |
| Credential selection            | The direct Agent API requires the model Source in both `harnessAuth` and `credentialSources`; Plugin selection is checked against that list.                                                                                   | Declare each credential once at its consumer and derive the revision Source set during admission.                                                                                  |
| Model provider coverage         | First deployment of an explicit OpenAI Responses model is implemented for dedicated OpenClaw and Codex with OCC TokenService and the paired OpenShell Sandbox and Proxy.                                                       | Anthropic, other model providers, completions, custom endpoints, and runtime qualification for each supported path.                                                                |
| Delivery ownership              | OCC custody uses an OpenShell Provider as a delivery copy. The [OpenShell development preview on main][native-preview] directly attaches the authoritative Provider for static OpenAI Sources.                                 | Require exact Provider mutations and qualify the preview’s full lifecycle.                                                                                                         |
| Driver composition              | OCC admission requires credential delivery and the selected Sandbox in one registration.                                                                                                                                       | Compose compatible Credential Proxy and Sandbox implementations without requiring shared registration; retire legacy delivery selection.                                           |
| Authentication methods          | PAT, ServiceAccount, OAuth refresh, and embedded-runtime authentication retain their existing delivery paths.                                                                                                                  | Move each applicable model authentication path to TokenService and Credential Proxy, with end-to-end verification.                                                                 |
| Codex OAuth                     | OCC owns temporary device-login sessions; provider exchange and grant handling still use Credential Refresh Driver and Credential Gateway.                                                                                     | Move grant custody and renewal to the selected TokenService Driver and model delivery to Proxy. Qualify account presentation, renewal, and recovery.                               |
| Network and injection policy    | OCC derives separate network and per-binding injection policies for the supported model route.                                                                                                                                 | Apply the same admission to each selected Plugin connection binding.                                                                                                               |
| Native credential delivery      | OpenShell prepares frozen HTTP and managed MCP bindings. Bindings can share a Source with separate credential environments.                                                                                                    | Integrate pinned Template authority and Plugin admission. Verify allowed and denied requests from a deployed Agent.                                                                |
| Connection Templates            | Static Bearer and OAuth templates can be managed in Console or through the API. Static templates store allowed HTTP destinations but have no Source association or credential delivery.                                        | Associate the Template ID with the Source and record the current compatible version in each admitted Agent revision.                                                               |
| Plugin connections              | OCC's existing TokenService registrar and issuer manage saved OAuth grants; the selected TokenService Driver does not yet own them. The connections list uses the latest manual template; Agent attachment is not implemented. | Keep the original consent and use the current compatible Template at Agent admission. Integrate connection delivery with the common policy and Proxy flow.                         |
| Guided creation and Console     | The ordinary Agent API can bind a managed Source and save a network grant before deployment. Guided creation with a managed Source returns `409`.                                                                              | Admit network policy and grant Source access during guided creation; qualify the complete Console flow.                                                                            |
| Replacement and retry           | Stop removes the current Sandbox and its Proxy attachment. The OpenShell Proxy retires its delivery copy for OCC custody after the last binding; native custody retains the authoritative Provider.                            | Replace an active managed-credential deployment and recover without requiring Stop.                                                                                                |
| Credential updates              | Active Sources allow replacement. OCC custody updates Proxy delivery copies and checks readiness; native custody updates the authoritative Workspace Provider. The Agent API can retry delivery.                               | Qualify rotation in the same running Harness.                                                                                                                                      |
| Withdrawal and retirement       | Withdrawal denies Agent use and confirms detachment or Sandbox absence. The Source and other Agents remain usable. Proxy retires an unused delivery copy; native custody retains its Provider until Source DELETE.             | Qualify live withdrawal and recover previously retained copies if an Installation restarts without the Proxy selected.                                                             |
| Enforcement qualification       | Compute checks applied network policy and Proxy readiness during preparation.                                                                                                                                                  | Recheck both immediately before starting the Harness. Qualify executable, credential presentation, destination, method, path, and target identity for each Sandbox and Proxy pair. |

[native-preview]: https://github.com/openclaw/openclaw-enterprise/blob/bd48810f139c4237ca9a9110a0166606670e9215/docs/reference/credential-sources/managed-static.md#preview-openshell-custody

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

Send PATCH with `credential_source:update`. For OCC custody, [managed static updates](credential-sources/managed-static.md#update-a-source) replace the write-only credential or change its provider association. Native OpenShell custody uses the [development preview][native-preview]. [Other source types](credential-sources/other-delivery-modes.md#update-a-source) have their own update and recovery rules. Current delivery-update limitations are in [implementation status](#implementation-status).

## Retry credential delivery

Send `POST /namespaces/:namespaceId/agents/:agentId/credentials/push` with `{"sources":"all"}` or a `sources` array of 1–64 distinct Source IDs. OCC selects Credential Proxy bindings from the deployed Agent revision and excludes a binding as soon as OCC records its withdrawal. The caller needs `agent:operate` on that exact Agent and `credential_source:update` on every selected Source. The Agent service principal must still have `credential_source:operate` on each Source. OCC rejects the whole request if any selected Source is ineligible or unauthorized, before it notifies Proxy or resolves a credential.

If the Agent service principal has lost Source access, ask an Installation administrator to restore its `credential_source:operate` grant, then retry credential delivery.

The response has one result per selected Source: `succeeded`, `resolution_failed`, or `delivery_failed`. Backend failures appear in these results with HTTP `200`; they do not hide successful results or roll back the credential held by TokenService. Retry does not replace the Source credential. In the native OpenShell preview, `succeeded` confirms Provider metadata; it does not prove that a running Harness used the replacement. A retry for a shared Source can affect other Agents bound to it. See the [OCC custody lifecycle flow](../flows/credential-source-lifecycle.md#retry-delivery) for execution.

## Rotate a refresh source

See [refresh source rotation](credential-sources/other-delivery-modes.md#rotate-a-refresh-source) for the existing Gateway refresh path.

## Withdraw a source from an Agent

Withdrawal removes an Agent's access without deleting the Source. See [withdrawal](credential-sources/withdrawal.md) and [implementation status](#implementation-status).

## Delete a source

DELETE requires `credential_source:delete` and returns `409` while blocking references remain. See [OCC custody deletion](credential-sources/managed-static.md#delete-a-source) or [other deletion behavior](credential-sources/other-delivery-modes.md#delete-a-source). With OCC custody, the OpenShell Proxy retires its delivery copy before TokenService removes the credential; a failure returns `503` and retains the Source for retry. With native OpenShell custody, TokenService removes the Source-owned Provider and profile. See [implementation status](#implementation-status) for remaining limits. To disconnect a saved OAuth account, use `DELETE /namespaces/:namespaceId/connections/:credentialSourceId`; Source DELETE is not account disconnect. See [Connection Templates](connection-templates.md).

## After a Credential Gateway change

See [Gateway ownership after selection changes](credential-sources/other-delivery-modes.md#after-a-credential-gateway-change).

## Errors

See [source errors](credential-sources/other-delivery-modes.md#errors) and the operation-specific [managed static reference](credential-sources/managed-static.md).

## Related

- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Connection Templates](connection-templates.md)
- [Credential Proxy](drivers/credential-proxy.md)
