# Managed static credential sources

Use a managed static Source to register one credential value with the selected
TokenService. The Namespace must be `ready`. Send
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
`openai`; omitting it grants no provider authority.

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
resolve or return credential material, the selected instance, Driver ID, or
private receipt. Record state does not prove live credential readiness.

DELETE requires exact `credential_source:delete` and refuses a referenced
Source with `409`. OCC removes an undispatched reservation directly; otherwise,
the recorded owner must confirm retirement. DELETE returns `204` after OCC removes
the Source and its bindings. Until then, the Source blocks Namespace deletion
and cleanup can be retried.

An authorized Agent draft can bind the Source for Harness authentication.
Deployment currently returns `409` before creating an Agent revision or work;
enrollment does not prove runtime delivery or a model turn. See the
[custody flow](../../flows/token-service-static-custody.md) for execution and
failure handling.
