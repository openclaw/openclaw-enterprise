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
Source. The optional `config.provider_preset` permits the exact approved preset
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
before custody changes. Repeating the same preset with a material rotation is
allowed, including while bound.

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
fails, the Source is already gone and another DELETE returns `404`.

An authorized Agent draft can bind the Source for Harness authentication.
Deployment currently returns `409` before creating an Agent revision or work;
enrollment does not prove runtime delivery or a model turn. See the
[custody flow](../../flows/token-service-static-custody.md) for execution and
failure handling.
