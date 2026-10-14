---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Proposal: A managed-mode contract for OCE runtimes

- **ID:** RFC-0020
- **Created:** 2026-10-13
- **Last updated:** 2026-10-14
- **RFC PR:** [#2367](https://github.com/openclaw/openclaw-enterprise/pull/2367)
- **Related:** [Agent access](0010-agent-access.md), [storage ownership](0003-gateway-harness-storage-split.md), [plugin policies](0014-plugin-policy-enforcement.md)

## Summary

OpenClaw Enterprise (OCE) admins choose OpenClaw (OC) or Codex as parallel
Harness options. Both must provide the same versioned managed-mode contract:
OCE's trusted control plane owns managed control configuration; neither the
model nor the running Harness may modify or replace it.

Compute activates a deployment only after runtime enforcement and host
containment are established for the selected Harness and its Gateway.
Dedicated OC is the priority for investigation and qualification; it is not a
prerequisite for Codex support. Its separate Harness and Gateway must both enforce
the contract. Embedded OC follows the same baseline. AGENTS.md, SOUL.md,
IDENTITY.md, USER.md, and other agent documents are outside this proposal.

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

| Action                                               | OC Gateway/Harness support and example calls                                                                                            | Codex support and example calls                                                                                                    | Managed mode                                              | Current OCE coverage / gap                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Read configuration/status/catalogs                   | R `config.get`, `agents.list`, `plugins.list`; T `gateway(config.get)`                                                                  | R `config/read`, `configRequirements/read`, `plugin/list`                                                                          | Allow permitted reads                                     | Native read scopes apply; client responses are not automatically model-safe.                             |
| Persist control settings                             | R `config.set`, `config.patch`, `config.apply`; T `openclaw` delegates system-agent changes; C `openclaw config set`                    | R `config/value/write`, `config/batchWrite`, `externalAgentConfig/import` (CONFIG); C config edits                                 | Block                                                     | OC read-only flag is conditional; Codex checks exact requirements fields.                                |
| Replace files or override runtime startup            | T `write`, `exec`; C config/environment/launcher overrides                                                                              | T `apply_patch`, `exec_command`; C `codex -c`; R `thread/start` config overrides                                                   | Block managed-state bypass                                | No uniform protection of managed paths is established.                                                   |
| Persist agents/roles                                 | T `openclaw` delegation; R `agents.create`, `agents.update`, `agents.delete`; C `openclaw agents add`                                   | No OC roster CRUD; R `externalAgentConfig/import` (SUBAGENTS), config writes; C role TOML files                                    | Block unadmitted roster/role changes                      | OC config guard is conditional; persistent roles differ from child threads.                              |
| Start/resume/delegate sessions                       | R `sessions.create`; T `sessions_spawn`                                                                                                 | R `thread/start`, `thread/resume`, `thread/fork`; T `spawn_agent`, `send_input`                                                    | Allow within admitted policy                              | Tool exclusions alone do not qualify inherited policy.                                                   |
| Choose session model/execution options               | R `sessions.patch`; T `session_status(model=…)`; `/model` command                                                                       | R `thread/start`, `thread/resume`, `turn/start` overrides                                                                          | Allow within OCE ceiling                                  | Provider/topology pins and startup checks do not prove later routing.                                    |
| Install/configure runtime plugins and tool providers | T `plugins(install/enable/uninstall)`; R `plugins.install`, `plugins.setEnabled`; C `openclaw plugins update`                           | T `request_plugin_install`; R `plugin/install`, `plugin/uninstall`; C `codex mcp add`                                              | Block unadmitted changes                                  | Trusted startup installs plugins; selected tool hiding is not a mutation barrier.                        |
| Update runtime packages                              | T `gateway(update.run)`; R `update.run`; C `openclaw update`                                                                            | C `codex update`, daemon-only `codex app-server daemon update`; no process-update RPC                                              | OCE upgrade only                                          | OC auto-update is disabled; external-supervisor mode blocks self-update but is not explicitly delivered. |
| Restart/reload admitted runtime                      | T `plugins(reload)`; R `gateway.restart.request`, `plugins.reload`; C `openclaw gateway restart`                                        | R `plugin/reconcile`, `config/mcpServer/reload`; C daemon-only `codex app-server daemon restart`                                   | Trusted recovery only                                     | Supervisor mode preserves targeted OC restart; plugin reload still needs separate policy.                |
| Replace provider identity/credentials                | T `secrets(request/delete)` (primary); R `models.authLogin`, `models.authOrderSet`, `secrets.store.set`; C `openclaw models auth login` | R `account/login/start`, `account/logout`; C `codex login`, auth/config files                                                      | Block changing OCE-owned bindings                         | Auth/secret stores need separate controls; task secrets retain existing policy.                          |
| Expand pairing/trust/scopes                          | T `nodes(approve)`; R `device.pair.approve`, `channels.pairing.approve`                                                                 | Experimental R `remoteControl/pairing/start`, `remoteControl/client/revoke` requires a configured handle; no OC node/channel roles | Block authority expansion                                 | OC admin RPCs relay; Codex remote-control exposure is unverified.                                        |
| Widen permissions/approvals/tool exposure            | R `exec.approvals.set`, `sessions.patch`; ordinary approval R `exec.approval.resolve`                                                   | T `request_permissions`; R `thread/start` with `dynamicTools`; S `item/permissions/requestApproval`                                | Block widening; allow bounded approvals                   | OC approval stores are separate; OCE Codex checks are startup-scoped.                                    |
| Refresh admitted credentials/peers                   | R `models.authRefresh`; trusted workspace-node renewal                                                                                  | Internal auth refresh; S `account/chatgptAuthTokens/refresh` for external token ownership                                          | Trusted flow allowed                                      | Preserve admitted identity/scopes; child token filtering alone is not containment.                       |
| Schedule tasks                                       | T `automations`; R `cron.add`, `cron.update`, `cron.run`; C `openclaw cron add`                                                         | No native cron CRUD; host/OC-bridge/MCP scheduling; conditional T `clock.sleep` pauses turns                                       | Allow bounded tasks; block unconstrained Gateway commands | With workspace node + Codex entry, OC triggers are disabled; timed admin command jobs remain.            |
| Edit task files/skills/dependencies                  | T `write`, `edit`, `exec`                                                                                                               | T `exec_command`, `write_stdin`, `apply_patch`                                                                                     | Allow within existing policy                              | Preserve workspace ownership; runtime packages remain protected.                                         |
| Create/deploy/stop an OCE Agent                      | No native OCE API; external HTTP/CLI only                                                                                               | No native OCE API; external HTTP/CLI only                                                                                          | Authorized OCE path                                       | Existing IAM applies; neither Harness gains implicit deployment authority.                               |

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

## Prior work and current status

Checked OCE main `9a5f37d5efb0` and upstream OC main `98116a50c5e3`.
PR validation below is recorded author evidence; it was not rerun here.

| Prior work                                                                                                                                                                                                 | Status                          | Reuse and remaining gap                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC [#109162](https://github.com/openclaw/openclaw/pull/109162) and [#121069](https://github.com/openclaw/openclaw/pull/121069)                                                                             | Merged; present in OCE's OC pin | Lifecycle supervision and optional shared-state ownership; coverage is detailed below.                                                                                                                                                                                                                                 |
| RomneyDa's OC [#157679](https://github.com/openclaw/openclaw/pull/157679) and [#158723](https://github.com/openclaw/openclaw/pull/158723)                                                                  | Open, unmerged                  | Deployment-specific supervisor guidance and externally managed Doctor repair. Guidance adds no authority; repair preserves deployment config/service ownership. These additions are not in inspected main.                                                                                                             |
| OCE [#840](https://github.com/openclaw/openclaw-enterprise/pull/840), [#2273](https://github.com/openclaw/openclaw-enterprise/pull/2273), [#333](https://github.com/openclaw/openclaw-enterprise/pull/333) | Merged                          | Conditional config guard, dedicated-Codex tool exclusions, and OCE-owned image rollouts. Explicit supervisor-mode delivery is absent from reviewed runtime paths; writable effective copies and native-admin RPCs remain gaps.                                                                                         |
| Dedicated OC [#1708](https://github.com/openclaw/openclaw-enterprise/pull/1708), [#1685](https://github.com/openclaw/openclaw-enterprise/pull/1685)                                                        | #1708 merged; #1685 open/draft  | Native configuration/workspace ownership is implemented. #1685 reports 4/4 real deployment/model/exec/redeploy tests at `c50dca7`; [CI](https://github.com/openclaw/openclaw-enterprise/actions/runs/38515204772) passed. Managed-state denial remains unproven; main's default native-worker admission remains gated. |
| Containment [#1003](https://github.com/openclaw/openclaw-enterprise/pull/1003)                                                                                                                             | Open, specification only        | Proposed policy/evidence contract; complementary to this RFC's runtime mutation ownership.                                                                                                                                                                                                                             |

## Native controls to reuse

These are current native building blocks. Both Harness options must close every
required gap before managed activation; partial native coverage is insufficient.

| Existing control                                                                                                                                                       | Coverage today                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC [external supervision](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/docs/cli/gateway/restart-and-supervision.md#L171)         | Refuses native service install/rewrite/start/stop/uninstall/restart and self-update. CLI restart targets the verified Gateway; authorized RPC restart remains available. Fresh-process restarts use bounded, one-time handoffs.                                                                                                                                                                                             |
| OC [shared-state ownership claim](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/docs/cli/gateway/restart-and-supervision.md#L180) | Explicit opt-in rejects unmarked writers before database migration/repair. External-mode writers remain allowed; this prevents accidental writes and supplies no publisher authentication.                                                                                                                                                                                                                                  |
| OC config/plugin guards                                                                                                                                                | Separate `OPENCLAW_CONFIG_READONLY=1` rejects supported config writers and [managed plugin installation](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/plugins/management-mutations.ts#L115). Supervisor mode leaves config, provider, plugin, and roster changes under existing authorization.                                                                                    |
| Codex daemon ownership                                                                                                                                                 | Refuses [restart/stop of an unowned app-server](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-daemon/src/lib.rs#L463); [daemon updates](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-daemon/src/manual_update.rs#L149) require an eligible package. OCE runs a foreground app-server, without that daemon updater. |
| Codex administrator requirements and sandbox                                                                                                                           | Requirements pin supported provider/security fields; [config RPC writes](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server/src/config_manager_service.rs#L222) cannot edit exact requirements-owned fields. Managed permission profiles restrict execution paths; child policy is inherited. Unconstrained config remains editable.                                         |

Codex has separate ownership and policy mechanisms rather than an OC-style
supervisor switch. See [administrator configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration),
[permission profiles](https://learn.chatgpt.com/docs/permissions), and
[child policy inheritance](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/agent/child_config.rs#L131).

OCE still derives OC's read-only flag from effective-directory writability;
startup can retarget it to a writable copy. It publishes Codex user config and
checks selected native requirements at startup. Current recovery preserves
unrelated native edits, and worker maintenance does not compare native
configuration/roster. See [runtime entrypoint](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts),
[native admin contract](../../docs/reference/agent-native-admin.md), and
[worker](../../apps/controller/src/worker.ts).

Native calls were inspected at OC `90d30a1178a7` and packaged Codex
`0.163.0-alpha.2` (`a6274249d587`). No new runtime qualification was performed.

## Remaining gaps by owner

The OC and Codex work below meets one mandatory contract for parallel Harness
choices. Dedicated OC is the investigation focus: cover its separate Gateway,
Harness and hosted workers. Enable/configure selects existing native controls;
OCE implementation wires them and adds controller, Driver, or Compute behavior.

### OC Harness (dedicated OC focus)

| Owner                              | Remaining work                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCE enable/configure               | Select external supervision and config-read-only policy. Pin admitted providers/plugins; reuse existing config/plugin guards. Adopt the optional database claim only after qualifying participating writers.                                                                                                                                                                                  |
| OCE implementation: execution      | Carry supervision through participating writers; enable config-read-only after trusted bootstrap. Derive policy from deployment ownership, not directory writability. Protect effective config, auth/role stores, approved plugin/load roots, binaries and parents. Confine shell/process access and alternate paths; retain trusted refresh.                                                 |
| OCE implementation: administration | Restrict native-admin RPCs and direct socket access. Keep publication, upgrades, and authorized recovery in Compute; a relay filter alone cannot cover local/in-process mutations.                                                                                                                                                                                                            |
| OCE implementation: control plane  | Add managed-mode admission/readiness and observation of managed fields/roster. Compare with the active revision and repair under approved authority without deleting persistent task data or agent documents.                                                                                                                                                                                 |
| OC native changes: agent lifecycle | Check managed-state admission before control side effects. Today [agent deletion](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods/agents.ts#L703) starts deletion bookkeeping and prepares databases before reaching the config guard.                                                                                          |
| OC native changes: shared policy   | Enforce admitted principals and grant ceilings for selected [pairing](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods/devices.ts#L279)/approval mutations in writable shared state. Preserve existing config security/ask ceilings and ordinary runtime database writes; making the entire database read-only would break them. |

Qualification must cover both roles, resume/delegation, plugin load/reload, trusted
refresh and recovery. Add OC policy-inheritance or load-path checks only where
existing controls fail this proof. Reuse [native applied-config hashes](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/config-get-response.ts#L26)
and qualified host observations for the status contract; extend native reporting
where they are insufficient.

### Codex Harness

**OCE enable/configure:** publish administrator requirements for supported
provider, permission, feature and plugin/MCP ceilings, plus managed permission
profiles. Apply the same protected-file, RPC, readiness and reconciliation work
above. Qualify existing child-policy inheritance.

**Required Codex enforcement:** requirements pin supported fields; they do not
freeze the entire managed configuration. Protect it against the running Harness
as well as model tools. Native changes are required wherever existing requirements
and OCE host enforcement cannot block a reachable mutation, including
[account mutations](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server/src/request_processors/account_processor.rs#L990)
or [plugin uninstall](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core-plugins/src/manager.rs#L2359).
A Codex deployment with any required protection missing must refuse managed
activation. Extend native reporting where existing readback cannot establish
applied-generation evidence; requirements readback alone is insufficient.

## OCE–runtime interface

For OC, add managed-state policy and applied-generation reporting to existing
external supervision. Preserve supervisor-only behavior for other deployments.
For Codex, reuse native requirements and permission profiles while Compute owns
deployment lifecycle. Both runtimes must meet the same baseline below.

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

Runtime status reports the contract version, applied generation, actual runtime
version, and digest of effective configuration. Compute may compose this report
from qualified native applied-state readback and host observations; add native
reporting where those cannot establish the contract. Compute validates the report
and containment before readiness. An echoed launch argument or copied file is insufficient.
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
stores, their parents, and runtime/plugin packages from workload writers:
model tools, the running Harness/Gateway, native API/CLI paths and loaded plugins.
An execution sandbox alone does not constrain native Harness writes outside it.
Only OCE's trusted control plane may publish or replace managed configuration;
trusted bootstrap and credential rotation must use its authorized path outside
agent-controlled execution. Ordinary session/task state remains writable within
policy. Infrastructure administrators remain outside the workload threat boundary.
This narrows RFC-0010's full native administration exception without changing
RFC-0003's document ownership.

## Reconciliation and delivery

Confirmed drift in the protected state above should be repaired against the
active revision through Compute. Ordinary credential rotation and task state
are not drift. Reconciliation complements mutation prevention. An unreachable native API is an observation failure, not evidence of
no drift. Recovery must preserve workspace and persistent runtime data; it must
not use destructive native agent deletion. Agent document changes are ignored.

Qualify OC and Codex independently against the same acceptance criteria.
Dedicated OC remains the priority investigation target and must run a separate
Harness and Gateway with managed mode active on both. A follow-up plan should
define observation cadence, repair mechanics and repair authorization; today's
worker reauthorizes the deployer and cannot silently assume system authority.

Each supported topology requires its own proof; one Harness's result cannot
qualify the other. Verify initial deployment, resume, delegation, and an admitted OCE update.
Acceptance requires real-runtime proof that prohibited native and model writes
fail, permitted session/task work and trusted credential refresh still work,
and resume/delegation cannot weaken policy. Also verify unsupported-mode refusal,
truthful applied-generation reporting and drift recovery that preserves data. This
RFC changes no runtime behavior; these checks have not run.
