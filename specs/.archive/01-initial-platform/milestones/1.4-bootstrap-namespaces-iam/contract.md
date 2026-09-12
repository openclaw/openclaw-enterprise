# Feature Spec: Milestone 1.4 — Bootstrap, Namespaces, and IAM: contract

[Spec overview](../1.4-bootstrap-namespaces-iam.md). Original record; decisions and status are preserved.

## Contract

### Singleton Installation boundary

Each state store owns exactly one persisted Installation. Its stable `id`
remains visible through `GET /installation` and is retained by server
configuration, admission and trust validation, exported audit events, and
external deployment boundaries. No request can select a second Installation.

Ordinary Namespace and Agent API resources do not repeat `installationId`.
Internal IAM identities and policy records, `ResourceRef` values, Compute
lifecycle observations, repository arguments, and controller-work objects also
inherit their Installation from the selected singleton store. They carry
`namespaceId` whenever exact tenant ownership is relevant; child resources and
work cannot cross Namespace boundaries. Storage keeps the singleton
Installation row and does not add redundant Installation columns to child
tables.

### Bootstrap and native IAM

The absence of the singleton `occ.installation` row is the only uninitialized
state; M1.4 adds no setup row or concurrent-bootstrap protocol. Development
bootstrap uses the explicit server-configured setup identity from M1.3. The
request supplies only the Installation name.

One transaction inserts the Installation, first Principal, built-in
administrator Role with its complete M1.4 Permissions, Installation-scoped
AccessBinding, and success audit. A unique singleton constraint permits one
commit. Failure rolls back the entire result. Initialized startup disables the
route, hydrates persisted IAM, and rejects reuse as `409 INSTALLATION_EXISTS`.
Normal APIs remain unavailable until bootstrap commits.

M1.4 preserves the M1.3 one-database/one-Installation model: IAM tables do not
repeat `installation_id`; nullable `namespace_id` distinguishes singleton-wide
and Namespace scope. Internal IAM identities and policy records likewise omit
the implied Installation ID. It adds:

- Groups containing direct Principals only, with membership in the same scope;
- AccessBindings whose subject is exactly one identity or Group; and
- deny-only Restrictions matching action, resource kind, optional exact
  resource ID, and optional Namespace.

Database constraints reject cross-Namespace membership, Roles, bindings, and
Restrictions. Public policy-management routes remain deferred; bootstrap and
internal test fixtures are the only M1.4 policy-authoring paths, so application
update/delete grants are not broadened.

Initialized startup hydrates `OCCIAMDriver` from one transaction-consistent
persisted view. It denies an unknown or wrong-scope identity, expands direct
Group membership, requires an exact binding and Role Permission, and then
applies every matching Restriction; any Restriction denies. Invalid, ambiguous,
unsupported, or unavailable IAM denies without a fallback Driver.

M1.4 preserves the M1.2 authorization contract: the fully qualified route action
is audit evidence, while IAM evaluates the existing exact
`PermissionAction + ResourceKind + ResourceRef` tuple without duplicating the
singleton Installation ID. `ResourceRef` retains its exact resource ID and, for
tenant resources, its `namespaceId`. Create targets the exact container defined
by the route registry. Lists authorize `read` per candidate: denial filters
that candidate, while IAM unavailability or an invalid decision fails the
entire list.

### Namespace lifecycle and readiness

Namespace creation reuses the M1.3 mutation transaction: insert
`status = provisioning`, append success audit, and enqueue the existing exact
Namespace `reconcile` work. The work identity derives from Namespace ID and the
target status; M1.4 adds no second lifecycle-intent table or generation field.

The M1.4 conformance harness claims that work and invokes a deterministic fake
of the selected `ComputeDriver` Namespace lifecycle. The fake ensures or deletes
the exact backing Namespace and exactly one Namespace-owned gateway. It returns
only bounded readiness or failure; it cannot choose placement, identity,
cardinality, or another Namespace. This is test execution, not the production
controller loop or Kubernetes implementation.

OCC is the only writer of public Namespace status. A successful observation for
a row still in `provisioning` changes it to `ready`; a permanent failure changes
it to `failed`; a retryable or incomplete result leaves it `provisioning`.
`ready` means both the backing Namespace and its one gateway are ready. M1.5 may
add continuous observation and readiness decay without changing that predicate.

`DELETE /namespaces/:namespaceId` authorizes the exact Namespace, locks it, and
accepts only a Namespace with no Agents. The transaction changes status to
`deleting`, appends audit, and enqueues exact Namespace reconcile work, returning
`202`. New children and deployments are then rejected. After the fake confirms
gateway and backing-Namespace removal, OCC sets `deleted_at`; list and exact read
treat the tombstone as absent. The row remains to satisfy M1.3 retained work,
audit, and `RESTRICT` ownership. Name reuse and physical retention remain
follow-on policy.

Every repository operation derives the singleton Installation from its selected
store and validates the exact Namespace and child-resource owner. Wrong-owner
lookup returns nondisclosing `404`; a correctly scoped IAM denial returns `403`.

### Deployment gate, API scope, and audit

The existing deploy route resolves and authorizes the exact Agent. If its
Namespace is not `ready`, it returns `409 NAMESPACE_NOT_READY` and creates no
revision or work. A ready Namespace reaches the existing unimplemented boundary
and returns `409 DEPLOYMENT_NOT_IMPLEMENTED`; M1.6 owns deployment.

M1.4 keeps the M1.2 route model: bootstrap and Namespace administration are
Installation-scoped, while Namespace-owned children use nested paths and exact
IAM targets. `GET /installation` returns the stable Installation `id`; ordinary
Namespace and Agent responses omit `installationId`. Namespace IDs come from
paths and persisted ownership, never body, query, or scope-override headers.
Production exact-Namespace admission remains an OAG concern; M1.4 adds no
`admissionScope` registry.

Exported audit events retain the Installation ID and record actor, action,
exact resource, Namespace scope, selected `IAMDriver`, applicable Restrictions
and outcome, and result. Bootstrap, IAM denial, Namespace transition, fake
lifecycle result, deployment rejection, and deletion are attributable.
Credentials, foreign-tenant identifiers, and raw Driver payloads are excluded.
Authorization failure occurs before mutation or fake Driver invocation.

