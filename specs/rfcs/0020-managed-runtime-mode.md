---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Proposal: A managed-mode contract for OCE runtimes

- **ID:** RFC-0020
- **Created:** 2026-10-13
- **Last updated:** 2026-10-13
- **RFC PR:** [#2367](https://github.com/openclaw/openclaw-enterprise/pull/2367)
- **Related:** [Agent access](0010-agent-access.md), [storage ownership](0003-gateway-harness-storage-split.md), [plugin policies](0014-plugin-policy-enforcement.md)

## Summary

Dedicated OpenClaw (OC) is the first required delivery target for OpenClaw
Enterprise (OCE) managed mode. Both its separate Harness and Gateway must enforce
the contract. The baseline also covers embedded OC and dedicated Codex.

OCE should require a versioned managed mode from its Harness and Gateway
runtimes. OCE supplies their control configuration; runtimes
enforce it against model execution and native administration. Compute activates a
deployment only after both runtime enforcement and execution containment are
established. AGENTS.md, SOUL.md, IDENTITY.md, USER.md, and other agent documents
are outside this proposal.

## Action support, calls, and managed-mode gaps

**T** = model tool; **R** = authenticated client/admin RPC; **C** = CLI/shell;
**S** = runtime-to-client request. Tool availability depends on features,
agent/session type, execution mode, scopes, and configured policy. RPC support does not imply
model access. “No native API” means none found at the inspected pin; host/MCP
integrations or shell access may still provide the action.

OC capabilities remain on the Gateway when Codex is the Harness. Embedded OC
runs both roles together; dedicated OC separates them. Dedicated Codex with a
workspace node and Codex plugin entry excludes selected OC management/file/shell
dynamic tools. The OC admin UI still relays native RPCs without a command filter.

**Block** denies unapproved changes through native/model paths; trusted OCE
publication remains available. **Allow** retains existing authorization and
topology restrictions.

| Action                                               | OC Gateway/Harness support and example calls                                                                                            | Codex support and example calls                                                                                                    | Managed mode                                              | Current OCE coverage / gap                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Read configuration/status/catalogs                   | R `config.get`, `agents.list`, `plugins.list`; T `gateway(config.get)`                                                                  | R `config/read`, `configRequirements/read`, `plugin/list`                                                                          | Allow permitted reads                                     | Native read scopes apply; client responses are not automatically model-safe.                  |
| Persist control settings                             | R `config.set`, `config.patch`, `config.apply`; T `openclaw` delegates system-agent changes; C `openclaw config set`                    | R `config/value/write`, `config/batchWrite`, `externalAgentConfig/import` (CONFIG); C config edits                                 | Block                                                     | OC read-only flag is conditional; Codex checks exact requirements fields.                     |
| Replace files or override runtime startup            | T `write`, `exec`; C config/environment/launcher overrides                                                                              | T `apply_patch`, `exec_command`; C `codex -c`; R `thread/start` config overrides                                                   | Block managed-state bypass                                | No uniform protection of managed paths is established.                                        |
| Persist agents/roles                                 | T `openclaw` delegation; R `agents.create`, `agents.update`, `agents.delete`; C `openclaw agents add`                                   | No OC roster CRUD; R `externalAgentConfig/import` (SUBAGENTS), config writes; C role TOML files                                    | Block unadmitted roster/role changes                      | OC config guard is conditional; persistent roles differ from child threads.                   |
| Start/resume/delegate sessions                       | R `sessions.create`; T `sessions_spawn`                                                                                                 | R `thread/start`, `thread/resume`, `thread/fork`; T `spawn_agent`, `send_input`                                                    | Allow within admitted policy                              | Tool exclusions alone do not qualify inherited policy.                                        |
| Choose session model/execution options               | R `sessions.patch`; T `session_status(model=…)`; `/model` command                                                                       | R `thread/start`, `thread/resume`, `turn/start` overrides                                                                          | Allow within OCE ceiling                                  | Provider/topology pins and startup checks do not prove later routing.                         |
| Install/configure runtime plugins and tool providers | T `plugins(install/enable/uninstall)`; R `plugins.install`, `plugins.setEnabled`; C `openclaw plugins update`                           | T `request_plugin_install`; R `plugin/install`, `plugin/uninstall`; C `codex mcp add`                                              | Block unadmitted changes                                  | Trusted startup installs plugins; selected tool hiding is not a mutation barrier.             |
| Update runtime packages                              | T `gateway(update.run)`; R `update.run`; C `openclaw update`                                                                            | C `codex update`, daemon-only `codex app-server daemon update`; no process-update RPC                                              | OCE upgrade only                                          | OC auto-update is disabled; manual/CLI paths need protection.                                 |
| Restart/reload admitted runtime                      | T `plugins(reload)`; R `gateway.restart.request`, `plugins.reload`; C `openclaw gateway restart`                                        | R `plugin/reconcile`, `config/mcpServer/reload`; C daemon-only `codex app-server daemon restart`                                   | Trusted recovery only                                     | Pure reload need not write config; OCE uses foreground Codex, not the daemon.                 |
| Replace provider identity/credentials                | T `secrets(request/delete)` (primary); R `models.authLogin`, `models.authOrderSet`, `secrets.store.set`; C `openclaw models auth login` | R `account/login/start`, `account/logout`; C `codex login`, auth/config files                                                      | Block changing OCE-owned bindings                         | Auth/secret stores need separate controls; task secrets retain existing policy.               |
| Expand pairing/trust/scopes                          | T `nodes(approve)`; R `device.pair.approve`, `channels.pairing.approve`                                                                 | Experimental R `remoteControl/pairing/start`, `remoteControl/client/revoke` requires a configured handle; no OC node/channel roles | Block authority expansion                                 | OC admin RPCs relay; Codex remote-control exposure is unverified.                             |
| Widen permissions/approvals/tool exposure            | R `exec.approvals.set`, `sessions.patch`; ordinary approval R `exec.approval.resolve`                                                   | T `request_permissions`; R `thread/start` with `dynamicTools`; S `item/permissions/requestApproval`                                | Block widening; allow bounded approvals                   | OC approval stores are separate; OCE Codex checks are startup-scoped.                         |
| Refresh admitted credentials/peers                   | R `models.authRefresh`; trusted workspace-node renewal                                                                                  | Internal auth refresh; S `account/chatgptAuthTokens/refresh` for external token ownership                                          | Trusted flow allowed                                      | Preserve admitted identity/scopes; child token filtering alone is not containment.            |
| Schedule tasks                                       | T `automations`; R `cron.add`, `cron.update`, `cron.run`; C `openclaw cron add`                                                         | No native cron CRUD; host/OC-bridge/MCP scheduling; conditional T `clock.sleep` pauses turns                                       | Allow bounded tasks; block unconstrained Gateway commands | With workspace node + Codex entry, OC triggers are disabled; timed admin command jobs remain. |
| Edit task files/skills/dependencies                  | T `write`, `edit`, `exec`                                                                                                               | T `exec_command`, `write_stdin`, `apply_patch`                                                                                     | Allow within existing policy                              | Preserve workspace ownership; runtime packages remain protected.                              |
| Create/deploy/stop an OCE Agent                      | No native OCE API; external HTTP/CLI only                                                                                               | No native OCE API; external HTTP/CLI only                                                                                          | Authorized OCE path                                       | Existing IAM applies; neither Harness gains implicit deployment authority.                    |

Calls are representative source entry points, not live exposure proof. Codex import applies the decision to selected control items; document/task
imports remain outside this RFC. Native `automations` rejects shell-command
payloads; admin RPC/CLI timed command jobs are not disabled by
`cron.triggers.enabled=false` and need execution containment. Codex clock/sleep and plugin schedule metadata do not prove
persistent scheduling support.

Common OCE calls are `createAgent`, `deployAgent`, `stopAgent`, and
`updateConfiguration` in the [HTTP contract](../../packages/contracts/src/api/routes.ts).
Trusted OCE startup uses Codex configuration/plugin RPCs. A native
`operator.admin` session is not the OCE publisher. OC `openclaw` delegates to a
system-agent turn; its privileged actions require host state and ownership checks.
Agent documents remain out of scope.

Inventory sources: [OC mutation handlers](https://github.com/openclaw/openclaw/tree/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods),
[OC model tools](https://github.com/openclaw/openclaw/tree/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools),
[Codex client/server methods](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-protocol/src/protocol/common.rs),
[Codex conditional tools](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/tools/spec_plan.rs#L1397),
and [Codex CLI lifecycle](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/cli/src/main.rs#L648).

## Existing controls and the gap

OC checks `OPENCLAW_CONFIG_READONLY=1` at its
[configuration writer](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/config/config-write-guard.ts#L46).
OCE derives that flag from directory writability; startup can create a writable
effective copy. Worker maintenance does not compare native configuration/roster.

Codex supplies administrator constraints and restricted filesystem policy;
[its configuration writer](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server/src/config_manager_service.rs#L222)
rejects exact requirements-managed fields. Legacy `managed_config.toml`
constrains a limited subset at this pin. Full-access execution needs host
containment. See [administrator configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
and [sandboxing](https://learn.chatgpt.com/docs/sandboxing).

OCE publishes Codex user config and validates selected native requirements at
startup. This does not establish a universal OCE-owned ceiling or future-turn
enforcement. Sources: [runtime entrypoint](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts),
[native admin contract](../../docs/reference/agent-native-admin.md), and
[worker](../../apps/controller/src/worker.ts).

Reviewed pins: OCE `1a031d2ff908`, OC `90d30a1178a7`, and packaged Codex
`0.163.0-alpha.2` (`a6274249d587`). No runtime qualification was performed.

## OCE–runtime interface

Extend the existing [Harness descriptors, workload requirements, and Compute
readiness](../../packages/contracts/src/index.ts). Compute already selects and
starts the runtime; this proposal adds no Harness Driver or separate registry.

Illustrative launch requirement:

```ts
managedMode: {
  version: 1;
  generation: string; // OCE-issued identity for effective configuration and policy
}
```

OCE derives the generation from the admitted immutable AgentRevision selected
for launch and Compute overlays. Existing file/environment delivery carries
native configuration and policy. Admission checks support for the selected Harness, runtime image,
topology, and Compute/Sandbox provider. Unsupported combinations are refused.

The runtime reports the contract version, applied generation, actual runtime
version, and digest of its effective configuration through existing runtime
status. Compute validates this report and the host's containment before declaring
readiness. An echoed launch argument or copied configuration file is insufficient.
Missing, invalid, unsupported, or unapplied managed policy keeps the deployment
unready; it must not fall back to ordinary execution.

Dedicated OC requires acknowledgements from both its OC Harness and Gateway;
hosted workers must inherit and enforce the same baseline. Embedded OC covers
both roles in one runtime. Dedicated Codex requires separate Codex and OC
acknowledgements: protecting the Harness does not protect its Gateway.

## Enforce the baseline

The host selects managed mode; model execution and native administration cannot
disable it. Native runtimes enforce these rules at mutation owners, before side
effects, and across fresh, resumed, and delegated execution. Hide prohibited management
tools as well. Approval cannot grant permission to change OCE-owned state.

Compute/Sandbox protects effective configuration, OCE-owned authority/credential
stores, their parent directories, and runtime/plugin packages from model execution.
A native read-only flag cannot stop shell writes to writable files. Only trusted OCE
publication may replace a generation; startup transforms and credential rotation
must use that path. Host administrators and trusted in-process plugin code remain
outside this threat boundary. This narrows RFC-0010's full native administration
exception without changing RFC-0003's document ownership.

## Reconciliation and delivery

Confirmed drift in the protected state above should be repaired against the
active revision through Compute. Ordinary credential rotation and task state
are not drift. Reconciliation complements mutation prevention. An unreachable native API is an observation failure, not evidence of
no drift. Recovery must preserve workspace and persistent runtime data; it must
not use destructive native agent deletion. Agent document changes are ignored.

Dedicated OC is the first implementation and qualification milestone. It must
run a separate Harness and Gateway with managed mode active on both. A follow-up
plan should define observation cadence, repair mechanics, and repair
authorization; today's
worker reauthorizes the deployer and cannot silently assume system authority.

Run the acceptance proof on dedicated OC first, then embedded OC and dedicated
Codex. Verify initial deployment, resume, delegation, and an admitted OCE update.
Acceptance requires real-runtime proof that prohibited native and model writes
fail, permitted session/task work and trusted credential refresh still work,
and resume/delegation cannot weaken policy. Also verify unsupported-mode refusal,
truthful applied-generation reporting and drift recovery that preserves data. This
RFC changes no runtime behavior; these checks have not run.
