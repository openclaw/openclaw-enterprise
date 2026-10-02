# Feature Spec: Deployment Simplification

**Date:** 2026-09-01

**Status:** Implemented

**Owner:** OpenClaw Enterprise deployment tooling and documentation

## Problem and Decision

Make starting OCC and verifying authenticated access a short default path, with customization through existing Compose, Helm, and Installation configuration. Add two narrow Bash helpers: local startup and fresh bootstrap-volume preparation. Keep Helm as the production deployment command.

The current [deployment guide](../../../docs/guides/deploy.md) is 1,587 lines at `a222ae3182a3dfd7dd8cd56c34f20b0e9b5ed09e`. It interleaves control-plane installation, Agent provisioning, interactive TUI proof, and credential administration. [Compose](../../../compose.yaml) already sequences PostgreSQL → migration → bootstrap → API → worker; [Helm hooks](../../../deploy/helm/openclaw-enterprise/templates/jobs.yaml) already sequence migration and bootstrap before installation or upgrade. Operators should not reproduce either lifecycle.

## Scope

- Simplify both supported deployment paths, preserve their native customization surfaces, and replace repetitive shell with reviewed repository scripts and native example files.
- The default path finishes with a ready control plane and an authenticated `/installation` read. Agent deployment and real model/TUI verification remain available as explicit subsequent tasks.
- Preserve the [platform design](../../../docs/design.md), exact-resource authorization, immutable AgentRevisions, Driver selection, credential isolation, and resource ownership. No API, database schema, Driver, or tenant-lifecycle changes.
- Exclude cloud/cluster/database/TLS provisioning, image publication, a universal installer, generated configuration schema, credential rotation, automatic recovery, and new Agent-provisioning automation. This proposal authorizes no live deployment.

## Contract

See [Contract](contract.md#contract).

## Implementation

1. Add the two Bash helpers and three native production example files. Reuse the runtime Dockerfile, Compose graph, worker probe, Helm chart, and API helper. Keep Bash control flow local and argument-safe; Python is limited to structured data checks. Add no package installer, persistent deployment state, public endpoint, or CI workflow.
2. Rewrite [deploy.md](../../../docs/guides/deploy.md) around Development, Production, Customization, and optional operations. Put the default control-plane paths first, within 150 lines excluding linked native examples; keep each command block at most 15 lines. Label prerequisites as site preparation, so the short path does not imply an unprepared cluster is ready. The local path is one command; production separates preparation, Helm, and authenticated verification.
3. Keep essential runnable Agent/TUI, tenant adoption/RBAC, teardown, bootstrap recovery, and service-key procedures in the existing guide as compact recipes: prerequisites, commands, success check, failure/cleanup rule, and links for contract detail. Remove repeated architecture, security, configuration, and runtime explanations already owned by reference/flow docs. Preserve required commands, denial behavior, safe cleanup, and referenced section anchors; links cannot replace a procedure unless another current guide owns its complete steps. Defer additional optional executable examples beyond the three production files.
4. Update [quickstart](../../../docs/guides/quickstart.md), [settings](../../../docs/reference/settings.md), and affected startup flows in the implementation change. Keep `guides/` limited to its existing two files. This specification is proposed behavior; do not publish it as current guide/reference behavior before implementation.

## Verification

| Required outcome | Proportionate proof in the implementation change |
| --- | --- |
| Default local path works and reruns preserve state | Run the helper against an isolated real Compose project without a model key; verify successful initializer exits, worker readiness, authenticated matching Installation, then rerun with unchanged identity/key and a fresh output destination. |
| Customization stays native | Exercise one nondefault port and custom image/Compose override. Render Helm with edited example values plus a second override file; use existing configuration validation for the example Installation YAML. |
| Failures cannot claim success or expose credentials | Focused command-boundary tests cover failed initialization, worker readiness timeout, rejected API key, mismatched Installation, and existing output destination; assert nonzero status, no reset/reissue, and no credential values in captured output/arguments. Mocks establish wrapper behavior only. |
| Fresh production preparation preserves storage ownership | On an explicitly selected disposable cluster, prove fresh claim permissions and successful Helm initialization/readiness; prove a used claim is refused with its bytes unchanged. Keep the policy-denied storage-administrator route documented. |
| Existing production security remains enforced | Run the existing [packaging tests](../../../tests/integration/production-kubernetes-packaging.test.mjs) for hooks, role separation, Secret mounting and network validation. No live mutation is required while authoring this spec. |
| Production completion means authenticated control-plane access | With the real chart, PostgreSQL and protected output in the disposable environment, read `/installation` using the retrieved key and match IDs. Report readiness separately from Agent/model/TUI proof; those existing optional checks retain their own evidence. |
| The guide is shorter without losing supported tasks | Count the default-path lines/commands, verify links and retained anchors, and walk both defaults plus one customization. Shell syntax checks cover both helpers; record unavailable live prerequisites as verification gaps. |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 13:45: Implemented both helpers, native examples, and the 150-line default deployment path. Real Compose startup/rerun/customization, Helm initialization/authentication, used-volume refusal, and the 300-second timeout passed. Current operator behavior is owned by the [deployment guide](../../../docs/guides/deploy.md) and [settings reference](../../../docs/reference/settings.md); Agent/model and external HTTPS proof remain outside this control-plane change. (01a05e59-7e72-7370-88f6-dbf09eed8a4f - 65fbb866b0c503cdf89106465ce1b7739897cc76)
- 2026-09-01 12:50: Accepted implementation direction and tightened optional procedures into compact runnable recipes after independent reviews. (01a05e59-7e72-7370-88f6-dbf09eed8a4f - a222ae3182a3dfd7dd8cd56c34f20b0e9b5ed09e)
- 2026-09-01 12:07: Draft deployment simplification using existing Compose/Helm lifecycles, native customization, and two bounded Bash helpers. (01a05e59-7e72-7370-88f6-dbf09eed8a4f - a222ae3182a3dfd7dd8cd56c34f20b0e9b5ed09e)
