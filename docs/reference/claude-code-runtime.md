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
The [console](console/create-and-deploy.md) does not offer the choice yet; set it
in the Configuration.

## Tool policy

Claude Code's native Read, Grep, Write, Edit, WebFetch and WebSearch tools
follow OpenClaw's exec security setting, not the Configuration's tool policy.
OpenClaw removes native Bash and routes shell work through its own `exec` tool,
so a `tools.deny` of `exec` or `process` holds. Save and deployment refuse with
`400 INVALID_REQUEST` any policy that would restrict `read`, `write`, `edit`,
`web_fetch` or `web_search`, because the runtime would ignore it: a `tools.deny`
naming one (by name, `*` glob, `group:fs`, `group:web` or `group:openclaw`), a
nonempty `tools.allow` leaving one out, or the `minimal` or `messaging` profile
unless `alsoAllow` adds all five back. This covers top-level `tools`, each
`agents.entries` entry's (its `profile` and `alsoAllow` fall back to the
top-level ones), and their `byProvider` entries for `anthropic`.

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
selects only user settings. Managed settings outrank every other tier, and so do
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

A binary missing from the image or not at the pinned
`OCE_CLAUDE_CODE_VERSION` also holds the gateway with `UNAVAILABLE`. Both checks
are logged as startup phase `claude-code-runtime`. Model egress rules are unchanged:
the endpoint must be reachable on public TCP/443.

## Telemetry and model pins

The managed settings set `disableAllHooks`, the only tier at which it also
disables managed hooks. OpenClaw's own hook callbacks keep working. The
settings' `env` takes precedence over the process environment. It always turns off updates, installation checks and feedback prompts, clears
`ANTHROPIC_CUSTOM_HEADERS`, and sets every model that Claude Code selects by
itself (`ANTHROPIC_MODEL`, the `opus`, `sonnet` and `haiku` aliases, the
small/fast, subagent and classifier models) to the primary model. Claude Code
therefore calls only the admitted model.

Telemetry is off by default. Deployment admission sets the OpenClaw setting
`telemetry.enabled` to `false` when it is unset. Then the file also sets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, `DISABLE_GROWTHBOOK` and `DO_NOT_TRACK`, and selects
no OpenTelemetry exporter. The pinned binary then runs at its essential-traffic level: no telemetry, error
reporting, feature-flag or update requests. To opt in, set
`telemetry.enabled: true` or use the Console toggle in
[Collaboration and safety](../guides/console/configuration-plugins-and-files.md).
The setting applies to every agent runtime that OCE configures; Codex keeps its
OpenTelemetry export off in all cases.

## Conversation state

Claude Code keeps each session's transcript under `$HOME/.claude/projects`, and
OpenClaw resumes a conversation by its session ID. Compute mounts that directory
from the Agent's private gateway state claim, so a conversation continues after a
gateway restart or redeploy. It is the only writable path under `$HOME/.claude`;
the rest is the read-only skeleton. The skeleton and the managed settings that
carry the credential exist only in the Pod's memory-backed volume, and the init
container writes them again when the Pod starts. Deleting the Agent deletes the
claim and its transcripts.
