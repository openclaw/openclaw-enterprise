# Agent runtime roles

With configured roles, the native Gateway sees `oce:<Principal ID>`, a stable account identifier verified against the OCE session, and the server-selected role. It finds or creates that native profile and commits the named role before admitting its connection. The proxy also supplies a SHA-256 digest of the role definition; missing roles or changed native definitions reject admission.

For native authenticated HTTP, creating a profile or changing its role retires the authority captured before acquisition. That request returns `401` before the handler runs; a separate request uses the committed role. OCC never automatically replays an HTTP write. WebSocket admission acquires authority after role publication.

Saved `gateway.roles` defines assignable roles; the active revision defines deployed policy. Compute owns the built-in administrator policy. The exact human/Agent AccessBinding stores `runtimeRole`. Native edits cannot change that assignment: the next admission reapplies it. Profiles linked to multiple OCE people cannot admit them as one person.

The [runtime-role catalog](api.md#get-namespacesnamespaceidagentsagentidruntimeroles) returns saved Configuration ID/generation, assignable roles, runtime state and optional deployed summaries, including before deployment and while stopped. Administrators create/change assignments with `runtimeRole` and the catalog’s `configuration` as `runtimeRoleConfiguration`; PATCH preserves binding identity, DELETE revokes entry. Stale Configuration returns `409`; unknown roles return `400`. Definitions require deployment; missing deployed roles deny entry. One direct person/Agent assignment is allowed; groups, services, broad bindings and Installation administration select no native role.

Kubernetes configures `gateway.auth.trustedProxy.managedIdentityPrefixes: ["oce:"]` and `managedIdentities: ["occ-workspace-files"]`. The bridge refuses undeclared identities and profiles with multiple managed identities. Selectors must be nonempty, trimmed lowercase values; role headers require at least one prefix or exact identity. Compute rejects conflicts.

Kubernetes retains the separate `occ-workspace-files` identity with the reserved `oce-service` role for server operations. The role catalog excludes that reserved role. OCE core consumes opaque role names and Compute descriptors; native profile details stay in the runtime and Driver.

Policy digests use SHA-256 of UTF-8 JSON role definitions, recursively sorting object keys with English locale comparison and preserving array order. Driver and runtime use identical rules. Digests check policy agreement; trusted-proxy authentication establishes authority.

## Related

- [Native admin access](agent-native-admin.md)
- [Authorization](authorization.md)
- [Compute Driver](drivers/compute.md)
