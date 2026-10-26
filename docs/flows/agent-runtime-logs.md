---
created: 2026-09-30
updated: 2026-10-24
last_updated_session: authoring-run/3954aa04-12f8-4a8e-bb62-a4d9a8603edd
---

# Agent runtime logs flow

## Overview

Authorized reads return size-limited, redacted Compute records; downloads stay local.

## Entry Points

- `GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId/runtime`
  and `GET .../runtime/logs` (`download=true` for attachments) from Console,
  `occ agent runtime|logs` (`internal/occcli/agent_runtime.go`) or API. See
  [CLI reference](../reference/cli.md#runtime-status-and-logs).
- Source: `apps/controller/src/index.ts:createFastifyApp`,
  `packages/occ/src/index.ts:OpenClawController.describeAgentRuntime` and
  `readAgentRuntimeLogs`, `packages/occ/src/runtime-logs/`, and
  `apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.describeAgentRuntime`
  and `readAgentRuntimeLogs`.
- Assumptions: `deploymentId` identifies this Agent's saved version.
  Status requires Agent `operate`/`read` and Agent revision `read`. Logs require Agent
  `read` and `read_logs` (or `administer`, unless a Restriction denies `read_logs`),
  covering every Agent revision. `authorizeRuntimeLogRead` checks
  `read_logs` first.

## Flow

```mermaid
graph TD
  V["CLI version probe"] --> W{"Pods?"}
  W -->|yes| Z{"Proven older?"}
  Z -->|no or unreadable| X["Select candidate"]
  Z -->|yes| Y["Retain active"]
  W -->|no| T{"Concrete Harness, proven newer?"}
  T -->|yes| X
  T -->|no or refused| Y
  X --> A["GET runtime or runtime/logs"]
  Y --> A
  A --> B["Feature switch"]
  B -->|off| C["Return 501"]
  B -->|on| E["OCC authorizes version and Agent tier"]
  E -->|denied| F["Audit denial, return 403"]
  E -->|authorized| G["Select recorded Compute Driver"]
  G -->|no method or driver-owned logging| C
  G -->|supported| S["Rate and concurrency limits"]
  S -->|limited| D["Return 429 with Retry-After, or 503"]
  S -->|admitted| H["Driver lists version Pods and Pod Events per plane"]
  H --> I["OCC validates and redacts the description"]
  I -->|status route| J["Return runtime description"]
  I -->|logs route| K["Validate cursor and listed Pod"]
  K -->|invalid| L["Return 400"]
  K -->|new view or download| M["Write view or download audit event"]
  M -->|failed| N["Return 503, no content"]
  M -->|written| O["Driver limits log reads and re-reads Pod"]
  K -->|cursor poll| O
  O --> P["De-duplicate, label gaps, classify and redact"]
  P --> Q["Return sanitized page and signed cursor"]
  P -->|download=true| R["Return the same records as a text/plain attachment"]
```

## Execution Trace

### 1. Admit and authorize

`internal/occcli/cli.go:validateOptions` checks explicit `--output` before
requests; default: `text`.

`internal/occcli/agent_runtime.go:agentRevision` honors `--revision`. Otherwise,
`newerRevisionWithRuntime` reuses status, excludes Pod candidates proven older by
`Client.GetAgentRevision`, and requires Harness-only candidates to be proven newer.

`packages/contracts/src/api/routes.ts:occApiRoutes` declares both GET routes with
a closed query schema. `apps/controller/src/index.ts:perform` answers `501` when
`agentRuntimeLogs` is disabled. `OpenClawController.runtimeLogTarget` authorizes
the tier action and Agent `read` (plus Agent revision `read` for status only), resolves
the version within the exact Agent, then rejects a Driver without
`describeAgentRuntime` or with `runtimeLogging: "driver"`. `apps/controller/src/http/runtime-logs.ts:RuntimeLogLimiter` admits reads;
audited denials spend no token; time buckets ignore clock changes.

### 2. Describe the runtime

`KubernetesComputeDriver.describeAgentRuntime` lists owned-Namespace Pods by
Agent, Agent revision ID, and role labels. Single-cluster profiles read
Gateways and Harnesses in the tenant namespace; two-cluster profiles read
Gateways from control and Harnesses from execution. It reports a terminated
container's current termination, otherwise the prior one. Event
reads keep the Pod's 100 newest eligible Events across pages,
drop a settled `FailedScheduling` PVC retry, and derive `container` from
`involvedObject.fieldPath` (`null` for Pod Events). A log read passes
`{ source, events: false }`. Each
Kubernetes call has a five-second deadline; a `403` becomes
`RuntimeLogsForbiddenByClusterError`. `runtime-logs/description.ts:validRuntimeDescription`
checks names, UIDs, counts and RFC 3339 UTC timestamps. Malformed, impossible
or offset timestamps, including Kubernetes Pod and Event times, make runtime status
unavailable; they are never normalized to another instant.
`runtime-logs/redact.ts:maskRuntimeEventText` masks node, image and Secret names;
reasons and Event messages are redacted.

### 3. Read one page

`runtime-logs/read.ts:readRuntimeLogPage` verifies the cursor HMAC against principal,
Agent, version and source (`runtime-logs/cursor.ts`). Select a listed Pod and main or
init `container` (default: first main). A different stream, missing or expired cursor (one hour),
or departed Pod starts a new view. First record the admitting action in the `openclaw.agents.runtime_logs.view`
access audit. The Driver rechecks Pod ownership and the declared container, then calls `readNamespacedPodLog` with `tailLines`, `sinceSeconds`,
`previous`, a 1 MiB `limitBytes` and timestamps, and re-reads the Pod. For a never-started
container, kubelet's exact `400` waiting-to-start Status (`PodInitializing` or
`ContainerCreating`) yields an empty page; logs are requested first, so stale
status cannot hide output, and other failures keep their error mapping.
`kubernetesRuntimeLogLine` separates kubelet's RFC3339 timestamp from each raw
line and converts numeric offsets to UTC while retaining every fractional digit.
Unknown or malformed offset prefixes remain untimed raw text. A cursor
poll derives `sinceSeconds` from the cursor: from its newest delivered line, or,
when the view has delivered nothing yet, from the previous read (a full or
byte-cut tail then emits `window_exceeded`). If every poll stalls because a line cannot fit the 1 MiB read limit, and that
cut line is over about 3 seconds old, the cursor resumes from the current read.
`window_exceeded` dates the lost interval. A carried PEM block loses its time
boundary and stays conservatively masked. Earlier lines are dropped.
Cursors are signed, not encrypted. Keyed line and window hashes prevent testing masked values;
even verified `v1` cursors expire into a new audited view.
For the frontier time, the cursor stores `frontierComplete`, `frontierCount`
and the last 16 hashes. Positional de-duplication requires a complete frontier,
its group's first line in the read (an earlier timestamp or a short uncut page),
ordered valid times and matching suffix hashes. It skips `frontierCount`
occurrences, preserving groups larger than 16. Hash fallback consumes matching
occurrences and invalidates the count when delivering at that frontier. A new
hash is accepted only with complete hash history; extra identical occurrences
also require frontier completeness.

Completeness requires an ordered consumed prefix after the earliest fetched time,
or a short uncut Driver page, and persists while time stays unchanged. Otherwise
matching-time text stays suppressed until time advances; enlarging a cut tail
must not reveal old occurrences as new. Legacy counts are inferred only below
16 hashes. Byte cuts preserve counts for complete frontiers.
It emits `stream_replaced`,
`window_exceeded`, `cursor_expired` or `truncated` gaps, and passes the rest to
`runtime-logs/sanitize.ts:sanitizeRuntimeLogChunk`, the only producer of
`SanitizedRuntimeLogRecord`. `page-budget.ts` measures serialized pages,
signed cursors and the HTTP envelope against 512 KiB. Oversized pages shrink to a fitting, not maximal, prefix without new I/O or audits. Fetched masking/withholding persist;
state advances through delivered rows.

Signed `pemOpen`/`pemAfterTime` describe delivered boundaries, never fetched overlap.
Timestamp order is validated through the last delivered line; each line is
compared with the prior cursor's reliable boundary, not earlier same-page lines. Only a line strictly
newer than that prior frontier can close a carried open block. Thus an ordered
same-page BEGIN and END at the same newer timestamp can close it. Times at or
before the prior frontier and evicted line hashes do not establish forward
progress; replayed overlap cannot erase a carried later BEGIN. Ordinary non-PEM
text remains visible while ambiguous context stays open.

Missing, invalid or reordered times make the frontier uncertain (`null`); later
timestamped pages alone cannot repair it. Empty polls preserve it,
and lines beyond the page or byte cut do not advance it. A new view, expiry,
instance/Pod change or replacement during the read discards the old context.
The paired fields share the cursor MAC; malformed
or inconsistent pairs fail as `cursor_invalid` before a Driver read. Legacy
cursors and initial tails without observed PEM boundaries remain unknown and
best-effort.

`source=sandbox` skips Compute description. `OpenClawController.readSandboxLogs`
requires the provisioning Sandbox Driver's `readSandboxLogs`, resolves Compute
placement through `resolveSandboxNamespace`, then runs
`runtime-logs/sandbox.ts:readSandboxLogPage`.
`OpenShellSandboxDriver.readSandboxLogs` derives the Sandbox name from the
version and calls `GetSandboxLogs` through `openShellSandboxLogReader`, which
exposes nothing else. The client rejects impossible `since_time` dates before gRPC. OpenShell batches
timestamped supervisor lines and filters by those timestamps. Resume overlaps
`SANDBOX_LOG_OVERLAP_MS` (5 s); the cursor retains up to 48 delivered line hashes,
consumed on reread. First pages retain the requested window start.
Signed checkpoints retain prefix digest/count, query floor and baseline, with
2-second container overlap. Timed windows resume progress; changed tails or
ambiguous replacements reset with gaps. Sandbox pins short/unordered windows,
untimed rows and overflowing groups. Full timed groups use counted overlap;
cuts retain a rollover witness. Uncertain context resets with a gap and replay;
container recovery gaps once unless a short uncut window precedes the delivered frontier.
All-untimed Driver byte cuts retain progress;
mixed cuts advance through time with an explicit reset that may replay untimed rows.
Matching checkpoints retain positional proof. Stable windows drain overflowing groups. UID/restarts reset progress; PEM recovery
keeps masking. Identical replacements remain unobservable; full checkpoints, missing
anchors or overflowing timestamp groups report gaps. gRPC `NOT_FOUND` (absent
Sandbox, or concealed from a non-member) maps to
`RUNTIME_LOGS_SANDBOX_NOT_FOUND`, never to an empty page. Lines naming two
Sandbox IDs are refused; a new Sandbox ID emits `stream_replaced`.
The OpenShell Driver adds decision fields; OCC removes sensitive values. See [policy evidence](agent-sandbox-policy.md).

Downloads (`download=true`) force `tailLines=1000`, reject cursors (`400`), and start
a new view; `apps/controller/src/index.ts:auditAction`
names its audit event, and any denial, `openclaw.agents.runtime_logs.download`.

### 4. Return

`apps/controller/src/http/runtime-logs.ts:runtimeLogPageBody` and `runtimeLogDownloadBody`
reject reserved `content`. Container headers label `instance` without Pods. Console and `runtimeLogDownloadFileName`
take `-previous.log` from the request; current and Sandbox names stay unchanged.
`runtimeLogPageAtLevel` filters after signing, preserving unknown levels, gaps and withheld counts.

`console/agents/logs.mts` clears output when status selects another source, Pod or instance.
Only a readable replacement starts a fresh tail. Status denial preserves log access; cached `403` avoids repeat denials.
Filters use loaded rows; debug is opt-in. Pod cards show state/exit; Gateway links Harness output or Deployment activity.

CLI rejects `--since` below one second; omission leaves reads unfiltered. `runAgentLogs --follow`
polls every two seconds; cancellation succeeds only for follow. `internal/occclient/transport.go:apiError`
accepts `Retry-After` seconds or HTTP dates: positive delays ≤1h round up to seconds; invalid or expired values retain the interval.
Driver failures use fixed `RUNTIME_LOGS_*` codes; requests have ten-second deadlines.

## Debugging and Verification

- `go test ./internal/occcli -run '^TestResourceRequestStopsWhenCommandContextIsCanceled$'`
  proves loopback CLI cancellation, not deployed OCC behavior.

- `503 RUNTIME_LOGS_CLUSTER_RBAC`: API ServiceAccount lacks namespace
  `pods/log`, `events` or execution-cluster `pods` reads.
  `503 RUNTIME_LOGS_AUDIT_UNAVAILABLE`: no output read.
- `runtime-logs-content.test.mjs` verifies handlers with synthetic Driver pages;
  `occ-api-security.test.mjs` verifies authorization and cursor failures.
  Kubernetes conformance substitutes API observations; Sandbox conformance/wire tests prove
  protocol boundaries, not runtime execution.

## Related docs

- [Agent logs guide](../guides/topics/agent-logs.md)
- [Console and API runtime log reads](../reference/security.md#console-and-api-runtime-log-reads)
- [Compute Driver runtime status and logs](../reference/drivers/compute.md#optional-runtime-status-and-logs)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-24 13:19: Validate output. (authoring-run/3954aa04-12f8-4a8e-bb62-a4d9a8603edd - 1b59554add06e9f7be0b0a730202f558c939a661)

- 2026-10-19 09:48: Preserve main and policy traces; condense prose. (authoring-run/545665b0-3aef-44dc-beb8-492b753b1a13 - bc3ba215dd9927692bc2882ffaf06a35c27fed4a)

- 2026-10-17 22:06: Align log output with status-driven selection changes. (authoring-run/77795960-6a71-4c2d-95a7-3c0c0558e489 - ee93918670368e1f34ae39b7a5f32744d8fae78e)

- 2026-10-17 18:04: Use monotonic request-bucket time. (authoring-run/5775742a-69b2-4b9b-947e-198df50d9f40 - 4c15e69650b440b8b4bbd995bb61669f69d1d049)

- 2026-10-16 19:09: Retain Pods unless proven older. (codex/01a10a81-070c-7aa3-97d0-fbce8f285d4d - 646709121b8ad092df151d16cd4ca6a6c523e34d)

- 2026-10-16 13:46: Require Pod candidate recency. (authoring-run/75d1c4b0-a13f-4188-9aec-3adb7fa43164 - 591feb34bdbaaf7f316607347a02f7335ee816c0)

- 2026-10-15 20:56: Label container exports. (authoring-run/5d925828-f306-4469-bedb-9c60bc9c6def - 7041b4c11a1bc9109fbb150beac2f8bc430474a6)

- 2026-10-15 22:11: Merge main; preserve both flows. (authoring-run/8e4e2c2d-907a-411c-96f0-f882c1118e6d - 20d9edc976cc)

- 2026-10-15 10:38: Verify Podless Harness recency; unknown ordering retains active. (authoring-run/7163351c-af75-410f-bd45-a2809e178c9e - c1a15e2e953c)

- 2026-10-15 09:08: Select newer provider Harness status before version Pods exist. (authoring-run/7163351c-af75-410f-bd45-a2809e178c9e - 422cb3fe407204d4add49ea8494f0fd0ce49be52)

- 2026-10-15 09:25: Honor HTTP-date Retry-After in CLI follow. (authoring-run/613fa018-dc4e-4c4d-b05b-f2f8f79e3244 - 422cb3fe407204d4add49ea8494f0fd0ce49be52)
- 2026-10-15 16:14: Move OpenShell decision parsing into its Driver; redact shared metadata. (authoring-run/43cb74b9-e1fe-4fc2-adde-9d932b061d7c - a28596ab8)

- 2026-10-13: Key cursor hashes; `v1` cursors expire. (#2274)

- 2026-10-12 11:55: Advertise and select actual main and init container streams with container-bound audit views. (authoring-run/adccd418-cf61-4fbb-b3ba-0fcad194d907 - 040e7498ecd89e0e565af71f234776ecfaad2186)

- 2026-10-11: Reject impossible OpenShell timestampMessage values before gRPC. (#2146)

- 2026-10-11 09:48: Refuse impossible or offset Kubernetes Pod and Event times. (fix-1096 - 839b0c90cb1c54d7ed70eb23229bd117f25278be)

- 2026-10-11 15:20: Reject malformed or impossible Compute Driver timestamps at the runtime-description boundary. (authoring-run/b5dc3ace-2767-4645-9b89-e30d18fa3184 - 2a1eae472d6a820a574cdbcb75dd7d31e3619a68)

- 2026-10-11 09:10: Reject sub-second runtime-log `--since` before any API request. (issue-2114 - 724b37bd1630f0b066bb2cbc23e3e965d172f9a7)

- 2026-10-11 08:15: Distinguish an omitted runtime-log `--since` from an explicit zero and refuse the latter before any API request. (issue-2109 - 731db98bbbc8e5296571e64130ac62482413520e)

- 2026-10-10 13:17: Resume partial groups; deduplicate gaps. (authoring-run/46f029c3-e915-4829-949b-638e0b2be118 - 59b9c9eec562e50df8e3cbe9669a2e6f697ba37d)

- 2026-10-10 09:27: Follow moving byte-cut windows. (authoring-run/8a9638ae-99ab-4dca-9759-92fe81e8d280 - 8741e9f5e2a915ac5c2dcb076479cc9e23d8c5cb)

- 2026-10-10 08:12: Retain overlap and Sandbox gaps. (authoring-run/e28bad2a-a77a-4033-aa7c-174ac006a870 - a2911f897dfdd9d748f8e65065da5196b7749eff)

- 2026-10-10 07:56: Preserve final-drain gaps. (authoring-run/9cfa5b3b-2ef8-4413-a9ec-458eb1ba7fdd - 5533e03c05db33fdec64574893190f8ec4096bb0)

- 2026-10-10 07:45: Advance mixed byte-cut windows. (authoring-run/8b207d82-4eff-4478-872a-80762052a959 - 42351dce1d1e1a4faf457edd87da96fa8d6169c4)

- 2026-10-10 07:44: Merge main; preserve histories. (authoring-run/19081d63-7696-4bb4-9fcd-1d6e0ffce0a0 - 3bfadece19cdbea1a23574549265953f9d0e54fc)

- 2026-10-10 07:32: Preserve untimed cut progress. (authoring-run/3dcf8b04-24bd-4739-ac19-fb70f6064952 - f9b208a0ac5e1e5118c2f8dcc9050c27ff23061c)

- 2026-10-10 07:17: Retain positional progress. (authoring-run/858ce292-681c-43ab-a4d3-0640d3380971 - a9176a61cf209915e2ccab3f862db9a2bc750754)

- 2026-10-10 05:09: Compact hashes and window tuples; retain legacy decoding. (authoring-run/377d6942-f5b9-4c5f-825c-cdfdfeea7501 - 95c76244bcc6f88989993a30730e63dc45b87f65)

- 2026-10-10 05:02: Unify Sandbox overlap baselines. (authoring-run/c8de19eb-fe81-4a26-b639-a0cb02360f23 - a0fd14ec40c2e5b8c66537e457ddd2d8202adc6e)

- 2026-10-10 04:37: Compose safety evidence with Events. (authoring-run/39d848cc-a298-48fd-9f82-c39b85089b94 - 8e5a06cec7f622185222a8a7dbafe3b0a7228d9f)

- 2026-10-10 04:19: Preserve masking evidence. (authoring-run/d983fb2c-0a98-43db-8690-ddb7f5b43f87 - 9222f0073c951203c5f959bc9382dbb13c605ee9)

- 2026-10-10 04:10: Preserve rounded and empty windows. (authoring-run/b4a36577-a96a-44f4-9600-41b94747c1c9 - d791a48aa0baacfef2dede241c6161ad9c82e89a)

- 2026-10-10 03:27: Keep recovery cursors valid and mark full Sandbox windows. (authoring-run/50fe6eec-f154-4d38-9cb5-8e755a82ded9 - dd55627538daa7b7ae43c431ab9db37ae878cc65)

- 2026-10-10 03:05: Drain Container cuts. (authoring-run/b68ecd62-c0d7-4fbf-82ee-0f440d8ae84c - 4e23a961fff52cb453a4114afc922278205d3fec)

- 2026-10-10 02:53: Fit termination status in response budgets. (authoring-run/2cbbcc37-919d-41ec-bdab-51aa836d92b7 - 880b645f5e5fb5c99c6046c1eac6ca81211be584)

- 2026-10-10 02:47: Keep untimed replacement progress. (authoring-run/fd5e728e-9e9f-42ea-8ab7-d389f82b973d - f4c9a1b36988d659f8f927825fda4cd838ae832a)

- 2026-10-10 02:43: Retain Sandbox cut progress; report changed snapshots. (authoring-run/2edda611-948b-44ae-a3d8-0a011073b719 - 5c7c56b49f16b80c4fcb91fedff0959a5fd733b0)

- 2026-10-10 01:14: Bound Container and Sandbox pages, cursors and API frame. (authoring-run/018d11d8-3699-4e97-945b-c2cfd3088412 - 243b38ba6d951240065e5061e1e4abccdb44410c)
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

- 2026-10-07 05:26: Point CLI runtime reads and log polling to their dedicated source owner; clarify the existing version selection. (authoring-run/9ac89b09-043f-44ba-8069-d0a90859ed7b - 61590165cdbb)

- 2026-10-05 11:38: Document clean CLI follow cancellation during initial version lookup with the accompanying fix. (authoring-run/2afba01b-8db4-41d7-a942-e14bd7f44262 - 0698d533b97dc3abe7bef7ff7907a0f4335c3182)
- 2026-10-05 10:51: Preserve shared tenant placement while incorporating main startup and runtime diagnostics. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 71a1cedb)

- 2026-10-04 07:00: Authorize before the rate and concurrency limits so every denial is audited. (bh11-runtime-log-authz)

- 2026-10-03 22:00: A resumed view moves past a line longer than the 1 MiB read limit instead of re-reading it on every poll. (f349-log-resume)

- 2026-10-03 03:00: A cursor from a page that delivered no line resumes from that page, not the whole tail. (bughunt-1/fix-runtime-logs-quiet-follow)

- 2026-10-02: Describe shared single-cluster runtime placement. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-01 14:00: Add the server-side `minLevel` floor and the console's **Include debug** control. (fix-d79 - 3d6ce1fdb)

- 2026-09-30 23:44: Clarify the prior cursor frontier and ordered same-page PEM boundaries without changing masking behavior. (authoring-run/2c8a089c-ec67-402d-8cfd-ec8b29c5e3fe - a4cddf26bc462744bfff912b1e1cdb9f1ee60cd2)

- 2026-09-30 20:37: Receive cursor-context masking with current runtime-log guidance and preserve the current view behavior. (authoring-run/e2da7c2d-8080-4dd4-9ce9-d494b890234c - fb22aa07c1613218280cff25d6b62bfb4cff6b5d)

- 2026-09-30 19:43: Carry authenticated PEM context across container polls with read limits without closing on ambiguous overlap. (authoring-run/b5fcaf0e-328a-4fe2-b53f-e72268ef70af - affac2bfc1370e590e6da570bcaaad4a207c9f09)

- 2026-09-30 08:30: Document runtime status and container log reads for Kubernetes Compute. (build-1/agent-logs-slice-1 - 0918be781)
- 2026-09-30 11:40: Add downloads, console filters and the `occ agent runtime|logs` callers. (build-2/agent-logs-slice-2)
- 2026-09-30 13:00: Add the OpenShell sandbox source. (build-logs-3/agent-logs-slice-3)
- 2026-09-30 15:30: Overlapping sandbox resume with counted de-duplication; NOT_FOUND is a 503. (fix-3/agent-logs-slice-3)
- 2026-09-30 18:10: Console remembers a runtime status denial per page and points unready-Harness Gateway views to the Harness source. (dogfood3-fix-7)
- 2026-09-30 18:30: Without a selected version the CLI reads the latest version; a failed deployment links to its version's Logs tab. (fix/dogfood3-5)
- 2026-09-30 20:00: Key remembered denials by operator; the Harness hint ignores a rollout's old Pod and covers a missing Pod. (dogfood3-refix-7)
