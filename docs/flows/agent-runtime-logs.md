---
created: 2026-09-30
updated: 2026-10-10
last_updated_session: authoring-run/b0c35eb4-2b87-4f3e-aec3-8c416cdef3bb
---

# Agent runtime logs flow

## Overview

An authorized reader requests Pod status or one page of container output for an
admitted Agent revision. OpenClaw Control Plane (OCC) authorizes the exact target,
asks the selected Compute Driver for raw Kubernetes data, and returns only
classified, redacted, bounded records. Nothing is stored on the server; a
download is a local file on the reader's device.

## Entry Points

- Trigger: `GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId/runtime`
  and `GET .../runtime/logs` (optionally `download=true`) from the console Logs
  tab, `occ agent runtime|logs` (`internal/occcli/agent_runtime.go`) or the API.
  Without `--revision`, the CLI uses a newer revision with Pods when available,
  otherwise the active revision, otherwise the latest revision
  (`agentRevision`, `latestRevisionID`).
- Source: `apps/controller/src/index.ts:createFastifyApp`,
  `packages/occ/src/index.ts:OpenClawController.describeAgentRuntime` and
  `readAgentRuntimeLogs`, `packages/occ/src/runtime-logs/`, and
  `apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.describeAgentRuntime`
  and `readAgentRuntimeLogs`.
- Assumptions: `deploymentId` is an admitted AgentRevision ID. Status needs exact
  Agent `operate` and `read` plus AgentRevision `read`; log text needs Agent
  `read_logs` or `administer` instead of `operate`, and no AgentRevision grant
  (`OpenClawController.authorizeRuntimeLogRead` tries `read_logs` first and
  falls back to `administer` unless a Restriction denied `read_logs`). The
  revision must still belong to the exact Agent, so an Agent grant covers every
  revision that Agent deploys.

## Flow

```mermaid
graph TD
  A["GET runtime or runtime/logs"] --> B["Feature switch"]
  B -->|off| C["Return 501"]
  B -->|on| E["OCC authorizes revision and Agent tier"]
  E -->|denied| F["Audit denial, return 403"]
  E -->|authorized| G["Select recorded Compute Driver"]
  G -->|no method or driver-owned logging| C
  G -->|supported| S["Rate and concurrency limits"]
  S -->|limited| D["Return 429 with Retry-After, or 503"]
  S -->|admitted| H["Driver lists revision Pods and Pod Events per plane"]
  H --> I["OCC validates and redacts the description"]
  I -->|status route| J["Return runtime description"]
  I -->|logs route| K["Validate cursor and listed Pod"]
  K -->|invalid| L["Return 400"]
  K -->|new view or download| M["Write view or download audit event"]
  M -->|failed| N["Return 503, no content"]
  M -->|written| O["Driver reads bounded container log and re-reads Pod"]
  K -->|cursor poll| O
  O --> P["De-duplicate, label gaps, classify and redact"]
  P --> Q["Return sanitized page and signed cursor"]
  P -->|download=true| R["Return the same records as a text/plain attachment"]
```

## Execution Trace

### 1. Admit and authorize

`packages/contracts/src/api/routes.ts:occApiRoutes` declares both GET routes with
a closed query schema. `apps/controller/src/index.ts:perform` answers `501` when
`agentRuntimeLogs` is disabled. `OpenClawController.runtimeLogTarget` authorizes
the tier action and Agent `read` (plus revision `read` for status only), resolves
the revision within the exact Agent, then rejects a Driver without
`describeAgentRuntime` or with `runtimeLogging: "driver"`. Only then does the
route's `admitRead` callback apply the replica-local
`apps/controller/src/http/runtime-logs.ts:RuntimeLogLimiter` around the Driver
reads, so a denial is always audited and never spends a token.

### 2. Describe the runtime

`KubernetesComputeDriver.describeAgentRuntime` reports the current termination
when a container is terminated, otherwise its prior termination. It resolves the owned Namespace, then
lists Pods by the exact Agent, revision and workload-role labels: dedicated
Gateways and Harnesses in the shared tenant namespace in a single cluster. The
two-cluster profile reads dedicated Gateways in its control target and Harnesses
in its execution target. It lists Events by
`involvedObject.uid`, keeps only that Pod's Events, drops the scheduler's
`FailedScheduling` retry after a lost PVC update race once the Pod has a node,
follows Event-list continuation under the same five-second deadline, retains
the newest 100 eligible Events across all pages, and takes each
Event's `container` from `involvedObject.fieldPath` (`spec.containers{name}` or
the init or ephemeral form; `null` for Pod-level Events such as `Scheduled`). A log
read passes `{ source, events: false }`, so it lists only that source's Pods and
no Events. Each
Kubernetes call has a five-second deadline; a `403` becomes
`RuntimeLogsForbiddenByClusterError`. `runtime-logs/description.ts:validRuntimeDescription`
checks names, UIDs and counts, masks node, image and Secret names in Event
messages (`runtime-logs/redact.ts:maskRuntimeEventText`) and redacts reasons and
Event messages.

### 3. Read one page

`runtime-logs/read.ts:readRuntimeLogPage` verifies the HMAC cursor
(`runtime-logs/cursor.ts`) against the principal, Agent, revision and source,
and accepts only a Pod the description listed. A request without a cursor, or
with one older than an hour, or a cursor whose Pod is gone, starts a view: the controller appends
`openclaw.agents.runtime_logs.view`, an `access` audit event naming the admitting
action, before any log read. The Driver re-checks
Pod ownership, calls `readNamespacedPodLog` with `tailLines`, `sinceSeconds`,
`previous`, a 1 MiB `limitBytes` and timestamps, and re-reads the Pod. Before first start,
zero restarts, no current or previous instance, and kubelet's exact `400`
waiting-to-start Status matching the Pod, container and `PodInitializing` or
`ContainerCreating` reason yield an empty page. Logs are requested first,
so stale waiting status cannot hide available output. Unrelated failures retain
their error mapping.
`kubernetesRuntimeLogLine` separates kubelet's RFC3339 timestamp from each raw
line and converts numeric offsets to UTC while retaining every fractional digit.
Unknown or malformed offset prefixes remain untimed raw text. A cursor
poll derives `sinceSeconds` from the cursor: from its newest delivered line, or,
when the view has delivered nothing yet, from the previous read (a full or
byte-cut tail then emits `window_exceeded`). When a resumed read delivers nothing
new on every poll because the next line does not fit in the 1 MiB limit (typically
one oversized line), and that line is more than about 3 seconds older than the read,
the cursor drops its delivered time and
continues from this read, as a view that has delivered nothing yet does. The page
emits `window_exceeded` dated at that line: it and the lines logged after
it until this read are lost. A carried PEM block then keeps no delivered frontier,
so it stays masked for the rest of the view. OCC
drops earlier lines. For the cursor time, the signed cursor carries
`frontierComplete`, `frontierCount` (lines delivered at that time) and the last
16 of their hashes. When `frontierComplete` is true and the read holds that
time's first line (it starts earlier, or the Driver page is shorter than the tail
and not byte-cut) with its timed lines in order through that time, OCC skips the
first `frontierCount` lines at that time, if the hashes match the end of that run,
and delivers the rest: a group larger than 16 lines neither replays nor hides
later lines. Otherwise it consumes one remembered hash per delivered occurrence,
and lines it then delivers at that time drop the count. Text with no remembered hash is new
only while the hashes cover the whole count; identical text beyond its count also
needs `frontierComplete`. A new frontier is complete when its consumed prefix is
ordered and starts after the earliest fetched timestamp, or the Driver page is
shorter than the requested tail and not byte-cut. The bit persists while the
frontier timestamp stays the same. Otherwise matching-time text stays suppressed
until the timestamp advances: expanding a previously cut tail must not make an
older occurrence appear new. A legacy cursor without `frontierCount` has a count
only when it holds fewer than 16 hashes. A page byte cut keeps the count, so
undelivered lines at a complete frontier resume. It emits `stream_replaced`,
`window_exceeded`, `cursor_expired` or `truncated` gaps, and passes the rest to
`runtime-logs/sanitize.ts:sanitizeRuntimeLogChunk`, the only producer of
`SanitizedRuntimeLogRecord`. It classifies the whole page first, so
`runtime-logs/redact.ts:maskPemBlockLines` can mask a PEM block whose BEGIN,
body and END lines arrive as separate plain-text lines.

For container follow polls, the signed cursor also carries optional `pemOpen`
and `pemAfterTime` state. It describes the delivered boundary, not the start of
the fetched overlap. The reader validates timestamp order in the consumed prefix
through the last delivered line, without replaying older content through that
state. Each delivered line is compared with the reliable `pemAfterTime` from the
prior cursor, not with an earlier line on the same page. Only a line strictly
newer than that prior frontier can close a carried open block. Thus an ordered
same-page BEGIN and END at the same newer timestamp can close it. Times at or
before the prior frontier and evicted line hashes do not establish forward
progress; replayed overlap cannot erase a carried later BEGIN. Ordinary non-PEM
text remains visible while ambiguous context stays open.

Missing, invalid or reordered times make the frontier uncertain (`null`); later
timestamped pages alone cannot repair that uncertainty. Empty polls preserve it,
and lines beyond the page or byte cut do not advance it. A new view, expiry,
instance/Pod change or replacement during the read discards the old context.
The paired fields are validated together under the existing cursor MAC; malformed
or inconsistent pairs fail as `cursor_invalid` before a Driver read. Legacy
cursors and initial tails without observed PEM boundaries remain unknown and
best-effort. This does not recover missing log history or change JSON withholding,
short-token patterns, bracket-tag classification or sandbox pagination.

`source=sandbox` skips the Compute description. `OpenClawController.readSandboxLogs`
lists the source only when the selected Sandbox Driver provisioned the revision
and implements `readSandboxLogs`, resolves Compute's placement with
`resolveSandboxNamespace`, and runs `runtime-logs/sandbox.ts:readSandboxLogPage`.
`OpenShellSandboxDriver.readSandboxLogs` derives the Sandbox name from the
revision and calls `GetSandboxLogs` through `openShellSandboxLogReader`, which
exposes nothing else. OpenShell stamps supervisor lines when recorded but
batches them, and filters `since_time` by that stamp, so a resume sends a time
`SANDBOX_LOG_OVERLAP_MS` (5 s) behind the newest delivered line; the cursor
keeps one hash per line delivered since then (up to 48), and each re-read line
consumes one. A view's first page floors its resume time at the requested window
start. If no remembered line came back and nothing older did, OCC emits
`buffer_lost` or, when the window was full, `window_exceeded`; more than 48
lines in one millisecond also emit `window_exceeded`. gRPC `NOT_FOUND` (absent
Sandbox, or concealed from a non-member) maps to
`RUNTIME_LOGS_SANDBOX_NOT_FOUND`, never to an empty page. Lines naming two
Sandbox IDs are refused; a new Sandbox ID emits `stream_replaced`.
`sanitizeSandboxLogLines` parses the OCSF shorthand into allowlisted fields.

A download (`download=true`) forces `tailLines` to 1000, rejects a `cursor` with
`400`, and always starts a new view; `apps/controller/src/index.ts:auditAction`
names its audit event, and any denial, `openclaw.agents.runtime_logs.download`.

### 4. Return

`apps/controller/src/http/runtime-logs.ts:runtimeLogPageBody` accepts only
sanitized records and fails on the reserved `content` class.
`runtimeLogDownloadBody` serializes the same branded records as text lines with
the same check, and `runtimeLogDownloadFileName` names the attachment
`<agent>-<revision>-<source>-<pod>.log`. A `minLevel` query
(`runtime-logs/read.ts:runtimeLogPageAtLevel`) removes sanitized lines below that
level after the cursor is signed, so polls resume after hidden lines; unknown-level
lines, gaps and withheld counts stay. The console asks for `minLevel=info` unless
**Include debug** is selected; its level chips and text filter
(`apps/controller/src/console/agents/logs.mjs`) run only over loaded rows. The
console remembers a `403` from either route for the signed-in operator for the
page session, so reopening the Logs tab adds no audited denial, and another
operator signing in on the tab asks again. Its status message names the
log-text grants too. On the Gateway source it points to the Harness source while
no Harness Pod is ready, or to Deployment activity while none exists. The
CLI's `--follow` loop re-sends the cursor every 2 seconds.
`internal/occcli/agent_runtime.go:runAgentLogs` treats command-context cancellation as a
clean follow exit during both initial revision selection and page polling.
Without `--follow`, a canceled request remains an error. Driver errors map to
fixed `RUNTIME_LOGS_*` codes; the whole request has a ten-second deadline.

## Debugging and Verification

- `go test ./internal/occcli -run '^TestResourceRequestStopsWhenCommandContextIsCanceled$'`
  exercises the real CLI and HTTP client against a loopback server, canceling
  in-flight Agent and revision lookups. Follow exits successfully; one-shot reads
  retain cancellation errors. This proves local CLI cancellation, not deployed OCC.

- `503 RUNTIME_LOGS_CLUSTER_RBAC` means the API ServiceAccount lacks
  `pods/log`, `events` or, on an execution cluster, `pods` reads in that
  namespace. `503 RUNTIME_LOGS_AUDIT_UNAVAILABLE` means no output was read.
- `tests/conformance/runtime-logs-content.test.mjs` plants credentials, prompts
  and protocol lines through the real handler; `occ-api-security.test.mjs` covers
  tiers, cursors and failures; `kubernetes-compute.test.mjs` covers plane
  selection, Event filtering and the typed `403`. These use in-memory Kubernetes
  responses; `agent-runtime-logs-k3d-real.test.mjs` reads a real cluster.
  The same content suite exercises the real reader, cursor and sanitizer with
  synthetic Driver pages: cross-poll masking, replay/eviction, uncertain times,
  cuts, paired-field validation and stream/view resets. A separate handler case
  checks the serialized cursor through the supported controller fixture. These
  controls do not establish real-cluster behavior.
  `runtime-logs-sandbox.test.mjs` drives the sandbox source through the real
  handler and OpenShell Driver with a gateway client that answers only
  `GetSandboxLogs`; `openshell-gateway-wire.test.mjs` checks the wire shape.

## Related docs

- [Agent logs guide](../guides/topics/agent-logs.md)
- [Console and API runtime log reads](../reference/security.md#console-and-api-runtime-log-reads)
- [Compute Driver runtime status and logs](../reference/drivers/compute.md#optional-runtime-status-and-logs)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-10 07:06: Merge main; preserve initial continuation, timestamps, Events, termination and histories. (authoring-run/b0c35eb4-2b87-4f3e-aec3-8c416cdef3bb - b744ee6f217d17942cdaacea80cbbd08126aa87f)

- 2026-10-09 23:09: Continue current-container log reads through initial Pod preparation without concealing unrelated failures. (authoring-run/9f37d8ec-6a5b-4676-a134-8a6fb5c54f3a - 21f34928437fb7d6f4391ba4af5d3e15bf9ce480)
- 2026-10-10 02:50: Preserve Event pagination and current termination when merging main; retain both regression groups and histories. (authoring-run/794085ff-b0bd-422e-8fe7-6b6e9846ca0f - 880b645f5e5fb5c99c6046c1eac6ca81211be584)

- 2026-10-10 00:33: Read Pod Event continuation pages before returning the newest 100 diagnostics. (authoring-run-9eade0ab-4aa4-4b21-9faa-e7478c6a8983 - 3e34cc0f4b469d29fc79d2c10a33f87a0921ee47)

- 2026-10-10 02:35: Preserve current termination projection and both flow histories when merging main timestamp parsing changes. (authoring-run/f9b46af2-6bd4-4636-b675-dd9bea82a566 - db4ccbdea96a752cd99a66cf4cf02c195f5fe3ba)

- 2026-10-10 00:51: Report the latest exit details for currently terminated containers while retaining prior exits for running and waiting instances. (authoring-run/3d28a5c1-f0ee-4fbd-97de-52993c05b57d - 4f29773d098d2288a805d0ad80e0c65474e162d9)
- 2026-10-10 00:04: Normalize supported kubelet timestamp offsets without losing nanoseconds, so classification and cursor overlap use the raw message and UTC time. (authoring-run/e25eab96-1110-45ec-b677-916a98b34613 - ba3686748ddf56052dc2717cc2ce6eaa3710c1f0)

- 2026-10-09 15:42: Count container lines delivered at the cursor time, so a timestamp group larger than the 16-hash history neither replays nor hides later lines; a full history without that evidence stays suppressed. (fix-949-950)

- 2026-10-09 22:24: Authenticate frontier completeness and retain conservative suppression for cut or legacy timestamp groups. (authoring-run/ce414344-4cec-4d51-accd-f66b2ece9e0f - f060fefd260b552e44d5549f549436d6147a474c)

- 2026-10-09 22:12: Preserve matching-text suppression when the 16-hash frontier may have forgotten earlier occurrences. (authoring-run/ce414344-4cec-4d51-accd-f66b2ece9e0f - 66845c95cde0c7ef6adf358eb7daa1474c5fd443)

- 2026-10-09 21:59: Count delivered occurrences when de-duplicating container lines at the cursor time. (authoring-run/ce414344-4cec-4d51-accd-f66b2ece9e0f - dc95c2261d4b46cff8aca703e13e43cdd71d153e)

- 2026-10-07 05:26: Point CLI runtime reads and log polling to their dedicated source owner; clarify the existing revision selection. (authoring-run/9ac89b09-043f-44ba-8069-d0a90859ed7b - 61590165cdbb)

- 2026-10-05 11:38: Document clean CLI follow cancellation during initial revision lookup with the accompanying fix. (authoring-run/2afba01b-8db4-41d7-a942-e14bd7f44262 - 0698d533b97dc3abe7bef7ff7907a0f4335c3182)
- 2026-10-05 10:51: Preserve shared tenant placement while incorporating main startup and runtime diagnostics. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 71a1cedb)

- 2026-10-04 07:00: Authorize before the rate and concurrency limits so every denial is audited. (bh11-runtime-log-authz)

- 2026-10-03 22:00: A resumed view moves past a line longer than the 1 MiB read limit instead of re-reading it on every poll. (f349-log-resume)

- 2026-10-03 03:00: A cursor from a page that delivered no line resumes from that page, not the whole tail. (bughunt-1/fix-runtime-logs-quiet-follow)

- 2026-10-02: Describe shared single-cluster runtime placement. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-01 14:00: Add the server-side `minLevel` floor and the console's **Include debug** control. (fix-d79 - 3d6ce1fdb)

- 2026-09-30 23:44: Clarify the prior cursor frontier and ordered same-page PEM boundaries without changing masking behavior. (authoring-run/2c8a089c-ec67-402d-8cfd-ec8b29c5e3fe - a4cddf26bc462744bfff912b1e1cdb9f1ee60cd2)

- 2026-09-30 20:37: Receive cursor-context masking with current runtime-log guidance and preserve the current view behavior. (authoring-run/e2da7c2d-8080-4dd4-9ce9-d494b890234c - fb22aa07c1613218280cff25d6b62bfb4cff6b5d)

- 2026-09-30 19:43: Carry authenticated PEM context across bounded container polls without closing on ambiguous overlap. (authoring-run/b5fcaf0e-328a-4fe2-b53f-e72268ef70af - affac2bfc1370e590e6da570bcaaad4a207c9f09)

- 2026-09-30 08:30: Document runtime status and container log reads for Kubernetes Compute. (build-1/agent-logs-slice-1 - 0918be781)
- 2026-09-30 11:40: Add downloads, console filters and the `occ agent runtime|logs` callers. (build-2/agent-logs-slice-2)
- 2026-09-30 13:00: Add the OpenShell sandbox source. (build-logs-3/agent-logs-slice-3)
- 2026-09-30 15:30: Overlapping sandbox resume with counted de-duplication; NOT_FOUND is a 503. (fix-3/agent-logs-slice-3)
- 2026-09-30 18:10: Console remembers a runtime status denial per page and points unready-Harness Gateway views to the Harness source. (dogfood3-fix-7)
- 2026-09-30 18:30: Without an active revision the CLI reads the latest revision; a failed deployment links to its version's Logs tab. (fix/dogfood3-5)
- 2026-09-30 20:00: Key remembered denials by operator; the Harness hint ignores a rollout's old Pod and covers a missing Pod. (dogfood3-refix-7)
