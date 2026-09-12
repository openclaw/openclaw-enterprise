# Feature Spec: ChatGPT Service Account Driver

**Date:** 2026-08-24
**Status:** Planning
**Owner:** OCC, ChatGPT integration, and Kubernetes Compute
**Source baseline:** `openai/openclaw-enterprise@c11ba6418d06`.

## Problem and Decision

Implement a generic `ServiceAccountDriver` capability with a concrete `ChatGPTServiceAccountDriver` that
creates an upstream account, issues its Codex-enabled access token, and supplies that token to an
associated dedicated Codex Agent. OCC owns only its provider-agnostic, Namespace-scoped account. The
Driver privately owns upstream identities and credential lifecycle; an injected `ChatGPTClient` owns
provider transport and admin authentication; Kubernetes Compute stores and installs the issued token.

Update the authoritative [platform design](../../docs/design.md) to replace `ResourceDriver` entirely with
`ServiceAccountDriver`. Explicitly supersede the historical [native-account specification](10-native-service-accounts.md)
where it defers provider Drivers, assigns provider operations to `ResourceDriver`, or prohibits Compute
Secret access. Keep the historical specification unchanged.

## Scope

**Accepted:** selectable `service_account` Driver capability; concrete ChatGPT implementation and shared
provider client; mounted admin credential; durable driver-private account/credential bindings;
provider-agnostic OCC accounts; separate account-creation and credential-creation operations;
Compute-owned Kubernetes Secret storage and installation; dedicated Codex access-token login; and one
real, provider-backed Agent turn.

**Preserved:** existing native accounts, manually associated API-key references, embedded OpenClaw API-key
execution, OCC authorization, Namespace isolation, immutable revisions, and operator-owned transport
Secrets.

**Deferred:** OAuth refresh and execution; access-token execution through embedded OpenClaw; credential
rotation and automated reconciliation; Namespace-to-workspace mapping; plugin/permission Drivers; other
providers; and general-purpose resource, client, credential-materializer, or Harness frameworks.

## Contract

See [Contract](11-service-account-driver/contract.md#contract).

## Implementation

1. Amend the authoritative [platform design](../../docs/design.md): remove every `ResourceDriver` reference;
   add `ServiceAccountDriver`, shared provider-client dependency, distinct OCC/provider account ownership,
   the approved Compute Secret boundary, dedicated Codex access-token execution, and exact tenant risks.
   Update the current [security model](../../docs/reference/security.md), [service-account guide](../../docs/reference/service-accounts.md),
   and [Kubernetes Compute guide](../../docs/reference/drivers/kubernetes-compute.md) in the same implementation.
2. Add the generic Driver contract, generic `access_token` credential and closed response schemas,
   separate credential route, provider-free immutable revision snapshot, and generated OpenAPI in
   [shared contracts](../../packages/contracts/src/index.ts), [API routes](../../packages/contracts/src/api/routes.ts),
   [request schemas](../../packages/contracts/src/api/common.ts), and
   [response schemas](../../packages/contracts/src/api/resources.ts). Update the real Fastify dispatcher and
   account serializer in the [controller](../../apps/controller/src/index.ts); implement exact OCC
   authorization, selected Driver dispatch, outer-transaction compensation, and deployment admission in
   [OCC](../../packages/occ/src/index.ts).
3. Add a new `migrations/0009_*.sql` and update [PostgreSQL schema/state](../../packages/occ/src/state/postgres-schema.ts)
   for generic credential variants, exact Namespace ownership, provider-free revision snapshots, and a
   separate driver-owned binding table containing durable upstream account, credential, Driver, and
   workspace identities. Bind each row to its exact OCC account/Namespace; share the existing outer
   transaction. Do not alter the already shipped [0007 migration](../../migrations/0007_native_service_accounts.sql).
4. Add `ChatGPTClient` and `ChatGPTServiceAccountDriver` with private persisted bindings; extend shared
   [Installation configuration](../../apps/controller/src/composition/installation-config.ts) with optional
   Driver selection, fixed ChatGPT endpoint, bounded TTL, and closed configuration validation. Initialize
   the client only in the existing [API entrypoint](../../apps/controller/src/server.mjs), and construct its
   Driver after API composition creates the existing PostgreSQL state and controller; leave the
   [worker entrypoint](../../apps/controller/src/worker.mjs) free of provider initialization and avoid a
   process-role configuration switch.
5. Extend [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts) for exact-account
   Secret creation and direct revision-driven access-token/workspace `secretKeyRef` projection; select
   API-key versus generic access-token login in
   [runtime entrypoints](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts).
6. Update production [deployment mounts](../../deploy/helm/openclaw-enterprise/templates/deployments.yaml),
   [tenant RBAC](../../deploy/helm/openclaw-enterprise/templates/rbac.yaml), and
   [NetworkPolicies](../../deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml). Replace existing
   assertions that prohibit all Compute Secret access with exact Namespace-limited API authorization;
   preserve existing worker/workload Secret-denial assertions.

## Verification

Extend the existing real [dedicated-Harness Kubernetes integration](../../tests/integration/harness-topology-k3d-real.test.mjs)
using actual OCC HTTP routes, PostgreSQL, selected Drivers, tenant RoleBindings, Kubernetes, approved
OpenClaw/Codex images, an authorized real ChatGPT workspace admin key, and the real ChatGPT Admin API:

1. Create a fresh OCC ServiceAccount; verify its provider-free public `sa_*` identity and inspect the
   Driver's private persisted binding for the distinct real upstream account and configured workspace.
2. Invoke the separate credential-creation route; verify `201`, a real provider credential with exactly
   the Codex access scope and bounded TTL, its provider credential ID durably persisted only in the
   private binding, a public generic `access_token`/`secretRef`, and one account-owned Secret containing
   token/workspace keys in the exact tenant namespace. Never print the token or admin key.
3. Associate that exact account with a dedicated Codex Agent and deploy. Verify its immutable,
   provider-free account/credential snapshot; the Codex Pod projects both access-token/workspace keys
   directly from exactly the account-owned Secret; only that Pod receives `CODEX_ACCESS_TOKEN`; no
   ambient `OPENAI_API_KEY` authenticates the token scenario; its separate gateway receives neither token
   nor admin key; Codex pins the exact provider workspace; and the authenticated app-server returns a
   fresh scenario-specific nonce from one actual provider-backed model turn. Delete the disposable
   provider account and Kubernetes resources.

Cover remaining boundaries in focused existing suites: closed provider-free HTTP contracts and exact
account IAM; cross-Namespace/sibling denial; API-only client initialization without role switches;
immutable driver-private upstream account/workspace identity and durable credential IDs; missing Secret,
unsupported OAuth/embedded token, excessive TTL, duplicate credentials, and no token/provider-identity
disclosure; compensation after storage, audit, persistence, and commit failures; and unchanged native
API-key dedicated/embedded execution. The real tenant-RBAC integration verifies API-only direct tenant
Secret permission and worker/workload denial of direct Secret API access using separate actual API/worker
identities and scoped kubeconfigs; one shared identity cannot prove this isolation. It does not claim to
prevent a trusted worker from projecting tenant Secrets through its existing Deployment authority. The separate
[production Helm packaging test](../../tests/integration/production-kubernetes-packaging.test.mjs) verifies
the API-only admin Secret mount and provider-egress policy; rendered-chart assertions are not live Helm
deployment or NetworkPolicy-enforcement evidence.

Missing live provider authorization, actual provider account/credential creation, tenant-scoped Secret
proof, or the genuine Codex model response is an integration blocker, not successful verification.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:10]: Removed private source hyperlinks without changing the historical implementation specification. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- [2026-08-24 22:10]: Defined selected ChatGPT ServiceAccountDriver, reusable provider client, immutable provider-linked OCC accounts, separate token issuance, approved tenant-bound Compute Secret ownership, dedicated Codex access-token execution, and real provider-backed acceptance. (01a03542-30ff-77a1-9967-587d55548ace - c11ba6418d06)
- [2026-08-24 22:20]: Simplified execution to one account-owned Secret and shared concrete client; retained durable provider credential IDs; added explicit token lifetime, API-only composition, complete HTTP wiring, outer-transaction compensation, and accurately separated runtime versus Helm verification. (01a03542-30ff-77a1-9967-587d55548ace - c11ba6418d06)
- [2026-08-24 23:05]: Encapsulated upstream account, credential, and workspace identity in durable driver-private bindings; made OCC accounts/revisions and access tokens provider-agnostic; projected workspace alongside the token; and initialized the concrete ChatGPT client/Driver only from the existing API entrypoint without a role switch. (01a03542-30ff-77a1-9967-587d55548ace - c11ba6418d06)
- [2026-08-25 00:27]: Removed the unused public credential-deletion operation and separate binding-store abstraction; retained durable private identities and account-owned credential cleanup. (01a03542-30ff-77a1-9967-587d55548ace - 96a841f)
