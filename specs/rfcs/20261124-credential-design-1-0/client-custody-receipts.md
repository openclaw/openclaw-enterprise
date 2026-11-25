---
rfc: index.md
---

# Retain private Client custody receipts

A TokenService that creates private material in an external store must be able to retain the immutable identity returned by that store. A Client currently records its selected TokenService instance but no private store reference, while `registerClientSecret` returns no result. Looking up the same name again cannot establish that the stored object is the one originally registered.

Change `registerClientSecret` to return an optional private, nonsecret backend reference. The Client registration transaction saves that reference with the reserved Client and clears its cleanup reservation in the same transaction. Later secret resolution, rotation and deletion pass the saved reference to the selected TokenService. Rotation updates the registered object in place; an unexpected replacement fails explicitly. The public Client representation, audit and logs do not contain the reference or usable material. A Driver whose private address is already derived from Client identity returns no reference rather than storing redundant state.

If the external write succeeds but the receipt cannot be saved, the cleanup reservation does not identify the created object. Cleanup must refuse name-only deletion and expose the unconfirmed custody for recovery. Before enabling registration, review whether the store can recover the immutable identity from a preassigned identifier or an idempotent operation record, or whether a documented orphan/manual-recovery limit is acceptable. A request ID that requires replaying the original secret-bearing request does not by itself establish recoverability.

For OpenShell, the reference identifies the immutable Namespace Workspace and Secret. A shared Client Secret is non-injectable and is distinct from a Source's account Provider and its access credential. Enable Namespace Client scopes only when the selected runtime can enforce the exact registered identities. Installation-wide Clients, including public OAuth Clients, remain unsupported by native custody without Installation-wide secret support. The existing purpose-and-scope capability applies to public and confidential OAuth Clients alike; no public-only exception is proposed.

## Interface changes

- API and IAM: no public operation or permission changes.
- Database: add one private, nonsecret backend reference to the stored Client record; public OAuth Clients have none.
- Driver: return the reference from `registerClientSecret` and carry it with subsequent Client secret operations. Keep Source and Client custody references separate.

## Simplifications and qualification

Do not add a second Client table or a parallel Client administration flow. Reuse the existing reservation, registration, rotation and cleanup lifecycle. Qualify through the real Client API and PostgreSQL with the selected TokenService: register, resolve only for the approved OAuth endpoint, rotate, delete, refuse a same-name replacement before reading or changing its material, and exercise a remote-write success followed by a lost receipt without deleting any replacement by name. OpenShell qualification depends on [exact Workspace Secret identity](https://github.com/ai-openshell/openshell/issues/5961); use of Gateway-managed refresh also depends on [exact refresh and material references](https://github.com/ai-openshell/openshell/issues/5966). This amendment is proposed for review and does not approve a custody exception.
