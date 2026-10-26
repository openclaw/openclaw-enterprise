---
rfc: index.md
---

# OCE-managed deployments: remaining work and verification

This companion records outstanding work for [RFC-0021](index.md).

## Delivery sequence

The coordinating thread maintains the completion column and PR links. Each implementation PR names its RFC item numbers, dependencies and evidence. Status progresses from queued or preparing to in progress, PR open, merged, and complete after the required verification. OC stages A–C have merged. OCE integration and deployment qualification remain open; no item is complete yet.

| Stage                 | RFC items                    | Dependency and deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — OC Gateway policy | 1, 2; native OC part of 8    | Merged [OC #174547](https://github.com/openclaw/openclaw/pull/174547) implements the policy schema and discovery/invocation checks, including retained worker handles. Historical worker-error forwarding checks passed 73 focused cases; that fix was packaged in the earlier OCE qualification images. Historical qualification used patched OC `c2976c8` on the earlier base with approved `fs-safe@0.26.6` dependencies.                                                                                                                                                                                                       |
| B — OC automations    | 3, 4; automation part of 8   | Merged [OC #174580](https://github.com/openclaw/openclaw/pull/174580) restricts model turns to caller-owned automations and blocks command jobs. Owned-job operations remain available. The separate scheduling-authentication fix merged in [OC #179696](https://github.com/openclaw/openclaw/pull/179696). Historical validation covered 17 routed cases and 28 authentication cases. An isolated Codex schedule also completed an actual `agents_list` call.                                                                                                                                                                    |
| C — OC Codex adapter  | 5; Codex part of 8           | Merged [OC #174565](https://github.com/openclaw/openclaw/pull/174565) filters schemas and guarded callbacks. The review fix keeps malformed tool descriptors from disabling valid tools. Earlier evidence covers 80 focused cases, including restored-tool compatibility. Tools capture the deployment policy; changes require Gateway restart or replacement.                                                                                                                                                                                                                                                                     |
| D — OCE integration   | 6, 7; OCE part of 8          | [OCE #2633](https://github.com/openclaw/openclaw-enterprise/pull/2633) implements the baseline on OC `cee236c9`. Both dedicated Harness cases passed. Embedded recovery checks the stopped Docker container or the first Gateway container in the same eligible Kubernetes Pod. A replacement must answer its first chat on the original volume. Unverified owners require operator confirmation. The linked CI failure predates the handoff. [Embedded restart CI](https://github.com/openclaw/openclaw-enterprise/actions/runs/40020642283/job/120644075211) · [AMD64/ARM64](https://github.com/openclaw/openclaw-enterprise/actions/runs/40002372120)     |
| Dedicated recovery    | Separate work                | [OC #181813](https://github.com/openclaw/openclaw/pull/181813) exposes the running Gateway owner. [OCE #3355](https://github.com/openclaw/openclaw-enterprise/pull/3355) binds that owner to its workload, requires proof of termination before recovery, and separates dedicated Docker state. A Docker Engine run verified private Gateway state, shared workspace, authenticated status and exact termination. Both PRs are drafts. Automatic recovery is disabled pending a supporting runtime, trusted deployment wiring and a full replacement test on each provider.                                                        |
| E — Qualification     | 9; completion evidence for 8 | Both original API-key/OpenShell cases pass on `d308b55c` images with OC `cee236c9`: 1 pass, 0 failures/skips each. Native OC records eight model turns; Codex seven and one schema-only command-conversion probe. Both cover Harness work, scoped scheduling, denied administrative effects with human controls, a bound child and narrower-policy replacement. Codex preserves OC session/history but reconstructs a different native thread. Frozen source/image identity and scoped cleanup are verified. Assertions, permissions and budgets are unchanged. Final CI/merges remain open; earlier evidence below is historical. |

Dependent work may use explicit stacked PRs; OCE must not activate fields that its packaged OC does not enforce. Policy changes take effect through restart or deployment replacement after affected old work ends. Track source merge, runtime packaging and qualification separately. New scope decisions return to the author.

At OCE `6fe73a3c`, the live dedicated OpenShell Codex case passes with verified OC `aff376aa` and Codex `0.163.0-alpha.2`: workspace and child execution, scoped scheduling, foreign-job and cross-Agent refusals, and existing-command-job edit/enable/run refusals with unchanged state and human controls. Replacement preserves Gateway history, reconstructs the native thread, withholds the removed tool and permits an allowed callback. This does not test a retained native-thread callback; invalid command conversion has source/schema coverage only. At `550004e0`, five offline initialization checks and four synthetic child-routing variants also passed.

At OCE `6b05fa22`, the native configuration-restart case and `90d30`→`6796` migration/restart checks pass. Identity, token-only authentication and ordered canary history survive on the same durable root, including the native client store persisted by [OCE #3041](https://github.com/openclaw/openclaw-enterprise/pull/3041). This is native data compatibility without inference; it does not qualify an OCE fleet upgrade.

## Initial Gateway tool allowlist

This is the proposed starting inventory for OCE-generated policy, not a claim that every path has completed runtime qualification. OCE publishes concrete tool identities and action sets; configuration from a loaded plugin cannot extend them automatically.

| Scope                         | Initially permitted tools                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared session/task tools     | `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `agents_list`, `automations` |
| Shared task interaction       | `message`, `ask_user`, `progress_card`, `get_goal`, `create_goal`, `update_goal`                                                                                                     |
| Native OC worker-local coding | `ls`, `read`, `write`, `edit`, `apply_patch`, `exec`, `process`, only in the assigned worker's execution boundary                                                                    |
| Approved task-tool additions  | Explicitly reviewed web, browser, media, memory, document or connector tools, including plugin-provided tools; no blanket plugin or namespace grant                                  |

Codex keeps its native coding, goal and collaboration tools. The adapter omits duplicate Gateway implementations under its existing replacement rules. Discovery helpers and Code Mode can operate only on the permitted catalog. Agent document content remains out of scope; approving a document tool is distinct from managing the document's contents. [Core catalog](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tool-catalog.ts#L73), [Codex replacements](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/dynamic-tool-profile.ts#L8).

| Action-bearing tool | Proposed permitted actions and bounds                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessions`          | `cloud_profiles`, `patch`, `stop`, `reset`, `delete`, `assign_owner`, `group_list`, `group_set`, `group_rename`, `group_delete`, retaining caller/target checks and session-only model selection |
| `subagents`         | `list`, `wait`, `cancel`, retaining existing caller/target checks                                                                                                                                |
| `automations`       | `status`, `list`, `get`, `add`, `update`, `remove`, `run`, `runs`, `next_check`, `wake`, under ordinary caller scope; command jobs and disabled trigger types remain prohibited                  |

Other retained tools must also record any declared action set explicitly before shipping; a newly added action is not approved by retaining its tool. [Session schema](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools/sessions-tool-schema.ts#L12), [subagent schema](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools/subagents-tool.ts#L58), [automation schema](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools/cron-tool-schema.ts#L24).

The required allowlist needs distinct semantics from ordinary `tools.allow`: currently an empty ordinary list allows all tools, plugin/group selectors expand with the catalog, and OCE merges plugin grants additively. Reuse OC's filtering/intersection machinery with a required Gateway policy input that permits nothing when empty, rejects invalid policy and cannot be widened by these grants. Merged [OC #174547](https://github.com/openclaw/openclaw/pull/174547) implements `tools.gatewayPolicy`; [OCE #2633](https://github.com/openclaw/openclaw-enterprise/pull/2633) packages supporting OC and integrates the baseline. Integration review and qualification remain open. [Tool matcher](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tool-policy-match.ts#L32), [plugin-group expansion](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tool-policy.ts#L164).

## Example OCE-generated Gateway configurations

OCE renders the deployment's policy into Gateway configuration for either Harness. These fragments illustrate the proposed interface; they are not complete deployment configurations.

**Source support:** Selected OC `cee236c9` supports `tools.gatewayPolicy` and its `allow`, `actions` and `automations` fields. These examples illustrate OCE's proposed configuration; OCE #2633 remains under review. The `agents` and `cron` settings already exist.

### Shared policy: OC and Codex

This focused example allows session work, ordinary scheduling, worker-local coding and the Diffs task tool. It is narrower than the initial inventory above: only the named tools and actions are allowed. Diffs must separately be selected and loaded through the deployment's plugin configuration.

```json
{
  "tools": {
    "gatewayPolicy": {
      "allow": [
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "session_status",
        "agents_list",
        "sessions",
        "automations",
        "ls",
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "diffs"
      ],
      "actions": {
        "sessions": ["patch", "stop"],
        "automations": [
          "status",
          "list",
          "get",
          "add",
          "update",
          "remove",
          "run",
          "runs",
          "next_check",
          "wake"
        ]
      },
      "automations": { "scope": "caller", "allowCommandJobs": false }
    }
  },
  "agents": { "defaults": { "modelSelectionScope": "session" } },
  "cron": { "triggers": { "enabled": false } }
}
```

`allow` is the required ceiling after ordinary tool/plugin grants; an empty list permits nothing. `actions` bounds the two action-bearing tools in this example. Existing caller, target, permission and execution-location checks still apply.

The proposed `automations.scope: "caller"` withholds administrative automation grants from model turns, including administrator-started chats. `allowCommandJobs: false` rejects command-job creation, conversion, modification, enablement and triggering; OC must check the existing job and the result of an update. The existing `cron.triggers.enabled: false` separately disables scripts, streams and condition triggers.

### Dedicated OC

Use the shared fragment above. The allowed `ls`, `read`, `write`, `edit`, `apply_patch` and `exec` tools must execute only in the assigned worker; allowing their names does not authorize Gateway-local execution. Other task tools require explicit approval before OCE adds them to the final policy.

### Dedicated Codex

Use the same proposed `tools.gatewayPolicy.allow` and `actions` configuration shown above for OC. OC's Codex adapter must enforce this allowlist before advertising Gateway tools and registering executable callbacks. Unlisted tools and actions remain unavailable.

Codex's native coding tools and subagents retain their existing runtime policies. The adapter must keep the Gateway policy separate from ordinary `tools.allow`, which can also restrict native Codex capabilities.

Existing adapter filters can further remove duplicate or unwanted Gateway implementations. Their exclusion settings are recorded in the implementation note below; the shared allowlist defines the P0 boundary.

Merge the shared fragment into OCE's generated configuration while preserving required deployment settings, plugin entries and stricter existing policy. It neither grants human permissions nor changes the separate Harness-local protection work.

## Codex requirements coverage

| Configuration to control                            | Available Codex support and remaining limit                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval policy, reviewer and execution permissions | Requirements constrain policies/reviewers and provide managed permission profiles. Sandbox-family restrictions alone do not pin every writable root or network option; qualify the effective profile and all override paths. |
| Provider routing                                    | Requirements can pin the provider ID and its definition. OCE must supply both where it owns that routing.                                                                                                                    |
| Native tools, MCP, plugins and hooks                | Feature, MCP identity and managed-hook controls exist. They are not a universal capability/configuration lock. OCE must protect executable inputs and approve native capability sources separately from Gateway tools.       |
| Model, effort and service tier                      | New-thread settings provide defaults, not a general enforced allowlist. Exact locks remain optional product decisions; a required unsupported restriction would need Codex work.                                             |

## Remaining runtime and integration work

**Native OC node-host isolation.** Verify that model commands cannot reuse the node host's saved identity or replace its trusted startup inputs. A restart-RPC restriction or read-only config file alone does not establish that protection.

The worker also has a small local configuration containing model/provider definitions and worker settings. OCE regenerates it at normal startup, and the running node host snapshots it. Editing that file alone therefore does not change running inference. The remaining issue is whether model commands can reuse the saved node identity to start a replacement host with different local definitions. Source inspection shows the Gateway accepts replacement connections for the same identity; the complete path has not been demonstrated in a deployed sandbox. [Generated worker configuration](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L4126), [startup snapshot](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/node-host/runtime.ts#L209), [node replacement](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/node-registry.ts#L534).

**Existing Codex connection protection.** A model could run the Codex CLI or a script to contact app-server. In the inspected dedicated OpenShell setup, the Harness receives only a token verifier; the trusted Gateway holds the bearer token. Authentication blocks an unauthorized client even when the listener is reachable, and some execution profiles also block the connection. This path does not establish a need for a new RPC ACL. Preserve it with model-origin CLI and custom-client regression tests, with successful Gateway start/resume as the positive control. Record whether denial comes from authentication or the sandbox; deployed qualification remains incomplete. [Token separation](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/sandbox/openshell.ts#L569), [Bearer verification](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/websocket-auth/src/lib.rs#L288).

**Codex local protection and effective policy.** Test that model commands cannot acquire management credentials, edit or replace protected configuration/requirements/helpers, or replace the trusted server. Existing permissions vary with preset and authentication method, and a permission profile can override a configured sandbox default. Inspect the effective permissions in each supported deployment. Test supported requirements across fresh, resumed and child threads, settings updates and policy refresh. [Current defaults](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/sandbox/openshell.ts#L2038), [profile selection](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/thread-requests.ts#L684).

**Gateway policy integration and tests.** Have OCE automatically publish the required allowlist for every dedicated deployment. Enforce it as a final intersection after ordinary plugin/Agent grants, using OC filtering and Codex dynamic-tool paths. Test new and unlisted tools/actions, empty policy, plugin additions and stricter preexisting restrictions. [OCE preparation](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L2691).

Verify that unlisted tools and actions are absent from discovery and cannot be invoked through direct calls, deferred discovery, Code Mode or catalog refresh. The six administrative tools named in the RFC must remain unavailable. Cover administrator-started chats, children, session recipients and scheduled jobs. Confirm ordinary tasks, explicitly approved plugin task tools, native Codex coding/subagents and permitted human administration still work. Test session-only model changes and stream-trigger denial separately. Drain or replace affected running turns before claiming immediate policy revocation. [Reload behavior](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/config-reload-plan.ts#L281).

**Codex adapter compatibility (existing behavior).** OCE currently supplies `codexDynamicToolsExclude` to remove Gateway implementations that Codex replaces, along with existing administrative-tool exclusions. Retain these settings and any additional configured exclusions when applying the proposed shared allowlist.

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
            "gateway"
          ]
        }
      }
    }
  }
}
```

These exclusions only narrow the tools admitted by `tools.gatewayPolicy.allow`. They cannot grant an unlisted tool or action, and do not replace the required allowlist. For example, `nodes` and `secrets` remain unavailable when absent from the allowlist, without adding either name here.

[Existing OCE Codex exclusions](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L2373), [Codex dynamic-tool filtering](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/extensions/codex/src/app-server/dynamic-tool-profile.ts#L99).

**Maintain the reviewed tool inventory.** Review new or changed Gateway/plugin tools before adding their concrete identities and actions to the allowlist. Loading a plugin or updating a tool catalog must not authorize additions automatically. Optional Gateway capabilities require explicit approval; Codex-native capabilities remain governed by separate Harness policy. Agent document contents remain out of scope.

**Mixed administration tools.** In the originally inspected OC `90d30`, the `gateway` model wrapper exposed `config.get`, `config.schema.lookup` and `update.run`, not `config.set/patch/apply`; self-update is the reason to exclude that wrapper. `secrets` combined human credential entry with a direct `secrets.store.delete` call against the team store. The proposed action filter can retain selected read/request actions after review; the initial baseline does not include these tools. [Gateway wrapper](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools/gateway-tool.ts#L70), [Secret deletion](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools/secrets-tool.ts#L257).

**Retained-tool checks.** The native session wrapper exposes selected fields, not arbitrary permission/sandbox writes. Its model selections can otherwise persist defaults under an admin caller; the session-scope setting prevents that. [Session persistence](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods/sessions-patch-model-selection.ts#L41).

**Automation authority and command jobs.** At OC `90d30`, ordinary model calls rejected command payloads, but administrative management grants bypassed the update guard and ordinary job-scope restrictions. A model with such a grant could modify a command job or convert an Agent-turn job to a command job, then trigger it or let its schedule run. P0 must preserve ordinary creator authority while withholding administrative automation access from model turns in OCE-managed deployments, including administrator-started conversations and restored grants. Check both the existing job and the resulting update. [Update guard](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/agents/tools/cron-tool.ts#L577), [caller scope](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/gateway/server-methods/cron-caller-scope.ts#L307), [payload conversion](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/cron/service/payload-merge.ts#L42).

OC `90d30` had no command-only disable setting. `cron.triggers.enabled: false` disables scripts, streams and condition triggers, but not command jobs; `cron.enabled: false` stops automatic scheduling but still allows manual runs. Excluding `automations` was the configuration-only fallback, removing ordinary model scheduling too. Merged [OC #174580](https://github.com/openclaw/openclaw/pull/174580) adds caller scope and `allowCommandJobs: false`. These are source findings, not a deployed exploit reproduction. [Cron configuration](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/config/zod-schema.root-shape.ts#L387), [manual-run preflight](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/src/cron/service/ops-run-preparation.ts#L203).

**Supervisor integration is separate.** OC external-supervisor mode controls service/update ownership; it is not required for Gateway tool filtering and does not provide a general configuration or permission policy. OCE already supervises the process through its wrapper and Kubernetes, but the inspected launcher does not explicitly implement OC's external-supervisor handoff protocol. [OC supervision contract](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/docs/cli/gateway/restart-and-supervision.md#L171), [OCE launcher](https://github.com/openclaw/openclaw-enterprise/blob/04514330688378316bd0641b8d5560da56aeff85/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L2744).

Run qualification with the actual image, permissions and mounts. The native replacement-host test and Codex Harness-local protection checks remain incomplete; neither is a demonstrated deployed bypass. Enforcement belongs in the Gateway, Harness and their execution boundaries, without introducing a per-RPC OCC approval service.

## Draft provenance

The working draft was imported from [PR #2367](https://github.com/openclaw/openclaw-enterprise/pull/2367), [source snapshot `e2190b7`](https://github.com/openclaw/openclaw-enterprise/blob/e2190b7a10a1782cb7488309af3cfcbf5e4a54c9/specs/rfcs/0020-managed-runtime-mode.md), on 2026-10-14 and last synchronized back on 2026-10-16. It was renumbered from RFC-0020 to RFC-0021 because RFC-0020 was assigned on the base branch. Source findings and runtime evidence retain their investigation-snapshot dates.
