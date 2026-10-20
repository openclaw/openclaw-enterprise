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
codes. Only then does the entrypoint prepare a Pod-local Claude Code
configuration directory (`$HOME/.claude`, on the runtime-state volume, `0700`,
settings `0600`) carrying the endpoint, the credential, and
`DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Claude Code reads that directory
because OpenClaw's backend scrubs `ANTHROPIC_*` and `CLAUDE_CODE_*` variables
from the child's environment. A binary missing from the image or not at the
pinned `OCE_CLAUDE_CODE_VERSION` holds the gateway unready with `UNAVAILABLE`,
logged as startup phase `claude-code-runtime`. Model egress rules are unchanged:
the endpoint must be reachable on public TCP/443.

## Conversation state

Claude Code keeps each session's transcript under `$HOME/.claude/projects`, and
OpenClaw resumes a conversation by its session ID. Compute mounts that directory
from the Agent's private gateway state claim, so a conversation continues after a
gateway restart or redeploy. The rest of `$HOME/.claude`, including the settings
file that carries the credential, stays on the Pod-local runtime-state volume and
is rewritten at each start. Deleting the Agent deletes the claim and its
transcripts.
