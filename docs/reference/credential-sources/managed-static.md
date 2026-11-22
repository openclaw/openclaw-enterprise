# Managed static credential sources

The selected TokenService creates and owns each managed static Source and its
credential. The Namespace must be `ready`. Send
`POST /namespaces/:namespaceId/credential-sources` with
`credential_source:create` on the Namespace:

```json
{
  "name": "Model access",
  "type": "static",
  "config": { "provider_preset": "openai" },
  "secret": { "opaque": "<credential>" }
}
```

`secret` is write-only and accepts exactly one value. Its field name does not
grant destination authority. OCC stores no Namespace Secret reference for this
Source. The optional `config.provider_preset` currently accepts the approved preset
`openai`; omitting it grants no provider authority. If a private-store write is
unconfirmed, POST can fail without creating a Source while leaving orphaned
credential material. An authorized request already in flight may finish after IAM
revocation. A failure after TokenService commits can instead leave a Source
without creator access. The current store cannot list orphaned material.

Send `PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId`
with exact `credential_source:update`. Supply `secret`, `config`, or both.
Omitting `config` preserves the preset; `config: {}` removes it. An effective
preset change or removal requires an unbound Source and a separate request from
material or lifecycle changes. A mixed change returns `409 RESOURCE_CONFLICT`
before custody changes. Repeating the same preset with a material rotation does
not change the policy. Credential material can be replaced while an active staged
Agent revision uses the Source. After committing replacement material, TokenService
notifies the selected Credential Proxy. The native Proxy updates an existing
Provider without creating one if none exists. If delivery fails, PATCH returns
`503 DEPENDENCY_UNAVAILABLE`; the Source remains ready and the new credential
remains stored.

Exact GET requires `credential_source:read`. List requires Namespace `read` and
returns only Sources with exact Source `read`. Responses contain sanitized Source
metadata, `ownerCapability: "token_service"`, and `secrets: {}`. They do not
resolve or return credential material, the selected instance, or Driver ID.
OCC reads this metadata from the shared catalog, so GET and list remain available
when TokenService is unavailable. Record state does not prove live credential
readiness.

DELETE requires exact `credential_source:delete` and refuses a referenced
Source with `409`. TokenService retires the Source and its credential. DELETE
returns `204` after Source removal and completion audit. An uncertain removal can
leave a `deleting` Source for retry. If removal succeeds but completion audit
fails, the Source is gone. A retry returns `403` if removing the Source also
removed the caller's delete authority, or `404` if the caller remains authorized.

An authorized Agent draft can bind the Source for Harness authentication.
Deployment attaches the Provider and applies the admitted credential policy before
starting the Harness when the selected Sandbox and Credential Proxy support the
route. Native readiness remains a separate requirement; enrollment and admission
do not prove runtime delivery or a model turn. See the
[custody flow](../../flows/token-service-static-custody.md) for execution and
failure handling.
