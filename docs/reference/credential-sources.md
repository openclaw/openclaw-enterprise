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

| Capability                      | Current implementation                                                                                                                                                                                                               | Remaining work                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source registration and custody | TokenService creates and maintains static and OAuth Sources. OCC reads the authorized Source catalog and owns IAM, policy, and audit.                                                                                                | Extend selected TokenService lifecycle support to other credential types.                                                                                                          |
| Credential selection            | The direct Agent API requires the model Source in both `harnessAuth` and `credentialSources`; Plugin selection is checked against that list.                                                                                         | Declare each credential once at its consumer and derive the revision Source set during admission.                                                                                  |
| Model provider coverage         | First deployment of an explicit OpenAI Responses model is implemented for dedicated OpenClaw and Codex with OCC TokenService and the paired OpenShell Sandbox and Proxy.                                                             | Anthropic, other model providers, completions, custom endpoints, and runtime qualification for each supported path.                                                                |
| Delivery ownership              | The OCC TokenService path initializes an OpenShell Provider with a credential delivery copy.                                                                                                                                         | Attach a compatible native TokenService Provider directly without copying its material.                                                                                            |
| Driver composition              | OCC admission requires credential delivery and the selected Sandbox in one registration.                                                                                                                                             | Compose compatible Credential Proxy and Sandbox implementations without requiring shared registration; retire legacy delivery selection.                                           |
| Authentication methods          | Static credentials and browser-consented OAuth grants use the selected TokenService. PAT, ServiceAccount, and embedded-runtime authentication retain their existing delivery paths.                                                  | Move each applicable model authentication path to TokenService and Credential Proxy, with end-to-end proof.                                                                        |
| Network and injection policy    | OCC derives separate network and per-binding injection policies for the supported model route.                                                                                                                                       | Apply the same admission to each selected Plugin connection binding.                                                                                                               |
| Connection Templates            | Static and OAuth Sources reference a Template by ID. The OAuth subtype retains the original consent version and client.                                                                                                              | Resolve the current approved Template version during Plugin admission, then snapshot it in the Agent revision; propagation to active policies remains pending.                     |
| Plugin connections              | The selected TokenService creates OAuth Sources and renews their private grants; Source GET/list expose nonsecret consent metadata.                                                                                                  | Admit selected Plugin Source IDs against the current approved Template and original OAuth grant, then integrate delivery with the common policy path.                              |
| Guided creation and Console     | The ordinary Agent API can bind a managed Source and save a network grant before deployment. Guided creation with a managed Source returns `409`.                                                                                    | Admit network policy and grant Source access during guided creation; qualify the complete Console flow.                                                                            |
| Replacement and retry           | Stop removes the current Sandbox and its Proxy attachment. The OpenShell Proxy retires its owned Provider and profile after the last binding is removed.                                                                             | Replace an active managed-credential deployment and recover without requiring Stop.                                                                                                |
| Credential updates              | Active staged Sources allow replacement. TokenService commits, then notifies Proxy. OpenShell updates existing Providers and checks readiness. A failed push returns sanitized `503`; the new credential remains stored.             | Add explicit retry and recovery; qualify rotation in the same running Harness.                                                                                                     |
| Withdrawal and retirement       | Staged managed Source withdrawal returns `409`. Static Source DELETE retires the selected OpenShell Proxy’s owned Provider and profile before TokenService removes custody. Proxy failure keeps the Source and credential for retry. | Support staged withdrawal and recover previously retained copies if an Installation restarts without the Proxy selected.                                                           |
| Enforcement qualification       | Compute checks applied network policy and Proxy readiness during preparation.                                                                                                                                                        | Recheck both immediately before starting the Harness. Qualify executable, credential presentation, destination, method, path, and target identity for each Sandbox and Proxy pair. |

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

The caller needs `credential_source:create` on a ready Namespace. The response contains the Source ID and metadata, never the credential. See [managed static sources](credential-sources/managed-static.md) for the complete API and first-deployment example. To create an OAuth Source, start the separate [browser consent workflow](connection-templates.md#connect-an-account). TokenService creates that Source only after the provider returns a grant.

The Source API accepts TokenService-owned static and OAuth Sources. It no longer admits or returns the former Gateway and Proxy Source formats.

## Read and list sources

Exact GET requires `credential_source:read` and returns all nonsecret metadata for that Source, even when TokenService cannot report refresh status. List requires Namespace `read` and includes only Sources the caller may read. A Source's saved `ready` state does not establish whether a particular deployment can use it.

Both Source types report their associated `connectionTemplateId`. OAuth-specific metadata records the original consent version, selected client, consenting principal, requested scopes, and granted scopes. Updating a Template does not rewrite the consent record or change the Source's Template ID. An Agent revision uses the current approved Template version when it is admitted; Plugin admission remains pending in this implementation. TokenService never returns access tokens or refresh grants through Source metadata.

## Bind a source to an Agent

The current direct Agent API requires `credentialSources` to list the selected Source IDs. For model authentication, it also requires the same Source in `harnessAuth`. See [implementation status](#implementation-status) for removing this duplicate input:

```json
{
  "credentialSources": [{ "sourceId": "cs_..." }],
  "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
}
```

The caller needs the corresponding Agent permission and `credential_source:operate` on each affected Source. Deployment requires both the caller and the Agent service principal to have `credential_source:operate` on each Source. With OCC-managed transactional Native IAM, deployment can create a missing exact Agent grant when the caller may operate the Source. Otherwise, grant the Agent access with a [Namespace Role and AccessBinding](authorization.md#manage-namespace-policy). A Source ID grants no authority by itself.

OCC saves each Source's ID, type, and TokenService instance in the Agent revision.

## Update a source

Send PATCH with `credential_source:update`. [Managed static updates](credential-sources/managed-static.md#update-a-source) replace the write-only credential or change its provider association. TokenService renews OAuth grants with the original consent settings. Current delivery-update limitations are in [implementation status](#implementation-status).

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
