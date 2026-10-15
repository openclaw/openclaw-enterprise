---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# RFC-0021: Managed-mode contract for OCE runtimes

> This working draft proposes a managed-runtime boundary and an initial restriction
> on administrative Gateway tools. Findings describe inspected sources; proposed
> behavior and remaining qualification work are identified separately.

**Implementation:** P0 integration proposed; deployed qualification incomplete.

- **Created:** 2026-10-13
- **Last updated:** 2026-10-15
- **RFC PR:** [#2367](https://github.com/openclaw/openclaw-enterprise/pull/2367)
- **Related:** [Agent access](../0010-agent-access.md), [storage ownership](../0003-gateway-harness-storage-split.md), [plugin policies](../0014-plugin-policy-enforcement.md)

## Summary

OpenClaw Enterprise is an agent deployment platform where OCE admins define the desired configuration of an Agent and deploy it, similar to Kubernetes. The [OpenClaw Control Plane (OCC)](https://github.com/openclaw/openclaw-enterprise/blob/fdd4a5850d9687f3ee0bad2e5e44f156760bbafc/docs/design.md#L11) owns desired state and deployment lifecycle.

OCE has swappable Drivers and a choice of first-party Harness: native OpenClaw or Codex. Both runtimes expose native configuration and administration paths. In managed mode, the Harness and model-written code must run in a separate data-plane workload from the Gateway. Trusted Gateway handlers execute approved tool and RPC operations in the Gateway workload. The Gateway provides a restricted coordination boundary under OCC management; OCE's trusted control plane remains the authority for deployment configuration and lifecycle.

To preserve OCE's ownership of deployment configuration and lifecycle, Gateway calls made by model-directed work must not override OCE-owned configuration or permissions. The same requirement applies to model-origin CLI commands, file changes and plugin operations. Authorized human Gateway administration remains available.

### Dedicated topology: OC or Codex

![Dedicated OC and Codex workloads across the control-plane and data-plane boundary](dedicated-managed-topology.png)

[Editable Excalidraw source](dedicated-managed-topology.excalidraw). Open the file in Excalidraw to edit the diagram.

Sources: [Harness placement and execution](https://github.com/openclaw/openclaw-enterprise/blob/909b0b9d45c10a40e42ef31d1e53cea6cd846cf5/docs/reference/harness-execution.md#L16), [Gateway/Harness transport](https://github.com/openclaw/openclaw-enterprise/blob/909b0b9d45c10a40e42ef31d1e53cea6cd846cf5/docs/reference/gateway-routing.md#L79).

## OpenClaw Harness vs Codex

OCE owns deployment configuration and lifecycle for both Harnesses. The difference is where native session state lives and where restrictions must be enforced.

**Codex:** Codex app-server owns native execution threads inside the Harness workload. The Gateway coordinates those threads, maintains OC Agent/session state, and supplies Gateway tools. Managed mode needs restrictions on those tools and protection for Codex's local configuration and administrative interfaces.

**OpenClaw:** The Gateway owns OC sessions and assigns execution to a dedicated worker. It can enforce restrictions on model-accessible tools and RPCs outside the Harness workload. The worker's local configuration, credentials and processes still need separate protection.

## Gateway RPC categories

These categories group Gateway RPCs by the resources and permissions they affect. They describe the broader boundary for model-directed work; inclusion in the table does not mean the Harness can invoke every listed RPC. P0 uses the existing tool filters described below. Authorized human administration remains governed by Gateway permissions.

| Category                                  | What it affects                                                                                        | Representative OC Gateway calls                                                                                           | Managed boundary to establish                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Observation and discovery**             | Reads health, configuration, history, and available capabilities.                                      | `health`, `config.get`, `models.list`, `sessions.list`                                                                    | Read access stays scoped to the Agent/session and redacts secrets.                                                                                                      |
| **Task and session operations**           | Runs work, creates task state, changes session options, or schedules work.                             | `chat.send`, `sessions.create`, `sessions.patch`, `node.invoke`, `cron.add`, `cron.run`                                   | Work stays within admitted models, tools, workspaces, execution locations, and limits. A session or transient subagent is distinct from deploying a new Agent.          |
| **Deployment configuration and topology** | Changes settings, routing, or the persistent agent roster that define how the deployment runs.         | `config.set`, `config.patch`, `config.apply`, `agents.create`, `agents.update`, `agents.delete`                           | OCE publishes managed configuration and roster changes. A bounded session option differs from changing the configured default.                                          |
| **Runtime and software lifecycle**        | Changes the deployed runtime process, installed runtime code, loaded extensions, or service ownership. | `update.run`, `gateway.restart.request`, `gateway.stop.request`, `plugins.install`, `plugins.uninstall`, `plugins.reload` | OCE owns deployed runtime software and service lifecycle. Any delegated recovery action needs explicit bounds; task cancellation is separate from stopping the runtime. |
| **Authority, trust, and credentials**     | Changes trusted callers/nodes, permissions, approval policy, or credential bindings.                   | `device.pair.approve`, `exec.approvals.set`, `exec.approval.resolve`, `models.authSetApiKey`, `models.authRefresh`        | OCE owns standing authority and credential bindings. Refreshing an approved credential and resolving a bounded approval differ from granting new authority.             |

## Managed harness boundary

OCE owns the deployed Agent's configuration and permission limits. The Harness executes model-directed work within those limits. Managed mode must prevent that work from changing the deployment configuration, credentials, installed capabilities and runtime processes that determine its authority.

This boundary applies to both dedicated OC and dedicated Codex. **P0 blocks the reviewed Gateway administrative tools from model-directed work**, including administrator-started chats, children and scheduled jobs. Trusted human Gateway UI/CLI administration remains available under existing authorization. Harness-local configuration, credentials and processes need separate runtime protection; Gateway filtering does not establish the complete managed-runtime guarantee. Human-edit persistence and automatic drift repair are separate policy decisions.

Normal work remains useful: scoped reads and tool discovery, session metadata and history, permitted session model/thinking choices, child tasks, session messaging, ordinary scheduled Agent turns, and shell/file work inside the Harness's execution boundary. The full managed-runtime contract must prevent model-directed work from changing deployed defaults, persistent Agent definitions, plugins, standing permissions, credential bindings or the deployed runtime lifecycle. P0 addresses the reviewed Gateway administrative tools; Harness-local protection and end-to-end qualification remain separate work. Cancelling a task is different from stopping the runtime; creating a child task is different from deploying an Agent. Agent document content remains out of scope.

The implementation below is proposed work built on inspected native controls. It is not a completed end-to-end qualification.

### Gateway controls shared by both harnesses

**OCE should configure a denylist using existing controls:** global `tools.deny` for dedicated OC, and `plugins.entries.codex.config.codexDynamicToolsExclude` for dedicated Codex. Both block the six tools below. No new policy input is needed for this P0. The per-harness settings below preserve their different execution and tool arrangements.

| Blocked model tool | Reason                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `gateway`          | Can run a runtime update. Whole-tool exclusion also removes configuration reads.                |
| `plugins`          | Can install, activate, remove or reload plugins. Inspection through this tool is also excluded. |
| `openclaw`         | Delegates to a privileged setup/repair agent.                                                   |
| `nodes`            | Can change pairing and device authority.                                                        |
| `terminal`         | Can send input to Gateway operator terminals.                                                   |
| `secrets`          | Can delete team secrets. Its credential-request and read actions are also excluded.             |

**Task/session work and observation remain available under existing policy.** This includes permitted session operations, child tasks, ordinary scheduled Agent turns, discovery and configured task tools. Local commands and files stay within the assigned Harness execution boundary.

Keep `agents.defaults.modelSelectionScope: "session"` so session model choices do not become deployed defaults. This setting also applies to the human model picker.

Set `cron.triggers.enabled: false` to disable stream schedules, condition triggers and cron script payloads. This prevents stream commands from executing on the Gateway and also disables the other scripting features controlled by this setting. The restriction applies to both model-created and human-created jobs; ordinary timed Agent turns remain available.

**Direct human administration remains available.** A human administrator can still use Gateway Console forms, CLI commands or RPCs to change configuration and plugins, subject to existing role/scopes and write rules. An administrator asking the Agent to do the same work remains subject to the model-tool restriction. The Console tool tester honors ordinary OC tool policies, including global `tools.deny`. Codex's `codexDynamicToolsExclude` filters tools supplied to Codex and does not filter the Console tool tester. The denylist affects callable tools, not only the descriptions shown to the model. [Gateway authorization](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods/method-authorization.ts#L29), [tool tester](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/tools-invoke-shared.ts#L400).

#### Relationship to plugins

`plugins.allow` and `plugins.entries` control which plugins load and how they are configured. `tools.allow`, `tools.alsoAllow` and `tools.deny` control model tools, including tools supplied by plugins. The tool named `plugins` is the model's plugin-management interface; excluding it does not unload configured plugins or disable their other task tools.

OCE's plugin merge adds tool grants, but preserves denials, and OC checks deny before allow. A plugin grant therefore cannot restore a tool blocked by `tools.deny`. Codex's separate exclusion list removes matching Gateway tools from its dynamic-tool set. OCE must preserve these restrictions when composing the final configuration. [Plugin merge test](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/tests/conformance/plugin-runtime-policy.test.mjs#L578), [deny precedence](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tool-policy-match.ts#L48), [Codex exclusions](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/dynamic-tool-profile.ts#L99).

**This is a denylist of reviewed tools.** Other configured tools retain their existing policy; a newly introduced administrative tool is not blocked automatically. Review tool/plugin additions and update the list when their capabilities require it.

### Dedicated OpenClaw implementation

The Gateway owns OC sessions and assigns work to the dedicated native worker. The worker's node identity does not grant general operator configuration RPCs. Child creation already inherits tool/permission policy and checks the parent's placement profile. OCE should retain these controls while applying the shared Gateway policy above. [Node method authorization](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods/method-authorization.ts#L43), [child policy and placement](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/worker-environments/worker-session-tool-executor.ts#L198).

**OCE work:** merge these names into global `tools.deny`, preserving all existing denials and other tool restrictions:

```json
{
  "tools": {
    "deny": ["gateway", "plugins", "openclaw", "nodes", "terminal", "secrets"]
  }
}
```

The global policy covers administrator-started model chats as well as ordinary chats. OC already filters tools before issuing worker handles, and invocation requires a valid handle. Keep Gateway administration credentials outside model execution. Native node-host identity and startup protection are separate runtime work, recorded in [remaining work](remaining-work.md). [Global policy stage](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tool-policy-pipeline.ts#L109), [worker invocation](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/worker-environments/worker-gateway-tool-runtime.ts#L168).

**OC work:** whole-tool exclusions require no new action-filtering mechanism. Add finer restrictions only if we retain permitted actions within excluded tools, or preserve human-managed streams while denying model-created stream commands.

### Dedicated Codex implementation

Codex app-server runs in the Harness workload and owns its native execution threads. The Gateway coordinates them, supplies instructions and Gateway tools, and retains OC routing/session state. Codex combines those supplied tools with its native capabilities. P0 filters the Gateway-supplied tools while retaining native Codex execution and subagents under their existing policies. [Adapter inputs](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/thread-requests.ts#L151).

**OCE work:** add `nodes` and `secrets` to the existing dedicated-Codex `codexDynamicToolsExclude` list. The minimum combined list is below; retain any additional configured exclusions:

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "config": {
          "codexDynamicToolsExclude": [
            "ls",
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "gateway_exec",
            "gateway_process",
            "terminal",
            "portal",
            "openclaw",
            "plugins",
            "gateway",
            "nodes",
            "secrets"
          ]
        }
      }
    }
  }
}
```

The existing exclusions remove Gateway execution implementations that Codex replaces, along with several administrative tools; `nodes` and `secrets` complete the six-tool P0 denylist. Excluded tools are absent from the dynamic-tool dispatch map as well as the advertised list. Native `spawn_agent` and permitted Gateway session tools, including `sessions_spawn`, remain available under existing checks. [Existing OCE list](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L2373), [dynamic-tool filtering](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/dynamic-tool-profile.ts#L99), [invocation](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/dynamic-tools.ts#L376).

Use this Codex-specific field instead of also inserting the six names into global `tools.deny` for Codex. Ordinary tool restrictions deliberately disable native Codex tools and subagents when OC cannot map them safely; several of these six names trigger that behavior. The dynamic-tool exclusion field limits Gateway tools without triggering that broader restriction. Existing stricter policies must still apply. [Policy classification](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/harness/execution-environment.ts#L479), [Codex policy support](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/harness.ts#L49).

**Beyond Gateway P0: protect configuration and runtime inputs.** OCE must enforce an execution boundary that protects its configuration, credentials, policy files and trusted processes across presets, authentication methods, approvals and delegated work. The Gateway/Harness Pod split alone does not protect app-server from model commands running inside the Harness workload. Token authentication protects its administrative connection; local files and processes need execution restrictions as well.

**For the full runtime contract, OCE must provision effective managed requirements.** Protect the system policy file, its parent directories and referenced code, and verify the merged requirements actually applied. OCE's inspected launcher publishes user config; it does not yet provision the complete protected requirements policy described here. Requirements constrain supported settings but do not freeze every setting or make privileged client RPCs safe for model use. [Current runtime-file contract](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/sandbox/openshell.ts#L596), [requirements composition](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/config/src/requirements_layers/stack.rs#L153).

| Configuration to control                            | Available Codex support and remaining limit                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval policy, reviewer and execution permissions | Requirements constrain policies/reviewers and provide managed permission profiles. Sandbox-family restrictions alone do not pin every writable root or network option; qualify the effective profile and all override paths. |
| Provider routing                                    | Requirements can pin the provider ID and its definition. OCE must supply both where it owns that routing.                                                                                                                    |
| Native tools, MCP, plugins and hooks                | Feature, MCP identity and managed-hook controls exist. They are not a universal capability/configuration lock. OCE must protect executable inputs and approve native capability sources separately from Gateway tools.       |
| Model, effort and service tier                      | New-thread settings provide defaults, not a general enforced allowlist. Exact locks remain optional product decisions; a required unsupported restriction would need Codex work.                                             |

**Codex work:** extend native enforcement only where existing requirements and execution restrictions cannot meet the chosen contract. A client RPC allowlist is not a P0 prerequisite while model execution lacks a usable administrative connection. Native child tasks and trusted Gateway thread start/resume remain available.

## Remaining work

[Remaining work and verification](remaining-work.md) records the runtime protection, Gateway integration and qualification still needed for this proposal.
