---
status: Proposed
implementation_status: Not implemented
author: HerbertHuerto
---

# Run Codex turns inside an SSH-hosted OpenClaw Gateway

An operator should be able to deploy an embedded OpenClaw Agent on SSH Compute
and select Codex to execute its turns. The Gateway still owns the chat session;
the SSH Driver still manages one embedded Gateway. No dedicated Codex deployment
is requested.

## Why the existing choice does not work

For an OpenAI model using the Codex plugin's WebSocket app-server,
[deployment admission](../../packages/occ/src/agent-deployment-admission.ts)
derives the deployment Harness from the model's runtime policy.
The [production resolver](../../apps/controller/src/composition/production-harness.ts)
approves the Codex Harness only for dedicated execution, while the
[SSH Driver](../../apps/controller/src/drivers/compute/ssh/index.ts) accepts
only embedded OpenClaw. Selecting the OpenClaw runtime makes a different engine
execute the turn. Selecting Codex requests a topology SSH cannot deliver.
[PR #4307](https://github.com/openclaw/openclaw-enterprise/pull/4307) improved
the refusal message without changing that behavior.

## Decision proposed for review

Make the **deployment topology** and the **turn runtime** two explicit results
of admission. For an eligible SSH Agent, record OpenClaw/embedded as the
deployment and preserve the selected model's `agentRuntime.id: codex` in its
revision. The model stays under its configured provider. Neither the model name
nor a session binding grants permission to execute Codex.

- The Installation operator qualifies the SSH runtime and its pinned local
  app-server. An Agent owner selects Codex only within that capability. Other
  Agents keep their current runtime. A session override cannot grant a
  capability absent from the revision.
- OCC checks the selection at save and deploy. The SSH Driver verifies the
  pinned binary and private, Agent-owned transport before activating the
  revision. Loopback alone does not authenticate the peer on a shared host.
  An arbitrary WebSocket URL or executable path is not an acceptable substitute.
- Keep SSH runtime authentication: the operator signs in for that Agent;
  credentials and refresh state do not enter the Configuration, revision,
  diagnostics or another Agent's home. Keep the current refusal of Secret
  bindings. The app-server runs with the Agent's OS identity and stops with
  its revision.
- If Codex cannot enforce the configured tool, approval or filesystem policy,
  refuse the selection. A missing binary, failed transport check or unavailable
  selected model must not silently switch the turn to OpenClaw. Report which
  check failed without exposing credentials.

This does not add dedicated Codex on SSH, remote app-servers, or support on
another Compute Driver. Simply approving Codex for embedded execution globally
would promise support on hosts that have not established any of these properties.
Keeping the current refusal is preferable wherever the Driver cannot prove them.

## Acceptance criteria

1. Exercise Agent save, deployment admission and revision preparation. Accept
   the opted-in SSH configuration; reject the same selection without the
   capability, an untrusted endpoint, and a dedicated Codex request. Existing
   embedded OpenClaw Agents still deploy unchanged.
2. On an isolated SSH host, start a Gateway UI turn with runtime OAuth, no API
   key and no fallback. Correlate its turn ID with Codex execution and an
   actual tool read of a harmless workspace fixture. A model label or a ready
   app-server is not runtime evidence.
3. In the same setup, record a denied read against a foreign-user sentinel
   and a separate denied tool action that Unix permissions would permit.
   Neither a model's assertion nor a filesystem denial proves Gateway tool
   policy enforcement.
4. Redeploy and verify that the same Agent retains its workspace and sign-in.
   Roll back to embedded OpenClaw and verify that chat works and no Codex
   listener or child remains. No test needs another Agent's real data.

The implementation review should settle how the SSH Driver advertises the
capability and authenticates its local peer. Until the installed-runtime tests
pass, admission should continue to refuse this combination.
