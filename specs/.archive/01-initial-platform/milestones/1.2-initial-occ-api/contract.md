# Milestone 1.2: Initial OCC API: contract

[Spec overview](../1.2-initial-occ-api.md). Original record; decisions and status are preserved.

## Contract

### Composition and authority

Application services receive an explicit dependency object:

```ts
interface ApplicationDependencies {
  admissionVerifier: AdmissionVerifier;
  iamDriver: IAMDriver;
  state: PlatformStateStore;
  auditEvents: AuditEventFactory;
  clock: Clock;
  ids: IdGenerator;
}
```

`composeDevelopment` binds local admission, native IAM, in-memory state/audit,
system clock/IDs, application services, and a loopback Fastify listener.
`composeTest` supplies deterministic fakes. `composeProduction` refuses to
start until a later milestone supplies OAG, trusted ingress, and durable state.
Handlers receive services, never a container; request data cannot select an
adapter or Driver.

Admission returns verified identity and scope, not permission. OCC resolves a
provisioned Principal, loads server-owned resource scope, selects the
authoritative IAM Driver, and requests exact authorization before side effects.
The resulting immutable `RequestContext` carries the server request ID,
issuer/subject/Principal, admission decision ID/method, and admitted
Installation/optional Namespace. Use cases receive it explicitly;
`AsyncLocalStorage` may correlate logs but is not an authority source.

### API ownership and wire rules

`packages/contracts/src/api` owns the TypeBox builders, `Type.Static` types, and
one `occApiRoutes` registry. The registry defines each operation's method, path,
schemas, semantic audit action, existing coarse `PermissionAction`, exact IAM
target, and response statuses. Fastify registers routes from it and Swagger
generates `packages/contracts/openapi/occ-api.openapi.json`; no parallel
handwritten interface, JSON Schema, or OpenAPI model is allowed.

Fastify must use:

```ts
Fastify({
  bodyLimit: 64 * 1024,
  ajv: {
    customOptions: {
      removeAdditional: false,
      coerceTypes: false,
      useDefaults: false,
    },
    plugins: [ajvFormats],
  },
});
```

Register Swagger before routes with OpenAPI `3.1.0` and
`convertConstToEnum: false`. Runtime TypeBox schemas remain compatible with
Fastify's managed Ajv v8; OpenAPI generation must not become a second contract.

Common rules:

- JSON bodies accept `application/json` with an optional charset. Routes with
  no body reject one; no route accepts query parameters.
- Object schemas are closed unless a field is explicitly arbitrary JSON.
  Unknown fields are rejected, not removed; values are not coerced/defaulted.
- Bodies cannot supply IDs, ownership, actor, admission, audit, or Driver data.
- IDs are opaque UUIDv4 values with exact prefixes: `ins_`, `ns_`, `agt_`,
  `rev_`, `aud_`, and `req_`. Prefixes are not ownership evidence.
- Names contain 1–200 Unicode code points, have no surrounding whitespace, and
  contain no control characters. Namespace names are unique per Installation;
  Agent names are unique per Namespace.
- Timestamps are server-produced RFC 3339 UTC values.
- Success is `{ "data": T, "meta": { "requestId": "req_..." } }`; failure is
  `{ "error": { "code": "...", "message": "...", "details"?: [...] },
"meta": { "requestId": "req_..." } }`.
- Every response sets `Cache-Control: no-store`, JSON UTF-8 content type,
  `X-Content-Type-Options: nosniff`, and `X-Request-Id`.
- `configuration` is a JSON object within the body limit. A separate boundary
  guard rejects nesting deeper than 24 and keys named `__proto__`, `prototype`,
  or `constructor`; OpenAPI describes but does not claim to enforce this guard.

Public resource fields are deliberately small:

| Resource     | Fields                                                                |
| ------------ | --------------------------------------------------------------------- |
| Installation | `id`, `name`, `createdAt`                                             |
| Namespace    | `id`, `installationId`, `name`, `status: "provisioning"`, `createdAt` |
| Agent        | `id`, `installationId`, `namespaceId`, `name`, `createdAt`            |

Milestone 2 exposes no successful AgentRevision representation and no Agent
workload identity.

### Routes and exact authorization

`I`, `N`, `A`, and `R` below are server-resolved Installation, Namespace,
Agent, and requested revision IDs. Semantic actions are recorded in audit; the
existing IAM Driver receives only its existing coarse action and exact
`ResourceRef`.

| Operation                                                            | Request and result                            | Semantic action                   | Existing IAM request                                    |
| -------------------------------------------------------------------- | --------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| `POST /installation/bootstrap`                                       | `{name}` → `201` Installation                 | `openclaw.installation.bootstrap` | `administer` installation `I`                           |
| `GET /installation`                                                  | → `200` Installation                          | `openclaw.installation.read`      | `read` installation `I`                                 |
| `POST /namespaces`                                                   | `{name}` → `201` Namespace                    | `openclaw.namespaces.create`      | `create` namespace container `I`                        |
| `GET /namespaces`                                                    | → `200` Namespace[]                           | `openclaw.namespaces.list`        | `read` each Namespace candidate `N`                     |
| `GET /namespaces/:namespaceId`                                       | → `200` Namespace                             | `openclaw.namespaces.read`        | `read` namespace `N`                                    |
| `POST /namespaces/:namespaceId/agents`                               | `{name}` → `201` Agent                        | `openclaw.agents.create`          | `create` agent container `N`                            |
| `GET /namespaces/:namespaceId/agents`                                | → `200` Agent[]                               | `openclaw.agents.list`            | `read` Namespace container `N`, then each Agent `A`     |
| `GET /namespaces/:namespaceId/agents/:agentId`                       | → `200` Agent                                 | `openclaw.agents.read`            | `read` agent `A`                                        |
| `POST /namespaces/:namespaceId/agents/:agentId/deploy`               | `{configuration}` → `409 NAMESPACE_NOT_READY` | `openclaw.agents.deploy`          | `deploy` agent `A`                                      |
| `GET /namespaces/:namespaceId/agents/:agentId/revisions`             | → `200`, always `data: []`                    | `openclaw.agent_revisions.list`   | `read` agent container `A`                              |
| `GET /namespaces/:namespaceId/agents/:agentId/revisions/:revisionId` | → `404 NOT_FOUND`                             | `openclaw.agent_revisions.read`   | `read` requested revision `R` after resolving Agent `A` |

Every `ResourceRef` includes `installationId: I` and, when scoped, the resolved
`namespaceId: N`. Lists load candidates under the exact owner tuple, authorize
every candidate before returning it, and fail the whole request if IAM is
unavailable. No pagination contract is defined for process-local M2 state.

Deploy validates and authorizes but creates no revision, controller work, or
success audit because M2 never establishes Namespace readiness. Revision list
and detail do not expose revisions that may exist through lower-level prototype
APIs. Keep `OpenClawController.createRevision` and its direct lifecycle tests
for later milestones, but remove it from the M2 HTTP path.

### Errors

Error messages and optional detail codes are bounded, server-authored, and
allowlisted. They never expose input values, headers, tokens, stack traces,
Driver errors, or foreign identifiers.

| HTTP  | Codes                                                             |
| ----- | ----------------------------------------------------------------- |
| `400` | `INVALID_REQUEST`                                                 |
| `401` | `UNAUTHENTICATED`                                                 |
| `403` | `FORBIDDEN`                                                       |
| `404` | `NOT_FOUND`                                                       |
| `405` | `METHOD_NOT_ALLOWED` with `Allow`                                 |
| `409` | `INSTALLATION_EXISTS`, `RESOURCE_CONFLICT`, `NAMESPACE_NOT_READY` |
| `413` | `PAYLOAD_TOO_LARGE`                                               |
| `415` | `UNSUPPORTED_MEDIA_TYPE`                                          |
| `500` | `INTERNAL_ERROR`                                                  |
| `503` | `DEPENDENCY_UNAVAILABLE`                                          |

Missing/invalid admission is `401`. An admitted but unresolved Principal or a
valid authoritative IAM denial is `403`. Missing resources and owner-tuple
mismatches are `404` to avoid existence disclosure. Admission/IAM/state/audit
unavailability or invalid authority decisions are `503`; no fallback authority
is attempted.

### State and Namespace ownership

Persistence is private OCC infrastructure, not an Installation-selected
integration capability, so this milestone does not define `DBDriver`.

```ts
interface PlatformStateStore {
  read<T>(work: (state: PlatformReadView) => Promise<T>): Promise<T>;
  transact<T>(work: (uow: PlatformUnitOfWork) => Promise<T>): Promise<T>;
}
```

The unit of work exposes aggregate-aware Installation, Namespace, Agent, and
audit repositories. Methods require full parent tuples; there is no generic
`get(id)` or `save<T>()` that can omit ownership.

`InMemoryPlatformState` serializes transactions and publishes a clone-on-write
snapshot only after the callback and staged audit succeed. Reads return cloned,
immutable values. It enforces:

1. Zero or one Installation; bootstrap compare-and-create is atomic.
2. Namespace key `(installationId, namespaceId)` and immutable owner.
3. Agent key `(installationId, namespaceId, agentId)` and immutable parents.
4. Name uniqueness within the owning Installation/Namespace.
5. ID collision rejection without overwrite.
6. Failed transactions publish neither state nor success audit.

For nested requests OCC selects the singleton Installation, resolves Namespace
and Agent by the full tuple, checks stored parents, authorizes the registry's
exact target, derives child ownership from the loaded parent, and only then
mutates. It never performs a global fallback lookup. State and audit disappear
on restart by design; Milestone 3 replaces the adapter with PostgreSQL behind
the same application contract.

### Development admission and future OAG

```ts
interface AdmissionVerifier {
  verify(input: AdmissionRequest): Promise<AdmittedCaller>;
}
```

`AdmittedCaller` contains immutable issuer, subject, admitted Installation and
optional Namespace, decision ID, and method (`local-development` or `oag`). It
does not contain a permission or select IAM.

The local adapter is available only in the development root. It requires an
explicit loopback listener and peer, `trustProxy: false`, no forwarding headers,
and one or more unique Installation-scoped bearer-to-provisioned-Principal
mappings. Each bearer has at least 256 bits of entropy and is compared through
fixed-length digests in constant time. Clients never send Principal or owner
IDs; tokens and authorization headers are never logged or audited. Namespace
access comes from post-creation IAM grants, not local admission mappings.

Before any nondevelopment exposure, a real OAG adapter and trusted ingress must
replace local admission. The adapter must verify issuer, immutable subject,
audience, expiry, required claims, tenant association, and request/scope binding;
reject direct, copied, expired, replayed, conflicting, or unverifiable evidence;
and fail closed on OAG or trust outage. OCC still resolves an existing Principal
and independently authorizes the exact operation. The signed evidence format,
mTLS/channel binding, key distribution, and replay mechanism are deliberately
deferred to the OAG milestone.

### Audit

Use an injected `AuditEventFactory` and transaction-bound `AuditRepository`.
Handlers do not construct ad hoc event objects. Every event includes its
server-generated ID and timestamp, kind, attributable actor, semantic action,
exact resource and scope, and outcome. Optional safe details may include
request correlation or an allowlisted reason; admission decision IDs and
serialized IAM requests or decisions are not required audit fields.

Required behavior:

- Bootstrap emits one `bootstrap/success` event in its state transaction.
- Namespace and Agent creation each emit one `mutation/success` event in their
  state transaction.
- Denial of an admitted, resolved actor emits one attributable
  `authorization_denial/denied` before returning.
- Unauthenticated local admission failures return `401` without writing an OCC
  audit event. Reads, validation failures, unknown routes, and unsupported
  methods likewise do not emit OCC audit events.
- Mutation audit failure rolls back the mutation and returns `503`.
  Authorization-denial audit failure permits no side effect and returns `503`
  instead of an unaudited `403`.

Audit excludes credentials, bearer tokens, headers/cookies, request/response
bodies, configuration/secret values, prompts/messages, stack traces, and raw
exceptions. Operational logs are not the audit source of truth.

### Request order and security boundary

The request path is: direct loopback check → server request ID → route/path
match → admission → body/boundary validation → Principal lookup → full owner
resolution → selected-IAM authorization → use case → state/audit commit →
schema serialization.

No denied or unavailable path creates a resource, revision, work item, gateway,
workload, or external Driver call. The server does not trust caller ownership,
ID prefixes, forwarded identity, caller request IDs, email/display names,
admission as permission, parent authorization as child authorization, or a
decision from a nonselected/changed Driver.

