---
rfc: index.md
---

# Let TokenService own credential sources

This proposed amendment supersedes the Source metadata and registration ownership decisions in the [Installation credential ownership amendment](installation-credential-ownership.md) and [TokenService instance amendment](token-service-instance-and-updates.md). The selected TokenService creates each CredentialSource and owns credential custody and lifecycle. OpenClaw Control Plane (OCC) can query Source metadata directly from the shared PostgreSQL catalog. OCC authorizes requests and owns IAM, Agent bindings, destination policy, and audit. Any operation that obtains a usable credential goes through TokenService.

## Registration and use

A caller submits a write-only credential to the Namespace Source API. OCC checks the ready Namespace, exact collection permission, and any approved destination policy. OCC records attributable registration intent without reserving a Source. Authorization admits the operation; a later revocation does not cancel an already admitted request. It then calls the selected TokenService once. TokenService allocates the scoped Source identity, creates the canonical Source record and credential, and returns the Source. OCC grants the creator access, records the successful mutation, and returns sanitized metadata. Neither metadata reads nor Agent binding resolve credential material.

The built-in TokenService uses the existing reviewed PostgreSQL Source catalog and Installation-private Secret Driver. The catalog contains one canonical record, so Agent and revision references can retain their database constraints. TokenService owns its database transactions; OCC does not pass a transaction to the Driver or hold database locks while calling it. OCC grants creator access and records completion in a separate transaction. A crash after Source creation can leave a Source without its creator grant or completion audit. The Secret Driver is also a separate store. An uncertain write or database failure can leave orphaned credential material; this is an accepted failure, not a reason for OCC to reserve a Source or maintain a registration dispatch fence. Do not claim automatic orphan discovery: the current private Secret store has no inventory operation.

OCC reads and lists Source metadata from the shared catalog after exact IAM authorization, without calling TokenService or resolving credential material. TokenService owns credential creation, update, and removal. OCC updates independent provider or Connection Template policy under its own authorization and Source-reference locks; a Driver response cannot grant destination authority. OCC refuses deletion while an Agent or revision references the Source. OCC commits the checked `deleting` state and attributable retirement intent before calling TokenService. TokenService independently removes custody and the canonical Source and returns the AccessBindings actually removed in that transaction for OCC's completion audit. An uncertain removal can leave `deleting` for retry; if removal commits before OCC can record completion, the Source is gone and a retry returns `404`. The committed intent remains, but a completion audit is not guaranteed across the two transactions. A binding stores the Source identity and needs no credential resolution. Changing the selected instance does not transfer ownership of existing Sources.

## Interface changes

### API

Keep the managed Namespace Source API and write-only credential input. Return the TokenService-created Source after sanitization. Repeated DELETE after retirement returns `404`.

### IAM

No action changes. OCC retains collection create, exact Source read/update/delete/operate, creator access, authorization-denial evidence, and Agent binding authorization.

### Database entities

Reuse the canonical Source catalog and its Namespace, Agent, revision, and TokenService instance references. Remove managed registration-only dispatch or receipt state when no supported caller needs it. Do not duplicate Source metadata in OCC and TokenService catalogs.

### Driver contract

Change TokenService Source creation to accept Namespace, name, lifecycle settings, and write-only credential, and return the complete created Source rather than a private registration receipt for an OCC-allocated identity. Provide credential update against that owner-created identity. TokenService commits its operations independently of OCC. Do not add TokenService metadata read or list APIs; OCC can query the shared catalog directly. Remove the separate `prepareSourceRetirement` operation. OCC commits retirement admission before calling `removeSource` once; that operation owns its transaction and returns the actual removed AccessBindings. Preserve authorized credential resolution, refresh, instance isolation, and Installation client-secret identity boundaries.

## Simplifications

Remove OCC's managed Source reservation, registration dispatch claim, late-write fence, and compensation state machine. Remove the shared transaction callback. Keep a single canonical Source and independent transaction ownership. Retaining OCC as the Source owner avoids a contract cutover but leaves credential registration split across two owners.

## Acceptance criteria

- A real authenticated managed Source POST authorizes before custody, calls TokenService to create the Source, commits creator IAM and audit, and returns sanitized metadata.
- OCC can read and list authorized Source metadata directly even when TokenService is unavailable. Updates and retirement go through TokenService; Agent bindings use Source IDs without credential disclosure or duplicate metadata.
- Exact IAM denials and unapproved destination policy prevent custody effects. Policy changes require an unbound Source. OCC commits deletion admission and intent before calling TokenService; a referenced Source cannot be deleted, and uncertain removal can leave `deleting` for retry. If removal commits and completion audit fails, the Source is already gone.
- PostgreSQL and Fastify integration exercises the real Source caller, Native IAM, canonical catalog, and TokenService custody. A simulated Secret transport does not establish live runtime or model execution.
- A crash or lost acknowledgement can leave orphaned material, a Source without a creator grant, or a missing completion audit. The platform neither silently reports success nor claims unsupported inventory or cleanup.
