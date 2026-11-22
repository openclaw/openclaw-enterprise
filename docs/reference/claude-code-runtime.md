# Claude Code agent runtime

Use this reference to run an embedded OpenClaw Agent's turns through Claude Code
instead of OpenClaw's own Anthropic client. See
[Harness execution](harness-execution.md) for the topologies and model policy rules.

## Select the runtime

Select it per model with the runtime policy OpenClaw's Anthropic plugin defines:

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-5",
      "models": { "anthropic/claude-sonnet-4-5": { "agentRuntime": { "id": "claude-cli" } } }
    }
  },
  "models": { "providers": { "anthropic": { "baseUrl": "https://api.anthropic.com" } } }
}
```

The Harness stays OpenClaw in `embedded` mode: the gateway process spawns the
runtime image's pinned Claude Code binary for each turn, so tools run in the
gateway Pod as they do for every embedded Agent. Every selectable model must be
`anthropic/*` with the same policy; a dedicated Agent, another provider, or
`openai`-style fallbacks are refused at save or deployment with `400 INVALID_REQUEST`.
OCE prepares the runtime only when the selected models resolve to it: a
`claude-cli` policy on a provider that no selected model uses has no effect.
The runtime needs Kubernetes Compute; SSH and Docker Compute refuse it at save
and at deployment.
The [console](console/create-and-deploy.md) does not offer the choice yet; set it
in the Configuration.

## Tool policy

The Configuration's tool policy applies as it does for the default runtime. On
an ordinary turn OpenClaw starts Claude Code with OpenClaw's own tools, served
through its tool bridge, instead of Claude Code's native Bash, Read, Write, Edit
and WebFetch. File, shell and web fetch work therefore follows `tools.deny`,
`tools.allow`, the tool profile and their `byProvider` entries. A side question
runs with no Claude Code tools.

A `write` deny alone does not stop file changes: the model still has `edit` and
`apply_patch`. To remove the file tools, deny all three, or deny `group:fs`,
which also removes `ls` and `read`. Shell tools such as `exec` can still write files.

OpenClaw skips this mediation when the exec host is `node`: Claude Code then
gets its full native tool set, outside tool policy. OCE refuses that pair at
save and deployment with `400 INVALID_REQUEST`, naming `tools.exec.host` or the
`agents.entries.<id>.tools.exec.host` that is `node`. A session can also be put
on a node without a setting: the `/exec host=node node=<id>` directive, or
`sessions.patch` or `sessions.create` with a node. The gateway therefore denies
the node command that runs Claude Code
(`gateway.nodes.commands.deny` gets `agent.cli.claude.run.v1`), and such a turn
fails.

OpenClaw's system prompt replaces Claude Code's own. Each turn's `TMPDIR`,
`TMP` and `TEMP` point at `.openclaw/tmp` in the session's or Agent's
workspace. The default workspace, `/home/node/.openclaw/workspace`, is mounted
writable from the Agent's private gateway state claim.

## Web search

Claude Code's native WebSearch tool stays on by default. The search runs at
the model provider, on the endpoint that already receives the conversation, so
it opens no new egress from the gateway Pod. It works only where that endpoint
offers Anthropic's server-side web search. On an endpoint without it, each
search fails with an error from the endpoint, so deny `web_search` there. Turn
it off with either setting:

- deny `web_search` in tool policy, for example `tools.deny: ["web_search"]`;
- set `tools.web.search.enabled` to `false`.

OpenClaw also drops it when `tools.web.search.provider` names a search
provider, whose own `web_search` tool then serves searches.

## Authentication and startup

Authentication is the ordinary `api_key` [binding](harness-execution.md#harness-authentication): the
Secret holds an Anthropic API key, a Claude Code setup token (`sk-ant-oat…`,
sent as a bearer), or the bearer token of an Anthropic-compatible endpoint named
by the provider's literal `baseUrl`. At startup the gateway first runs the usual
[model probe](harness-execution.md#harness-authentication) through OpenClaw's HTTP client, so a
rejected credential or unreachable endpoint fails the deployment with the same
codes.

Claude Code reads its admin-managed settings from `/etc/claude-code`. These
settings carry the endpoint, the credential and the settings in
[Telemetry and model pins](#telemetry-and-model-pins). OpenClaw's backend scrubs
`ANTHROPIC_*` and `CLAUDE_CODE_*` variables from the child's environment and
selects at most user settings. Managed settings outrank every other tier, and so do
remote managed settings: an API key or a stored sign-in makes a session eligible
for them, and when the fetch fails Claude Code applies its cached copy from its
configuration directory (`CLAUDE_CONFIG_DIR`). No supported setting turns that
cached copy off. The model's tools run as the same uid as the gateway, so no
process in the gateway container can change either directory:

- The `prepare-claude-code-settings` init container writes only
  `managed-settings.json` (`0400`) to a memory-backed volume, and next to it the
  skeleton of the configuration directory: a `0500` directory that holds only the
  `projects` mount point. It is the only container that mounts the volume
  writable. It gets only the model inputs and the one credential variable, and it
  has no Agent state mounted.
- The gateway mounts the settings read-only at `/etc/claude-code`. Because the
  directory holds only that file, it has no `managed-settings.d` drop-ins.
- The gateway mounts the skeleton read-only at `/home/node/.claude` and the
  transcript directory writable inside it (see
  [Conversation state](#conversation-state)). Every file that can supply remote
  managed settings or a stored sign-in lives directly in that directory: the
  remote settings cache and its signature files, `policy-limits.json`,
  `.credentials.json`, `.claude.json`, `settings.json`, `storage-v2/` and
  `state/`. None of them can be created. Claude Code tolerates the refused writes
  of its own state, such as `.claude.json`.
- After the model probe, the gateway checks both mounts. It holds the gateway
  unready with `UNAVAILABLE` unless all of these are true: its mount table lists
  each directory as read-only, write access and a create probe are refused, the
  settings directory holds only `managed-settings.json` and the configuration
  directory only a real `projects` directory, and the file is exactly the one
  that the admitted inputs produce.
- The gateway then points `CLAUDE_CONFIG_DIR` at the configuration directory and
  `ANTHROPIC_CONFIG_DIR`, the Anthropic profile store that otherwise lives under
  the writable home, at `/etc/claude-code`, which holds no profile. It drops the
  variables that would move a credential or settings store elsewhere, such as
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `ANTHROPIC_PROFILE`.

OCE writes the credential to one file in the Pod, `managed-settings.json` in the
memory-backed volume. The value is also in the environment of the init
container and, as for every `api_key` binding, of the gateway process. Claude
Code reads it from the managed settings. The gateway's uid, which the model's tools
share, can read that file, so a tool can copy the credential to a writable path.
For example, a move of `/etc/claude-code` into the home directory fails, but
first copies `managed-settings.json` there.

The image installs the binary at `/opt/oce/claude-code/bin/claude`, outside
`PATH`, and only this check adds that directory to the gateway's `PATH`. In a
gateway that did not select the runtime, OpenClaw therefore cannot start Claude
Code by its command name, also not after a chat command such as
`/model --runtime claude-cli`. This does not stop a model's shell tool: in any
Agent it can run the file by its full path. In a gateway that did not select
the runtime, it then runs without the managed settings, and with only the
credentials that the tool can already read. A binary missing from the image or not at the pinned
`OCE_CLAUDE_CODE_VERSION` also holds the gateway with `UNAVAILABLE`. Both checks
are logged as startup phase `claude-code-runtime`.

Model egress rules are unchanged: the gateway reaches public addresses on
TCP/443 only (see [Kubernetes networking](drivers/kubernetes-compute/networking-and-isolation.md#networking)).
An endpoint in the cluster, at a private address or on another port needs an
egress NetworkPolicy for the gateway Pod, which the operator adds.

## Telemetry and model pins

The managed settings set `disableAllHooks`, the only tier at which it also
disables managed hooks. OpenClaw's own hook callbacks keep working. The
settings' `env` takes precedence over the process environment. It always turns off updates, installation checks and feedback prompts, clears
`ANTHROPIC_CUSTOM_HEADERS`, and sets every model that Claude Code selects by
itself (`ANTHROPIC_MODEL`, the `opus`, `sonnet` and `haiku` aliases, the
small/fast, subagent and classifier models) to the primary model. Claude Code
therefore calls only the admitted model. `CLAUDE_CODE_MAX_RETRIES` is `4`: it
bounds Claude Code's own retries of a failed model request, of every kind,
because by default it retries a rejected credential for about three minutes. An
authentication failure now ends the turn within about 10 seconds. A short
background run of Claude Code can follow a turn in the same Pod. It reads the
same managed settings, so its retries have the same bound.

Telemetry is off by default. Deployment admission sets the OpenClaw setting
`telemetry.enabled` to `false` when it is unset. Then the file also sets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, `DISABLE_GROWTHBOOK` and `DO_NOT_TRACK`, and selects
no OpenTelemetry exporter. The pinned binary then runs at its essential-traffic level: no telemetry, error
reporting, feature-flag or update requests. To opt in, set
`telemetry.enabled: true` or use the Console toggle in
[Collaboration and safety](../guides/console/configuration-plugins-and-files.md).
With telemetry on, Claude Code also sends connectivity checks to the model
endpoint. The setting applies to every agent runtime that OCE configures; Codex keeps its
OpenTelemetry export off in all cases.

## Conversation state

Claude Code keeps each session's transcript under `$HOME/.claude/projects`, and
OpenClaw resumes a conversation by its session ID. Compute mounts that directory
from the Agent's private gateway state claim, so a conversation continues after a
gateway restart or redeploy. It is the only writable path under `$HOME/.claude`;
the rest is the read-only skeleton. The init container writes the skeleton and
the managed settings to the memory-backed volume again each time the Pod
starts. Deleting the Agent deletes the
claim and its transcripts.
