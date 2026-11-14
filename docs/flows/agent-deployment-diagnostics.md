---
created: 2026-09-27
updated: 2026-11-12
last_updated_session: authoring-run/610ff967-1248-450d-a432-c62fe1e8ac7a
---

# Agent deployment diagnostics flow

## Overview

An admin requests fresh runtime checks for one saved version through a
bodyless API call. OpenClaw Control Plane (OCC) authorizes the exact target,
asks the selected Compute Driver for runtime checks with time and size limits, and returns that
observation. The call ends at the API response; it does not change deployment
work or select a live version.

## Entry Points

- Trigger: `POST /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId/diagnostics`.
- Source: `apps/controller/src/index.ts:createFastifyApp`,
  `packages/occ/src/index.ts:OpenClawController.diagnoseAgentDeployment`, and
  `apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.diagnoseAgentDeployment`.
- Assumptions: `deploymentId` is the Agent revision ID of a saved version. The caller needs
  exact Agent `read` and `operate` and Agent revision `read` permissions.

## Flow

```mermaid
graph TD
  A["POST diagnostics for this version"] --> B["OCC resolves and authorizes version and Agent"]
  B -->|denied or missing| C["Return 403 or 404"]
  B -->|authorized| D["Select matching Compute Driver"]
  D -->|unsupported| E["Return 503"]
  D -->|supported| F["Kubernetes resolves owned Namespace and version Pods"]
  F -->|Pod absent| G["Return unknown check for that container"]
  F -->|one Pod| H["Read private runtime diagnostics and status through Pod proxy"]
  H --> I["Recheck Pod UID and container identity"]
  I -->|changed| G
  I -->|same| J["Validate checks for the requested version"]
  J -->|invalid| E
  J -->|valid| K["Return current observation"]
  G --> K
```

## Execution Trace

### 1. Authorize the exact deployment

`packages/contracts/src/api/routes.ts:occApiRoutes` declares a bodyless POST.
`apps/controller/src/index.ts:requiredPermissions` requires exact Agent
`operate` and `read` plus Agent revision `read`.
`packages/occ/src/index.ts:OpenClawController.diagnoseAgentDeployment`
resolves the version under the supplied Namespace and Agent, authorizes the
same resources, and selects the Compute Driver recorded in that version.

### 2. Read the current runtime

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.diagnoseAgentDeployment`
checks the binding and owned Namespace.
`deployment-diagnostics.ts:collectDeploymentChecks` reads diagnostics and startup
status concurrently for each runtime role under a shared ten-second deadline. In a
two-cluster installation, dedicated Gateways use their managed Gateway namespace
and dedicated Harnesses use the tenant namespace.

`apps/controller/src/drivers/compute/kubernetes/private-status-proxy.ts:readPrivateStatusProxy`
reads and decodes the private endpoint with a 64 KiB limit. A 404 or 503 means the
endpoint is unavailable for this observation. A redirect fails the read and the
Driver requests body cancellation without retrying. The Driver checks the Pod
name, UID, and container ID again before using the decoded evidence. Missing or
replaced Pods produce `unknown` checks. Invalid diagnostics data fails the
request. When concurrent reads reach the shared deadline, the Driver can still
classify a rejected Gateway diagnostics request before reporting a generic timeout.

`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:PLUGIN_RUNTIME_HELPERS`
calls `channels.status` through OpenClaw's public Gateway SDK on demand in the
Gateway container. It maps live configuration, authentication, and connectivity
to safe codes without sending a message. The call cancels after six seconds or
when the HTTP caller disconnects. OpenClaw loads the Slack plugin only for a
Configuration with a Slack channel, so for an Agent without one the Gateway
refuses the call as an unknown channel; that refusal maps to configuration
`failed` with `NOT_CONFIGURED`. The probe code is part of the Gateway Pod
specification, so a version deployed by an earlier controller keeps the
earlier mapping (three unknown `PROBE_FAILED` checks) until the Agent is
redeployed. Transport failures return `UNAVAILABLE`; other RPC failures return
`PROBE_FAILED`. Both produce unknown checks; local configuration is not
substituted for the live response. The Agent container
currently returns no channel checks.

`KubernetesComputeDriver.heldRuntimeFailureCheck` also reads each Pod's private
runtime status. A runtime that held startup, such as a Gateway with an unusable
peer configuration record or an Agent whose model check failed, reports its
failure there. The Driver lists it first as a `failed` check named after the
startup step, with the failure code; diagnostics do not rerun that step. The
private boundary accepts only real UTC timestamps, normalizing a valid whole-second
value to the public millisecond form. A failed, impossible-date, or otherwise
invalid status read adds nothing.

The Driver skips Harness Pod proxy reads when the revision's selected Sandbox
Driver provisions the Harness. An [OpenShell](../reference/drivers/openshell-sandbox.md)
Harness listens inside its own Sandbox network namespace. Its `agent` `runtime-status` check is `unknown` with code
`UNAVAILABLE`. The Gateway can still report a held failure.

Beside Compute's checks, `OpenClawController.diagnoseAgentDeployment` asks the
version's Sandbox Driver for its record of a dedicated Harness Sandbox
(`observeHarness`, with a ten-second timeout signal). The result leads the list as an
`agent` `sandbox` check: `succeeded` while the Sandbox runs, `failed` with a code
such as `SANDBOX_FAILED` or `HARNESS_EXITED` once it can no longer serve the
version, `failed` with `HARNESS_RESTARTING` while OpenShell restarts a Harness
process that exited, and `unknown` on a first start (code `STARTING`), when the
record is unreadable (`UNAVAILABLE`), or when a version that is not selected for the running
Agent has no Sandbox, such as a stopped Agent's.

### 3. Return validated evidence

`packages/occ/src/deployment-diagnostics.ts:deploymentDiagnostics` requires
the requested Agent revision ID, valid timestamps, and at most 32 checks with component, check, and code values of 1 to 64 allowed characters. A
component, check or code outside `packages/contracts/src/runtime-failure.mjs`
reads `UNRECOGNIZED`. Native Driver errors become `DEPENDENCY_UNAVAILABLE`
without messages. A rejected private Gateway diagnostics Pod-proxy request instead
retains the fixed `RuntimeDiagnosticsTransportError` class and message in the
request-ID-correlated `http.dependency_unavailable` operator log. OCC reconstructs
this error without supplier text or causes. The public response remains generic
`503 DEPENDENCY_UNAVAILABLE`. This category identifies collection transport; it
does not establish a channel failure or its network cause. Pod discovery, invalid
endpoint data, redirects, and normal not-serving responses keep their existing
handling. Stored deployment status, startup evidence, plugin warnings
and Agent state stay unchanged.

## Guarded first admission

The [Configuration persistence flow](configuration-driver/persistence-and-revisions.md#guarded-first-admission)
traces first-deployment admission and receipt recovery. That path ends when OCC
commits an Agent revision and queues reconciliation. Diagnostics observes runtime
state after admission.

## Debugging and Verification

- `403` indicates missing exact permission; `404` indicates the path does not
  identify that Agent revision. `503 DEPENDENCY_UNAVAILABLE` indicates missing
  Driver support, collection failure, or invalid evidence.
- Checks that are all `unknown` with code `UNAVAILABLE` mean the runtime did
  not answer, usually because the Gateway is stopped, starting, or failed to
  start. The console says so and names a failed deployment's recorded error
  code, because these checks do not test model credentials.
- A `failed` check named after a startup step, such as `peer-bridge-record`,
  means the runtime is holding that failure. Its Logs tab shows the remedy.
  `egress-enrollment` with code `UNAVAILABLE` is a protected execution whose
  Harness could not enroll with its egress proxy before the model check.
  An `agent` `state-migration` or `workspace-baseline` check with code
  `UNAVAILABLE` is a dedicated Harness or native worker held before Codex or its
  node started: Doctor did not complete maintenance, or `openclaw setup --baseline`
  failed. The log line names the cause and any invalid setting paths, and
  OpenClaw's own hints to run `openclaw doctor` are dropped, since the
  Harness runs Doctor itself. A pending marker in the retained `state` directory preserves the repair requirement
  across container replacements; fix the cause, then deploy again.
- A `gateway` `gateway-state-lock` check with code `UNAVAILABLE` is a dedicated
  Gateway that OpenClaw refused to configure: an earlier Gateway process did not
  stop cleanly, and the restarted container cannot verify that the lock holder
  stopped. The log line quotes OpenClaw's holder description. Follow
  [unverifiable state owner recovery](../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner).
- A dedicated Gateway held at `gateway-tool-policy` with code
  `INCOMPATIBLE_RESPONSE` can have a runtime image provenance failure.
  `apps/controller/src/drivers/compute/gateway-tool-policy.ts:requireGatewayToolPolicyRuntime`
  runs in both Docker and Kubernetes launchers. Its fixed log message distinguishes
  missing, unreadable, or malformed provenance from a source or commit that does
  not match the controller's pinned OpenClaw source/revision. Use the OpenClaw
  Enterprise (OCE) runtime image matching the controller. Neither message includes
  supplied provenance values or read-error details. With matching provenance,
  a policy refusal still names the required tool policy and Gateway tool allowlist.
  These failures keep the Gateway stopped and unready.
- A `gateway` `gateway-config` check with code `UNAVAILABLE` is a Kubernetes
  Gateway that exited before it served, and `openclaw config validate` reports
  its configuration invalid. A plugin entry whose `config` fails the plugin's
  schema causes this even when the plugin is disabled or denied. The log line
  names up to five setting paths, with the schema message where OpenClaw gives
  one, and never a value. Fix or remove those settings, then deploy again.
  A dedicated Gateway's tool policy step holds the same check before OpenClaw
  starts when no invalid setting belongs to the tool policy.
- A `crash-loop` check with code `UNAVAILABLE` is a startup failure Kubernetes
  Compute reads from Pod status, as it does `workspace-setup`; no runtime holds it
  (`apps/controller/src/drivers/compute/kubernetes/index.ts:safeCrashLoopObservation`):
  the role's container waits in `CrashLoopBackOff` after 3 consecutive
  unexplained exits. The Gateway wrapper states that count in its termination
  message (`runtime-entrypoints.ts:countUnexplainedExits`); readiness starts it
  again at 1, and a deliberate restart (exit 75, `stopContainer`) clears it and
  never counts; its `deliberate restart:` message counts 0 whatever the exit
  code. Without a count, and for a Harness, the restart count plus one stands
  in: in backoff the kubelet has not yet counted the restart it waits for.
  The deployment fails with `RUNTIME_STARTUP_FAILED`; the record keeps no check,
  but the runtime description shows the restart count and last exit code.
- When a Codex startup check returns `model_not_found`, the worker saves that
  code. Codex can omit the code from its error event. In that case, the probe
  recognizes the provider’s HTTP 404 missing-model message for the requested model.
  The Console names the model from the failed version. It directs editors to
  Configuration and tells other viewers to ask an editor to choose a model.
  If the viewer cannot redeploy the Agent, it tells them who can.
- A dedicated Codex model check cause whose detail ends `-attempt2`, such as
  `turn-failed-attempt2`, means the check was retried once, after a timeout, a
  transient failure or a network or 5xx exit, and the second attempt failed that
  way. A failure whose output names a credential, TLS error or limit is never
  retried. Each failed access-token login attempt logs a `codex.login` line with
  its number and output class. An unreachable
  model provider is transient: each attempt waits out its 30-second limit, so
  `error-event-attempt2` follows about a minute after the check starts. Codex
  reports a refused port, an unresolvable host and a rejected TLS certificate
  the same way, so a permanent mistake such as a wrong endpoint host or port
  or a blocked egress route is also retried once before it is held. If Codex
  reconnects and the model answers in the same attempt, the check passes.
- On an OpenShell Harness, the `agent` `runtime-status` check says nothing about
  its health; the `agent` `sandbox` check does. A failed one means the Sandbox
  is lost; [deploy the Agent again](../guides/topics/agent-troubleshoot.md#an-openshell-agent-stops-answering).
  A failed `HARNESS_RESTARTING` check instead means the Harness process keeps
  exiting while OpenShell restarts it; its Sandbox logs show why.
  A failed deployment's status names the held failure's code and cause, such as
  `RUNTIME_MODEL_PROBE_FAILED`. While it holds a failure, the Harness answers
  the Agent Gateway's connection with `503` naming the held code, but the
  Gateway logs only `Unexpected server response: 503`; Compute's authenticated
  status read carries the code. The
  [Sandbox source](../guides/topics/agent-logs.md#sandbox-source) shows policy
  decisions; an operator can read the
  [Harness output](../guides/topics/agent-troubleshoot.md#read-openshell-sandbox-and-supervisor-logs).
- The focused API test covers exact permissions and sanitized Driver failures.
  The Kubernetes conformance test covers Pod proxy placement, version and Pod
  identity, and missing-Pod behavior. These tests do not prove a live Slack
  connection, message delivery, or a model response.

## Related docs

- [Agent deployment status and diagnostics](../reference/agents.md#deployment-status)
- [Compute Driver diagnostics](../reference/drivers/compute.md#optional-runtime-diagnostics)
- [Kubernetes networking](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-12 20:29: Distinguish runtime image provenance failures from tool policy refusals in both generated launchers. (authoring-run/610ff967-1248-450d-a432-c62fe1e8ac7a - a627e44694987459dbbf9aa59a3d76b9a97f48a7)

- 2026-11-11 02:04: Trace the private Pod proxy reader and shared diagnostics deadline. (authoring-run/e028dbec-8765-42b2-b94f-fafcd435d7bc - c5f99318f7e2495afac28ff7ec7b5f8e77891dfc)

- 2026-11-10 23:59: Preserve a fixed private Gateway diagnostics transport category in operator logs. (authoring-run/028ba1b2-5a61-4135-8d59-b919ec55e0eb - 42ffbb69e04e306d32eddcec27e8ea3d9075ec42)

- 2026-11-10 23:30: Count only consecutive unexplained Gateway exits toward a crash loop, from the wrapper's termination message. (crashloop-fix-2, finding 3041)

- 2026-11-10 12:00: Fail a Kubernetes runtime container in a crash loop as check `crash-loop`; deliberate Gateway restarts exit 75. (crashloop-fail-fast, finding 3041)

- 2026-11-04 07:41: Move the first-admission trace to the Configuration persistence owner and retain its diagnostics link. (authoring-run/06bc63c9-f110-4607-a058-a816a61dd579 - 6371064e)

- 2026-10-31 15:00: Hold a dedicated Gateway's invalid settings outside its tool policy as check `gateway-config` instead of `gateway-tool-policy`. (fix-3045, finding 3045)

- 2026-10-31 13:00: Hold a Kubernetes Gateway whose configuration OpenClaw refuses at startup as check `gateway-config`. (fix-3043b, finding 3043)

- 2026-10-30 16:53: Document guarded first admission, receipt recovery, and how both controller calls bind authorization to the request captured on entry. (authoring-run/62495070-6f26-49ba-b4b9-e00ac1a9bccd - 460529c7)

- 2026-10-29 15:00: Hold a dedicated Gateway's unverifiable Gateway state lock as check `gateway-state-lock` instead of `gateway-tool-policy`. (fix-2864, finding 2864)

- 2026-10-27 09:00: Name the `state-migration` and `workspace-baseline` holds of a dedicated Harness or native worker. (fix-2686-status, finding 2686)

- 2026-10-17 03:40: Say that an unreachable model provider covers permanent connection mistakes, and pass a check whose network wait recovered. (lows-1017d, findings 1621 and 1622)

- 2026-10-17 02:30: Retry the dedicated Codex model check once when the model provider is unreachable. (lows-1017c, finding 1618)

- 2026-10-14 15:27: Reject redirected status responses before reading their bodies. (authoring-run/3ffec2d3-d528-40ec-98a6-f91d0ad55db4 - 8e916a6c)

- 2026-10-11 14:30: Reject impossible private runtime timestamps before returning held failure evidence. (issue-2142)

- 2026-10-10 18:30: Report a Harness that OpenShell is restarting as `HARNESS_RESTARTING`. (fix-1043)

- 2026-10-10 15:30: Lead OpenShell diagnostics with the Harness Sandbox lifecycle check. (fix-1027)

- 2026-10-10 14:30: Document that an OpenShell Harness's runtime status is unreachable to diagnostics. (fix-1022-1019)

- 2026-10-10 10:00: Report a held runtime startup failure as the first diagnostic check. (fix-1013)

- 2026-10-07 12:00: Say that a version deployed by an older controller keeps its diagnostics mapping until the Agent is redeployed. (dogfood-r43)

- 2026-10-07 11:30: An Agent without a Slack channel reports `NOT_CONFIGURED` instead of three `PROBE_FAILED` checks. (fix-member-1007/d531)

- 2026-10-01 15:14: Use SDK queries with request timeouts for live channel diagnostics. (authoring-run/24df37c6-7eef-483a-a31c-d2c14a51ca6c - 521549df)

- 2026-10-01 15:22: Point validation to its private deployment diagnostics module. (authoring-run/089c3e66-9284-44a0-9e60-285ac7f50ab9 - 28debe57)

- 2026-09-27 06:34: Document the diagnostics request for one version and its Compute observation boundary. (authoring-run/d4a7cf04-5ef8-46a6-8a29-814f0292bf66 - ab37f9b)
