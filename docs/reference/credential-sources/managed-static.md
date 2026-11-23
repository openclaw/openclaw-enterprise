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

To associate a Source with a Connection Template, supply `connectionTemplateId` in the POST. OCC checks create authority and requires a ready Namespace, then accepts a `static_bearer` Template available Installation-wide or in that Namespace. A malformed ID or unsupported version field returns `400`; an unavailable or foreign Template returns `404`; a different mode returns `409`. OCC rejects an invalid selection before TokenService takes custody.

Omit `connectionTemplateId` for a Source that uses a Harness provider preset, as in the example above. A Template-associated Source cannot also use `config.provider_preset`; POST or PATCH returns `409` before changing custody or configuration.

`secret` is write-only and accepts one nonempty credential. Its field name does not grant destination authority. The optional `config.provider_preset` associates the Source with an approved provider; without it the Source cannot authorize a model destination. The response contains sanitized Source metadata. OCC does not store a Namespace Secret reference or return the credential.

If the private-store write cannot be confirmed, registration can fail while leaving orphaned material. A failure after TokenService commits can leave a Source without its creator IAM grant. The private store cannot list orphaned material. See the [custody flow](../../flows/token-service-static-custody.md) for failure handling.

## Deploy an Agent with the source

This development integration is not production-qualified. Before starting, select OCC TokenService and an OpenShell Sandbox registration that also exposes `credential_proxy_delivery`; see [supported Driver selections](../drivers/selection.md#supported-selections). Selecting legacy `drivers.credential_proxy` makes the policy PUT below return `409`; omit that selection. This path admits exactly one Source and no repository credentials.

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

Exact GET requires `credential_source:read`; list requires Namespace `read` and filters each Source by exact `read`. Responses do not resolve credentials or expose the TokenService instance or Driver ID. GET and list read the catalog and remain available when TokenService is unavailable. POST, PATCH, GET, and list return `connectionTemplateId` when a static association exists. They do not return a Template version. Updating the Template preserves the Source association; PATCH cannot change the associated ID. Plugin credential admission against the Template's current version remains pending; see [implementation status](../credential-sources.md#implementation-status).

## Update a source

Send `PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId` with `credential_source:update`. Supply `secret`, `config`, or both. Omitting `config` preserves the provider preset; `config: {}` removes it. Changing or removing the preset requires an unbound Source and a separate request from credential or lifecycle changes. Combining those changes returns `409 RESOURCE_CONFLICT` before credential custody changes. Repeating the same preset while replacing the credential does not change policy. Credential replacement is allowed while an active Agent revision uses the Source. After TokenService commits the replacement, it notifies the selected Credential Proxy. The native Proxy updates an existing Provider; it does not create one if none exists. If delivery fails, PATCH returns `503 DEPENDENCY_UNAVAILABLE`; the Source remains ready and the replacement stays in custody. See the [lifecycle flow](../../flows/credential-source-lifecycle.md#deliver-source-updates) for execution.

## Delete a source

DELETE requires `credential_source:delete` and returns `409` while blocking references remain. OCC marks the Source `deleting`. If an OpenShell Credential Proxy is selected, OCC asks it to retire its owned Provider and profile before TokenService removes the Source and credential from custody. If Proxy retirement fails, DELETE returns `503` and retains the Source and credential for retry. Success returns `204` after Source removal and completion audit. An uncertain removal can leave the Source in `deleting` for retry. If removal succeeds but the completion audit fails, the Source remains gone; retry returns `403` or `404` depending on the caller's remaining authority.

If an Installation restarts without the Proxy selected, deletion follows the no-Proxy path. A previously retained Provider copy can remain after Source deletion.
