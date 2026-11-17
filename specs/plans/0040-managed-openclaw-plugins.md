---
rfc: ../rfcs/0040-managed-openclaw-plugins.md
---

# Implementation plan: Managed OpenClaw plugins

- **ID:** RFC-0040
- **Delivery status:** In progress
- **Authority:** [Managed OpenClaw plugins](../rfcs/0040-managed-openclaw-plugins.md)
- **Source baseline:** OCE `26a24253e44403469837e5d41674d721495509f5`, audited 2026-11-17. PR status reflects that date. This is a source and delivery audit, not a fresh runtime test.

## Outcome

An administrator publishes reviewed plugins. An operator selects CLI, skill, or hosted MCP plugins for a dedicated OpenClaw Agent, connects accounts through Credentials, chooses MCP tools, and deploys. The selected Credential Proxy enforces the plugin's request policy for native calls and scripts. Account grants, renewal, removal, and worker recovery follow their existing lifecycle.

## Merged baseline

- **Catalog and deployment:** OCC selects the Plugin Driver for the Harness. Dedicated Agents can deploy multiple managed packages. [#4174](https://github.com/openclaw/openclaw-enterprise/pull/4174), [#4462](https://github.com/openclaw/openclaw-enterprise/pull/4462)
- **CLI:** Google Workspace uses pinned [gogcli](https://github.com/openclaw/gogcli), an OpenClaw skill, and a reviewed operation map. Credential attachments and worker recovery are independent of plugin removal. [#3885](https://github.com/openclaw/openclaw-enterprise/pull/3885), [#4179](https://github.com/openclaw/openclaw-enterprise/pull/4179)
- **Hosted MCP:** The curated Slack MCP plugin, worker execution, discovery, tool selection, and OpenShell enforcement work with an attached bearer credential. [#3982](https://github.com/openclaw/openclaw-enterprise/pull/3982), [#4427](https://github.com/openclaw/openclaw-enterprise/pull/4427), [#4448](https://github.com/openclaw/openclaw-enterprise/pull/4448)–[#4450](https://github.com/openclaw/openclaw-enterprise/pull/4450)
- **Credentials:** OCC manages scoped connection templates, client registrations, and browser consent. The Secret Driver stores client material; Token Service owns saved account grants and renewal. [#4668](https://github.com/openclaw/openclaw-enterprise/pull/4668), [#4671](https://github.com/openclaw/openclaw-enterprise/pull/4671), [#4853](https://github.com/openclaw/openclaw-enterprise/pull/4853)

Current behavior is documented in the [Agent plugins reference](../../docs/reference/agent-plugins.md), [plugin flow](../../docs/flows/agent-plugins.md), and [connection reference](../../docs/reference/connection-templates.md).

## P0 implementation and PR splits

1. **Saved-account onboarding and Agent grants:** Connect or select an account from a plugin slot using OCC's shared Credentials flow.
   - Match the template and account to the pinned release, bind the source, grant Agent access, and discover tools before deployment. Recheck authority, release, slot, and recipient on callback.
   - **Status:** Open PR [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673). Its delivery contract must align with steps 2–3 before merge; onboarding can merge earlier only if separated from that contract.
2. **Credential Proxy capability and admission:** Define the portable operation policy required by each credential binding.
   - OCC checks the approved destination, resource, protocol, selected upstream tool names, and the Proxy's enforcement capability on save and deployment. Reject unsupported enforcement settings. Submit the Driver contract through this RFC before implementation.
   - **Status:** Not done; can proceed alongside step 1.
3. **Selected-implementation enforcement:** Configure the chosen Credential Proxy and Sandbox to enforce the admitted policy.
   - Reuse OpenShell's native MCP tool-name rules, and preserve Google's reviewed connector policy. Align #4673's delivery path so generic MCP inspection does not depend on a per-request OCC Plugin Driver callback or another OCE filter. Verify both native calls and admitted scripts.
   - **Status:** Not done; depends on step 2 and aligns the delivery portion of [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673).
4. **Reviewed Namespace plugin uploads:** Admit, pin, publish, and deploy reviewed skill and hosted MCP packages.
   - Remove OCC API Helm egress restrictions for approved custom discovery URLs while retaining destination, DNS, redirect, API ingress, and worker policy checks. Bearer-based imports can proceed independently of steps 1–3.
   - **Status:** Open PR [#4734](https://github.com/openclaw/openclaw-enterprise/pull/4734).
5. **Saved OAuth for imported MCP servers:** Create a template from the server URL, connect an account, discover tools, and deploy the selected subset.
   - Recheck the protected resource, destination, release, and account. This integrates account onboarding, publishing, and enforcement.
   - **Status:** Not done; depends on steps 1–4.
6. **Multiple accounts for the same plugin:** Give each account a distinct binding identity and route calls to it.
   - Discover tools, select permissions, and enforce policy per account, including accounts sharing an endpoint. Removing or failing one account must not affect another.
   - **Status:** Not done; depends on steps 1–3.
7. **End-to-end Console and runtime qualification:** Prove the complete launch workflow on ordinarily deployed Agents.
   - Resolve the Slack tool-assembly failure reported in #4673, then verify live Slack search, Google CLI, selection changes, renewal, worker replacement, withdrawal, and multi-account isolation. Update the owning current documentation as work ships.
   - **Status:** Not done; [#4819](https://github.com/openclaw/openclaw-enterprise/issues/4819) tracks the connected-account lifecycle portion. Imports and multi-account proof belong to steps 4–6.

## Acceptance gates

- **Onboarding:** From Console, configure a template/client, complete real consent, bind the resulting account to a plugin, discover tools, and deploy without exposing tokens to the model or browser responses.
- **MCP enforcement:** Select a read tool while the provider grant also permits a disabled tool. Verify a successful native call and admitted script call. A script POST for the disabled upstream name must receive a denial with zero upstream calls. Change the selection, redeploy, and verify the inverse. An empty selection grants no tools.
- **Capability admission:** An implementation lacking the required MCP inspection or connector policy must reject the proposed settings before deployment. Unavailable or conflicting enforcement must stop credentialed requests.
- **Imports:** Publish and deploy an uploaded skill and an uploaded OAuth MCP package. Verify pinned artifacts, discovery, selected and disabled calls, and recovery after worker replacement.
- **Lifecycle:** Renew an expired token; detach or revoke an account from one Agent without breaking another. Removing a plugin preserves independent credential access and worker recovery.
- **Multi-account:** Invoke two accounts for the same plugin and endpoint by explicit identity. Verify independent tool restrictions and successful use after the other account is removed.

Use the real Agent workflow with approved provider accounts, a disposable Kubernetes installation, digest-pinned runtime images, model authorization, and sanitized upstream observations. Record the tested Agent revision, runtime, request counts, proof limits, and a short Console recording. Planned checks are not completed proof.

## Post 1.0 and separate owners

- OCC plugin invocation approvals, reviewers, elicitation, and `all_actions`/`write_actions`; generic MCP argument restrictions or trusted read/write classification; arbitrary REST action mapping.
- Direct external directory or ClawHub discovery, installation, and automatic updates; additional providers and placements; Gateway-native code and renewable Gateway credentials.
- Google product/action UI and reusable-script or public-schema caching optimizations.
- Codex hosted-app approval qualification belongs to the Codex Plugin Driver owner. Its real Kubernetes Agent-turn check and session-policy constraints are tracked in [plugin testing](../../docs/testing/plugins.md#current-proof-notes); this plan does not claim Codex approval enforcement is qualified.

## Changelog

- 2026-10-21: Drafted against `000aa1d6b801`.
- 2026-10-21: Clarified worker placement and OAuth scope selection against `3e006d31275d` (session `01a13641-ad1f-7e93-a453-f1fd8c3ad711`).
- 2026-10-21: Clarified connection readiness and custom scope access against `d81e24e9e3c6` (session `01a13641-ad1f-7e93-a453-f1fd8c3ad711`).
- 2026-10-22: Added deployed credential access visibility and the custom-scope endpoint requirement against `99c762c6ca57` (session `01a13641-ad1f-7e93-a453-f1fd8c3ad711`).
- 2026-10-22: Aligned P0 with the RFC's protected native dispatch boundary for Codex and OpenClaw. Deferred direct credentialed custom code until mandatory user elicitation is enforced; replaced credentialed-script success checks with caller-separation tests.
- 2026-10-22: Refocused P0 on working managed OpenClaw plugins and moved prevention of custom-code credential-injection bypass to P0.5/P1.
- 2026-10-22: Superseded the earlier caller-separation requirement and P0.5/P1 deferral. Steps 1–9 now require the same effective credential policy and live allowed/denied proof for gog and custom code in P0. MCP discovery and enforcement is a separate investigation conditional on a confirmed gap; broader credential visibility and optional public schema caching remain later work.
- 2026-10-22: Split credential policy, Google action translation, Console, protected request authorization, and end-to-end qualification into P0 steps 8–12; moved later work to steps 13–16. Policy composition remains an open design decision.
- 2026-10-26: Scoped P0 to one personal Agent and one Google connection. Separated the two-account and shared-connection milestones (source `0adc144cab65`, session `01a17910-cb4f-7cf0-b57b-c08ef4ff643f`).
- 2026-11-05: Reworked the active proposal against `18041cc84aa0`. Renumbered its RFC to 0029, retained this plan's filename, recorded merged CLI/MCP delivery, replaced the old Google-only P0 with the scoped-account stack, and separated later enforcement/marketplace/Gateway work (session `01a13641-ad1f-7e93-a453-f1fd8c3ad711`).
- 2026-11-09: Renumbered the proposal to RFC-0031 after RFC-0029 and RFC-0030 merged. Recorded template, Token Service and mixed-Driver delivery, updated the remaining Agent grant and qualification steps, and linked the living plugin support reference.
- 2026-11-17: Renumbered the active proposal to provisional RFC-0040, aligned P0 with the 1.0 scope, separated the selected Credential Proxy capability and enforcement work, and moved reviewed uploads and same-plugin multi-account into launch delivery (source `26a24253e444`; session `01a13641-ad1f-7e93-a453-f1fd8c3ad711`).
