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

If the private-store write cannot be confirmed, registration can fail while leaving orphaned material. A failure after TokenService commits can leave a Source without its creator IAM grant. The private store cannot list orphaned material. See the [custody flow](../../flows/token-service-static-custody.md) for failure handling.

## Deploy an Agent with the source

1. Create a same-Namespace [Agent Configuration](../configuration.md) with `kind: "agent"`. Configure its model and explicit inference endpoint. For this example, use provider `openai`, protocol `openai-responses`, and base URL `https://api.openai.com/v1`.
2. [Create the Agent](../agents.md#supported-operations) with `POST /namespaces/:namespaceId/agents`, using that Configuration and dedicated execution:

   ```json
   {
     "name": "example-agent",
     "configurationId": "cfg_...",
     "executionMode": "dedicated",
     "credentialSources": [{ "sourceId": "cs_..." }],
     "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
   }
   ```

3. Grant the Agent service principal `credential_source:operate` on that Source. The deploying caller also needs that permission and `agent:deploy`.
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

The [implementation status](../credential-sources.md#implementation-status) lists gaps in guided creation, provider coverage, replacement, updates, withdrawal, and enforcement qualification. The [lifecycle flow](../../flows/credential-source-lifecycle.md) explains the current implementation.

## Read and list sources

Exact GET requires `credential_source:read`; list requires Namespace `read` and filters each Source by exact `read`. Responses do not resolve credentials or expose the TokenService instance or Driver ID. GET and list read the catalog and remain available when TokenService is unavailable.

## Update a source

Send `PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId` with `credential_source:update`. Supply `secret`, `config`, or both. Omitting `config` preserves the provider preset; `config: {}` removes it. Changing or removing the preset requires an unbound Source and a separate request from credential or lifecycle changes. Combining those changes returns `409 RESOURCE_CONFLICT` before credential custody changes. Repeating the same preset while replacing the credential is allowed when the Source is selected only in a draft. See [implementation status](../credential-sources.md#implementation-status) for active delivery updates.

## Delete a source

DELETE requires `credential_source:delete` and returns `409` while the Source is referenced. TokenService removes the Source and credential from its custody; current handling of retained delivery copies is listed in [implementation status](../credential-sources.md#implementation-status). Success returns `204` after Source removal and completion audit. An uncertain removal can leave the Source in `deleting` for retry. If removal succeeds but the completion audit fails, the Source remains gone; retry returns `403` or `404` depending on the caller's remaining authority.
