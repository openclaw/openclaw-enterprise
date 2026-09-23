---
created: "2026-09-23"
updated: "2026-09-23"
last_updated_session: "Codex/01a0cf27-71c6-7042-8357-74d1811a2ef8"
---

# Agent provisioning flow

## Overview

Console saves new Slack token Secrets from the channel setup modal through the existing Secrets API, then sends inline Configuration and ordinary Secret references to the provisioning API. Model authentication discovers models from an entered API key or service account token, then saves the credential as a Secret before provisioning. Presets retain their existing Secret binding. OCC queues setup work without creating placeholder resources. A worker creates the Configuration and Agent, grants the Agent access to accepted Secrets, provisions trusted-proxy runtime credentials, and admits the first deployment.

This flow ends at deployment submission. The [controller worker](controller-worker.md) and [Harness execution topology](harness-execution-topology.md) own activation, runtime failures and later deployments.

## Entry Points

- Console: `apps/controller/src/console/agents/create.mjs`, with the shared Slack Secret select/create modal in `apps/controller/src/console/channels/slack.mjs`.
- API: `packages/contracts/src/api/routes.ts:provisionAgent`, `apps/controller/src/index.ts:createFastifyApp`, and `packages/occ/src/index.ts:OpenClawController.provisionAgent`.
- Preconditions: a ready Namespace, supported Dedicated runtime and selected Drivers, PostgreSQL-backed work storage, required Agent/Configuration/deploy permissions, exact Secret access and existing transactional IAM authority. No provisioning-input keyring is required.

## Flow

```mermaid
graph TD
  Console["<b>Console</b><br/>Save entered Secrets"] --> Secrets["<b>Existing Secrets API</b><br/>Return ordinary references"]
  Secrets --> API["<b>Provision API</b><br/>Inline config and references"]
  API --> Queue["<b>Existing work queue</b><br/>Return job handle"]
  Queue --> Claim["<b>Worker</b><br/>Claim and authorize"]
  Claim --> Config["<b>Create Configuration</b><br/>Record completed identity"]
  Config --> Agent["<b>Create Agent</b><br/>Grant exact Secret access"]
  Agent --> Transport["<b>Compute Driver</b><br/>Trusted-proxy credentials"]
  Transport --> Deploy["<b>Ordinary deploy</b><br/>Record first revision"]
  Deploy --> UI["<b>Agent deployment view</b><br/>Follow activation"]
  Claim -->|Failure| Failed["<b>Retain outputs</b><br/>Retry known failures"]
  Failed -->|Uncertain write| Recovery["<b>Recovery required</b><br/>Do not repeat blindly"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef condition fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class Console,Secrets,API,Queue state
  class Claim,Config,Agent,Transport,Deploy,UI operation
  class Failed,Recovery condition
```

## Execution Trace

### 1. Console saves credentials and freezes a provisioning request

`apps/controller/src/console/agents/create.mjs:renderCreateAgent`

The Slack channel setup modal sends each new token to ordinary `POST /namespaces/:namespaceId/secrets` immediately, before an Agent exists. It clears entered values after the save attempt. Applying channel settings stages the returned references and environment bindings in the form. Cancelling the drawer discards its selections but retains created namespace Secrets. Model discovery uses the entered API key or service account token without saving it. Create Agent saves that credential as an ordinary Namespace Secret, clears the input, and reuses its returned reference for provisioning retries. Bound Presets retain their credential and provider. A lost Secret-save response needs recovery rather than automatic repetition.

Create Agent sends the parsed inline Configuration, ordinary Secret bindings, model-auth references, supported Agent options and a stable request ID. The provisioning worker owns exact Secret grants; Slack has no special worker path. After an uncertain admission response, the Console resends the same request ID and accepted inputs, without resaving acknowledged Secrets.

On ordinary draft creation paths, Console creates the Configuration and Agent, then grants access to the selected Slack Secrets. A grant failure retains the saved Agent and offers Retry credential access on that Agent, without repeating creation.

### 2. OCC admits one job

`packages/occ/src/index.ts:OpenClawController.provisionAgent`

OCC validates the accepted Configuration, references, workspace inputs, supported execution mode and current authority. It stores the accepted request and its deduplication fingerprint in `agent_provisioning_work`, then enqueues `controller_work` with `work_kind = 'provisioning'`. Agent and Configuration creation happen later. Identical actor/Namespace/request IDs return the same work; changed input conflicts.

The `202` response contains `data.provisioning`, with the work ID and status URL. Public progress exposes result IDs and safe errors without input values or backend credentials.

### 3. The worker creates resources and credentials

`packages/occ/src/index.ts:OpenClawController.processAgentProvisioning`

The existing worker dispatches the job under its queue claim. Before effects and result commits, OCC verifies current ownership, Namespace readiness and exact authority. Completed outputs are reused on retry. Configuration creation uses the accepted inline values and existing bindings. Once that Configuration exists, OCC creates a stopped Agent, persists its auth/provider/plugin/repository/workspace selections and grants its service principal exact Secret permissions.

The Compute Driver prepares runtime credentials through the existing credential path, without a loopback HTTP call. The Kubernetes Driver owns trusted-proxy configuration and generated credential protection; provisioning carries no gateway token or trust override.

### 4. Deployment becomes the lifecycle owner

`packages/occ/src/index.ts:OpenClawController.deployAgent`

The job admits one first revision and records its ID. Provisioning reports success at this handoff. Console then follows deployment status until activation and opens Workspace files for the returned Agent and revision. Ordinary revision reconciliation owns startup, activation and runtime failure. Later deployments use the regular Deploy API.

### 5. Failures preserve useful outputs

`packages/occ/src/state/postgres-state.ts:provisioning`

Safe failed steps can retry under a fresh claim and authorization check. Completed resources are retained and reused. An unresolved external write keeps its exact target and ownership evidence; lease expiry or a not-found response alone does not justify dispatching it again. No provisioning rollback or Secret deletion runs.

While initialization owns an Agent, conflicting edits and manual deployment are guarded. Stop/Delete invalidate provisioning, and stale workers cannot hand off a deployment afterward. Ordinary deletion retains its lifecycle and in-flight credential safety. Namespace Secrets and completed Configurations remain available through their existing resource APIs.

## Debugging and Verification

- Follow the returned `data.provisioning.url` or read `GET /namespaces/:namespaceId/agents/provision/:workId`. Failed work reports a safe error. Explicit retry uses the same URL plus `/retry` and an empty body.
- Inspect `worker.completed`, `worker.error` and the `agent_provisioning` work metric. PostgreSQL job state lives in `occ.controller_work` and `occ.agent_provisioning_work`.
- Use `tests/integration/postgres-agent-provisioning.test.mjs` for persisted admission, deduplication, safe retry, retained outputs and authorization behavior.
- Use Console browser coverage for channel Secret creation before provisioning, reference reuse after failure and job-to-deployment navigation. The disposable Kubernetes fixture proves actual Driver handoff, not native enrollment, model execution or Slack replies.

## Related docs

- [Console creation and API example](../reference/console/create-and-deploy.md)
- [Controller worker and durable reconciliation](controller-worker.md)
- [Configuration Driver flow](configuration-driver.md)
- [Secret storage and delivery](secret-storage-and-delivery.md)
- [Workspace files](workspace-files.md)
- [Asynchronous Agent provisioning spec](../../specs/35-agent-provisioning.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-23 21:00: Integrate provider model discovery and saved API-key/PAT references with canonical Dedicated provisioning and deployment activation. (Codex/01a0cf27-71c6-7042-8357-74d1811a2ef8 - fb711b49)

- 2026-09-23 11:20: Reused the channel setup Secret modal and preserved ordinary-create grant recovery when rebasing onto PR #323. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:37: Simplified Secret saving, delayed resource creation, retry ownership and deployment handoff. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 01331ac4)

- 2026-09-23 02:43: Restored existing repository-session deletion safeguards alongside the provisioning cleanup guard. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 1e4936f0)
- 2026-09-23 02:20: Clarified pre-handoff mutation reservations, retained failed-work receipts, and cancellation-owned cleanup. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - a20f0b07)
- 2026-09-23 01:25: Corrected provisioning effect recovery to use inspect-first recovery and clarified terminal cleanup ownership. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 5886094b)
- 2026-09-23 00:51: Restored concrete status, exact-create recovery, generation, external-effect, retry, and cleanup details from the accepted spec. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:45: Clarified Console first-time provisioning, ordinary create separation, and versioned provisioning keyring prerequisites. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:22: Added the source-backed Agent provisioning flow. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
