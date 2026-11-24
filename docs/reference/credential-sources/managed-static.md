# Managed static credential sources

TokenService owns a managed static Source and its credential. OCC controls who may create, bind, update, or delete it. This example uses an OpenAI model; see [implementation status](../credential-sources.md#implementation-status) for provider coverage and work still in progress.

## Register a source

In a ready Namespace, send `POST /namespaces/:namespaceId/credential-sources` with `credential_source:create`:

```json
{
  "name": "Model access",
  "type": "static",
  "config": { "provider_preset": "openai" },
  "secret": { "opaque": "<credential>" }
}
```

`secret` is write-only and accepts one nonempty credential. Its field name does not grant destination authority. The optional `config.provider_preset` associates the Source with an approved provider; without it the Source cannot authorize a model destination. The response contains sanitized metadata, `ownerCapability: "token_service"`, and `secrets: {}`. OCC does not store a Namespace Secret reference or return the credential.

If the private-store write cannot be confirmed, registration can fail while leaving orphaned material. A failure after TokenService commits can leave a Source without its creator IAM grant. See the [OCC custody flow](../../flows/token-service-static-custody.md) for failure handling.

### Register a GitHub repository token

The `github` preset holds one GitHub fine-grained personal access token. `config.repositories` is required with this preset and is not allowed with other presets. It is the Source's repository ceiling: comma-separated `owner/name:read` or `owner/name:write` entries, each optionally ending in `:api` for [issue and pull request access](../repository-credentials/repository-token-source.md#issues-and-pull-requests), each repository once, in canonical lowercase form. It holds at most 32 entries, and the whole value at most 2,048 characters, as for every config value. An error names the refused entry by number. The response returns the ceiling in repository order. Create and update audit records carry the ceiling, and a ceiling change also records the previous one.

```json
{
  "name": "Repository token",
  "type": "static",
  "config": { "provider_preset": "github", "repositories": "octo/app:write,octo/docs:read" },
  "secret": { "token": "<fine-grained token>" }
}
```

OCC refuses every other token class with `400` before custody. TokenService also refuses, with `400` before custody, a value the native Git Provider cannot install: one longer than 16,384 bytes or one containing `openshell:resolve:`. Neither message includes the value. OCC makes no GitHub request. A `github` Source is not a model credential: an Agent cannot list it or use it for Harness authentication. A repository registration names it to deliver native Git; see [Repository token Source](../repository-credentials/repository-token-source.md). The OpenShell custody preview below refuses the `github` preset at registration, before it writes a Provider.

### Preview OpenShell custody

A development Installation can select `drivers.token_service: { id: openshell, configuration: {} }` and add `token_service: openshell` to the selected OpenShell Backend's `drivers`. Use the bundled Kubernetes Compute and OpenShell Sandbox and Credential Proxy. Configure one fixed HTTPS Gateway endpoint with authenticated management access. Direct Provider attachment uses that management connection. Configure separate operator mTLS only for authorized control-plane callers that need to read the credential.

Use a Gateway that keeps its Provider records and credentials in its own database. OCC uses the Gateway database's built-in `default` Workspace ID to recognize the store and refuses advertised external credential drivers. The management identity must be able to read Gateway info and the default Workspace. PostgreSQL stores each Source's private Workspace and Provider IDs. The selected TokenService stores the credential in the Source's OpenShell Provider, which the Proxy attaches directly.

The preview accepts static Sources with the `openai` preset and the single model binding. Provider RPCs still select by name. If an administrator deletes and recreates a Workspace, Provider, or Profile between verification and mutation, the Gateway can act on the replacement. Keep this preview in disposable development state. [OpenShell #5931](https://github.com/ai-openshell/openshell/issues/5931)

## Deploy an Agent with the source

Use a development Installation with the same TokenService that enrolled the Source. For OpenShell custody, keep the [preview selections](#preview-openshell-custody) above. For OCC custody, use OCC TokenService and an OpenShell Sandbox registration that exposes `credential_proxy_delivery`. Omit the legacy `drivers.credential_proxy` selection, which causes the policy PUT below to return `409`. This path admits exactly one Source and no repository credentials. See [supported Driver selections](../drivers/selection.md#supported-selections).

This example covers dedicated OpenClaw. Codex requires a separate Configuration; see [implementation status](../credential-sources.md#implementation-status) for coverage.

1. Send `POST /namespaces/:namespaceId/configurations` to create a same-Namespace [Agent Configuration](../configuration.md#create-read-update-and-delete). Use a model your account can access and replace the illustrative limits and costs with its actual catalog metadata:

   ```json
   {
     "kind": "agent",
     "values": {
       "agents": {
         "defaults": {
           "model": { "primary": "openai/example-model" },
           "models": {
             "openai/example-model": { "agentRuntime": { "id": "openclaw" } }
           }
         }
       },
       "models": {
         "providers": {
           "openai": {
             "api": "openai-responses",
             "baseUrl": "https://api.openai.com/v1",
             "models": [
               {
                 "id": "example-model",
                 "contextWindow": 128000,
                 "maxTokens": 8192,
                 "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
               }
             ]
           }
         }
       }
     }
   }
   ```

   The response returns the Configuration ID for the next step.

2. [Create the Agent](../agents.md#supported-operations) with `POST /namespaces/:namespaceId/agents`, using that Configuration and dedicated execution. The current API requires the Source in both fields; [the intended flow](../credential-sources.md#intended-credential-flow) selects it once:

   ```json
   {
     "name": "example-agent",
     "configurationId": "cfg_...",
     "executionMode": "dedicated",
     "credentialSources": [{ "sourceId": "cs_..." }],
     "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
   }
   ```

3. The deploying caller needs `agent:deploy` and `credential_source:operate` on the Source. With OCC-managed transactional Native IAM, deployment creates a missing exact Agent service-principal grant when the caller can operate the Source. Otherwise, grant the Agent service principal `credential_source:operate` before deployment.
4. Save the Agent's Sandbox networking policy. Enabling editing requires Installation and Agent `administer`; reading requires Agent and SandboxPolicy `read`; saving requires Agent `manage_policy` and SandboxPolicy `update`. See [policy authority](../sandbox-policies.md#authority-and-admission). Send `PATCH /namespaces/:namespaceId/agents/:agentId/sandbox-policy/networking/editing` with `{ "enabled": true }`. Send `GET /namespaces/:namespaceId/agents/:agentId/sandbox-policy/networking` and use `data.policy.version` as `expectedVersion` in `PUT /namespaces/:namespaceId/agents/:agentId/sandbox-policy/networking`. For example, if the current version is `1`:

   ```json
   {
     "expectedVersion": 1,
     "additions": [
       {
         "id": "model-egress",
         "binary": "<actual runtime executable>",
         "host": "api.openai.com",
         "ports": [{ "from": 443, "to": 443 }]
       }
     ]
   }
   ```

   Replace the executable placeholder with the actual runtime executable allowed by the Installation network ceiling. OCC requires one matching grant and derives the `POST /v1/responses` injection rule from the model provider and Source authority.

5. Send `POST /namespaces/:namespaceId/agents/:agentId/deploy`. OCC checks the Source and policy before queuing deployment. Compute waits for applied network policy and credential delivery, and Worker checks Source authorization again before activation.

The [implementation status](../credential-sources.md#implementation-status) lists gaps in guided creation, provider coverage, replacement, recovery, withdrawal, and enforcement qualification. The [lifecycle flow](../../flows/credential-source-lifecycle.md) explains the current implementation.

## Read and list sources

Exact GET requires `credential_source:read`; list requires Namespace `read` and filters each Source by exact `read`. Responses do not resolve credentials or expose the TokenService instance or Driver ID. GET and list read the catalog and remain available when TokenService is unavailable.

## Update a source

Send `PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId` with `credential_source:update`. Supply `secret`, `config`, or both. Omitting `config` preserves the provider preset. Use `config: {}` to remove it. Changing or removing the preset requires an unbound Source and a separate request from credential or lifecycle changes. Combining those changes returns `409 RESOURCE_CONFLICT` before credential custody changes. Keep the `openai` preset for the OpenShell preview's model binding. You can replace a credential while an active Agent revision uses the Source.

A Source's `github` purpose is fixed at registration, whether or not anything uses the Source: adding `github` to another Source, or changing, removing or clearing (`config: {}`) the preset of a `github` Source, returns `409 RESOURCE_CONFLICT`. Every `config` update to a `github` Source must repeat `repositories` with the preset; the preset alone returns `400`. The ceiling changes only in a request without `secret` and only while the Source is unbound. A replacement credential passes the same checks as registration, and a refused replacement keeps the stored credential. A `github` Source has no Credential Proxy Provider copy, so its replacement does not notify the Credential Proxy and cannot fail on delivery: the Worker rotates it into native Git ([replacement](../repository-credentials/repository-token-source.md)).

For OCC custody, TokenService commits the replacement and notifies the Credential Proxy. The Proxy updates existing delivery Providers. If delivery fails, PATCH returns `503 DEPENDENCY_UNAVAILABLE` and the replacement stays in custody. Use [manual credential delivery retry](../credential-sources.md#retry-credential-delivery) to deliver it without resending the secret.

For OpenShell custody, TokenService updates the Source's Workspace Provider. OpenShell propagates the change to attached Sandboxes. A successful manual push confirms that OCC can read the Provider metadata. Verify delivery by checking the running Sandbox. See the [Source update flow](../../flows/credential-source-lifecycle.md#deliver-source-updates).

## Delete a source

DELETE requires `credential_source:delete` and returns `409` while blocking references remain. A `github` Source also returns `409` while a native Git copy of it is not confirmed retired ([retirement](../repository-credentials/repository-token-source.md)). OCC marks the Source `deleting`. With OCC custody and the OpenShell Credential Proxy, the Proxy retires its delivery Provider and profile before TokenService removes the credential. A `github` Source has no Credential Proxy Provider, so OCC skips that step for it. If Proxy retirement fails, DELETE returns `503` and retains the Source and credential for retry. With OpenShell custody, TokenService deletes the Source's own Workspace Provider and profile.

Success returns `204` after Source removal and completion audit. An uncertain removal can leave the Source in `deleting` for retry. If removal succeeds but the completion audit fails, the Source remains gone. A retry returns `403` or `404` depending on the caller's remaining authority.

If an Installation restarts without the Proxy selected, deletion follows the no-Proxy path. A previously retained Provider copy can remain after Source deletion.
