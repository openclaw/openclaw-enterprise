# View Agent runtime status and logs

The **Logs** tab on an Agent version shows its Pods, restarts, recent Kubernetes
Events and a bounded, redacted page of container output or, for OpenShell
sandboxed Agents, sandbox policy decisions. Use it to find out why a
version crashes, restarts or stops serving. Nothing is stored on the server: each
read fetches one page from the cluster through the Compute Driver.

Runtime status and logs are available for **Kubernetes Compute** only. Docker and
SSH Compute, and Drivers that own their runtime logging (`runtimeLogging:
"driver"`), answer `501 NOT_IMPLEMENTED`.

## Open the Logs tab

1. Open the Agent and select a deployed version. The editable draft is not a
   version and has no runtime; a version without a running Pod shows no Pod.
   When the latest deployment failed, **Deployment activity** links straight to
   that version's Logs tab.
2. Select **Logs**. The runtime strip refreshes every 10 seconds. Each Pod card
   lists its recent warning Events, prefixed with their container.
3. Choose a **Source**: **Gateway** (the OpenClaw Gateway container),
   **Agent (Harness)** (the dedicated Codex or OpenClaw Harness container, only
   for dedicated execution) or **Sandbox (policy decisions)** (see
   [Sandbox source](#sandbox-source)), and a **Pod** when there are several.
   While no Harness Pod is ready, the Gateway logs failed connections to it
   (`ECONNREFUSED`); the console then points you to the **Agent (Harness)**
   source for the cause (such as a failed model probe), or to Deployment
   activity when the Harness Pod does not exist yet.
4. Select **Follow** to poll for new lines every 2 seconds. Following pauses while
   the browser tab is hidden or you scroll up, and stops after a permission denial.
5. Select **Previous instance** after a restart to read the exited container's
   output. Following is off for the previous instance.

### Filter the loaded output

The server returns **info** and above (and lines of unknown level) unless you
select **Include debug**, which starts a new view. The level chips and the
case-insensitive **Filter** box (message, kind, subsystem and field values)
narrow only the rows already loaded (up to 5000). To look further back, use
**Download** or the CLI with `--since`. Gap and withheld rows always stay
visible.

### Download

**Download** saves the last 1000 lines of the selected source, Pod and instance
as a text file named `<agent>-<revision>-<source>-<pod>.log`, using IDs. The
file holds the same classified and redacted records as the page, one per line
(`TIME LEVEL KIND [SUBSYSTEM] MESSAGE key=value`, plus `GAP` and `WITHHELD`
rows), after a `#` header naming the Agent, revision, Pod and container.
Only **Include debug** applies to the download. Redaction is best-effort:
handle the file as sensitive and delete it when done.

The HTTP API has the same two reads:

```sh
GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{revisionId}/runtime
GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{revisionId}/runtime/logs?source=gateway&tailLines=200
```

`runtime/logs` accepts only `source` (`gateway`, `agent` or `sandbox`), `pod`, `previous`,
`tailLines` (1 to 1000, default 200), `sinceSeconds` (1 to 86400), `cursor`,
`download` and `minLevel` (`error`, `warn`, `info` or `debug`: drop lines below it;
unknown-level lines, gaps and withheld counts stay). Pass the returned `cursor` to read only newer lines of the same view.
`download=true` answers `text/plain` with `Content-Disposition: attachment`,
always reads 1000 lines, and cannot be combined with `cursor` (`400`). See the
[API reference](../../reference/api.md).

## Command line

`occ agent runtime AGENT_ID` prints the Pods, sources and Events; `occ agent logs
AGENT_ID --source SOURCE` prints one page, or keeps polling with `--follow`:

```sh
occ agent logs agt_... --source agent --since 10m --level info --follow
occ agent logs agt_... --source agent --previous -o json
occ agent logs agt_... --source sandbox --follow
```

Without `--revision`, both prefer a newer revision that has Pods (a deploy in
progress or failed) and name the revision on stderr. The
[CLI reference](../../reference/cli.md#runtime-status-and-logs) owns revision
selection, flags, output formats, retries and exit codes.

## Who can see what

| Read                                                                       | Required grants                                       | Audited                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Runtime status: Pods, phase, readiness, restarts, last termination, Events | Agent `operate` and `read`, and `read` on the version | No, like [diagnostics](../../reference/agents.md)         |
| Log text                                                                   | Agent `read_logs` or `administer`, and Agent `read`   | Once per view as `openclaw.agents.runtime_logs.view`      |
| Log download                                                               | Same as log text                                      | Every download as `openclaw.agents.runtime_logs.download` |

Installation administrators hold Agent `administer`, which already reaches Gateway
log text in the [native admin UI](../../reference/agent-native-admin.md). To
delegate log reading, bind a Namespace Role with Agent `read_logs` and `read` to
the exact Agent; it covers every version, including later deployments. Opening
the Agent in the console also needs Namespace `read` bound to that Namespace
(otherwise it shows "Namespace unavailable"). Runtime status needs `read`
bound to each exact version. A `read_logs` Restriction blocks log text even for
administrators. Without `operate`, the Logs tab has no runtime strip or Pod
picker; it reads each source's current Pod and says when a source is missing.
Service principals use the same grants. Every request and follow poll is
authorized again, so revoking a grant stops the next poll. See
[authorization](../../reference/authorization.md).

## What the output contains

OCC classifies every line against an allowlist of operational output before
returning it:

- **wrapper**: runtime startup and model-probe events, with fixed fields only,
  plus the fixed plain line `Harness model authentication probe failed.` as an
  `error`. A line's `code` field shows on the collapsed row.
- **openclaw**: Gateway JSON console records (level, subsystem, message and a
  short list of operational fields such as `status`, `method` and `durationMs`).
  Payload keys such as `prompt`, `content`, `messages`, `args` and `headers` are
  dropped. `info` and `debug` records without a subsystem carry reply text (for
  example from the OpenAI-compatible chat endpoint) and are withheld; errors
  and warnings without one, like `Gateway failed to start: ...`, are kept.
- **codex**: Codex tracing records (level, target, message). Turns show as
  `turn started` and `turn completed` (info, with model, turn ID, tokens and
  busy time); tool calls keep their name and duration. Only app-server, login,
  CA-setup, plugin-manifest, model-connection, proxy-startup and retry messages
  keep their text; others, such as `codex_core` (which logs chat text), read
  `Codex message withheld`. Other span records are `debug`; below
  `logging.level: debug` the Harness drops them, readiness-probe
  connections and repeated remote-control retries (one per 10 minutes is kept).
- **text**: plain lines up to 4 KiB, including those starting with a bracketed
  component tag such as `[node-host] advertised commands: ...`.

Other structured output, including Codex JSON-RPC protocol traffic, oversized
lines and malformed lines that start like a JSON object or array, is
**withheld**: the page shows a count, never content. A pretty-printed
(multi-line) JSON value becomes one withheld row.

Every retained string is then redacted. OCC replaces PEM blocks, `Authorization`
and cookie header values, `Bearer` tokens, `Basic` user:password values, JWTs,
known token prefixes (`sk-`, `sk_live_`, `rk_live_`, `ghp_`, `ghs_`,
`github_pat_`, `hf_`, `xoxb-`, `AKIA` and others), URL user information, every
URL query value and fragment, `password=`/`token:`/`"api_key":`-style values,
upper-case `*_KEY=` assignments, netrc `login <user> password <secret>` values,
the value after a command-line credential flag such as `curl -u user:password`
(listed under [Sandbox source](#sandbox-source)), and long base64 or hex runs
with `[redacted:<pattern>]`. A PEM block printed over several lines is masked
from an observed BEGIN through END, across follow polls in the same container
view. Only ordered lines newer than the prior cursor position can close it (at
END or the first line that is not base64, a PEM header or blank). PEM-shaped
lines may stay masked for the rest of that view.
A restart, Pod change, expired cursor or new view starts without that context,
and a page that begins inside a block whose BEGIN it never saw cannot mask it.
Redaction is best-effort: an opaque token under 40 characters with no known
prefix and no key name or `Bearer` next to it stays visible. Do not rely on
redaction to make a runtime that prints secrets safe.
Control characters are removed and messages are capped at 8 KiB.

Runtime status Event messages are redacted the same way; node names, image
references and Secret and ConfigMap names are masked in the standard scheduler
and kubelet messages. Other Event text can still name cluster
objects.

Container lines carry `contentClass: "operational"` and sandbox lines
`"activity"`; the reserved `content` class (message text, prompts, tool output)
is never returned.

## Gaps, limits and retention

A page never silently skips output; it labels each gap:

| Row                 | Meaning                                                            |
| ------------------- | ------------------------------------------------------------------ |
| Container restarted | The Pod or container instance changed since the last page.         |
| Lines skipped       | New output exceeded one page between polls.                        |
| View resumed        | The cursor was older than one hour; reading restarted at the tail. |
| Page limit reached  | The page hit its byte limit; later lines were not read.            |
| Sandbox buffer lost | The sandbox buffer no longer holds the lines after the last page.  |

Limits per request: 1000 lines, 1 MiB read from the cluster, 32 KiB per input
line, 512 KiB per response, 100 Events per Pod, 10 seconds overall. Each API
replica allows each principal 2 requests per second per Agent with a burst of
10 (`429` with `Retry-After`) and 16 concurrent reads (`503`). The rate limit
and operator switch run before
[authorization](../../reference/security.md#console-and-api-runtime-log-reads).

Kubernetes keeps only each container's current and previous instance, nothing
from deleted Pods; for
older output, use your [observability backend](../observability.md). While a
container crash-loops, the previous instance can briefly read as empty.

## Sandbox source

When the Agent's version runs in an [OpenShell sandbox](../../reference/drivers/openshell-sandbox.md),
the **Sandbox** source shows what the OpenShell gateway recorded for it:
network and HTTP policy decisions (allowed or denied, destination,
method, binary, policy name and engine, denial reason), process launches, and
supervisor tracing. The Harness's own output inside the sandbox is not
available here; operators can read it and the supervisor log with
[kubectl](agent-troubleshoot.md#read-openshell-sandbox-and-supervisor-logs).

- OCC derives the sandbox from the version. The source has no Pods or
  previous instance (`pod` or `previous=true` answers `400
RUNTIME_LOGS_POD_INVALID`).
- Lines are kind `sandbox`. Kept fields:
  `activity`, `action`, `disposition`, `dst_host`, `dst_port`, `method`, `path`,
  `binary`, `pid`, `rule_name`, `rule_type`, `policy_generation`, `reason`,
  `source`, `cmd_line` and `url`. Command lines and URLs often carry tokens:
  they are redacted like every string and cut to 1 KiB. In command lines the
  value after a credential flag is masked too (`-p`, `-pass`, `--pass`,
  `--token`, `--with-token`, `--username`, `-u`, `--user`, `-U` or
  `--proxy-user` with `user:password`, `smbclient -U user%password`,
  `lftp -u user,password`, `redis-cli -a`, `sqlcmd -P`, and the token of
  `vault login`). A secret passed under another flag name can still show. A
  message that holds structured data is withheld.
- OpenShell keeps the last 2000 lines per sandbox in memory and loses them when
  its gateway restarts; a follow poll whose last line is gone reports
  **Sandbox buffer lost** or **Lines skipped**. Lines the sandbox drops under
  load are not reported.
- The sandbox stamps lines when it records them but sends them in batches, so
  a line can arrive after a newer one was shown. A follow poll re-reads the
  5 seconds before the newest line it showed and shows each line once, repeats
  included. A line that arrives more than 5 seconds late, or behind more than
  48 lines in those 5 seconds, can be missed. When more than 48 lines share one
  millisecond, the poll shows **Lines skipped** at that time.
- OCC reads through the read-only `GetSandboxLogs` call. Its OpenShell identity
  needs the `sandbox:read` scope (otherwise `503 RUNTIME_LOGS_CLUSTER_RBAC`)
  and Workspace role `user`. OpenShell hides sandboxes outside the identity's
  Workspace, so a missing role answers `503 RUNTIME_LOGS_SANDBOX_NOT_FOUND`,
  like a sandbox not yet provisioned or removed.

### Which rule decided

Each network or HTTP decision row shows
`rule <name> · engine <engine> · policy generation <generation>`, from the
`rule_name`, `rule_type` and `policy_generation` fields:

- **rule** is the policy rule that matched. `no matching rule` means OpenShell
  matched none (it reports `-`), which is the usual cause of a denial.
- **engine** is the OpenShell component that decided, for example `opa`,
  `ssrf`, `mechanistic` or `nftables`.
- **policy generation** is the policy version that decided. The pinned OpenShell
  release does not send it with pushed decision lines, so it usually reads
  `unknown`.

### Relating sandbox decisions to other sources

OpenShell records no Agent turn, session or request ID with a decision, so no
source shares an ID with the sandbox. Each decision row carries the label
**Gateway lines: inferred (time window)**: Gateway or Harness lines near that
time may be related, but nothing links them.

The logs cannot tell you, and you should not infer:

- which Agent turn, session, user or prompt caused a sandbox decision;
- which policy generation decided a line whose generation reads `unknown`
  (do not assume the current policy decided an older line);
- which credential OpenShell injected into an allowed request;
- the order of two lines from different sources less than a few seconds apart,
  because the sandbox and the cluster stamp lines with separate clocks;
- who made a request from its source IP address.

## Errors

| Response                              | Meaning and action                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `403 FORBIDDEN`                       | Missing grants for that tier. The console names the grants and stops asking for this page.    |
| `400 RUNTIME_LOGS_CURSOR_INVALID`     | The cursor belongs to another principal, version or source, or was altered. Start a new view. |
| `400 RUNTIME_LOGS_POD_INVALID`        | The Pod is not a current Pod of this version and source.                                      |
| `400 RUNTIME_LOGS_SOURCE_UNAVAILABLE` | This version has no such source, for example no Sandbox log or no dedicated Harness.          |
| `429 RUNTIME_LOGS_RATE_LIMITED`       | Wait for `Retry-After`.                                                                       |
| `501 NOT_IMPLEMENTED`                 | The Compute Driver does not expose runtime logs, or an operator disabled them.                |
| `503 RUNTIME_LOGS_CLUSTER_RBAC`       | The cluster or OpenShell denied the read. An operator must grant the roles or scope.          |
| `503 RUNTIME_LOGS_SANDBOX_NOT_FOUND`  | OpenShell reports no such sandbox: not provisioned yet, removed, or outside OCC's Workspace.  |
| `503 RUNTIME_LOGS_AUDIT_UNAVAILABLE`  | The view could not be audited, so nothing was read. Retry.                                    |
| `503 RUNTIME_LOGS_UNAVAILABLE`        | The runtime or cluster is unreachable. Retry.                                                 |
| `504 RUNTIME_LOGS_TIMEOUT`            | The read exceeded 10 seconds. Retry or read fewer lines.                                      |

## Enable or disable (operators)

The `openclaw-enterprise` chart value `agentRuntimeLogs.enabled` (default `true`)
grants `pods/log get` and `events get,list` to the tenant API and Gateway observer
roles and sets `OCC_AGENT_RUNTIME_LOGS_ENABLED`. Set it to `false` to remove the
grants; both routes then answer `501`. Tenant RoleBindings you create by hand
need the same rules; see [production Agents](../deploy/production-agents.md).
Two-cluster installs set the same value on the `openclaw-execution` chart.

These grants are read-only and namespace-scoped through your RoleBindings;
the [security reference](../../reference/security.md#console-and-api-runtime-log-reads)
explains how OCC confines them to one Agent's Pods.
