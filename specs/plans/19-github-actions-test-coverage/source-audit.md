# Report: OpenClaw testing infrastructure and Enterprise reuse

**Last Updated:** 2026-09-04
**Status:** Complete — source audit and sampled workflow metadata; no tests executed by this audit
**Authoring Agent Session:** [01a06dd0-9fff-7e90-aae3-4e7099a6d154](codex://threads/01a06dd0-9fff-7e90-aae3-4e7099a6d154)

## Context

Borrow OpenClaw's small setup action, explicit lane selection, selected-job gate, and separation of ordinary CI from credentialed runs. Keep Enterprise's Node test runner and its database/Kubernetes setup. OpenClaw's main CI is now 5,555 lines and its reusable suites depend on its product layout.

This refresh replaces the September 1 baseline with immutable main revisions resolved through GitHub on September 4: [OpenClaw `97abb65691d97ee95c977a9a4ede2ef221d6929c`](https://github.com/openclaw/openclaw/commit/97abb65691d97ee95c977a9a4ede2ef221d6929c), committed 19:06:54 UTC, and [Enterprise `1233e13aa6e1a2e4f502fa5febf06f5531c19f2c`](https://github.com/openclaw/openclaw-enterprise/commit/1233e13aa6e1a2e4f502fa5febf06f5531c19f2c), committed 09:24:03 UTC. “Current” below means these snapshots; later main commits are outside this audit.

Enterprise was reached through the approved project's `code/openclaw-enterprise` symlink. Canonical HEAD remains `f0b17b79e25b020e7cf1adb5ed143ef8adc502c2` on `dev/kevinlin/common-otel-logging`, with HTTPS origin `openclaw/openclaw-enterprise`. The GitHub comparison shows three local-only commits and one main-only commit. The local `origin/main` is older (`6c50aab`); it was not used as the current baseline. No branch, worktree, remote, or checkout was changed. Existing untracked report/plan files are refreshed in place; unrelated README, spec and audit-report changes are preserved.

Enterprise's Actions API again reported `enabled: true`, `allowed_actions: all`, `sha_pinning_required: false`, and **zero registered workflows**. [AGENTS.md](https://github.com/openclaw/openclaw-enterprise/blob/1233e13aa6e1a2e4f502fa5febf06f5531c19f2c/AGENTS.md#L3-L11) still prohibits workflow changes because of organization push restrictions. API enablement does not remove that instruction; the actual ruleset was not tested by attempting a write. This was the audit-time instruction; the user subsequently removed it and authorized implementation. Actual workflow-push acceptance and protected-environment setup remain to be verified.

No dependencies were installed and no tests, workflows, deployments, live model calls, provider accounts or Slack messages were initiated. The sampled run metadata below is separate from source configuration and does not prove these exact snapshots pass.

## How OpenClaw runs tests

See [How OpenClaw runs tests](source-audit/upstream-test-execution.md#how-openclaw-runs-tests).

## What Enterprise can reuse

| Candidate | Decision | Integration cost and boundary |
| --- | --- | --- |
| Standard checkout, Node setup and artifact actions | Use reviewed full commit SHAs directly. | Keep Enterprise's toolchain and Node runner. No access to upstream credentials or paid runner contracts is implied. |
| [setup-pnpm-store-cache](https://github.com/openclaw/openclaw/blob/97abb65691d97ee95c977a9a4ede2ef221d6929c/.github/actions/setup-pnpm-store-cache/action.yml#L3-L35) | Best small upstream action to trial. | Parameterizes package-manager file, lockfile, Node and cache mode; reads caller `packageManager` using Corepack and an action-local `ensure-node.sh`; exports store/save inputs. It restores on non-Windows and leaves saving to the caller. No checkout-local action dependency was found. Trial `openclaw/openclaw/.github/actions/setup-pnpm-store-cache@97abb65691d97ee95c977a9a4ede2ef221d6929c` against Enterprise cold/warm pnpm 11 installs and PR merge-ref read/write isolation before adopting (the later implementation decision supersedes the earlier restore-only recommendation). [Implementation](https://github.com/openclaw/openclaw/blob/97abb65691d97ee95c977a9a4ede2ef221d6929c/.github/actions/setup-pnpm-store-cache/action.yml#L62-L132). |
| Small container smoke workflow | Reuse the pattern for offline PR checks. | Upstream builds a minimal Debian sandbox with Buildx, then uses `docker run --rm` to verify its runtime user and tools. Enterprise should invoke its existing image-smoke tests against its own Dockerfiles. [Sandbox smoke](https://github.com/openclaw/openclaw/blob/97abb65691d97ee95c977a9a4ede2ef221d6929c/.github/workflows/sandbox-common-smoke.yml#L37-L65). |
| Selected-job gate, explicit live inputs, summaries and always-on diagnostics | Adopt the patterns. | Small Enterprise-owned jobs plus expected-case accounting; selected missing/skipped/advisory failures cannot satisfy a required lane. |
| Build once and distribute immutable image artifacts | Adopt only when multiple jobs consume the image. | Record producer SHA, architecture and digest; load/tag exactly what k3s requests. Never promote untrusted PR artifacts into a credentialed run. |
| [detect-docs-changes](https://github.com/openclaw/openclaw/blob/97abb65691d97ee95c977a9a4ede2ef221d6929c/.github/actions/detect-docs-changes/action.yml) | Defer. | OpenClaw-specific path policy; establish full intended coverage before adding filters. Documentation fixtures may be test inputs. |
| setup-node-env, reusable product E2E workflows, shard planner, Docker scheduler and external runner services | Do not transplant initially. | `setup-node-env` assumes `ui`, `packages`, `extensions`, `examples` and calls `./.github/actions/setup-pnpm-store-cache` in the caller checkout. Vitest ownership, sandbox, image/registry and Blacksmith/Testbox contracts differ from Enterprise. [Setup coupling](https://github.com/openclaw/openclaw/blob/97abb65691d97ee95c977a9a4ede2ef221d6929c/.github/actions/setup-node-env/action.yml#L195-L236). |

A callable workflow must expose `workflow_call` and a compatible inputs/secrets contract; repository membership alone does not share secrets or runners. [GitHub workflow reuse](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows). OpenClaw is [MIT licensed](https://github.com/openclaw/openclaw/blob/97abb65691d97ee95c977a9a4ede2ef221d6929c/LICENSE); retain applicable notices when copying substantial code. A pinned source reference is not a compatibility test.

## Enterprise coverage inventory

See [Enterprise coverage inventory](source-audit/enterprise-coverage-and-gaps.md#enterprise-coverage-inventory).

## Gaps CI configuration alone cannot fix

See [Gaps CI configuration alone cannot fix](source-audit/enterprise-coverage-and-gaps.md#gaps-ci-configuration-alone-cannot-fix).

## Open Questions

- Repository administrators: verify actual workflow-push acceptance and protected-environment setup; the user has now removed the AGENTS.md prohibition and authorized implementation.
- Test owners: select approved public dependency/image access, dedicated model/ChatGPT/Slack resources, ephemeral runner capacity, budget and cleanup responsibility. No access was trialed here.
- Runtime owners: prove Envoy/CA and OpenShell runner setup at the selected implementation revision.
- CI owner: trial the pinned cache action with Enterprise and validate case-level results; sampled upstream job success does not substitute.

The [Enterprise GitHub Actions plan](index.md) is derived from this refreshed report. Coverage and source mismatches above are its inputs, not implementation completion claims.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog
- 2026-09-04 12:11: Refreshed pinned upstream CI, sampled runs, Enterprise main/branch inventory, skip gates and reuse boundaries before revising the plan. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
- 2026-09-01 15:18: Audited pinned upstream CI and both Enterprise revisions; inventoried all test files, gates, reuse candidates and implementation prerequisites. (01a05901-204b-7b52-b9da-527ee94cbf81 - 264d6d2f58cd97504c2b8b58d607d002cd62cc5e)
