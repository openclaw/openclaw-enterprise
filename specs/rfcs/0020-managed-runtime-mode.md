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

OpenClaw Enterprise (OCE) should require a versioned managed mode from its
Harness and Gateway runtimes. OCE supplies their control configuration; runtimes
enforce it against model execution and native administration. Compute activates a
deployment only after both runtime enforcement and execution containment are
established. AGENTS.md, SOUL.md, IDENTITY.md, USER.md, and other agent documents
are outside this proposal.

## Actions managed mode should allow or block

The proposed baseline separates runtime work from administration of the
deployment. **Block** means denied through model tools and native administration;
authorized OCE publication remains available. **Allow** preserves existing IAM,
tool, and topology restrictions.

| Action and examples                                                                                  | Managed mode               | Boundary                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Read status, redacted configuration, agent/plugin inventories                                        | Allow                      | Existing read permissions apply.                                                                           |
| Persist Gateway/Harness settings: `config.set/patch/apply`, Codex configuration writes               | Block                      | OCE owns listeners, provider bindings, default models/routing, and tool/permission policy.                 |
| Replace protected files or supply alternate runtime config, environment, or CLI overrides            | Block                      | File/shell execution cannot bypass the same ownership boundary.                                            |
| Create, update, or delete persistent native agents: `agents.create/update/delete`                    | Block                      | OCE owns the complete admitted roster, including multi-agent deployments.                                  |
| Create/resume sessions, spawn subagents, send delegated work                                         | Allow                      | Use admitted agents and inherited policy; this creates no persistent agent or OCE deployment.              |
| Select a session model or execution options                                                          | Allow within policy        | Use OCE-admitted models and Harness; permissions cannot exceed OCE's ceiling.                              |
| Install/remove/enable Gateway/Harness plugins, configure MCP/tool providers, update runtime packages | Block                      | OCE owns loaded runtime plugins, tool bindings, and version; installation requests do not grant authority. |
| Restart/reload the Gateway or reapply plugins/configuration                                          | OCE-controlled             | Trusted recovery may reapply the admitted generation; model tools cannot replace it.                       |
| Replace OCE-owned auth profiles/order or referenced credentials                                      | Block                      | Native auth/secret APIs cannot change the admitted provider identity or binding.                           |
| Expand device/node/channel trust or operator token scopes                                            | Block                      | Preserve trusted OCE enrollment; native pairing cannot expand managed authority.                           |
| Widen execution approvals, sandbox/write grants, or dynamic tool exposure                            | Block                      | Separate policy stores cannot bypass OCE's ceiling; ordinary task approvals still follow existing policy.  |
| Refresh credentials or renew an admitted runtime peer                                                | Allow through trusted flow | Preserve the admitted binding and scopes; no model-provided replacement identity.                          |
| Schedule or run tasks                                                                                | Allow within policy        | Existing automation restrictions apply; scheduled work cannot gain Gateway administration.                 |
| Write task files, memory, workspace skills, and project dependencies                                 | Allow within policy        | Existing workspace ownership applies. Agent documents are outside this RFC.                                |
| Create/deploy/stop an OCE Agent or publish an OCE Configuration revision                             | OCE-controlled             | Existing authorized control-plane APIs remain available; managed mode grants no deployment credentials.    |

The same decision applies through the OC Console, RPCs, CLI, dynamic tools, and
direct filesystem access. Hiding a tool is insufficient. Trusted startup may
still configure Codex and install admitted plugins; a native `operator.admin`
session does not become the OCE publisher. Task secrets retain existing policy;
OCE-owned provider and workload credentials remain protected.

Inventory sources: [OC mutation handlers](https://github.com/openclaw/openclaw/tree/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods),
[OC model tools](https://github.com/openclaw/openclaw/tree/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools),
and [Codex client methods](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-protocol/src/protocol/common.rs).
These are supported entry points, not proof that OCE exposes each to every model.

## Existing controls and the gap

Codex provides useful mechanisms rather than a flag that freezes every setting:

| Codex mechanism                   | What it gives OCE                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Administrator `requirements.toml` | Constraints that user, project, and per-turn configuration cannot override, including permitted sandbox and approval choices. |
| Restricted filesystem permissions | Writable task files with protected configuration paths. Full-access execution requires separate host containment.             |
| App-server configuration RPCs     | A trusted client write path that rejects changes to fields with exact requirements. These RPCs are not model tools.           |

Legacy `managed_config.toml` constrains only a limited subset of settings at this
Codex version. OCE must protect the actual configuration paths and prevent
permission grants from bypassing that protection. See [administrator configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration),
[sandboxing](https://learn.chatgpt.com/docs/sandboxing), and the
[configuration writer](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server/src/config_manager_service.rs#L222).
The source comparison uses OCE's packaged Codex `0.163.0-alpha.2`; no runtime
qualification was performed.

OpenClaw (OC) already checks `OPENCLAW_CONFIG_READONLY=1` at its
[canonical configuration writer](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/config/config-write-guard.ts#L46).
OCE currently derives that flag from the effective configuration directory's
writability, while startup can create a writable private copy. Dedicated Codex
excludes some management tools, but auth, pairing, approval stores, and lifecycle
actions also need enforcement. Worker maintenance checks infrastructure and
readiness without comparing native configuration or roster. These source
findings use OCE `4cb3db1a8655`; see its [runtime entrypoint](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts),
[native admin contract](../../docs/reference/agent-native-admin.md), and
[worker](../../apps/controller/src/worker.ts).

OC's config guard covers part of the inventory. Managed mode needs enforcement
at each remaining mutation owner and evidence that the baseline is active.

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

Embedded OC covers both Harness and Gateway roles. Dedicated Codex requires
separate Codex and OC acknowledgements: protecting the Harness does not protect
its Gateway.

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

First implement and qualify the managed-mode interface. A follow-up plan should
define observation cadence, repair mechanics, and repair authorization; today's
worker reauthorizes the deployer and cannot silently assume system authority.

Acceptance requires real-runtime proof that prohibited native and model writes
fail, permitted session/task work and trusted credential refresh still work,
and resume/delegation cannot weaken policy. Also verify unsupported-mode refusal,
truthful applied-generation reporting, an admitted OCE update, and drift recovery that preserves data. This
RFC changes no runtime behavior; these checks have not run.
