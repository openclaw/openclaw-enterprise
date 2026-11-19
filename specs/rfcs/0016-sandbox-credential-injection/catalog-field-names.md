---
rfc: index.md
---

# Require usable credential source catalog field names

This proposed amendment requires each Credential Gateway Driver to advertise
config and secret field names that the credential source API can accept. Each
name must match `^[a-z][a-z0-9_]{0,63}$`. The API already uses this limit for
caller-supplied field names. A Driver that requires `client-id`, for example,
would otherwise ask the caller for a field that the API rejects.

OCC checks the catalog when it builds Installation capabilities. If any
advertised type contains an invalid config or secret field name, discovery
returns `503 DEPENDENCY_UNAVAILABLE`. When a caller registers a source directly,
OCC checks the selected type and returns the same error before it reads Secrets,
creates a record, or calls the Driver to register the source. An invalid field
on an unrelated type does not block that registration. Caller-supplied malformed
config keys continue to return `400 INVALID_REQUEST` with the specific field.

The Driver owns its catalog and must correct an invalid name. OCC reports a
dependency failure because the caller cannot repair the Driver's declaration.
The alternative is to continue exposing unusable catalog entries and report a
caller error during registration.

Acceptance requires discovery and direct-registration tests with invalid Driver
fields, a valid registration on another type, a field-specific error for a
malformed caller key, and proof that rejected registration has no effects.
