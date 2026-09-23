# Feature Spec: Asynchronous Agent provisioning

**Date:** 2026-09-22\
**Status:** Implemented; local integration verified, pending PR review. PR #314 trusted-proxy contract merged into main at `a870a0bd`.\
**Owner:** OCC resource lifecycle and controller worker

Current behavior is documented in the [API reference](../docs/reference/api.md), [Console workflow](../docs/reference/console/create-and-deploy.md), and [implementation flow](../docs/flows/agent-provisioning.md). PostgreSQL, browser, and disposable Kubernetes fixture checks cover admission, recovery, cancellation, resource creation, and revision activation. Native enrollment, a real model turn, and a Slack reply remain separate unrun runtime proofs.

## Problem and Decision

Expose `POST /namespaces/:namespaceId/agents/provision` as the single first-time provisioning API for new Kubernetes Dedicated Codex Agents. The request contains the Agent inputs, inline Configuration, optional new Secret values, existing same-Namespace Secret references, and a stable client `requestId`. OpenClaw Control Plane (OCC) admits one stopped Agent, reserves its Configuration identity, protects submitted Secret values, and queues durable provisioning work. A worker then creates requested Secrets, finalizes model auth, Configuration metadata, exact Native IAM grants, Configuration materialization, runtime credentials, and the first deployment handoff.

Subsequent deployments use the regular exact-Agent Deploy API. Provisioning does not accept an existing Agent or Configuration ID. Other execution modes keep the ordinary create workflow unless they explicitly become provisionable. Console uses this API only for supported first-time provisioning; ordinary create still saves Configuration first and then creates a draft Agent.

“Commit progress” means a database transaction. Checkpoints record verified results, and lost Driver responses never justify blindly repeating effects. Console reports Provisioned only after successful activation of the exact admitted revision; model behavior, Slack replies, and other integrations require separate proof.

## Scope

- In scope: first-time Kubernetes Dedicated Codex provisioning, trusted-proxy gateway authentication, generic Secret inputs, existing Secret references, supported model auth, durable enqueue, ordered checkpoints, restart recovery, bounded retry, exact revision handoff, Console progress/failure/retry, and initial workspace-file setup before runtime execution.
- Out of scope: Slack app installation, ServiceAccount issuance, model-account funding, cluster/Helm/DNS/TLS setup, existing-Agent migration, credential rotation, new IAM delegation policy, a generic workflow engine, automatic test messages, live tenant changes, or compatibility for obsolete gateway-token work shapes.
- Slack is a reference workflow. It uses existing Configuration channel settings and ordinary Secret bindings; Slack credentials, connectivity, and real-message proof remain runtime acceptance, not provisioning admission.

## Contract

### Inputs and admission

The API body includes `name`, provisionable execution mode, optional provider/plugin/repository/workspace inputs, `configuration: { kind: "agent", values, secretBindings? }`, optional `secrets: [{ name, value }]`, and optional `harnessAuth`. It rejects `agentId`, `configurationId`, top-level `secretBindings`, duplicate local Secret names or destinations, unused local Secrets, missing local references, cross-Namespace references, invalid protected inputs, and conflicting trusted-proxy settings. Request-local Secret sources use `{ kind: "provisioning-secret", name }` and resolve only within this request's unique `secrets` entries, never by stored Secret name. Persisted Agent and Configuration records contain only ordinary Secret references. Existing `POST .../agents` stays create-only with `201`.

Admission authorizes every requested operation, validates a ready Namespace and configured provisioning capabilities, reserves generation-1 Configuration metadata, creates the stopped Agent and service principal, saves workspace setup, encrypts Secret values, records reserved Secret IDs and immutable accepted inputs, queues `controller_work` with `work_kind = 'provisioning'`, and appends safe audit. The accepted `requestId` is unique per Namespace and actor. Reauthorized identical retries return the same Agent/work; changed payloads, including Secret values, conflict. Idempotency compares a private keyed fingerprint of the canonical request and retains its key version for the request-record lifetime.

Provision returns `202` with `data.agent` and `data.provisioning`. Public provisioning reads use exact-Agent `GET /namespaces/:namespaceId/agents/:agentId/provisioning`; explicit retry uses bodyless `POST /namespaces/:namespaceId/agents/:agentId/provisioning/retry` and returns `202`. Status exposes only `status`, `phase`, `attemptCount`, `updatedAt`, `url`, optional `revisionId`, and optional safe `{ code, message }` error. Setup success means handoff and includes the revision ID; Console then follows existing deployment status until exact revision activation.

API and worker must mount an operator-provisioned versioned provisioning-input keyring at `OCC_PROVISIONING_KEYS_PATH`. The keyring has a `primaryKeyId` and retained keys; missing key support rejects admission, and unavailable retained keys stop recovery safely. Secret values use authenticated encryption bound to Installation, Namespace, Agent, work ID, and input slot. This custody is temporary workflow storage, not a public Secret store. Plaintext exists only during admission or the authorized Driver call and must not appear in queue payloads/results, responses, logs, traces, audit, or generic errors.

### Worker ordering

Each work claim fences the Namespace and Agent, reauthorizes the initiating actor, confirms selected Driver IDs, and requires the Agent to remain active and pre-revision before external effects. The worker creates submitted Secrets first, using stable reserved IDs and a cursor checkpoint. It commits the exact backend target intent before the Driver call, creates outside the checkpoint transaction, and verifies exact ownership and accepted input on recovery. Exact create conflicts on mismatch and never overwrites, rotates, adopts by name, or changes accepted values on retry. After each committed Secret, the corresponding protected input is removed; failed work retains only pending inputs needed for authorized retry or exact cleanup.

The database setup checkpoint resolves request-local sources, revalidates existing Secret and ServiceAccount references, grants the Agent service principal exact `secret:operate` access for accepted model auth and final Configuration bindings, updates Agent auth/provider/plugin/repository choices, and finalizes Configuration metadata in one OCC transaction. If bindings exist, OCC advances the Configuration generation and records them; otherwise generation 1 remains final.

After setup, the worker materializes the Configuration backend exactly once at the finalized generation. Generation 2 is used when bindings were resolved; generation 1 is used when none were submitted. Configuration materialization and transport are separate external effects, not atomic with PostgreSQL, so workers must not hold a database transaction while waiting for Drivers or readiness. Ambiguous results are resolved by inspecting the exact target for expected Namespace, ID, kind, generation, creation time, and inline values. Handoff calls normal OCC deployment admission for one exact first revision, records the returned revision ID, enqueues ordinary revision work, and marks provisioning succeeded in the same transaction. The claim is released before revision work waits; revision reconciliation owns gateway startup, workspace initialization, activation, Stop, redeploy, and rollback.

### Trusted-proxy and operator prerequisites

Provisioning supports only the Kubernetes trusted-proxy gateway contract merged from PR #314 into main at `a870a0bd`. Console and provisioning inputs do not select gateway auth mode, set trust ranges, or provide gateway tokens. The Kubernetes Compute Driver derives `gateway.trustedProxies` from operator-owned `network.gatewayTrustedProxyCidrs`, sets trusted-proxy auth with `x-occ-identity` and the fixed `occ-workspace-files` identity/scopes, permits no `allowLoopback: true`, and rejects token/password-mode fields, missing or invalid source CIDRs, unrestricted CIDRs, and identity conflicts before Agent/work admission when they are visible at admission.

The operator must provide a ready Namespace, compatible immutable runtime images, Gateway/Envoy/certificates, trusted proxy source, enforced NetworkPolicy, API/worker RBAC, CA/key mounts, and the versioned provisioning-input keyring. Provisioning validates configured capabilities but does not install, repair, or migrate shared infrastructure. Runtime failures still fail closed in worker status.

### Lifecycle, retry, and cleanup

Before Configuration materialization, reads that require the Configuration report an explicit not-materialized conflict. Ordinary Agent edits, Configuration edits/deletion/sharing, runtime credential mutation, and manual Deploy are blocked while they would invalidate accepted provisioning work. Agent reads, Stop, and Delete remain available.

`recordFailure` stores safe errors and either retries queued work or marks it failed after retry exhaustion. Explicit retry is allowed only for the initiating actor before handoff, after fresh authorization and lifecycle checks, and without changing the accepted plan. Duplicate retry on already pending work returns current status without resetting attempts or admitting another execution. After handoff, revision reconciliation owns retry/remedy. Stop records terminal `PROVISIONING_CANCELLED`, and retry cannot clear it. Delete keeps provisioning metadata until every recorded in-flight or unknown external effect is resolved, quiesced, or cleaned by exact identity; one not-found response is not quiescence proof. Committed Namespace Secrets and materialized Configurations remain ordinary resources; unmaterialized reservations are removed only after the Agent/work can be safely removed.

## Implementation

1. Add the route, contracts, OpenAPI surface, PostgreSQL schema, work queue type, provisioning record repository, protected-input custody, and OCC admission operation. Keep ordinary `POST .../agents` create-only for non-provisionable paths.
2. Add worker dispatch for provisioning. Implement stable Secret creation/recovery, database setup, Configuration materialization, runtime credential provisioning, handoff, cancellation, retry, and unknown-effect cleanup through claim-fenced checkpoints.
3. Update Console create so supported first-time provisioning submits one inline request, clears masked values after admission acknowledgement, shows queued/running/failed/succeeded progress, and retries only the same request ID and in-memory payload after uncertain admission. Preserve Preset rendering as draft preparation and keep initial workspace files in the provisioning request.
4. Update current API, Console, deployment, worker-flow, and trusted-proxy docs without adding compatibility paths for obsolete gateway-token state.

## Verification

- Admission: unsupported modes use ordinary create; supported Dedicated create returns `202`, creates one stopped Agent/work, reserves Configuration metadata, performs no Driver effects while the worker is paused, and replays identical lost responses without duplicating work.
- Inputs: inline Configuration values survive unchanged; request-local and existing Secret references resolve to exact ordinary Secret IDs; duplicate, unused, missing, cross-Namespace, invalid binding, and changed-idempotency inputs are rejected.
- Recovery: worker restarts before/after every external effect resume with the same Agent, Secret, Configuration, cursor, grants, generation, credentials, and revision; exact-create mismatch conflicts, no overwrite/adopt-by-name occurs, and unknown Secret/Configuration outcomes quiesce before cleanup.
- Authority and custody: revoked authority prevents later effects; retry requires fresh authority; no plaintext Secret values or ciphertext appear in public responses, audit, logs, traces, or generic queue payloads; keyed fingerprint and retained key-version behavior is exercised.
- Lifecycle: Stop/Delete cannot resurrect an Agent, manual Deploy/edit paths are blocked before safe materialization, nonempty Namespace deletion stays rejected, and terminal revision failure is handled by deployment status rather than provisioning retry.
- Trusted proxy: omitted auth/trust settings render from operator configuration; conflicting modes, identity fields, and missing/invalid/unrestricted CIDRs fail before Agent/work admission; the runtime has no gateway-token credential or projection and uses the fixed `occ-workspace-files` trusted-proxy identity/scopes.
- Usable Agent: an authorized disposable Kubernetes proof through real Console/API, PostgreSQL, compatible gateway and Codex images activates the exact revision and verifies workspace access. Model/native-enrollment proof and any Slack example proof are recorded separately.

These are implementation acceptance checks. Spec review itself performed no provisioning.

## Settled Decisions

- Initial automatic provisioning is limited to Kubernetes Dedicated Codex.
- The workflow uses current Installation-admin IAM authority; delegated per-Namespace grant authority requires a separate design.
- Generic Secret inputs enter the provisioning API; local references resolve to ordinary Secret IDs, and existing references remain supported.
- Completion means exact deployment activation. Model and configured-integration proof are separate. Automatic real Slack proof requires separate messaging authorization and a verification channel/account contract.

## Manual Notes

## Changelog

- 2026-09-23 02:23: Recorded implementation completion, current documentation owners, and local verification limits. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - a20f0b07)
- 2026-09-23 00:51: Restored concise public status, retry, exact-create recovery, phase generation, external-effect, unknown-write, and trusted-proxy identity details from the accepted spec. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:45: Tightened the accepted provisioning contract under the repository word limit while preserving custody, trusted-proxy, lifecycle, and verification requirements. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-22: Selected a new-Agent create-and-provision API. Later deployments use the regular Deploy API.
- 2026-09-22: Required inline Configuration and generic Secret inputs in the provisioning request. Request-local Secret references resolve to committed Secret IDs; Slack stays Configuration-driven.
- 2026-09-22: Made Kubernetes provisioning trusted-proxy-only on the PR #314 contract and retained runtime credential provisioning without gateway-token fallback.
- 2026-09-22: Simplified worker ordering: create Secrets first, finalize Native IAM grants and Configuration metadata in one database checkpoint, materialize the Configuration once at the finalized generation, then hand off one exact deployment revision.
