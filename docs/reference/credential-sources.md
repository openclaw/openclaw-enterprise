# Credential sources

A CredentialSource is a Namespace resource created and maintained by the selected TokenService. It describes either a static credential or an OAuth grant. It has one ID and can reference a Connection Template by ID. Selecting a Source does not grant access or expose credential material.

The [credential design](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md) proposes one lifecycle for model and plugin credentials. The design is still in progress. The following section describes its intended behavior; [implementation status](#implementation-status) records which parts are available.

## Intended credential flow

1. **Select a consumer.** An operator chooses a model provider or a plugin connection and selects its credential once at that consumer. A model uses `harnessAuth`; a Plugin uses its named connection. The consumer identifies the endpoint and operations it needs.
2. **Connect a Source.** TokenService owns the Source and credential. A provider preset or Connection Template limits where the credential may be sent. A Source can reference a Connection Template by ID. The Agent receives permission to use the Source, not permission to read the credential.
3. **Admit the policy.** OCC resolves the associated Template's current version and checks the consumer's requested destinations against the Installation's network ceiling and the Source's credential authority. It prepares two separate policies:
   - **Network access policy:** which executable may contact which host and ports, with request restrictions where required. A consumer can request network access without a credential.
   - **Credential injection policy:** which of those requests may use each Source. For a plugin, this is the intersection of the plugin's requested endpoints and the destinations authorized by its Source and Connection Template. A template cannot grant network access by itself.
4. **Save the deployment.** OCC derives the unique Source references from the model and Plugin selections, then records them with the admitted bindings and policies in the Agent revision. The revision contains no credential value.
5. **Prepare delivery.** Compute creates an idle Sandbox. Worker verifies the deploying actor's and Agent's Source permissions and gives Credential Proxy a resolver limited to that Source. For OCC-owned material, Proxy resolves the authorized credential and initializes a delivery copy when needed. For a compatible native TokenService, the intended path attaches the existing Provider without transferring material. Sandbox enforces network access; Credential Proxy enforces credential injection. Their paired implementations may combine configuration privately.
6. **Start the Agent.** Compute waits for the admitted network policy and credential delivery to be ready. Worker checks Source authorization again before activation. Sandbox starts the Harness, and Compute exposes user traffic after runtime readiness. The Harness can use the admitted credential route without receiving the real credential.
7. **Maintain access.** TokenService owns issuance, renewal, forced refresh, status, and removal of credential material. After it commits or renews a credential, it notifies Credential Proxy with the Source reference and credential version, when known, without sending material. If a delivery resource exists, Proxy resolves only the authorized Source, updates the resource, and acknowledges delivery after every serving copy can use the resolved version. Withdrawal and retirement remove delivery access under the Source authority.

The intended guided Create Agent flow uses this same admission: it registers or selects the credential Source, grants the Agent access, derives the required network and injection policies from the selected model, and deploys. It does not require the operator to create an Agent draft through a separate API path. Current guided-creation support is recorded below.

See the [Source ownership](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/credential-source-ownership.md), [deployment policy](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/installation-credential-ownership.md#prepare-an-agent-revision), and [worker delivery](https://github.com/openclaw/openclaw-enterprise/blob/main/specs/rfcs/0023-egress-proxy-credential-lifecycle/worker-credential-configuration.md) proposals for design details.

## Implementation status

This table separates implemented behavior from work remaining in the proposed design.

| Capability                      | Current implementation                                                                                                                                                                                                                           | Remaining work                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source registration and custody | TokenService creates and maintains static and OAuth Sources. OCC reads the authorized Source catalog and owns IAM, policy, and audit.                                                                                                            | Extend selected TokenService lifecycle support to other credential types.                                                                                                          |
| Credential selection            | The direct Agent API requires the model Source in both `harnessAuth` and `credentialSources`. OCC reads Plugin Source IDs from the selections reported by the Plugin Driver.                                                                     | Remove the duplicate model Source input.                                                                                                                                           |
| Model provider coverage         | First deployment of an explicit OpenAI Responses model is implemented for dedicated OpenClaw and Codex with OCC TokenService and the paired OpenShell Sandbox and Proxy.                                                                         | Anthropic, other model providers, completions, custom endpoints, and runtime qualification for each supported path.                                                                |
| Delivery ownership              | The OCC TokenService path initializes an OpenShell Provider with a credential delivery copy.                                                                                                                                                     | Attach a compatible native TokenService Provider directly without copying its material.                                                                                            |
| Driver composition              | OCC admission requires credential delivery and the selected Sandbox in one registration.                                                                                                                                                         | Compose compatible Credential Proxy and Sandbox implementations without requiring shared registration; retire legacy delivery selection.                                           |
| Authentication methods          | Static credentials and browser-consented OAuth grants use the selected TokenService. PAT, ServiceAccount, and embedded-runtime authentication retain their existing delivery paths.                                                              | Move each applicable model authentication path to TokenService and Credential Proxy, with end-to-end proof.                                                                        |
| Network and injection policy    | OCC combines model and Plugin requirements, checks the complete policy with the selected Sandbox and Proxy, and limits credential injection separately for each binding.                                                                         | Qualify allowed and denied requests from a deployed Plugin Agent.                                                                                                                  |
| Native HTTP credential delivery | OpenShell prepares frozen HTTP bindings. Bindings can share a Source with distinct credential environments and disjoint endpoint paths. The native qualifier refuses MCP.                                                                        | Verify delivery through a managed Plugin that accepts a TokenService Source.                                                                                                       |
| Connection Templates            | A Source can reference a Template by ID. Template-based OAuth Sources retain the version and client used for consent. Built-in Codex OAuth has no Template.                                                                                      | Propagate policy changes to active deployments.                                                                                                                                    |
| Plugin connections              | OCC checks the Source’s current Template and the reviewed slot. The managed Google Workspace slot accepts legacy Gateway OAuth Sources, which cannot pass TokenService admission.                                                                | Accept compatible TokenService OAuth Sources at the Google Workspace slot.                                                                                                         |
| Guided creation and Console     | Console can register a static OpenAI Source and save an Agent draft. The Agent API can bind a managed Source and save a network grant. Guided creation with a managed Source returns `409`.                                                      | Admit network policy and grant Source access during guided creation; qualify deployment through that flow.                                                                         |
| Replacement and retry           | Stop removes the current Sandbox and its Proxy attachment. The OpenShell Proxy retires its owned Provider and profile after the last binding is removed.                                                                                         | Replace an active managed-credential deployment and recover without requiring Stop.                                                                                                |
| Credential updates              | Active staged Sources allow replacement. TokenService commits, then notifies Proxy. OpenShell updates existing Providers and checks readiness. A failed PATCH returns `503`; the Agent API can retry delivery.                                   | Qualify rotation in the same running Harness.                                                                                                                                      |
| Withdrawal and retirement       | Staged withdrawal denies Agent use and confirms a `REVOKED` detach receipt or Sandbox absence. The Source and other Agents remain usable. Proxy retires the last Provider and profile; static Source DELETE retires them before custody removal. | Qualify live withdrawal and recover previously retained copies if an Installation restarts without the Proxy selected.                                                             |
| Enforcement qualification       | Compute checks applied network policy and Proxy readiness during preparation.                                                                                                                                                                    | Recheck both immediately before starting the Harness. Qualify executable, credential presentation, destination, method, path, and target identity for each Sandbox and Proxy pair. |

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

The caller needs `credential_source:create` on a ready Namespace. The response contains the Source ID and metadata, never the credential. See [managed static sources](credential-sources/managed-static.md) for the complete API and first-deployment example. To create an OAuth Source, start the separate [browser consent workflow](connection-templates.md#connect-an-account). TokenService creates that Source only after the provider returns a grant.

The Source API accepts TokenService-owned static and OAuth Sources. It no longer admits or returns the former Gateway and Proxy Source formats.

## Read and list sources

Exact GET requires `credential_source:read` and returns all nonsecret metadata for that Source, even when TokenService cannot report refresh status. List requires Namespace `read` and includes only Sources the caller may read. A Source's saved `ready` state does not establish whether a particular deployment can use it.

An associated Source reports `connectionTemplateId`. OAuth consent records its provenance: `connection_template` preserves the original Template version, OAuth client, principal, and scopes; `builtin_codex` has no Template and uses the fixed server-owned Codex issuer/client preset, with trusted account metadata. The Codex device-login cutover to this Source format is a separate dependency. Updating a Template does not rewrite consent or change the Source's Template ID. Source metadata never contains tokens.

## Bind a source to an Agent

For model authentication, specify the same Source in `credentialSources` and `harnessAuth`.

```json
{
  "credentialSources": [{ "sourceId": "cs_..." }],
  "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
}
```

For a Plugin, select the Source once in its credential slot. OCC includes it in admission without a separate `credentialSources` entry. A Plugin Source must reference a Connection Template. A Source used only by the Harness can omit the Template.

OCC resolves the current Template version when it checks a selection and again at deployment. For an HTTP Plugin, a credential-bearing request must match a reviewed Plugin operation and a destination in that Template version. A manual OAuth Template can authorize a new destination for an existing Source. The grant still uses its original issuer and client and the scopes granted by the provider. An issuer change requires new consent. Each Agent revision records the admitted Template ID and version and keeps its executable, permitted requests and credential projection when the Template changes.

The caller needs the corresponding Agent permission and `credential_source:operate` on each affected Source. Deployment requires both the caller and the Agent service principal to have `credential_source:operate` on each Source. With OCC-managed transactional Native IAM, deployment can create a missing exact Agent grant when the caller may operate the Source. Otherwise, grant the Agent access with a [Namespace Role and AccessBinding](authorization.md#manage-namespace-policy). Saving an eligible Plugin selection under Native IAM grants the Agent service principal exact Source `operate` access in the same transaction.

OCC refuses deployment before it saves a revision or queues work if the selected Sandbox and Credential Proxy cannot enforce the complete policy. The managed Google Workspace slot cannot yet accept a TokenService OAuth Source. Its legacy Gateway Source and static Sources cannot complete this workflow. MCP injection also requires enforcement of the transport and RPC method and tool restrictions together.

## Update a source

Send PATCH with `credential_source:update`. [Managed static updates](credential-sources/managed-static.md#update-a-source) replace the write-only credential or change its provider association. TokenService renews OAuth grants with the original consent settings. Current delivery-update limitations are in [implementation status](#implementation-status).

## Retry credential delivery

Send `POST /namespaces/:namespaceId/agents/:agentId/credentials/push` with `{"sources":"all"}` or a `sources` array of 1–64 distinct Source IDs. OCC selects Credential Proxy bindings from the deployed Agent revision and excludes a binding as soon as OCC records its withdrawal. The caller needs `agent:operate` on that exact Agent and `credential_source:update` on every selected Source. The Agent service principal must still have `credential_source:operate` on each Source. OCC rejects the whole request if any selected Source is ineligible or unauthorized, before it notifies Proxy or resolves a credential.

If the Agent service principal has lost Source access, ask an Installation administrator to restore its `credential_source:operate` grant, then retry credential delivery.

The response has one result per selected Source: `succeeded`, `resolution_failed`, or `delivery_failed`. Backend failures appear in these results with HTTP `200`; they do not hide successful results or roll back the credential held by TokenService. Retry does not replace the Source credential. A retry for a shared Source can affect other Agents bound to it. See the [lifecycle flow](../flows/credential-source-lifecycle.md#retry-delivery) for execution.

## Withdraw a source from an Agent

Withdrawal removes an Agent's access without deleting the Source. See [withdrawal](credential-sources/withdrawal.md) and [implementation status](#implementation-status).

## Delete a source

Use `DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId` to retire either type. Static deletion requires `credential_source:delete`, returns `409` while blocking references remain, and retires the selected Proxy's delivery copy before removing custody. A Proxy failure returns `503` and retains the Source for retry. An OAuth owner can disconnect the Source; another caller needs `credential_source:delete`. OCC records the revocation request before TokenService retires the grant, and the worker can complete a pending revocation. See [managed static deletion](credential-sources/managed-static.md#delete-a-source) and [OAuth consent](connection-templates.md#connect-an-account).

## Errors

See the operation-specific [managed static reference](credential-sources/managed-static.md) and [OAuth consent reference](connection-templates.md#connect-an-account).

## Related

- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Connection Templates](connection-templates.md)
- [Credential Proxy](drivers/credential-proxy.md)
