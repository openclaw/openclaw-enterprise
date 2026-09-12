# Feature Spec: Configuration Driver and Driver-Owned Schemas

**Date:** 2026-08-19
**Status:** Completed
**Owner:** OCC, configuration storage, and selected Driver implementations
**Supersedes:** earlier Installation-owned configuration proposal

## Problem and Decision

OCC reads singleton Installation settings from an initial YAML file at startup;
the file selects and configures every Driver. A substrate-neutral
`ConfigurationDriver` stores the platform's existing
Namespace-scoped Agent Configuration resources through create, read, update,
delete, and validate operations. Implement Kubernetes ConfigMaps only.

## Scope

**Changes:** startup-file-owned Installation settings; selected Driver-owned
configuration schemas; flat, nonsecret, Namespace-scoped Configuration CRUD;
and one Kubernetes ConfigurationDriver implementation.

**Unchanged:** OCC authorization and placement, Namespace isolation, immutable
AgentRevisions, brokered secrets, and Kubernetes-only compute. Docker is only
a possible future configuration backing substrate. No Installation ConfigMap,
Installation configuration record, configuration reload, or secret backend.

## Contract

OCC reads its trusted startup YAML before constructing any selected Driver:

```yaml
occ:
  cluster: production-west
drivers:
  configuration:
    id: config-kubernetes
    implementation: occ/kubernetes-configmap
    version: 1.0.0
    configuration:
      authentication:
        mode: inCluster
  iam:
    id: native-iam
    implementation: occ/native-iam
    version: 1.0.0
    configuration: {}
  compute:
    id: compute-kubernetes
    implementation: occ/kubernetes
    version: 1.0.0
    configuration:
      authentication:
        mode: inCluster
```

OCC resolves its persisted singleton Installation internally. Installation
configuration belongs to startup YAML; ConfigurationDriver manages
Namespace-owned Configuration resources. Startup fails closed for missing or
invalid YAML, unknown implementations, unsupported configuration, or
unavailable selected Drivers.

Each implementation exposes its closed schema before instantiation; OCC
validates its settings and then constructs the selected Driver. Existing known
Driver constructors provide this metadata directly; no plugin registry is added.

```ts
interface DriverImplementation {
  readonly configurationSchema: JSONSchema;
  validateConfiguration(configuration: unknown): void;
}

type Configuration = {
  readonly id: string;
  readonly namespaceId: string;
  readonly values: Readonly<Record<string, string>>;
};

type ConfigurationReference = Pick<Configuration, "id" | "namespaceId">;

interface ConfigurationDriver extends Driver {
  readonly capability: "configuration";
  create(configuration: Configuration): Promise<Configuration>;
  read(reference: ConfigurationReference): Promise<Configuration>;
  update(configuration: Configuration): Promise<Configuration>;
  delete(reference: ConfigurationReference): Promise<void>;
  validate(configuration: Configuration): Promise<void>;
}
```

OCC owns IDs, placement, and authorization. Creation requires access to the
exact Namespace; read, update, and delete require access to the exact
Configuration. Deployment additionally authorizes the exact referenced
Configuration and snapshots its flat values into the admitted AgentRevision.
Later edits never mutate existing revisions.

Each admitted AgentRevision snapshots flat Configuration values and records the
selected Compute Driver identity. Runtime Compute settings remain startup-owned;
stability across changes to those settings is tracked separately in
[TODO.md](https://github.com/openclaw/openclaw-enterprise/blob/a57c3c69c35865443e4cbfca3ccf54a2e24c6d8f/TODO.md).

The Namespace-owned API uses existing OCC authorization/error conventions:

```text
POST   /namespaces/:namespaceId/configurations                    -> 201
GET    /namespaces/:namespaceId/configurations/:configurationId   -> 200
PATCH  /namespaces/:namespaceId/configurations/:configurationId   -> 200
DELETE /namespaces/:namespaceId/configurations/:configurationId   -> 204
```

Create accepts `{ values: Record<string, string> }`; OCC generates a `cfg_`
identifier and returns `{ id, namespaceId, values, createdAt }`. PATCH
replaces the entire values map; GET and PATCH return the same resource shape.
`validate` is internal and runs
before create/update. Malformed values return 400, missing authorization 403,
unknown resources 404, deletion of an Agent-referenced Configuration 409, and
unavailable authorization/storage 503. Create authorizes the exact Namespace;
other operations authorize the exact `configuration` resource.

`K8ConfigurationDriver` maps each record to one ConfigMap in the Namespace's
exact OCC-selected Kubernetes namespace. Its Role grants only namespaced
ConfigMap `create`, `get`, `update`, and `delete`; `create` needs a separate
rule because Kubernetes cannot restrict it with `resourceNames`. OCC enforces
exact Namespace/object ownership. No Secrets, Pod creation, list, watch, or
cluster-wide access.

Startup validates Configuration Driver implementation and authentication
settings but does not probe tenant ConfigMaps or their RBAC. Exact tenant
namespace existence and ConfigMap authorization are checked during the first
CRUD operation; a provisioning Namespace whose Kubernetes namespace or Role is
not ready fails that operation with `503`.

Driver settings may express an opaque credential reference:

```yaml
credential:
  secretRef: model-provider
```

A `secretRef` is never a credential. Existing Namespace Secrets are accessible
only through their exact Namespace's authorized SecretBroker/SecretDriver.
Installation-scoped credential resolution remains unavailable until an approved
authority exists. Raw credentials never appear in startup YAML, ConfigMaps,
API responses, logs, AgentRevisions, or Agent workloads.

## Implementation

1. Extend [contracts](../../packages/contracts/src/index.ts),
   [resource schemas](../../packages/contracts/src/api/resources.ts),
   [request schemas](../../packages/contracts/src/api/common.ts), and
   [routes](../../packages/contracts/src/api/routes.ts) with a Namespace-owned
   Configuration resource, exact CRUD shapes, and `configuration` capability.
2. Update [OCC](../../packages/occ/src/index.ts), [IAM](../../packages/iam/src/index.ts),
   and [PostgreSQL state](../../packages/occ/src/state/postgres-state.ts) for
   exact-resource authorization, PostgreSQL-owned Configuration metadata,
   dependency-safe mutation and immutable deployment snapshots. Store values
   only in ConfigMaps; lock Configuration metadata during snapshot admission.
   Replace
   existing inline nested Agent draft
   configuration with one exact flat Configuration reference; no merge or
   compatibility path. The forward-only migration rejects any existing Agents
   and reports that the operator must export and recreate them before cutover.
3. Add `apps/controller/src/drivers/configuration/kubernetes/index.ts` using
   the installed Kubernetes client, existing Namespace mapping, exact ConfigMap
   CRUD, strict validation, and minimal namespaced RBAC.
4. Expose closed pre-construction schemas on [IAM](../../packages/iam/src/index.ts)
   and [Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
   implementations. Read Installation YAML once during
   [server startup](../../apps/controller/src/server.mjs),
   [production composition](../../apps/controller/src/composition/production.ts),
   and [worker startup](../../apps/controller/src/worker.mjs); resolve the
   singleton Installation internally and keep YAML startup-owned.
5. Regenerate shared OpenAPI artifacts; update
   [configuration](../../docs/reference/settings.md) and [controller](../../docs/reference/controller.md)
   documentation. Add forward-only database migrations when resource ownership
   or Agent reference persistence requires them.

## Verification

- Startup reads singleton Installation YAML; missing, invalid, or
  plaintext-secret configuration fails closed.
- ConfigurationDriver performs all five operations only on Namespace records;
  it never reads or writes Installation configuration.
- Kubernetes CRUD rejects cross-Namespace access, unauthorized ownership, nested
  values, secret values, and excess Kubernetes permissions.
- Driver schemas validate before construction; unavailable implementations,
  unknown fields, and semantic validation failures reject startup.
- Editing a Configuration affects only subsequently admitted revisions.
- Legacy Agents reject migration with an actionable error; clean installations
  migrate successfully and CRUD returns documented bodies and error statuses.
- Exercise real API authorization and generated contract coverage; run focused
  integration/conformance tests, `pnpm typecheck`, `pnpm openapi:check`, and
  repository formatting checks.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-19 12:38]: Created the minimal substrate-neutral ConfigurationDriver CRUD specification with Kubernetes implementation, Driver-owned schemas, and singleton bootstrap. (01a01b65-5e90-78f0-b899-ce53454884c6 - 96e3cb92b22bcad23243d2fad7a5c3b335bc5eb1)
- [2026-08-19 14:52]: Made Installation YAML startup-owned and limited ConfigurationDriver CRUD to Namespace configuration. (01a01b65-5e90-78f0-b899-ce53454884c6 - eb71e6eec7e8edc6ee23ae213f8ae37691550e86)
- [2026-08-19 14:59]: Resolved review findings with explicit Namespace Configuration CRUD contracts and fail-closed legacy-Agent migration. (01a01b65-5e90-78f0-b899-ce53454884c6 - eb71e6eec7e8edc6ee23ae213f8ae37691550e86)
- [2026-08-19 15:24]: Documented lazy tenant ConfigMap authorization and provisioning failures. (01a01b65-5e90-78f0-b899-ce53454884c6 - 1e048452d44be143677c4a2b83c959979126846c)
- [2026-08-19 16:19]: Simplified runtime Driver selection and tracked Compute configuration stability as a separate future design gap. (01a01b65-5e90-78f0-b899-ce53454884c6 - 0e8413ee880a21a2db9b83cbf952f6d565378d67)
- [2026-08-19 16:29]: Marked the completed ConfigurationDriver specification archived after implementation and verification. (01a01b65-5e90-78f0-b899-ce53454884c6 - 97cb5e5ed3b9f9f1ff14b493720f98a6be0c4ad3)
