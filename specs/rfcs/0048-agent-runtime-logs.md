---
status: Proposed
status_note: "Retroactive record. The design below is implemented on main (PRs #696 through #811, with follow-ups through #969) and awaits human review. No acceptance decision has been recorded; Proposed is the closest allowed status."
---

# Proposal: Agent runtime status and log reads

- **ID:** RFC-0048
- **Owner:** needs a human owner; this record was written from the landed PRs
- **Created:** 2026-10-01
- **Last updated:** 2026-10-03
- **RFC PR:** https://github.com/openclaw/openclaw-enterprise/pull/854
- **Implementation:** [#696], [#711], [#726], [#730], [#737], [#739], [#741], [#742], [#745],
  [#747], [#793], [#807], [#811] (with the event from [#806]). Follow-ups: [#863], [#869],
  [#876], [#879], [#896], [#928], [#933], [#939], [#967], [#969]
- **Related:** [Default production observability](36-production-observability.md) (the
  Collector boundary), [Agent access](36-agent-access.md) (native admin audience),
  [RFC-0042](0042-oidc-sign-in.md) (sign-in provider outages)
- **Source baseline:** `main` at `04d01d02e`. Symbols below were checked there.

<a id="problem-and-decision"></a>

## Summary

An Agent administrator can now see why a deployed Agent version crashes, restarts or
stops serving, without cluster access. OpenClaw Control Plane (OCC) exposes two routes:
runtime status (Pods, containers, restarts, Pod Events, log sources) and one bounded,
redacted page of log text per request. The console has a Logs tab, and the CLI has
`occ agent runtime` and `occ agent logs`. Sources are the Gateway container, the Agent
(Harness) container, and, for OpenShell Harnesses, the sandbox's policy decisions.
OCC stores no log text and the routes export nothing; the bundled Collector's allowlist
gained only the bounded additions listed under Collector export below. Every log view and download is audited before the read,
as the new audit kind `access`. A new, delegable `read_logs` Agent permission grants log
text without full administration.

## Motivation

Before [#696], diagnostics did not inspect Pods, Events or logs, and the bundled Collector
strips text by design. A failing Agent's cause (a bad model key, a crash loop, a blocked
egress request) was visible only to someone with `kubectl`.

## Decision as landed

### Routes and tiers

| Route (`GET`, under `…/agents/:agentId/deployments/:deploymentId`) | Grants |
| --- | --- |
| `/runtime` | Agent `operate` + `read`, revision `read` |
| `/runtime/logs` | Agent `read_logs` (or `administer`) + Agent `read`, any revision of that Agent |

`OpenClawController.describeAgentRuntime` and `readAgentRuntimeLogs`
([packages/occ/src/index.ts](../../packages/occ/src/index.ts)) own the decisions;
`runtimeLogTarget` resolves the revision inside the exact Agent and Namespace.
`authorizeRuntimeLogRead` tries `read_logs` first. It falls back to `administer` only when
no Restriction applies to `read_logs`, so a `read_logs` Restriction blocks an
administrator too. [#745] dropped the revision `read` requirement for log text so a
delegated reader keeps access across redeploys; status still needs it.

`read_logs` is in `PERMISSION_ACTIONS` ([packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)).
It is orthogonal: it implies nothing and nothing implies it, and bootstrap does not grant
it ([#737]). Migration
[`0041_restriction_read_logs.sql`](../../migrations/0041_restriction_read_logs.sql) widened
the Restriction action CHECK so such a Restriction can be stored ([#739]).

The log query is closed: `source` (`gateway`, `agent`, `sandbox`), `pod`, `previous`,
`tailLines` (1 to 1000), `sinceSeconds`, `cursor`, `download`, `minLevel`. Failures map to
fixed `RUNTIME_LOGS_*` codes
([apps/controller/src/http/errors.ts](../../apps/controller/src/http/errors.ts)); Driver
and cluster error text never reaches a client.

### Sources and Driver contract

- `ComputeDriver.describeAgentRuntime?` and `readAgentRuntimeLogs?` return raw lines. The
  Kubernetes Driver reads `pods/log` (1 MiB limit, timestamps) and Events by
  `involvedObject.uid`, only for Pods listed for that revision, and re-reads the Pod after
  the log read. Docker and SSH omit the methods; `runtimeLogging: "driver"` gets `501`.
- `SandboxDriver.readSandboxLogs?` ([#726]) calls OpenShell's read-only `GetSandboxLogs`
  through a reader that exposes only that method. The source is listed only when the selected Sandbox Driver provisioned the
  revision. OpenShell `NOT_FOUND` (absent, still provisioning, or concealed by Workspace
  membership) becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND` and never says which.
- Helm `agentRuntimeLogs.enabled` (default `true`, in both charts) grants `pods/log get`
  and `events get,list` to the tenant API, Gateway observer and execution tenant API
  roles. Off, both routes answer `501`. Those roles hold `pods get,list` and `pods/proxy
  get` either way, for diagnostics ([#967] for the execution role).

### Sanitization: one chokepoint

`sanitizeRuntimeLogChunk` and `sanitizeSandboxLogLines`
([packages/occ/src/runtime-logs/sanitize.ts](../../packages/occ/src/runtime-logs/sanitize.ts))
are the only producers of the branded `SanitizedRuntimeLogRecord`. The JSON serializer
and the download writer
([apps/controller/src/http/runtime-logs.ts](../../apps/controller/src/http/runtime-logs.ts))
accept only that type.

- **Classify by allowlist.** Kept: runtime wrapper events with per-event fields; OpenClaw
  JSON console records with a fixed key list (without a `subsystem`, only at warn or
  error: below that it is a `runtime.log` write such as a chat reply, [#869]); Codex
  tracing records; and plain text up to 4 KiB as `text`/`unknown`. A Codex record keeps
  its message only for reviewed operational targets (`CODEX_MESSAGE_TARGET`) and reviewed
  fixed formats (`CODEX_FIXED_MESSAGES`); otherwise it reads `Codex message withheld`
  ([#928], [#969]). Payload keys such as `prompt`, `content`, `messages`,
  `body` and `headers` are never kept. Any other JSON, including Codex JSON-RPC and
  pretty-printed JSON spread over several lines ([#742]), is withheld and counted.
- **Redact every kept string.** PEM blocks are masked on every line, also across pages
  ([#741]). Also masked: auth and cookie headers, JWTs, known token prefixes, cloud keys,
  URL userinfo, all query values, credential-named key/value pairs, `Bearer` tokens and
  base64 or hex runs of 40+ characters. Argv credentials (`-u user:pass`, `-p pass`) are
  masked first, in every kept string ([#869]). Replacements are `[redacted:<pattern>]`, with nothing of the value kept.
- **Content classes.** Container lines are `operational`, sandbox lines `activity`.
  `content` (prompts, responses, tool output) has no producer; the serializer throws on it.
- **Bounds.** 32 KiB in and 8 KiB out per line, 1000 lines and 512 KiB per page, 10 s per
  request, a per-principal, per-Agent token bucket (2/s, burst 10) and 16 concurrent reads
  per API replica (`RuntimeLogLimiter`).
- Pod Event messages pass `maskRuntimeEventText`, which masks node, image, Secret and
  ConfigMap names in standard kubelet and scheduler shapes.

### Views, cursors and audit

A page carries a cursor, HMAC-signed with the auth secret under purpose
`occ-runtime-logs-cursor` and bound to principal, Agent, revision and source. It expires
after 1 h ([packages/occ/src/runtime-logs/cursor.ts](../../packages/occ/src/runtime-logs/cursor.ts)).
`@kubernetes/client-node` 2.0.0 has no `sinceTime` parameter, so `readRuntimeLogPage` resumes with
`sinceSeconds` plus 2 s of overlap and drops already-seen lines by hash. A view that has
delivered nothing resumes from its previous read, not the whole tail; the sandbox source
floors its resume time at the first window's start ([#933]). A resumed page that fills the
tail or is cut by the byte limit and starts after the cursor's line reports `window_exceeded`
([#939]). Loss the API can
see becomes a `gap` record: `stream_replaced`, `window_exceeded`, `cursor_expired`,
`truncated`, or `buffer_lost` for the sandbox ring.

A view is audited once, before its first Driver read, as
`openclaw.agents.runtime_logs.view` (or `.download` per download) with kind `access`.
`authorization.action` records whether `read_logs` or `administer` admitted the reader.
If the audit write fails, the request returns `503` with no content. Cursor polls inside a
view are re-authorized but not re-audited. Status reads are not audited, like
diagnostics.

### Failure surfacing and noise ([#747], [#793], [#807])

- Runtime Events carry `container` (from `involvedObject.fieldPath`). `occ agent runtime`
  prints an Events table, and the console shows a record's `code` on the collapsed row.
  The wrapper's fixed line `Harness model authentication probe failed.` is an error
  record.
- Codex 0.158 prints span records at INFO, burying real events. The Harness wrapper pipes
  Codex stderr through `CODEX_STDERR_FILTER_HELPER`
  ([runtime-entrypoints.ts](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)).
  Unless `RUST_LOG` starts at `debug` or `trace`, it drops span `new`/`enter`/`exit`/`close`
  (except the `turn` span's `new`/`close`), loopback `websocket client connected` lines,
  repeats of the remote-control wait, and repeats of the macOS-only Unix-socket proxy
  warning (the first per app-server is kept). It also drops Codex's startup ERROR that
  bubblewrap is not on PATH: the image runs Codex's bundled `bwrap` on purpose, because a
  `bwrap` on PATH triggers a namespace probe the seccomp profile denies. Since [#876] it
  drops the startup ERROR that project-local config is untrusted when the only folder it
  names is the workspace's own `.codex`. The classifier renders the turn span as
  `turn started`/`turn completed` with model, IDs, token counts and busy time.
- `minLevel` is a server-side floor (`runtimeLogPageAtLevel`). It is applied after the
  page is read, sanitized and its cursor signed. Lines of `unknown` level, gaps and
  withheld counts are always kept. The console reads `minLevel=info` by default, with an
  **Include debug** checkbox; the CLI has `--level`.

### Collector export ([#793], [#811], [#863], [#879], [#896])

The Collector boundary in RFC 36 is unchanged. These bounded additions landed:

- `codex.turn` and `codex.tool_call` are exported with fixed bodies. A `codex.operational`
  body keeps Codex's own message only for `codex_app_server` targets and two fixed retry
  messages, and only when it is short plain text with no credential words, argv
  credential flag or `user:password` pair ([#879]). A Codex warning without such a body
  is dropped ([#863]).
- `gateway.startup_failed` ([#879]) exports OpenClaw's subsystem-less `Gateway failed to
  start:` error, its body kept under the same plain-text rules.
- A failed `runtime.startup_phase` keeps its cause as `occ.code` ([#863]).
  `runtime.gateway_settings_overridden` is exported as WARN with no attributes ([#896]).
- `authentication.provider-unavailable-warning` (from [#806]) is allowlisted with
  `occ.sign_in.provider`, `step`, `cause` and `status`, each from a fixed value list. The
  provider instance ID and other fields stay in local Pod logs.

## Security and threat model

| Threat | Control as landed |
| --- | --- |
| A reader sees another Agent's logs | Exact-Agent grants; the Driver reads only Pods carrying the revision's labels and re-checks them. RBAC cannot separate Agents, so this check carries the weight. |
| Credentials in output | Allowlist classification, then pattern redaction. Canary tests run planted credentials in many shapes through the real handler and download. |
| Chat content in output | Structured payload keys are dropped; Codex protocol output and subsystem-less OpenClaw records below warn are withheld; Codex messages keep text only for reviewed targets and formats; `content` has no producer. Plain text lines are still kept (see Known gaps). |
| Forged or replayed cursors | HMAC binding to principal, Agent, revision and source; mismatch is `400`. |
| Unaudited reads | Audit before the read; audit failure means no content. |
| Lateral cluster actions | Log reads add only read grants: `pods/log get`, `events get,list`, OpenShell `sandbox:read`. The roles' `pods get,list` and `pods/proxy get` serve diagnostics. |
| Resource abuse | Byte, line and time bounds, plus the token bucket and the concurrency cap. |

The `501` switch and the rate limiter run before authorization. A principal with no
grants learns only whether the feature is on, and spends only its own budget.

## Rationale and alternatives

- **Gateway `logs.tail` RPC.** Rejected: needs a live Gateway; misses crash loops.
- **Read from Loki or another log store.** Rejected for text. The Collector strips bodies
  by design, and OCE keeps no store; the backend stays a link.
- **Streaming (SSE).** Deferred. Polling every 2 s with a cursor reuses normal request
  authorization and does not hold a kubelet connection per viewer.
- **`administer` only.** Slice 1 used it, following the native admin precedent: that
  audience already reaches Gateway logs through the native admin UI. `read_logs` lets log
  reading be delegated.
- **Audit as `mutation`.** Slice 1 did this; [#737] moved views and downloads to `access`.
- **`RUST_LOG` to quiet Codex.** It cannot drop span events alone.
- **Client-side level filtering only.** Debug lines filled the page before
  `turn completed` was reached ([#807]).

## Known gaps and residual risk

- Redaction is pattern-based. Opaque tokens under 40 characters, with no known prefix, key
  name or `Bearer`, can still appear. Plain text up to 4 KiB is kept after redaction.
- Harness stdout and stderr inside an OpenShell sandbox are not readable without attach
  (`sandbox:write`). This needs an upstream read-only RPC.
- Sandbox decisions often show policy generation "unknown": OpenShell does not stamp it on
  CONNECT allows. Ring loss and push drops are inferred, not reported. The resume overlap
  is bounded at 5 s and 48 lines. The 2000-line ring is lost on gateway restart. The OCSF
  fixture is derived from upstream source, not captured from a live OpenShell.
- Kubernetes keeps only the current and previous container instance.
- The Codex stderr filter is keyed to Codex 0.158 message shapes. A rename lets the noise
  back rather than hiding other lines. Unless `RUST_LOG` is `debug` or `trace`, three
  records are suppressed on purpose: span enter/exit lines, the error-level
  missing-bubblewrap startup record, and the untrusted workspace `.codex` startup record.
- Rate and concurrency limits are per API replica.
- Operators must refresh the Collector config Secret on upgrade to get the Collector
  export changes above.

## Open questions for reviewers

1. Should `agentRuntimeLogs.enabled` default to on? **Implemented:** `true` in both charts.
2. Should `administer` keep admitting log text? **Implemented:** yes, unless a `read_logs`
   Restriction applies.
3. Should log text cover every revision of an Agent while status needs revision `read`?
   **Implemented:** yes ([#745]).
4. Is one audit row per view enough, with polls and status reads unaudited?
   **Implemented:** yes.
5. Should Codex message text be exported to the backend under the plain-text pattern?
   **Implemented:** yes, for `codex_app_server` targets and fixed retry messages.
6. Should `minLevel` read more lines to fill the page? **Implemented:** no. It is a display
   floor applied after the tail, so a page can show fewer lines than requested.
7. Should the OpenShell asks (Harness output RPC, generation on every decision, drop and
   eviction signals, structured OCSF fields) be filed upstream? **Implemented:** not filed;
   the limits are documented.
8. Should the console offer a log-only share? **Implemented:** no; `read_logs` is granted
   through the Namespace IAM Role API only.

## References

- Guide: [Agent logs](../../docs/guides/topics/agent-logs.md); flow:
  [Agent runtime logs](../../docs/flows/agent-runtime-logs.md); security:
  [Console and API runtime log reads](../../docs/reference/security.md#console-and-api-runtime-log-reads).
- Code: [packages/occ/src/runtime-logs/](../../packages/occ/src/runtime-logs/index.ts),
  [apps/controller/src/http/runtime-logs.ts](../../apps/controller/src/http/runtime-logs.ts),
  [apps/controller/src/console/agents/logs.mjs](../../apps/controller/src/console/agents/logs.mjs),
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
