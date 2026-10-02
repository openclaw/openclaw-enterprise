# Feature Spec: Asynchronous Agent provisioning

**Date:** 2026-09-22\
**Status:** Implemented in PR #322.\
**Owner:** OCC resource lifecycle and controller worker

## Problem and Decision

Console saves namespace Secrets through the existing Secrets API, then submits their references with inline Configuration to `POST /namespaces/:namespaceId/agents/provision`. OpenClaw Control Plane (OCC) validates the request and queues setup work. The worker creates the Configuration, creates the Agent and its permissions, provisions trusted-proxy runtime credentials, and submits its first deployment through normal deployment admission.

Admission returns a job handle before an Agent exists. Provisioning succeeds when it submits the initial deployment; existing revision status owns activation and runtime failures. Subsequent deployments use the regular Deploy API.

## Scope

- First-time Kubernetes Dedicated Codex Agents, inline Configuration, ordinary same-Namespace Secret references, existing model-auth/provider/plugin/repository/workspace options, durable setup progress, safe retries and request deduplication.
- Console reuses the channel setup Secret select/create modal to save Slack tokens before Agent creation. API-key model authentication uses an existing Secret reference. Create Agent submits the resulting inline Configuration and references.
- Secret creation, secret-value custody, Slack-specific setup, automatic rollback/cleanup, cluster setup, migrations of existing Agents, credential rotation, new IAM delegation, and live integration messages are outside provisioning.

## Contract

### Secrets and requests

The provisioning body includes a stable client `requestId`, Agent inputs and `configuration: { kind: "agent", values, secretBindings? }`. Bindings and model authentication use the existing ordinary Secret reference types. The API rejects `secrets`, request-local `provisioning-secret` references, existing Agent/Configuration IDs, cross-Namespace references and conflicting trusted-proxy settings. No provisioning encryption key or protected-input staging is required.

The channel setup Secret modal saves immediately and clears entered values after each attempt; applying channel settings retains the returned references in the form. Saving Secrets is a separate, non-atomic operation: if a later save or provisioning fails, successfully saved namespace Secrets remain available. A retry reuses their references rather than recreating them. An uncertain Secrets API response is surfaced for recovery rather than blindly resubmitted. Provisioning never deletes namespace Secrets.

### Admission and status

Admission validates a ready Namespace, supported Kubernetes Dedicated Codex capabilities, the inline Configuration and exact-resource authority. It stores the accepted non-secret request in the existing durable provisioning record and enqueues the existing controller work queue without creating an Agent or Configuration. Request identity is scoped to Namespace and initiating actor. An identical request returns the same work; changed input under the same `requestId` conflicts. Replays and explicit retries require current authorization.

`POST .../agents/provision` returns `202` with `data.provisioning`. It contains `workId`, `status`, `phase`, `attemptCount`, `updatedAt`, and a status `url`; `configurationId`, `agentId`, and `revisionId` appear as those results become available. Public status contains only identifiers, progress and safe errors, never accepted input values or backend credentials.

Status is read through `GET /namespaces/:namespaceId/agents/provision/:workId`. Bodyless `POST /namespaces/:namespaceId/agents/provision/:workId/retry` returns `202` for a retry of the unchanged accepted request. Only the initiating actor can read provisioning status or retry the job, with current authorization required at every stage. There is no separate job-cancellation API. Console watches this status during creation, then uses the existing Agent/deployment view for the exact returned revision.

### Worker and lifecycle

The worker uses the existing queue claim and runs in order:

1. Create the ordinary Configuration from the accepted inline values and existing Secret bindings.
2. Create the stopped Agent and save its existing auth/provider/plugin/repository/workspace choices; grant its service principal the exact accepted Secret permissions using existing IAM operations.
3. Provision runtime credentials through the selected Compute Driver in trusted-proxy mode.
4. Admit one initial revision through ordinary deployment and record its ID. Revision reconciliation owns startup, workspace initialization and activation.

Completed resource IDs and the accepted request are retained for retries and support recovery. Each step rechecks its current claim, Namespace readiness and required authority before committing or dispatching effects. A completed step is reused rather than recreated. A failed step can be retried when its outcome is known; an uncertain external write is retained as unresolved and must be resolved before replay. Minimal effect ownership records prevent duplicate dispatch and stale workers from publishing a deployment. Provisioning does not automatically roll back or clean up partial resources.

After Agent creation and before handoff, minimal initialization guards prevent competing configuration edits, Agent edits, runtime-credential mutation and manual deploy. Stop/Delete invalidate provisioning so later workers cannot restart the Agent. Ordinary resource deletion retains its existing credential/lifecycle safety; unresolved in-flight effects cannot be forgotten or used to recreate a deleted resource. Namespace Secrets and completed Configurations remain ordinary resources with their existing explicit management APIs.

### Trusted proxy and security

The Kubernetes Compute Driver owns gateway auth configuration, operator trust CIDRs and generated runtime credentials. Provisioning accepts no gateway token, trust-range override or auth-mode switch. Preserve the trusted-proxy contract: fixed `x-occ-identity`, `occ-workspace-files` identity/scopes, validated operator CIDRs, fail-closed access and no token/password fallback. Existing protection of generated runtime credentials remains unchanged.

The operator provides a ready Namespace and existing compatible runtime images, Gateway/Envoy/certificates, trusted proxy source, NetworkPolicy, RBAC and CA/key mounts. Provisioning does not install shared infrastructure. Slack uses ordinary configuration settings and Secret bindings; it has no provisioning branch.

## Implementation

1. Remove provisioning-only Secret input types, encrypted staging/key configuration, decryption, Secret creation, secret progress and staged-value cleanup from API, worker, persistence and packaging.
2. Make provisioning queue records Namespace-scoped at admission; create Configuration and Agent in the worker. Retain the existing queue, request deduplication, completed outputs, safe retry and minimal lifecycle fencing.
3. Reuse Console channel Secret saving, retain references through failures, poll the job before Agent creation, then use ordinary deployment status. Preserve ordinary-create Secret grants and recovery; add no duplicate credential-entry form.
4. Update API schemas/examples, current references, operator guidance and the [implementation flow](../../docs/flows/agent-provisioning.md). Remove obsolete recovery/staging tests and replace them with outcome-focused coverage.

## Verification

- API/worker integration: saved references and inline values are accepted; secret values/local references are rejected; paused-worker admission creates only one deduplicated job and no Agent/Configuration. Changed requests and cross-Namespace references fail.
- PostgreSQL integration: worker creates one Configuration/Agent/revision; retries reuse completed resources, revoke stale authority, preserve ambiguous-effect evidence, and cannot resurrect stopped/deleted Agents. Migration compatibility retains ordinary deletion invariants.
- Console browser: channel setup saves Secrets before Create Agent; successful saves survive cancellation and later failures; provisioning retries reuse references and request identity; progress switches to the exact ordinary deployment view. Ordinary-create grant failures retain the saved Agent.
- Kubernetes fixture: the supported API/worker path hands off to the real trusted-proxy Compute Driver, with no gateway-token projection. This is fixture proof, not native enrollment, a real model turn or a Slack message.
- Repository checks: type/build/workspace/format, generated OpenAPI and docs checks pass; stale provisioning-key and secret-staging configuration has no callers.

## Manual Notes

## Changelog

- 2026-09-23 11:20: Reused PR #323 channel Secret setup and retained ordinary-create grants without duplicate credential inputs. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:06: Approved separate Console Secret saving, job-first creation, retained safe retries and removal of provisioning staging and automatic rollback. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 3e55be4b)

- 2026-09-23 02:23: Recorded implementation completion, current documentation owners, and local verification limits. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - a20f0b07)
- 2026-09-23 00:51: Restored concise public status, retry, exact-create recovery, phase generation, external-effect, unknown-write, and trusted-proxy identity details from the accepted spec. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:45: Tightened the accepted provisioning contract under the repository word limit while preserving custody, trusted-proxy, lifecycle, and verification requirements. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-22: Selected a new-Agent create-and-provision API. Later deployments use the regular Deploy API.
- 2026-09-22: Required inline Configuration and generic Secret inputs in the provisioning request. Request-local Secret references resolve to committed Secret IDs; Slack stays Configuration-driven.
- 2026-09-22: Made Kubernetes provisioning trusted-proxy-only on the PR #314 contract and retained runtime credential provisioning without gateway-token fallback.
- 2026-09-22: Simplified worker ordering: create Secrets first, finalize Native IAM grants and Configuration metadata in one database checkpoint, materialize the Configuration once at the finalized generation, then hand off one exact deployment revision.
