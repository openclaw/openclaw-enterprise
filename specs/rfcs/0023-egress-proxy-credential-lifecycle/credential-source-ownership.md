---
rfc: index.md
---

# Let TokenService own credential sources

This proposed amendment supersedes the Source metadata and registration ownership decisions in the [Installation credential ownership amendment](installation-credential-ownership.md) and [TokenService instance amendment](token-service-instance-and-updates.md). The selected TokenService owns each CredentialSource identity, metadata, credential lifecycle, and custody. OpenClaw Control Plane (OCC) authorizes requests and owns IAM, Agent bindings, destination policy, and audit.

## Registration and use

A caller submits a write-only credential to the Namespace Source API. OCC checks the ready Namespace, exact collection permission, and any approved destination policy. OCC records attributable registration intent without reserving a Source. It then calls the selected TokenService once. TokenService allocates the scoped Source identity, creates the canonical Source record and credential, and returns the Source. OCC grants the creator access, records the successful mutation, and returns sanitized metadata. Neither metadata reads nor Agent binding resolve credential material.

The built-in TokenService uses the existing reviewed PostgreSQL Source catalog and Installation-private Secret Driver. The catalog contains one canonical record, so Agent and revision references can retain their database constraints. Source metadata, creator IAM binding, and completion audit can share the platform transaction. The Secret Driver is a separate store. An uncertain write or a later database failure can leave orphaned credential material; this is an accepted failure, not a reason for OCC to reserve a Source or maintain a registration dispatch fence. Do not claim automatic orphan discovery: the current private Secret store has no inventory operation.

TokenService owns Source read, list, update, and retirement. OCC filters reads by exact IAM authority and controls independent provider or Connection Template policy; a Driver response cannot grant destination authority. OCC refuses deletion while an Agent or revision references the Source. TokenService first prepares retirement by durably marking an unreferenced Source `deleting`. OCC then calls TokenService removal inside the transaction that records the completion audit; an uncertain removal or failed audit leaves the Source `deleting` for retry. A binding stores the Source identity and needs no credential resolution. Changing the selected instance does not transfer ownership of existing Sources.

## Interface changes

### API

Keep the managed Namespace Source API and write-only credential input. Return the TokenService-created Source after sanitization. Repeated DELETE after retirement returns `404`.

### IAM

No action changes. OCC retains collection create, exact Source read/update/delete/operate, creator access, authorization-denial evidence, and Agent binding authorization.

### Database entities

Reuse the canonical Source catalog and its Namespace, Agent, revision, and TokenService instance references. Remove managed registration-only dispatch or receipt state when no supported caller needs it. Do not duplicate Source metadata in OCC and TokenService catalogs.

### Driver contract

Change TokenService Source creation to accept Namespace, name, lifecycle settings, and write-only credential, and return the complete created Source rather than a private registration receipt for an OCC-allocated identity. Provide Source read/list/update operations against that owner-created identity. Split retirement into `prepareSourceRetirement`, which commits the checked `deleting` state, and `removeSource`, whose canonical removal participates in OCC's completion-audit transaction. Preserve authorized credential resolution, refresh, instance isolation, and Installation client-secret identity boundaries.

## Simplifications

Remove OCC's managed Source reservation, registration dispatch claim, late-write fence, and compensation state machine. Keep a single canonical Source and let TokenService implement its lifecycle. Retaining OCC as the Source owner avoids a contract cutover but leaves credential registration split across two owners.

## Acceptance criteria

- A real authenticated managed Source POST authorizes before custody, calls TokenService to create the Source, commits creator IAM and audit, and returns sanitized metadata.
- A managed Source can be read, listed, updated, bound to an Agent draft, and retired through its owner without credential disclosure or duplicate metadata.
- Exact IAM denials and unapproved destination policy prevent custody effects. A referenced Source cannot be deleted; an uncertain owner removal or rejected completion audit leaves a retryable `deleting` Source and preserves its IAM bindings.
- PostgreSQL and Fastify integration exercises the real Source caller, Native IAM, canonical catalog, and TokenService custody. A simulated Secret transport does not establish live runtime or model execution.
- A crash or lost acknowledgement can leave orphaned material; the platform neither silently reports success nor claims unsupported inventory or cleanup.
