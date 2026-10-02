---
status: Proposed
---

# Native OpenClaw plugin tool policies

Status: Proposed. Full policy coverage is requested; the configuration surface
and native automatic-review semantics below await acceptance.

The [policy translation plan](../../apps/controller/src/drivers/plugin/policy-support.md)
tracks current support, harness capabilities, and an incremental delivery order.

## Outcome and ownership

An Agent using the OpenClaw Plugin Driver must enforce its saved plugin defaults,
tool overrides, write/destructive rules, and selected reviewer before a plugin
tool executes. Keep the existing `Agent.plugins` API and immutable revision
snapshot. The Plugin Driver translates policy; a trusted OpenClaw policy plugin
packaged by OCE enforces it in the Agent gateway.

The existing shared tool gate, plugin approval transport, and model-review
runtime are the integration points. Do not add a
controller approval service or encode Enterprise policy in OpenClaw core.
OpenClaw needs generic SDK improvements for authoritative native tool ownership,
classification, final-argument review, and a native-tool reviewer input.

This work covers the existing curated native catalog, currently Diffs. Adding
other packages, HTTP catalog discovery, credential setup, and changing the
native admin identity model remain separate work.

## Verified starting point

At Enterprise `f7e1f2d1`,
[`runtime-translator.ts`](../../apps/controller/src/drivers/plugin/runtime-translator.ts)
accepts native plugin `always` and `never`, but rejects reviewers, `auto`,
`prompt`, categories, and every tool override. Its catalog returns `tools:null`.
A direct invocation of the current translator reproduced all six rejection
branches. The existing allow/alsoAllow composition and `--no-enable` installation
changes are already on this main revision.

OpenClaw `e912761b43f` already filters native tools by plugin/tool allow/deny and
runs trusted policies before execution. Its private tool metadata records the
registered plugin owner. Public before-tool-call hooks do not expose that owner.
Manifest `sideEffecting` describes durable-state effects; it cannot establish
read-only or destructive classifications. Existing model review supports shell
and board-widget inputs, not arbitrary native plugin calls.

These are source and translator observations, not deployed-runtime proof.

## Proposed managed configuration

Package `oce-tool-policy` as an OCE-owned native plugin and explicitly enable it
in gateways using the OpenClaw Plugin Driver. Startup owns
`plugins.entries.oce-tool-policy.config`. Its `plugins` map is keyed by verified
native plugin IDs and carries the existing OCE selection fields without another
operator-facing API. For example:

```json
{
  "plugins": {
    "entries": {
      "oce-tool-policy": {
        "enabled": true,
        "config": {
          "plugins": {
            "diffs": {
              "enabled": true,
              "approvalMode": "prompt",
              "approvalsReviewer": "user",
              "tools": { "diffs": { "enabled": true } }
            }
          }
        }
      }
    }
  }
}
```

Use the existing conflict checks for managed settings. Verify installation,
loaded policy registration, and effective policy before readiness; merely
writing this configuration is insufficient. A missing or disabled enforcement
plugin fails startup. Policy applies to model tool invocation, not arbitrary
startup hooks or unrestricted installed plugin code.

Bind each tool to its host-registered plugin identity. Carry that identity
through the generic hook SDK if the current public interfaces cannot provide
it; never infer ownership from a tool prefix or current callback scope.
Classification comes from explicit, version-bound tool metadata verified against
the installed package. Unknown read-only/destructive/open-world annotations
remain unknown and use conservative defaults. Do not infer them from names or
from absence of `sideEffecting`.

## Proposed native semantics

Preserve the [policy vocabulary](../../docs/reference/agent-plugins.md#approval-policy):
explicit tool approval mode, then the stricter applicable category mode, then
plugin default. Category strictness is `never > prompt > auto > always`.
Plugin/tool `enabled:false` and existing OpenClaw deny policies remain terminal.
An explicit approval-mode override may override a category default; approval
does not override an independent disabled or denied tool.

Keep plugin registration separate from its default tool approval mode: a
plugin-level `never` default must still permit an explicitly approved tool
exception when the plugin itself is enabled. The current whole-plugin disable
shortcut cannot implement this distinction.

| Mode     | Native behavior proposed for acceptance                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `always` | No additional OCE approval; existing authorization and plugin-owned gates still apply.                       |
| `never`  | Block the call before its body executes.                                                                     |
| `prompt` | Request review for every call, including reads. Allow-once or deny only.                                     |
| `auto`   | Skip review for explicitly safe annotations; otherwise request review. No newly persisted remembered grants. |

For `auto`, match the inspected native annotation predicate: explicitly
destructive tools require review; explicitly read-only, non-destructive tools
skip review; other tools require review unless both destructive and open-world
annotations are explicitly false. Missing destructive/open-world hints are
conservative. Writes means read-only is not explicitly true.

Reviewer and trigger remain independent. Omitted reviewer uses `user` for this
new native OCE policy. `user` uses existing native approval delivery. Missing
delivery, decline, cancellation, and timeout block visibly. `auto_review` uses
the Agent's configured model through the existing model reviewer, extended with
a native-tool request and dedicated prompt. Reuse its strict response parser,
input/output bounds, cancellation, timeout, and completion-status checks.
The low-risk-only allowance below is a proposed native policy choice, not a
description of the current shell reviewer, which can allow low/medium risk.
The general plugin LLM API currently drops completion
status and is insufficient by itself for approval decisions.
Only an explicit low-risk allow decision authorizes the exact pending call; malformed,
unavailable, timed-out, or denied review blocks. There is no silent reviewer
substitution and no new model-setting field.

This native `auto` proposal deliberately adds no remembered-grant storage.
Codex keeps its native remembered-approval behavior. Adding equivalent durable
native grants would require a separately accepted storage/lifecycle design.
Native human approval identity remains the existing gateway identity; OCE proxy
admission audit is not evidence of per-human native approval attribution.

## Delivery and verification

1. Establish the generic native owner/classification SDK contract and extend the
   existing reviewer with a native-tool input. Preserve metadata through
   wrappers and model runtimes. Reuse existing registration and tool-policy
   tests. Update native SDK documentation with the contract.
2. Add the OCE-owned policy plugin and runtime packaging, then extend native
   discovery/translation to validate exact tool IDs and emit managed policy.
   Retain existing grant composition, install failure handling, and revision
   isolation. Update the existing Agent plugin flow and living references.
3. Extend the real API → revision → startup → model tool-call integration. Prove
   enabled native tools execute, denied tools do not, user acceptance releases
   exactly one call, decline/timeout/cancellation prevent effects, automatic
   review actually runs when selected, and explicit tool/category precedence
   works. Include an enabled plugin denied by `tools.deny`, later redeployment,
   and another unaffected Agent. This OCE deployment proof uses admitted Diffs.
   Separately, native host/SDK integration uses a registered fixture plugin with
   distinct tool IDs, annotations, and observable effects to verify ownership
   and category selection. Do not add a production fixture catalog.
4. Test normal and deferred tool exposure through the same gate. Revalidate live
   run authority after awaited review; stale approvals cannot release a call.
   A configured `prompt` remains every-call even after a previous acceptance.
   Ordinary hooks currently run after trusted-policy approval and can rewrite
   arguments. Bind approval to final executed arguments at the existing final
   tool gate; a changed payload requires a fresh decision. Do not let an early
   approval authorize a later mutation. Exercise that ordering in regression
   coverage without changing unrelated hook behavior.
5. Use a real OpenClaw runtime supporting `--no-enable` and the resulting SDK.
   The current image pin is `2026.9.1`, documented as missing that installation
   flag. Do not claim full coverage from translator or mocked approval tests.

Owning current documentation:
[Agent plugins](../../docs/reference/agent-plugins.md),
[bundled Plugin Drivers](../../docs/reference/drivers/plugin-bundled.md),
[Agent plugin flow](../../docs/flows/agent-plugins.md), and
[runtime proof](../../docs/testing/plugins.md).

## Acceptance checkpoint

Approve the managed `oce-tool-policy` configuration and the native semantics
above before implementing them. The OpenClaw repository requires explicit chat
approval for new configuration. Full OCE coverage is the agreed objective; this
checkpoint selects its native runtime contract, including the lack of persisted
remembered grants and fail-closed automatic-review failures.
