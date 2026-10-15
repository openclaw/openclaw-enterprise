# Historical plugin policy support and translation plan

This document preserves the source review and proposed ordering from the
snapshot below. The later nested policy contract supersedes its vocabulary,
category compiler proposal, and implementation order. It is not the current
support matrix.

Current behavior is defined by the [Agent plugin reference](../../../../../docs/reference/agent-plugins.md#approval-policy)
and [bundled mappings](../../../../../docs/reference/drivers/plugin-bundled.md#native-mappings-and-limits).
The current translator accepts independent `toolDefaults` and explicit tool
fields with `provider_default`, `all_actions`, `write_actions`, and `none` approval
modes. Codex maps them to native `auto`, `prompt`, `writes`, and `approve` at both
app-default and explicit-tool scope. The app default also covers future tools.
Common reviewer choices are `human` and `auto`, advertised separately per scope;
omission inherits the effective Harness reviewer. Driver-specific fields remain
in `driverPolicy`. Native OpenClaw supports `provider_default` and `none` only;
it has no generic write/destructive category expansion. Effective runtime proof
remains separate from translation support.

## Previous review

Reviewed 2026-09-23 against OCE `f7e1f2d1`, OpenClaw `9a15bd82af`, and Codex
`e4d0ba4e92`. Harness capability below is source evidence, not deployment proof.
The [runtime image](../../../../../deploy/runtime/Dockerfile) still pins
OpenClaw `2026.9.1` and Codex `0.156.0`; it also records the missing OpenClaw
`plugins install --no-enable` release prerequisite. Verify the packaged versions
and real Agent flow before promoting a capability to supported.

## Plugin policies

**Today** means accepted and emitted at the reviewed OCE snapshot above.
The implementation tracking below records later work without changing that
baseline. **Translation** means the harness already exposes the needed policy
control. **Integration** means existing hooks/approval transport can enforce it
with additional wiring and metadata. **Runtime work** means a general capability or policy semantics
still need implementation. All three future categories remain unsupported in
OCE until integrated and verified.

Codex plugin scope is concrete hosted apps from `plugin/read` in the curated
marketplace. Native OpenClaw scope is the admitted catalog, currently Diffs.
Neither column implies arbitrary plugin-package support.

| OCE policy                                         | Codex plugins today                | Codex harness: remaining work                                                    | Native OC plugins today      | OC harness: remaining work                                                                                    |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Plugin enable/disable                              | Yes                                | Existing app/plugin controls                                                     | Yes                          | Existing plugin enablement and tool filters                                                                   |
| `always`: no added approval                        | Yes, except explicit `auto_review` | Existing `approve` mode; other restrictions still apply                          | Yes                          | Existing execution path; other restrictions still apply                                                       |
| `never`: block plugin calls                        | Yes, by disabling the plugin       | Separate default denial from plugin disablement when adding tool exceptions      | Yes, by disabling the plugin | Same distinction needed for tool exceptions                                                                   |
| `auto`: decide whether review is needed            | Yes                                | Native annotation and remembered-approval behavior                               | No                           | **Runtime work:** annotation trigger, metadata, and native remembered-grant semantics                         |
| `prompt` with human reviewer                       | No                                 | **Translation:** native every-call `prompt`; pending PRs below                   | No                           | **Integration:** trusted tool policy plus existing human approval transport                                   |
| Select `auto_review` reviewer                      | Yes with `auto`; `prompt` rejected | **Translation** for `prompt`; native per-app reviewer already exists             | No                           | **Runtime work:** extend the reviewer to arbitrary native tool calls                                          |
| Per-tool enable/disable                            | No                                 | **Translation:** native app tool settings; discover exact tool identities        | No                           | **Integration:** existing exact-tool allow/deny; establish plugin ownership                                   |
| Per-tool approval modes                            | No                                 | **Translation:** native tool approval/enablement settings                        | No                           | **Integration** for `always`/`never`/human `prompt`; **runtime work** for `auto`/automatic review             |
| `writes` / `destructiveActions` category overrides | No                                 | **Translation + metadata:** compile effective category policy into tool settings | No                           | **Integration + metadata:** evaluate categories in the trusted policy gate; automatic review remains separate |
| Tool exceptions to plugin/category defaults        | No                                 | **Translation:** preserve OCE precedence and independent enablement              | No                           | **Integration:** same precedence, without bypassing native denies                                             |

`auto` selects **when** to review; `auto_review` selects **who** reviews. Human
approval can therefore ship before generic automatic review. An omitted reviewer
inherits native behavior where supported; it is not an explicit human selection.

Codex already has the controls behind
[OCE #227](https://github.com/openclaw/openclaw-enterprise/pull/227) (every-call
translation) and
[OpenClaw #151260](https://github.com/openclaw/openclaw/pull/151260) (preserving
hosted-app policy through the bridge). Both are open at this snapshot.
[OpenClaw #152085](https://github.com/openclaw/openclaw/pull/152085), which permits
consent for allowed reads under destructive denial, is merged. None of these
adds OCE category or per-tool translation by itself.

## Other tool surfaces

These are native runtime/configuration surfaces, not additional OCE
`Agent.plugins` implementations. Do not infer policy support from a tool's JSON
argument schema or from the model provider.

| Tool surface                                      | Existing harness controls                                                                               | What OCE-style coverage would require                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native MCP servers in Codex                       | Server/tool filters, default and per-tool approval modes, annotation-based review, human/model reviewer | Translate policy and tool metadata. Non-app MCP uses the thread reviewer, not a per-server reviewer. OC projection exposes `auto`/`prompt`/`approve` defaults and exact-name filters, not the complete Codex per-tool policy surface. |
| MCP tools in embedded OC                          | Include/exclude filters and the shared before-tool-call gate; MCP annotations available                 | Human approval through existing hooks; category translation using annotations; generic model review needs runtime work. Codex-specific server settings do not enforce policy here.                                                    |
| OC-hosted tools exposed to Codex as dynamic tools | Host execution callbacks; OC's MCP bridge has explicit host-side approval handling                      | Enforce in the host path. Dynamic tools do not automatically inherit native Codex app/MCP policy.                                                                                                                                     |
| OC shell `exec` on gateway/node                   | Dedicated deny/allowlist/ask/auto/full modes, human approval, shell model reviewer                      | Adapt shell-specific semantics; these are not generic plugin controls. `ask` means approval on an allowlist miss, not every call.                                                                                                     |
| Other OC built-in tools                           | Tool allow/deny and shared policy hooks                                                                 | Human gates can reuse existing transport; category metadata and a general automatic reviewer still need integration.                                                                                                                  |

## Implement easier policies first

| Slice                                                   | Implementation                                                                                                                                                                                                                                | Status                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Generic native per-tool enablement                      | [OCE #312](https://github.com/openclaw/openclaw-enterprise/pull/312): translate trusted pinned catalog tool identities into native denies, preserving operator restrictions. Diffs remains the only admitted entry.                           | Draft, unmerged; real deployment proof pending. |
| Native per-tool `always`/`never` and default precedence | [OCE #313](https://github.com/openclaw/openclaw-enterprise/pull/313), stacked on #312: apply explicit tool mode before plugin default, deny unspecified siblings, and keep explicit disablement, install failure, and native denies terminal. | Draft, unmerged; real deployment proof pending. |

Implementation source revisions: #312 `21c77bee`; #313 `d47d7df6`.
Both use the same generic translator; adding an admitted native plugin requires
verified package and tool metadata, not a plugin-specific policy branch.

The ordering below is proposed; it does not select a new configuration or
storage contract. Finish and verify each supported slice before enabling it.

1. **Finish Codex every-call translation.** Complete the existing PR path and
   verify the effective Agent thread preserves its app approval mode/reviewer.
2. **Finish exact per-tool enablement for both drivers.** Native ownership is
   established in draft #312 through the trusted pinned catalog's complete tool
   names. Its policy algorithm applies to every admitted entry and rejects
   ambiguous native denies. The public catalog stays `tools:null` until truthful
   action classifications are available. Codex still needs exact tool-to-app
   identities before translating its native tool settings.
3. **Finish native per-tool `always`/`never` overrides.** Draft #313 reuses
   those identities to distinguish a plugin's default denial from explicit disablement. An
   allowed tool exception must leave unspecified sibling tools denied; plugin
   or tool `enabled:false`, installation failure, and native denies remain terminal.
4. **Add per-tool Codex approval translation and OC human prompting.** Codex
   has native controls; OC has reusable approval delivery and wait/resolve APIs.
   OC needs trusted ownership and approval bound to the exact executed call.
   This is integration work, not a new human-approval system.
5. **Add write/destructive category policies.** Require reliable annotations
   and conservative handling of unknown values. Preserve tool override →
   stricter applicable category → plugin default precedence. Native OC manifest
   `sideEffecting` does not establish destructive/read-only classification;
   names and missing flags cannot fill that gap. Codex category booleans alone
   cannot express every OCE category mode; compile effective per-tool settings.
6. **Add native OC annotation-driven `auto` and automatic review.** Separate
   trigger/remembered-grant semantics from reviewer choice. Extend the existing
   hardened reviewer with a native-tool input and prompt; its current inputs are
   shell and board-widget requests. Retain strict parsing, bounded inputs,
   cancellation, timeouts, and completion checks. Decide review-failure behavior
   explicitly. This is the largest step; a raw model completion is insufficient.

OC trusted-policy approval currently precedes ordinary hooks that can rewrite
arguments. Human and automatic approval integrations must bind or revalidate
the final executed arguments and live run authority after awaited work. Existing
transport alone does not establish that guarantee.

The [native policy proposal](../../../../../specs/rfcs/0009-native-plugin-tool-policy.md)
contains a possible managed configuration and semantics. Those choices remain
proposed; they are not prerequisites already approved by this matrix.

## Evidence and maintenance

- OCE: [translator](runtime-translator.ts),
  [API schema](../../../../../packages/contracts/src/api/resources.ts), and
  [runtime proof notes](../../../../../docs/testing/plugins.md).
- Codex: [app/tool policy precedence](https://github.com/openai/codex/blob/e4d0ba4e927363f695bb8d0fef187fd229700657/codex-rs/connectors/src/app_tool_policy.rs#L165-L240),
  [MCP policy types](https://github.com/openai/codex/blob/e4d0ba4e927363f695bb8d0fef187fd229700657/codex-rs/config/src/mcp_types.rs#L25-L82),
  [annotation predicate](https://github.com/openai/codex/blob/e4d0ba4e927363f695bb8d0fef187fd229700657/codex-rs/core/src/mcp_tool_call.rs#L2271-L2303),
  [reviewer scope](https://github.com/openai/codex/blob/e4d0ba4e927363f695bb8d0fef187fd229700657/codex-rs/core/src/connectors.rs#L514-L553), and
  [dynamic dispatch](https://github.com/openai/codex/blob/e4d0ba4e927363f695bb8d0fef187fd229700657/codex-rs/core/src/tools/handlers/dynamic.rs#L116-L168).
- OC: [trusted policy registration](https://github.com/openclaw/openclaw/blob/9a15bd82af5a403bc652688a02470e3f95c301b7/src/plugins/host-hooks.ts#L77),
  [hook inputs](https://github.com/openclaw/openclaw/blob/9a15bd82af5a403bc652688a02470e3f95c301b7/src/plugins/hook-types.ts#L715-L759),
  [manifest tool metadata](https://github.com/openclaw/openclaw/blob/9a15bd82af5a403bc652688a02470e3f95c301b7/src/plugins/manifest-types.ts#L633-L640),
  [policy/ordinary-hook ordering](https://github.com/openclaw/openclaw/blob/9a15bd82af5a403bc652688a02470e3f95c301b7/src/agents/agent-tools.before-tool-call.policy.ts#L296-L412),
  [model reviewer](https://github.com/openclaw/openclaw/blob/9a15bd82af5a403bc652688a02470e3f95c301b7/src/agents/exec-auto-reviewer.ts), and
  [Codex MCP projection](https://github.com/openclaw/openclaw/blob/9a15bd82af5a403bc652688a02470e3f95c301b7/src/agents/codex-mcp-config.ts#L35-L123).

With each implementation, update its row, source revision, remaining work, and
owning product reference/matrix together. Record real deployment proof in the
testing guide. Do not mark a policy supported solely because its schema accepts
it, a translator emits it, or an upstream PR merges.
