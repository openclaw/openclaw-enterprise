---
created: "2026-09-23"
updated: 2026-10-25
last_updated_session: fix-postland-1025b
---

# Agent provisioning flow

## Overview

Console saves Slack and model Secrets, submits inline Configuration and credential references, and retains Preset bindings. OCC queues setup without placeholder resources. The worker creates Configuration and Agent, grants exact Secret or source access, provisions trusted-proxy credentials, and admits the first deployment.

The original provisioning handle follows the first deployment to activation or failure. The [controller worker](controller-worker.md) and [Harness execution topology](harness-execution-topology.md) own runtime reconciliation; later deployments use separate handles.

## Entry Points

- Console: `apps/controller/src/console/agents/create.mts`, with the shared Slack Secret select/create modal in `apps/controller/src/console/channels/slack.mjs`.
- API: `packages/contracts/src/api/routes.ts:provisionAgent`, `apps/controller/src/http/agents.ts:createAgentHandlers`, and `packages/occ/src/index.ts:OpenClawController.provisionAgent`.
- Preconditions: a ready Namespace, Dedicated runtime and selected Drivers, PostgreSQL-backed work storage, required Agent/Configuration/deploy permissions, exact Secret access and existing transactional IAM authority. No provisioning-input keyring is required.

## Flow

```mermaid
graph TD
  Console["<b>Console</b><br/>Save entered Secrets"] --> Secrets["<b>Existing Secrets API</b><br/>Return ordinary references"]
  Secrets --> API["<b>Provision API</b><br/>Inline config and references"]
  API --> Queue["<b>Existing work queue</b><br/>Return job handle"]
  Queue --> Claim["<b>Worker</b><br/>Claim and authorize"]
  Claim --> Config["<b>Create Configuration</b><br/>Record completed identity"]
  Config --> Agent["<b>Create Agent</b><br/>Grant exact credential access"]
  Agent --> Transport["<b>Compute Driver</b><br/>Trusted-proxy credentials"]
  Transport --> Deploy["<b>Ordinary deploy</b><br/>Record first version"]
  Deploy --> Observe["<b>Same provisioning handle</b><br/>Observe saved version"]
  Observe -->|Pending| Observe
  Observe -->|Activated| UI["<b>Agent deployment view</b><br/>Open existing version"]
  Observe -->|Failed| Terminal["<b>Creation failed</b><br/>Keep Agent and version"]
  Claim -->|Failure| Failed["<b>Retain outputs</b><br/>Retry known failures"]
  Failed -->|Uncertain write| Recovery["<b>Recovery required</b><br/>Do not repeat blindly"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef condition fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class Console,Secrets,API,Queue state
  class Claim,Config,Agent,Transport,Deploy,Observe,UI operation
  class Failed,Recovery,Terminal condition
```

## Execution Trace

### 1. Console saves credentials and freezes a provisioning request

`apps/controller/src/console/agents/create.mts:renderCreateAgent`

Console keeps the configured Harness separate from execution mode: dedicated
OpenClaw uses the same provisioning, retry, and deployment navigation as
dedicated Codex. Preset restoration and Credentials read native model runtime
policy through `apps/controller/src/console/agents/harness-auth.mjs:configuredHarnessId`.

The Slack modal immediately saves new tokens through `POST /namespaces/:namespaceId/secrets`, before an Agent exists, then clears entered values. Apply stages references and environment bindings; Cancel discards selections but retains created Secrets. Model discovery uses an API key or service account token without saving it. Create Agent runs its preflight, then saves it as a Namespace Secret, clears the input, and reuses the reference on retries. Bound Presets retain their credential/provider. A lost Secret-save response requires recovery, not automatic repetition.

A selected Credential Gateway's catalog directs Console to register the model
Secret before source-backed provisioning. [Console recovery](../reference/console/create-and-deploy.md)
reuses confirmed sources and safely retries uncertain registration.
Installation discovery preserves catalog metadata.

Create Agent sends a stable request ID, inline Configuration, Secret and model-auth references, Agent options, and repository bindings with an explicit access profile. The worker grants Secret access, including Slack. After uncertain admission, Retry sends the same ID and inputs without saving Secrets again.

For a draft, Console creates the Configuration and Agent, then grants access to selected Slack Secrets. Retry credential access keeps that Agent.

### 2. OCC admits one job

`packages/occ/src/index.ts:OpenClawController.provisionAgent`

`apps/controller/src/http/agents.ts:createAgentHandlers` receives schema-validated inputs after shared admission. It supplies the Namespace from the route and creates the audit event inside the controller transaction.

OCC first authorizes Agent `create`, Configuration `create` and Installation `administer` for the Namespace, as status and retry do, so a caller without them gets `403` whatever the body says. It then validates the accepted Configuration, references, workspace inputs, supported execution mode and current authority. Reserved Secret destinations, cross-Namespace Secret references, and missing or `runtime` Harness authentication give `400 INVALID_REQUEST` naming the rule; a Secret absent from the Namespace stays `404`. Before the Compute plan check, a Secret binding gets Agent save's Harness authentication check and its named `400`.

A selected Credential Gateway requires a supported model Credential Source for dedicated provisioning. OCC checks its exact `operate` authority and readiness, and preserves its canonical binding. Unsupported authentication methods fail before a job or external resource is created.

After an Installation selects another Secret Driver, request, status and retry answer `503` for a Secret owned by the previous Driver, after authorization and lookup. The message asks the caller to save replacement Secrets and submit a new request. The worker fails that attempt with `PROVISIONING_REJECTED`; an unavailable Secret Driver still retries.

Before admission, the ChannelDriver checks configured credentials through authorized Secret callbacks. Slack checks token roles and bot authentication; this neither pins Secret versions nor adds worker revalidation. The repository Driver validates Namespace selections before queueing and when creating the Agent. Undeliverable repository bindings, including Sandbox repositories, keep Agent create's `409` on admission and retry ([Compute admission](../reference/drivers/compute-admission.md)). Initial workspace files require the selected Sandbox's `validateWorkspaceSetup` capability; Compute delegates validation or refuses unsupported placement before staging files. Deployment checks the exact Harness topology.

OCC stores the accepted request and deduplication fingerprint in `agent_provisioning_work`, then queues `controller_work` with `work_kind = 'provisioning'`. Configuration and Agent creation happen later. The same actor, Namespace and request ID return the existing work; changed input conflicts.

The `202` response contains `data.provisioning`, with the work ID and status URL. Public progress exposes result IDs and safe errors without input values or backend credentials.

### 3. The worker creates resources and credentials

`packages/occ/src/index.ts:OpenClawController.processAgentProvisioning`

Under its queue claim, the worker verifies ownership, Namespace readiness and authority before
effects and result commits. Retries reuse completed outputs. It creates the Configuration from the accepted inline
values and bindings, then creates a stopped Agent, records the auth, provider, plugin, repository and
workspace selections, and grants its service principal the exact Secret permissions.

Source-backed provisioning records the canonical model source and grants only source `operate`.
Admission, replay, retry and execution recheck caller authority, source readiness and Gateway
ownership. Queued or running work prevents source deletion.

Compute prepares runtime credentials without loopback HTTP. Kubernetes owns trusted-proxy
configuration and credential protection; provisioning supplies neither gateway token nor trust
override. Losing the provisioning claim cancels outstanding Kubernetes Configuration requests,
freeing the serial worker.

### 4. Deployment becomes the lifecycle owner

`packages/occ/src/index.ts:OpenClawController.deployAgent`

The job records its first Agent revision ID. `packages/occ/src/index.ts:observeProvisioningDeployment`
defers work without consuming retries until that version activates or fails. The same handle reports
success or the deployment’s safe error; meanwhile `progress` names its wait. Stop during rollout yields `REVISION_STOPPED`; Stop or deletion
before handoff yields `PROVISIONING_CANCELLED` and says which happened. Status retains the Agent ID; both IDs survive restart.

Create Agent (`apps/controller/src/console/agents/create.mts:waitForProvisioning`) shows the job's named
wait and waits one second between status reads, spending it on details such as a full Pod quota, cancelling unfinished reads
at the next poll. Admission, status and retry report the stored client `requestId`.
If absent or different, Create keeps the original request and any confirmed job.
`meta.requestId` identifies each HTTP request. Leaving stops polling, not provisioning.
If the first deployment fails, open the existing Agent, correct the cause and deploy a new version.
After an intentional Stop, deploy when ready. Reconciliation owns startup and activation;
subsequent deployments use Deploy.

Dedicated OpenClaw admission requires native worker support and a Sandbox Driver
with all required containment facets. The pinned runtime declares native support;
custom images still require an operator declaration in
[Installation startup configuration](../reference/configuration.md#installation-startup-configuration).
`packages/occ/src/index.ts:requireDedicatedNativeSupport` enforces both requirements.
Admission does not prove workload delivery. Sandbox receives private setup
identity and the exact Secret reference through `HarnessWorkloadRequirements.workspaceSetup`;
OpenShell executes initialization through `ExecSandbox` before Harness startup.
See [workspace initialization](workspace-files.md#2-deployment-initializes-storage-before-execution).
Stock OpenShell rejects Secret-backed environment projection; the
[OpenShell flow](openshell-sandbox-provisioning.md#3-validate-and-serialize-the-sandbox)
covers remaining limits and verification-only support.

### 5. Failures preserve useful outputs

`packages/occ/src/state/postgres-state.ts:provisioning`

Safe failed steps can retry under a fresh claim and authorization check. Completed resources are retained and reused. An unresolved external write keeps its exact target and ownership evidence; lease expiry or a not-found response alone does not justify dispatching it again, except a Configuration create still absent 90 seconds after it began, which is [resent](configuration-driver.md#2-resolve-singleton-state-and-select-drivers). Only a refusal before the Configuration record exists rolls back: it deletes the written Configuration, or marks it for a later attempt.

While initialization owns an Agent, conflicting edits and manual deployment are guarded. Stop/Delete invalidate provisioning, and stale workers cannot hand off a deployment afterward. Ordinary deletion retains its lifecycle and in-flight credential safety. A cancelled provisioning never runs again. Agent deletion settles an effect it left pending one worker lease after cancellation: it removes runtime credentials and records the receipt with its finalizer, deferring without spending attempts. Deploy, Agent update and runtime-credential requests settle it once the cancelled claim's stored lease expires, returning `409` until then. Namespace deletion waits for queued or running work and for any effect without a matching receipt, not for settled effects on terminal work. Namespace Secrets and completed Configurations remain available.

No API deletes a provisioning request. Agent deletion removes the Agent's requests; a request that never created an Agent stays. To clear one that blocks migration `0049`, see [legacy bindings](../reference/settings/operations.md#clear-legacy-managed-pat-bindings-before-0049).

## Debugging and Verification

- Poll `data.provisioning.url` or `GET /namespaces/:namespaceId/agents/provision/:workId`; failed work reports a safe error. Status checks stored ownership and provisioning grants, while retry also revalidates the accepted plan. See [admission](#2-occ-admits-one-job) for refusal rules. Explicit pre-handoff retry uses the same URL plus `/retry` and an empty body; only the initiating actor can read or retry work. Match request IDs in `agent_provisioning.compute_refused` and `worker.completed`.
- Status does not repeat plugin policy, runtime-image support, Compute plan validation or Harness authentication checks; retry can refuse a readable record. Missing accepted Secrets, Credential Sources or ServiceAccounts give `409`; changed selected Driver IDs or Sandbox containment can give `503`. Caller-owned Configuration refusals name the setting without its value; other Compute refusals use fixed public text. A worker refusal fails that attempt with `PROVISIONING_REJECTED` after inspecting earlier unsettled writes; an unobservable write still retries. Kubernetes provisioning requires explicit `dedicated`, because omission defaults to `embedded`. An accepted account without an access token requires the ChatGPT Backend.
- Inspect `worker.completed`, `worker.error` and the `agent_provisioning` work metric. PostgreSQL job state lives in `occ.controller_work` and `occ.agent_provisioning_work`.
- Use `tests/integration/postgres-agent-provisioning.test.mjs` for persisted admission, deduplication, safe retry, retained outputs and authorization behavior.
- Use Console browser coverage for channel Secret creation before provisioning, reference reuse after failure and job-to-deployment navigation. The disposable Kubernetes fixture proves actual Driver handoff, not native enrollment, model execution or Slack replies.

## Related docs

- [Console creation and API example](../reference/console/create-and-deploy.md)
- [Controller worker and durable reconciliation](controller-worker.md)
- [Configuration Driver flow](configuration-driver.md)
- [Secret storage and delivery](secret-storage-and-delivery.md)
- [Workspace files](workspace-files.md)
- [Asynchronous Agent provisioning spec](../../specs/plans/35-agent-provisioning.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-25 03:30: Check a Secret binding's placement before the Compute plan check; Console runs the preflight first. (fix-postland-1025b - 2b1f510594)

- 2026-10-17: Bound optional deployment details to the provisioning poll interval. (PR #2685)

- 2026-10-14: Merge current contracts with native provisioning and retained-workspace preparation. (Codex/01a13654-be66-7741-b54f-f8ae80f2d496)

- 2026-10-15 07:00: A later attempt retries a failed unrecorded-Configuration delete. (fix-1399)
- 2026-10-15 06:30: Refused provisioning deletes its unrecorded Configuration. (fix-1395)
- 2026-10-14 23:59: Name the Stop or deletion that cancelled provisioning. (fix-1375-1377)
- 2026-10-14 20:21: Name a stopped initial deployment without changing its failed and non-retryable outcome. (authoring-run/b98d803a-436a-4437-84af-01be278a6460 - 8642bef0e3a39ff73459ef9e96a3404084135837)

- 2026-10-13 09:37: Reconcile current admission and lifecycle behavior with external OAuth custody in the accompanying merge. (authoring-run/fd902939-ed58-4508-8d33-95a863d966af - e8d39978d801e7a5a8ac7242f32035f426da94e1)

- 2026-10-12 22:30: Provisioning refuses undeliverable repository bindings and Sandbox workspace files before queueing. (fix-1144-1145b - d34b4a8f7)

- 2026-10-12 11:55: Follow the initial deployment on the original provisioning handle and retain its failure identity. (authoring-run/adccd418-cf61-4fbb-b3ba-0fcad194d907 - 040e7498ecd89e0e565af71f234776ecfaad2186)

- 2026-10-09 13:59: Keep OpenShell initialization and current provisioning limits within the flow budget. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - a9298d2ed)

- 2026-10-09 12:00: A Configuration create still absent 90 seconds after it began is resent. (fix-911)

- 2026-10-08 23:00: Guided provisioning registers model sources and preserves exact source authority for both Dedicated Harnesses. (Codex/01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa)

- 2026-10-08 14:00: Missing or `runtime` Harness authentication is a named `400`, not a generic `404`. (fix-821-824)
- 2026-10-08 13:00: Say that no API deletes a provisioning request, and link how to clear one with a legacy plan that blocks migration `0049`. A plan bound to an account without an access token on an Installation with no ChatGPT Backend fails with a message naming the Backend. (fix-780-781/d540-d541)
- 2026-10-08 12:30: The provisioning worker inspects an unsettled external write before its authority check, so a permanent refusal fails the work with `PROVISIONING_REJECTED` instead of retrying it as `PROVISIONING_OUTCOME_UNKNOWN` until attempts run out. (fix-808-815)
- 2026-10-08 11:30: The provisioning worker fails accepted work whose Secrets the selected Secret Driver does not own with `PROVISIONING_REJECTED` and the fixed message, instead of retrying it as an unavailable dependency. (fix-809)
- 2026-10-08 11:00: A Secret stored through a previously selected Secret Driver answers a `503` that names the fix (replacement Secrets, a new request) instead of the generic dependency text. (fix-802)
- 2026-10-07 11:00: Provisioning authorizes its Namespace-level grants before it validates the plan, so a caller without them gets `403` instead of a `400` or `404` about the body. (fix-member-1007/d530)

- 2026-10-06 17:00: A Compute Harness authentication refusal that names a setting in the caller's Configuration answers `400` naming it on request and retry, and the failed work's message keeps it, as deployment does. Status no longer rechecks Harness authentication. (fix-648-652/provisioning-harness-refusal)

- 2026-10-06 13:30: A Compute refusal of a caller's gateway setting names the setting in the `409` and the failed work's message; other Compute refusals keep fixed text and are logged with the request ID as `agent_provisioning.compute_refused`. (fix-635-636/compute-gateway-setting)

- 2026-10-06 12:00: Compute plan refusals answer `400` (unsupported execution mode) or `409` instead of `500`, the worker rejects them on the first attempt, and status no longer rechecks them. Status also skips the runtime image's native worker support check (#1499). (audit-1006b/provisioning-compute-refusal)

- 2026-10-06 05:00: The worker rejects stored plans refused by the current Plugin Driver or runtime image on the first attempt. (audit-1006/provisioning-refusal-class)

- 2026-10-05 23:30: A binding destination failure names the broken rule; a reserved destination also names its key, with a `/configuration/secretBindings/<key>` detail. (findings-sweep-1-api)

- 2026-10-03 15:30: Provisioning rejects reserved binding destinations and cross-Namespace Secret references as invalid requests instead of not-found. (f239/provisioning-binding-validation)

- 2026-10-03 05:30: Namespace deletion no longer waits on failed provisioning whose effect is already settled. (fix-d354/namespace-settled-provisioning)

- 2026-10-01 17:20: Point provisioning admission at the extracted Agent HTTP handlers. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-09-30 17:31: Reconcile Console Harness selection with Embedded defaults, native-worker admission, and current provisioning navigation. (Codex/01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa - a0970577)

- 2026-09-29 17:30: Agent deletion settles an effect left by cancelled provisioning instead of waiting for it forever. (fix-1/agent-deletion-unsettled-effect)

- 2026-09-29 05:00: Document request-time channel credential validation. (authoring-run/bb89c55f-8771-46c9-801d-e5bc028d7e5c - 756b02ce)

- 2026-09-29 02:33: Open Agent details after provisioning hands off the first deployment, and show pending or failed deployment status there. (Codex/01a0eaf9-6dcf-76b1-a376-d2a2fbfd6c60 - a14435c8)

- 2026-09-28 17:30: Separate Console Harness selection from Dedicated placement and document retained Sandbox delivery requirements. (Codex/01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa - e2b739f5)

- 2026-09-23 21:00: Integrate provider model discovery and saved API-key/PAT references with canonical Dedicated provisioning and deployment activation. (Codex/01a0cf27-71c6-7042-8357-74d1811a2ef8 - fb711b49)

- 2026-09-23 20:21: Integrate repository selections with asynchronous provisioning and preserve draft-only discovery recovery. (public-pr/295 - 8bd367636aff766d484b4e684d42f6b4419c9e4e)

- 2026-09-23 11:20: Reused the channel setup Secret modal and preserved ordinary-create grant recovery when rebasing onto PR #323. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:37: Simplified Secret saving, delayed resource creation, retry ownership and deployment handoff. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 01331ac4)

- 2026-09-23 02:43: Restored existing repository-session deletion safeguards alongside the provisioning cleanup guard. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 1e4936f0)
- 2026-09-23 02:20: Clarified pre-handoff mutation reservations, retained failed-work receipts, and cancellation-owned cleanup. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - a20f0b07)
- 2026-09-23 01:25: Corrected provisioning effect recovery to use inspect-first recovery and clarified terminal cleanup ownership. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 5886094b)
- 2026-09-23 00:51: Restored concrete status, exact-create recovery, generation, external-effect, retry, and cleanup details from the accepted spec. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:45: Clarified Console first-time provisioning, ordinary create separation, and versioned provisioning keyring prerequisites. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:22: Added the source-backed Agent provisioning flow. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
