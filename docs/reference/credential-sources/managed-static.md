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
allowed while the Source is selected in a draft. Credential changes return
`409` while an active staged Agent revision uses the Source, until delivery
updates are supported.

Exact GET requires `credential_source:read`. List requires Namespace `read` and
returns only Sources with exact Source `read`. Responses contain sanitized Source
metadata, `ownerCapability: "token_service"`, and `secrets: {}`. They do not
resolve or return credential material, the selected instance, or Driver ID.
OCC reads this metadata from the shared catalog, so GET and list remain available
when TokenService is unavailable. Record state does not prove live credential
readiness.

DELETE requires exact `credential_source:delete` and refuses a referenced
Source with `409`. If a Credential Proxy is selected, it first retires its owned
delivery copy and profile. On failure, DELETE returns `503`, the Source stays
`deleting`, and TokenService keeps the credential for a retry. TokenService then
retires the Source and credential. DELETE returns `204` after Source removal and
completion audit. An uncertain removal can leave a `deleting` Source for retry.
If removal succeeds but completion audit fails, the Source is gone. A retry returns `403` if removing the Source also
removed the caller's delete authority, or `404` if the caller remains authorized.

If an Installation restarts without the Credential Proxy selected, Source deletion
follows the no-Proxy path. A native Provider copy retained from the earlier Proxy
selection can remain after the Source is deleted.

An authorized Agent draft can bind the Source for Harness authentication.
Deployment can admit the approved model route when the selected Sandbox and
Credential Proxy support it. Native readiness remains a separate requirement;
enrollment and admission do not prove runtime delivery or a model turn. See the
[custody flow](../../flows/token-service-static-custody.md) for execution and
failure handling.
