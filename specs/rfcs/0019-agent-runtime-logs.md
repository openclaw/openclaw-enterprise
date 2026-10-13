---
status: Proposed
implementation_status: Implemented
author: freeqaz
status_note: "Retroactive record. The design below is implemented on main (PRs #696 through #811, with follow-ups through #2274) and awaits human review. No acceptance decision has been recorded; Proposed is the closest allowed status."
---

# Proposal: Agent runtime status and log reads

- **ID:** RFC-0019
- **Created:** 2026-10-01
- **Last updated:** 2026-10-13
- **RFC PR:** https://github.com/openclaw/openclaw-enterprise/pull/854
- **Implementation:** [#696], [#711], [#726], [#730], [#737], [#739], [#741], [#742], [#745],
  [#747], [#793], [#807], [#811]. Follow-ups: [#863], [#869], [#876], [#879], [#896],
  [#928], [#933], [#939], [#967], [#969], [#973], [#1096], [#1102], [#1108], [#1187],
  [#1354], [#1362], [#1371], [#1591], [#1896], [#1918], [#1922], [#1934], [#1938], [#1946],
  [#1981], [#1994], [#2076], [#2089], [#2110], [#2139], [#2147], [#2153], [#2274]
- **Related:** [Default production observability](0012-production-observability.md) (the
  Collector boundary), [Agent access](0010-agent-access.md) (native admin audience),
  [RFC-0001](0001-oidc-sign-in.md) (sign-in provider outages)
- **Source baseline:** `main` at `07590c64e`, cursor hashing at `84755c0ab` (#2274). Symbols below were checked there.

<a id="problem-and-decision"></a>

## Summary

An Agent administrator can see why a deployed Agent version crashes, restarts or stops
serving, without cluster access. OpenClaw Control Plane (OCC) exposes two routes: runtime
status (Pods, containers, restarts, Pod Events, log sources, Harness Sandbox state) and
one bounded, redacted page of log text per request, surfaced in the console's Logs tab
and `occ agent runtime` / `occ agent logs`. Sources are the Gateway and Agent Pods'
containers and, for OpenShell Harnesses, the sandbox's policy decisions. OCC stores no
log text; the Collector gained only the bounded additions below. Every log view and
download is audited, as kind `access`, before any log text is read. A delegable
`read_logs` Agent permission grants log text without full administration.

Step-by-step behaviour is in the
[runtime logs flow](../../docs/flows/agent-runtime-logs.md).

## Motivation

Before [#696], finding a failing Agent's cause (a bad model key, a crash loop, a blocked
egress request) needed `kubectl`; the bundled Collector strips text by design.

## Decision as landed

### Routes and tiers

| Route (`GET`, under `…/agents/:agentId/deployments/:deploymentId`) | Grants                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `/runtime`                                                         | Agent `operate` + `read`, revision `read`                                      |
| `/runtime/logs`                                                    | Agent `read_logs` (or `administer`) + Agent `read`, any revision of that Agent |

`OpenClawController.describeAgentRuntime` and `readAgentRuntimeLogs`
([packages/occ/src/index.ts](../../packages/occ/src/index.ts)) own the decisions;
`runtimeLogTarget` resolves the revision inside the exact Agent and Namespace.
`authorizeRuntimeLogRead` tries `read_logs` first. It falls back to `administer` only when
no Restriction applies to `read_logs`, so a `read_logs` Restriction blocks an
administrator too. [#745] dropped the revision `read` requirement for log text so a
delegated reader keeps access across redeploys; status still needs it.
`RuntimeLogLimiter` gates both routes after authorization ([#1187]): a per-principal,
per-Agent token bucket (2/s, burst 10, else `429`) and 16 concurrent Driver reads per API
replica (else `503 RUNTIME_LOGS_UNAVAILABLE`).

`read_logs` ([packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)) is
orthogonal for authorization: it implies nothing and nothing implies it. For IAM grant
coverage only, an `administer` grant covers a `read_logs` delegation. Bootstrap does not
grant it ([#737]). Migration
[`0041_restriction_read_logs.sql`](../../migrations/0041_restriction_read_logs.sql) widened
the Restriction action CHECK so such a Restriction can be stored ([#739]).

The log query (`AgentRuntimeLogsQuery`) is closed: `source` (`gateway`, `agent`,
`sandbox`), `pod`, `container`, `previous`, `tailLines` (1 to 1000), `sinceSeconds`,
`cursor`, `download`, `minLevel`. Failures map to fixed `RUNTIME_LOGS_*` codes
([apps/controller/src/http/errors.ts](../../apps/controller/src/http/errors.ts)); Driver
and cluster error text never reaches a client.

### Sources and Driver contract

- `ComputeDriver.describeAgentRuntime?` and `readAgentRuntimeLogs?` return raw lines. Only
  the Kubernetes Driver implements them; Docker and SSH omit them, and
  `runtimeLogging: "driver"` gets `501`. The Kubernetes Driver lists at most 8 Pods per
  role by label, up to 16 main and init containers per Pod ([#1994]), and each Pod's
  newest 100 Events ([#1938]). A log read re-checks Pod ownership and the container, reads
  `pods/log` (1 MiB limit, timestamps), then re-reads the Pod to detect a replaced
  instance; if the Pod is gone, the requested UID and restart count stand. Any `400` on a
  `previous` read, or on a container still being prepared, yields an empty page ([#1922]).
- Timestamps: in runtime status, `validRuntimeDescription` rejects malformed, impossible
  or offset values, so status becomes unavailable rather than showing a different instant
  ([#2139], [#2153]). In log lines, the Driver converts kubelet's numeric offsets to UTC
  without losing precision ([#1934]). The OpenShell client refuses an impossible
  `since_time` ([#2147]).
- `SandboxDriver.readSandboxLogs?` ([#726]) calls OpenShell's read-only `GetSandboxLogs`
  through a reader that exposes only that method. The source is listed only when the
  selected Sandbox Driver provisioned the revision. OpenShell `NOT_FOUND` (absent, still
  provisioning, or concealed by Workspace membership) becomes
  `RUNTIME_LOGS_SANDBOX_NOT_FOUND` and never says which.
- For a dedicated OpenShell Harness, status also carries `harness` from
  `SandboxDriver.observeHarness`: `running`, `starting`, `lost` (OCC will not restart it,
  [#2076]) or `unknown`. `HARNESS_RESTARTING` adds the last exit code and restart number
  ([#2089]).
- Helm `agentRuntimeLogs.enabled` (default `true`, in both charts) grants `pods/log get`
  and `events get,list` to the tenant API, Gateway observer and execution roles ([#967]).
  Off, both routes answer `501`; the roles keep `pods get,list` and `pods/proxy get`.

### Sanitization: one chokepoint

`sanitizeRuntimeLogChunk` and `sanitizeSandboxLogLines`
([packages/occ/src/runtime-logs/sanitize.ts](../../packages/occ/src/runtime-logs/sanitize.ts))
are the only producers of the branded `SanitizedRuntimeLogRecord`. The JSON serializer
and the download writer
([apps/controller/src/http/runtime-logs.ts](../../apps/controller/src/http/runtime-logs.ts))
accept only that type.

- **Classify by allowlist.** Kept: wrapper events with per-event fields; OpenClaw JSON
  console records with fixed keys (without a `subsystem`, only at warn or error, since
  below that it is a `runtime.log` write such as a chat reply, [#869]); Codex tracing
  records; plain text up to 4 KiB. A Codex record keeps its message only for reviewed
  targets and fixed formats; otherwise it reads `Codex message withheld` ([#928], [#969]). Payload keys such as
  `prompt`, `content`, `messages`, `body` and `headers` are never kept. Other JSON,
  including Codex JSON-RPC and pretty-printed JSON ([#742]), is withheld and counted.
- **Redact every kept string.** In container text, PEM blocks are masked across lines and
  pages ([#741]); sandbox messages get only the single-string PEM rule. Also masked: auth
  and cookie headers, JWTs, known token prefixes, cloud keys, URL userinfo, query values,
  credential-named key/value pairs, `Bearer` tokens, and 40+ character runs that are hex
  or base64 mixing upper case and digits. Argv credentials (`-u user:pass`, `-p pass`) are
  masked first ([#869]). Replacements are `[redacted:<pattern>]`.
- **Content labels.** Container lines are labelled `operational`, sandbox lines
  `activity`; nothing is labelled `content` (the serializer throws on it). Labels do not
  guarantee that no chat content remains (see Known gaps).
- **Bounds.** 32 KiB in and 8 KiB out per line, at most 1000 lines, 10 s per request.
  Since [#1981] the 512 KiB response limit covers the serialized page, cursor and
  envelope; the reader returns a fitting prefix, not a maximal one.
- Pod Event messages have node, image, Secret and ConfigMap names masked in standard
  kubelet and scheduler shapes.
- The console and `occ agent logs` show invisible or direction-changing characters in kept
  text as escapes such as `\u202e` ([#1362], [#1371]).

### Views, cursors and audit

A page carries a cursor ([cursor.ts](../../packages/occ/src/runtime-logs/cursor.ts)),
HMAC-signed (not encrypted), bound to principal, Agent, revision and source, and valid
for 1 h. Clients treat it as opaque and poll about every 2 s (the CLI with
`tailLines=1000`). Continuity is rebuilt from re-reads; the
[flow](../../docs/flows/agent-runtime-logs.md#3-read-one-page) has the steps. The
_frontier_ is the newest delivered timestamp; a _checkpoint_ is a signed record of the
raw Driver window a cut page came from, so the next poll continues inside it.

Resume guarantees:

- A delivered line is not shown again, except after a visible reset, which may replay.
- Loss the API can see becomes a `gap`: `stream_replaced` (restart or new Pod UID),
  `window_exceeded` (usually more than `tailLines` lines between polls, or one over-long
  line skipped, [#1102], [#1108]), `cursor_expired`, `truncated`, or `buffer_lost`.
- Not guaranteed: when position is unproven, container lines at the frontier can be
  dropped with no gap (below).

Per source:

- **Container.** A resume reads `sinceSeconds` plus 2 s of overlap (the client has no
  `sinceTime`). The cursor stores the frontier, the count of lines delivered at it,
  whether that count is complete, and the last 16 of their hashes ([#1896], [#1918]). When
  the re-read proves position (complete count, the group's start re-read, ordered times,
  hashes matching the run's end), the first _count_ lines at the frontier are skipped
  whatever their text. Otherwise hashes decide: until time advances,
  a line repeating delivered text is dropped unless the count was complete, and past 16
  lines at one instant every new line there is dropped. Only a response-limit cut creates
  a checkpoint ([#1981]); a 1 MiB Driver cut alone gives `truncated` and resumes by time.
  PEM and withholding state from undelivered lines carry forward.
- **Sandbox.** OpenShell batches lines, so a resume reads 5 s behind the newest delivered
  line and consumes one stored hash per re-read line (up to 48): repeats and late lines
  are delivered. There is no 1 MiB read or checkpoint; ring loss is `buffer_lost`.

A quiet view resumes from its previous read ([#933], [#939], [#973]).

A view is audited once, after the Pod listing and before any log text is read, as
`openclaw.agents.runtime_logs.view` (or `.download` per download) with kind `access`.
It records the admitting action (`read_logs` or `administer`) and the source, Pod,
container, `previous` and tail, never text. A different Pod, container or `previous`
starts a new view; a restart or new Pod UID under the same
name continues it. An expired cursor starts a new, audited view. If the audit write
fails, the request returns `503` with no content. Other polls are re-authorized but not
re-audited. Status reads are not audited, like diagnostics.

### Failure surfacing and noise ([#747], [#793], [#807])

- Runtime Events carry `container`; `occ agent runtime` prints Events and the Harness
  Sandbox state; the console shows a record's `code` on the collapsed row. A terminated
  container reports its current termination, otherwise the prior one ([#1946]). Since
  [#1096], failed model probe events keep a closed `runtimeFailureCause`.
- Status drops the PVC binding-conflict `FailedScheduling` retry once the Pod has a node
  ([#1354]).
- The Harness wrapper pipes Codex stderr through `CODEX_STDERR_FILTER_HELPER`
  ([runtime-entrypoints.ts](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)).
  Unless `RUST_LOG` starts at `debug` or `trace`, it drops INFO span lifecycle records
  (except the `turn` span's `new`/`close`) and a fixed list of idle or expected lines
  ([#876]).
- `minLevel` is a server-side floor applied after the page is read, sanitized and its
  cursor signed; unknown-level lines, gaps and withheld counts are always kept. The CLI
  has `--level` and refuses an explicit zero or sub-second `--since` ([#2110]).

### Collector export ([#793], [#811], [#863], [#879], [#896])

RFC-0012's Collector boundary is unchanged, apart from these bounded additions:

- `codex.turn` and `codex.tool_call` have fixed bodies. A `codex.operational` body keeps
  Codex's message only for `codex_app_server` targets and two fixed retry messages, and
  only as short plain text with no credential words or argv credentials ([#879]); other
  Codex warnings are dropped ([#863]). `gateway.startup_failed` follows the same rules.
- A failed `runtime.startup_phase` keeps its cause as `occ.code` ([#863]).
  `runtime.gateway_settings_overridden` is exported as WARN with no attributes ([#896]).
- `authentication.provider-unavailable-warning` ([#806]) keeps four fixed-vocabulary
  attributes.

## Security and threat model

| Threat                             | Control as landed                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reader sees another Agent's logs | Exact-Agent grants; the Driver reads only Pods carrying the revision's labels and re-checks them and the container. RBAC cannot separate Agents, so this check carries the weight.                                                                                                                                                          |
| Credentials in output              | Allowlist classification, then pattern redaction. PEM state survives container page cuts. Canary tests run planted credentials through the real handler and download. Cursor line and window hashes are 96-bit HMACs under a subkey of the cursor secret, so readers cannot test guesses offline ([#2274]); a verified `v1` cursor expires. |
| Chat content in output             | Payload keys dropped; Codex protocol output and subsystem-less OpenClaw records below warn withheld; Codex messages keep text only for reviewed targets and formats. Kept operational and plain text can still carry fragments (see Known gaps).                                                                                            |
| Forged or rebound cursors          | HMAC binding to principal, Agent, revision and source; mismatch is `400`. The same principal may replay a cursor within its hour.                                                                                                                                                                                                           |
| Unaudited reads                    | Audit before any log text is read; audit failure means no content.                                                                                                                                                                                                                                                                          |
| Lateral cluster actions            | Log reads add only read grants: `pods/log get`, `events get,list`, OpenShell `sandbox:read`.                                                                                                                                                                                                                                                |
| Resource abuse                     | Byte, line and time bounds, plus the token bucket and the concurrency cap.                                                                                                                                                                                                                                                                  |

The `501` switch runs before authorization, so a principal with no grants learns only
whether the feature is on. The rate and concurrency limits wrap only the Driver reads
([#1187]): every denial is refused and audited, and spends no token.

## Rationale and alternatives

- **Gateway `logs.tail` RPC.** Rejected: needs a live Gateway; misses crash loops.
- **Read from Loki or another log store.** Rejected for text: the Collector strips bodies
  and OCE keeps no store.
- **Streaming (SSE).** Deferred. Polling reuses request authorization and holds no kubelet
  connection per viewer, at the cost of the resume machinery.
- **`administer` only.** Slice 1 used it, following the native admin precedent;
  `read_logs` lets log reading be delegated.
- **Audit as `mutation`.** Slice 1 did this; [#737] moved views and downloads to `access`.
- **`RUST_LOG` to quiet Codex.** It cannot drop span events alone.
- **Client-side level filtering only.** Debug lines filled the page first ([#807]).

## Known gaps and residual risk

- Redaction is pattern-based. Opaque tokens with no known prefix, key name or `Bearer` can
  still appear when under 40 characters or not credential-shaped (for example, lower case
  and digits only).
- Content labels are not a guarantee. Kept text can carry fragments of prompts, replies or
  tool output: plain text up to 4 KiB, OpenClaw records with a `subsystem` (any level) or
  at warn or error, messages from reviewed Codex targets, and sandbox `cmd_line` and `url`.
- Following is not lossless. Identical replacement windows are unobservable, and resets
  may replay lines ([#1981]). When a container cursor cannot prove its position, repeated
  frontier lines are dropped with no gap and are lost once time advances.
- Harness stdout and stderr inside an OpenShell sandbox are not readable without attach
  (`sandbox:write`). This needs an upstream read-only RPC.
- Sandbox decisions often show policy generation "unknown": OpenShell does not stamp it on
  CONNECT allows. The 2000-line ring is lost on gateway restart, and push drops are
  inferred, not reported. Sandbox tests use synthetic lines and loopback gRPC, not a live
  OpenShell.
- Kubernetes keeps only the current and previous container instance.
- `occ agent logs` has no container flag; it reads the default first main container.
- The Codex stderr filter is keyed to Codex 0.158 shapes; the image ships 0.163.0-alpha.2
  since [#2029]. A rename lets noise back rather than hiding other lines.
- Rate and concurrency limits are per API replica.
- Operators must refresh the Collector config Secret on upgrade to get the export changes.

## Open questions for reviewers

1. Should `agentRuntimeLogs.enabled` default to on? **Implemented:** yes.
2. Should `administer` keep admitting log text? **Implemented:** yes, unless a `read_logs`
   Restriction applies.
3. Should log text cover every revision while status needs revision `read`?
   **Implemented:** yes ([#745]).
4. Is one audit row per view enough? **Implemented:** yes.
5. Should Codex message text be exported? **Implemented:** yes, as listed above.
6. Should `minLevel` read more lines to fill the page? **Implemented:** no; a page can show
   fewer lines than requested.
7. Is a best-effort follow acceptable without a backend sequence number, given visible
   resets and silent frontier drops? **Implemented:** yes; no sequence was added.
8. Should the OpenShell gaps above be filed upstream? **Implemented:** not yet.
9. Should the console offer a log-only share? **Implemented:** no; only the Namespace IAM
   Role API grants `read_logs`.

## Delivery history

Slices 1 to 3 ([#696] to [#811]) landed on 2026-09-30 and 2026-10-01, with hardening
through 2026-10-05 and resume, budget, container and timestamp follow-ups from 2026-10-09
to 2026-10-12. [#2274] (2026-10-13) keyed cursor hashes; `v1` cursors expire. [#1591]
and [#1213] only moved code.

## References

- Guide: [Agent logs](../../docs/guides/topics/agent-logs.md); flow:
  [Agent runtime logs](../../docs/flows/agent-runtime-logs.md); security:
  [Console and API runtime log reads](../../docs/reference/security.md#console-and-api-runtime-log-reads).
- Code: [packages/occ/src/runtime-logs/](../../packages/occ/src/runtime-logs/index.ts),
  [apps/controller/src/http/runtime-logs.ts](../../apps/controller/src/http/runtime-logs.ts),
  [apps/controller/src/console/agents/logs.mjs](../../apps/controller/src/console/agents/logs.mjs),
  [internal/occcli/agent_runtime.go](../../internal/occcli/agent_runtime.go),
  [deploy/logging/collector.yaml](../../deploy/logging/collector.yaml).
- Tests: [runtime-logs-content](../../tests/conformance/runtime-logs-content.test.mjs),
  [occ-api-security](../../tests/conformance/occ-api-security.test.mjs).

[#696]: https://github.com/openclaw/openclaw-enterprise/pull/696
[#711]: https://github.com/openclaw/openclaw-enterprise/pull/711
[#726]: https://github.com/openclaw/openclaw-enterprise/pull/726
[#730]: https://github.com/openclaw/openclaw-enterprise/pull/730
[#737]: https://github.com/openclaw/openclaw-enterprise/pull/737
[#739]: https://github.com/openclaw/openclaw-enterprise/pull/739
[#741]: https://github.com/openclaw/openclaw-enterprise/pull/741
[#742]: https://github.com/openclaw/openclaw-enterprise/pull/742
[#745]: https://github.com/openclaw/openclaw-enterprise/pull/745
[#747]: https://github.com/openclaw/openclaw-enterprise/pull/747
[#793]: https://github.com/openclaw/openclaw-enterprise/pull/793
[#806]: https://github.com/openclaw/openclaw-enterprise/pull/806
[#807]: https://github.com/openclaw/openclaw-enterprise/pull/807
[#811]: https://github.com/openclaw/openclaw-enterprise/pull/811
[#863]: https://github.com/openclaw/openclaw-enterprise/pull/863
[#869]: https://github.com/openclaw/openclaw-enterprise/pull/869
[#876]: https://github.com/openclaw/openclaw-enterprise/pull/876
[#879]: https://github.com/openclaw/openclaw-enterprise/pull/879
[#896]: https://github.com/openclaw/openclaw-enterprise/pull/896
[#928]: https://github.com/openclaw/openclaw-enterprise/pull/928
[#933]: https://github.com/openclaw/openclaw-enterprise/pull/933
[#939]: https://github.com/openclaw/openclaw-enterprise/pull/939
[#967]: https://github.com/openclaw/openclaw-enterprise/pull/967
[#969]: https://github.com/openclaw/openclaw-enterprise/pull/969
[#973]: https://github.com/openclaw/openclaw-enterprise/pull/973
[#1096]: https://github.com/openclaw/openclaw-enterprise/pull/1096
[#1102]: https://github.com/openclaw/openclaw-enterprise/pull/1102
[#1108]: https://github.com/openclaw/openclaw-enterprise/pull/1108
[#1187]: https://github.com/openclaw/openclaw-enterprise/pull/1187
[#1213]: https://github.com/openclaw/openclaw-enterprise/pull/1213
[#1354]: https://github.com/openclaw/openclaw-enterprise/pull/1354
[#1362]: https://github.com/openclaw/openclaw-enterprise/pull/1362
[#1371]: https://github.com/openclaw/openclaw-enterprise/pull/1371
[#1591]: https://github.com/openclaw/openclaw-enterprise/pull/1591
[#1896]: https://github.com/openclaw/openclaw-enterprise/pull/1896
[#1918]: https://github.com/openclaw/openclaw-enterprise/pull/1918
[#1922]: https://github.com/openclaw/openclaw-enterprise/pull/1922
[#1934]: https://github.com/openclaw/openclaw-enterprise/pull/1934
[#1938]: https://github.com/openclaw/openclaw-enterprise/pull/1938
[#1946]: https://github.com/openclaw/openclaw-enterprise/pull/1946
[#1981]: https://github.com/openclaw/openclaw-enterprise/pull/1981
[#1994]: https://github.com/openclaw/openclaw-enterprise/pull/1994
[#2029]: https://github.com/openclaw/openclaw-enterprise/pull/2029
[#2076]: https://github.com/openclaw/openclaw-enterprise/pull/2076
[#2089]: https://github.com/openclaw/openclaw-enterprise/pull/2089
[#2110]: https://github.com/openclaw/openclaw-enterprise/pull/2110
[#2139]: https://github.com/openclaw/openclaw-enterprise/pull/2139
[#2147]: https://github.com/openclaw/openclaw-enterprise/pull/2147
[#2153]: https://github.com/openclaw/openclaw-enterprise/pull/2153
[#2274]: https://github.com/openclaw/openclaw-enterprise/pull/2274
