# Feature Spec: SecretDriver storage and delivery

**Date:** 2026-08-28
**Status:** Implemented and verified for Namespace-owned Secret storage and delivery. Broader runtime limits are recorded below.

**Current reference:** [Kubernetes Secret Driver](../../docs/reference/drivers/kubernetes-secret.md).
**Owner:** OCC, KubernetesSecretDriver, Kubernetes ComputeDriver, and Installation operator

## Problem and Decision

Add the singular **SecretDriver**, capability `secret`, with **KubernetesSecretDriver** as the default Installation-selected implementation. It stores Namespace-owned secret material before any Agent exists. Kubernetes delivers the value only to an explicitly selected Agent gateway environment, and OpenClaw resolves native SecretRefs from that environment.

Each Secret belongs to **exactly one Namespace**. Same-Namespace Agents may consume it only through explicit Configuration binding and Agent assignment checks; cross-Namespace use is unsupported. Namespace membership, Configuration access, Agent access, or possession of a reference never grants Secret consumption. The Secret reference stays stable when its value is updated. Each affected Agent must be explicitly redeployed or restarted to consume the latest value; secret updates do not automatically restart workloads.

## Scope

**Changes:** protected secret create/update, metadata-only read, and delete; Namespace-owned Secret storage with Namespace-unique names; source/delivery bindings in Configuration and immutable AgentRevision; exact Agent workload delivery targeting; real Kubernetes bootstrap-to-Agent-turn proof.

**Preserves:** Kubernetes-first placement, Installation-selected Drivers, immutable revision documents, existing ServiceAccount issuance/storage, dedicated Codex credential placement, and the API-only mounted `adminKeyPath` consumer.

**Deferred:** cross-Namespace secrets, value-version history, automatic rotation/restart, durable mutation replay, adoption of existing Secrets, additional storage backends, public reveal/list APIs, new grant APIs, credential issuance/revocation, SecretBroker services, CredentialGateway/OpenShell substitution implementation, generic source registries, arbitrary text replacement, and non-Kubernetes compute.

**Architecture handoff:** the repository [platform design](../../docs/design/safeguards.md#secret-access) is the current implementation design and records this approved env-delivery amendment. This same PR updates it from exact-Agent to Namespace-owned Secrets. Project-root `ref/design.md` remains the external broker-target owner handoff outside this worktree's write scope; it does not reopen the accepted storage/env decision.

## Contract

### Storage, owner, and bootstrap

See [Storage, owner, and bootstrap](14-secret-driver/storage-api-and-binding.md#storage-owner-and-bootstrap).

### API and per-use binding

See [API and per-use binding](14-secret-driver/storage-api-and-binding.md#api-and-per-use-binding).

### Authorization and delivery

See [Authorization and delivery](14-secret-driver/authorization-and-lifecycle.md#authorization-and-delivery).

### Update, restart, deletion, and failure

See [Update, restart, deletion, and failure](14-secret-driver/authorization-and-lifecycle.md#update-restart-deletion-and-failure).

## Implementation

1. Extend [resource/driver/Configuration/revision contracts](../../packages/contracts/src/index.ts), [API schemas](../../packages/contracts/src/api/resources.ts), [routes](../../packages/contracts/src/api/routes.ts), and [IAM](../../packages/iam/src/index.ts) for Namespace-owned Secret CRUD, existing `operate` authorization, and separate bindings. Keep write bodies outside generic log/audit/error serialization.
2. Extend [OCC resource, assignment, and admission checks](../../packages/occ/src/index.ts), [state repositories](../../packages/occ/src/state/platform-state.ts), [PostgreSQL constraints](../../packages/occ/src/state/postgres-schema.ts), and [revision encoding](../../packages/occ/src/state/postgres-state.ts) for Namespace-only metadata, serialized dependencies, frozen refs, and safe synchronous failures; no plaintext columns, `secret.agentId`, Agent foreign key, or generic mutation queue.
3. Add KubernetesSecretDriver using existing [Kubernetes ConfigurationDriver](../../apps/controller/src/drivers/configuration/kubernetes/index.ts) and [API-side Secret storage](../../apps/controller/src/drivers/compute/kubernetes/index.ts) as client/ownership prior art. Register through [Installation config](../../apps/controller/src/composition/installation-config.ts), [production](../../apps/controller/src/composition/production.ts), and [development composition](../../apps/controller/src/composition/development-postgres.ts); consume verified Compute placement.
4. Wire [HTTP handlers](../../apps/controller/src/index.ts), [Compute projection/redeployment](../../apps/controller/src/drivers/compute/kubernetes/index.ts), and [Helm RBAC](../../deploy/helm/openclaw-enterprise/templates/rbac.yaml). Grant the API needed tenant-local Secret verbs independently of ChatGPT integration; retain worker/workload Secret-verb denial and default-deny networking.
5. Reconcile the architecture handoff; update [Configuration](../../docs/reference/configuration.md), [settings](../../docs/reference/settings.md), [deployment guidance](../../docs/guides/deploy.md), and a short [Kubernetes Secret Driver](../../docs/reference/drivers/kubernetes-secret.md) reference linked from [the index](../../docs/README.md). Document protected input, Namespace-first bootstrap, explicit per-consumer redeploy, no value rollback, and safe cleanup; preserve account/admin-key guidance.

## Verification

1. Prove Secret creation before any Agent exists in the Namespace, Namespace-unique naming, metadata-only read/update/delete, and no `secret.agentId` or Agent foreign key in public metadata, backend identity, or PostgreSQL. Namespace membership alone must not read, update, delete, or operate the Secret.
2. Prove every Configuration create/update whose resulting Configuration contains `secretBindings` requires the normal Configuration mutation permission and `operate` on every selected Secret, including retained bindings when PATCH omits `secretBindings`. Possession of a Secret ref, Configuration read/update alone, or Namespace membership alone must fail.
3. Prove Agent create/update assignment to a bound Configuration requires the normal Agent mutation permission and `operate` on each exact Secret. Cross-Namespace refs are unsupported and fail even when both Namespaces contain matching names or IDs.
4. Extend [real Kubernetes Agent proof](../../tests/integration/harness-topology-k3d-real.test.mjs) with PostgreSQL, actual API/worker composition, and pinned OpenClaw. The deploying caller and the Agent service principal both need `operate` on every bound Secret. The authorized operator deploys an embedded Agent, completes a real provider-backed turn, then invalidates only the native provider/reference so the turn fails and restoring it succeeds. Ambient/operator model credentials cannot bypass this proof.
5. Prove explicit same-Namespace sharing through two Agent assignments that bind the same Secret. Kubernetes projects `env[].valueFrom.secretKeyRef` only into each selected gateway's authorized env destinations; Agents without an admitted binding for that Secret, dedicated model credentials, sidecars, workers, logs, audits, responses, revisions, and ConfigMaps do not receive values. Updating the shared Secret keeps the same ref, restarts no workload, and requires explicit redeploy/restart for each consumer to observe the new value.

### Current verification

On 2026-08-28, independent verification of the real Kubernetes Secret API
scenario after rebasing onto main `84e773f` passed: 1 passed, 0 failed, 0 skipped, exit 0, in
386.4s with OpenClaw 2026.8.1. It proved pre-Agent Secret creation, caller
binding denial before exact Secret grants, Agent service principal denial before
explicit Secret grant, two selected Agent model-sharing turns, private env
absence, shared sentinel `v1` to `v2` update with no automatic restart and
independent redeploy per consumer, cross-Namespace denial, missing-backend
rejection, unbound deletion, private stable-ref same-revision restart and
redeploy, native-ref startup failure followed by restoration, and no-leak
assertions.

Post-rebase focused verification also passed: conformance 134 passed with
1 optional skip, and static, API, startup, and Helm checks passed. The prior
PostgreSQL Secret-state proof remains 2 passed with 0 skipped, and post-rebase
real Compute passed 2 cases with 0 skipped. The earlier exact-Agent-owned proof
is superseded for ownership and retained only as historical storage/delivery
context.

This does not claim the broader runtime suite is green: host OpenClaw model tests
encountered stale generated assets, and the dedicated Codex file-edit scenario was
blocked by an unavailable native hook relay after its real turn and Secret-binding
denial succeeded. Those runtime repairs are outside this implementation.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-28 16:33]: Updated Namespace-owned Secret verification to the passing post-rebase Agent and Compute proofs against main 84e773f and conformance 134. (01a043fa-27fd-7651-b75a-4d46538a2809 - f7c33d5)

- [2026-08-28 15:56]: Recorded current Namespace-owned Secret verification from the parent-inspected live proof and focused suites. (01a043fa-27fd-7651-b75a-4d46538a2809 - 9214fbb56f0437b7529f4a9aaa325ae73a489453)

- [2026-08-28 14:48]: Applied accepted review fixes for retained Configuration binding authorization, repository-design handoff wording, implementation-pending status, and unselected-consumer leakage language. (01a043fa-27fd-7651-b75a-4d46538a2809 - 9214fbb56f0437b7529f4a9aaa325ae73a489453)

- [2026-08-28 14:40]: Amended the SecretDriver contract to Namespace-owned Secrets, explicit same-Namespace consumption, no `secret.agentId`, per-consumer restart, and superseded prior exact-Agent verification for ownership. (01a043fa-27fd-7651-b75a-4d46538a2809 - 9214fbb56f0437b7529f4a9aaa325ae73a489453)

- [2026-08-28 13:43]: Removed the research link after moving the reports to the project workspace; implementation decisions are unchanged. (01a043fa-27fd-7651-b75a-4d46538a2809 - 4e6162e27fd0a6790054125267dcc48db44da8d0)

- [2026-08-28 13:12]: Recorded implemented storage/delivery, current reference ownership, independently passed SecretDriver acceptance, and separate broader-runtime limits. (01a043fa-27fd-7651-b75a-4d46538a2809 - 07d8eb57a05cf4b439f1cb04816da723e4a36209)

- [2026-08-28]: Began authorized sw-loop implementation; incorporated one-pass reviews with explicit routes, metadata-only Configuration checks, admission-time backend checks, and one OCC backend-reference authority. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)

- [2026-08-28 10:17]: Applied Kevin's stable-value update plus explicit restart and no-sharing decisions; made Secrets exact-Agent-owned, clarified owner-first bootstrap and no credential rollback, and incorporated compatible IAM/metadata/synchronous-failure review corrections. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-28 09:34]: Replaced the resolver-only draft with KubernetesSecretDriver storage, scoped source/delivery bindings, immutable replacement semantics, explicit bootstrap/architecture boundaries, and real Agent acceptance; independent reviews and approval pending. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-28 09:24]: Marked the resolver-only draft superseded by Kevin's storage, default KubernetesSecretDriver, and explicit delivery requirements; linked the platform research without treating its API proposals as approved implementation scope. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-27 21:12]: Included the canonical production startup example in the implementation documentation checklist after rebasing onto origin/main; the approved design is unchanged. (01a043fa-27fd-7651-b75a-4d46538a2809 - 315b1ef5dc4c8dedc5512637f46eb947317ee61b)
- [2026-08-27 10:29]: Applied approved review simplifications: version-pinned native references, API-only file consumption, owner-derived Agent projection, gateway-owned resolution, and reference-specific live proof. (01a043fa-27fd-7651-b75a-4d46538a2809 - 1f3c8445e0da0609023b3446f35ebfcc66939afd)
- [2026-08-27 09:09]: Drafted the source-backed singular SecretDriver contract, operator-owned bootstrap boundary, native OpenClaw provider resolution, and real isolated Agent-turn acceptance. (01a043fa-27fd-7651-b75a-4d46538a2809 - 1f3c8445e0da0609023b3446f35ebfcc66939afd)
