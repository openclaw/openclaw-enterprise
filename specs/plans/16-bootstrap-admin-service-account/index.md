# Feature Design: Bootstrap administrator service account

**Date:** 2026-08-31  
**Status:** Bootstrap recovery guarantees superseded; removal locally verified; PR review pending\
**Owner:** OCC bootstrap, authentication, and native IAM  
**Source baseline:** `openclaw/openclaw-enterprise` `main` at `b43cc49c45fa6275e79985be0eabb517743c6a23`  
**Affected references:** [Authentication](../../../docs/reference/authentication.md), [Authorization](../../../docs/reference/authorization.md), [Settings](../../../docs/reference/settings.md)

> The bootstrap recovery guarantees below are historical and are superseded by
> [the current authentication reference](../../../docs/reference/authentication.md#installation-and-account-ownership).
> The user-approved removal replaces automatic recovery with one attempt that
> preserves created artifacts after any error. The earlier design and recorded
> test results remain unchanged below.
>
> **Removal verification:** Fresh Compose (138.6 seconds) and Helm/k3d (163.5
> seconds) each passed 1/1 with no failures or skips, exercising private output,
> protected retrieval, helper GET/POST requests, model/TUI execution, production
> revision cutover, and network boundaries. TypeScript, format, workspace, and
> five output/packaging tests passed; independent reviews were clear.
>
> The first full PostgreSQL run had 30 passes, two stale event-label assertion
> failures, and five previously documented skips. After correcting those
> assertions, all six failure tests passed without skips. This verifies 32
> distinct PostgreSQL cases across runs, not one clean full-suite run. The
> unchanged earlier 140 conformance tests, eight worker tests, and broader
> integration result (94 passes, one baseline fixture failure, 58 skips) were
> reused and were not rerun for this removal.

## Goal and scope

Fresh bootstrap creates the human administrator and one Installation-scoped service administrator. Extend the existing native IAM seed and issue a 30-day service API key through existing authentication code. Deliver it in a **private JSON file** on the production password PVC or a bootstrap-only development volume.

The service identity is a non-Agent IAM `ServicePrincipal`, with no human login, email, password, session, Namespace, or Agent owner. Namespace [ServiceAccount resources](../../../docs/reference/service-accounts.md) instead supply upstream workload credentials. The operator owns the delivered credential; native IAM owns identity and permissions; Better Auth owns key generation, hashing, expiry, and revocation.

This active, unshipped specification records the approved implementation under [the platform design](../../../docs/design.md). The user-approved simplification replaces the earlier retained-entrypoint decision with one initializer for Compose and Helm: migrate → initialize administrators and credentials → start API/worker. Native IAM provisioning and the public human-only bootstrap endpoint remain. A shared transaction coordinator, auth/OCC atomicity, receipt table or migration, recovery endpoint, external-IAM bootstrap, extra startup-YAML mounting, automatic rotation, and existing-installation backfill remain out of scope. Local verification of the shared-initializer revision and its predecessor is recorded below. No production rollout is included.

## Current state and evidence

The predecessor implementation at `b6f213c` had separate production-script and
development-composition bootstrap owners. Development created credentials,
constructed Fastify, signed into itself, and submitted HTTP bootstrap; production
committed directly. Both tracked credential output and cleanup. The shared
initializer removes that duplication and the internal HTTP error boundary.

| Area | Selected owner and source |
| --- | --- |
| Initialization | [`scripts/bootstrap-installation.mjs`](../../../scripts/bootstrap-installation.mjs) handles both environment modes, private output, commit, and failure cleanup. |
| API startup | [Development composition](../../../apps/controller/src/composition/development-postgres.ts) and [production composition](../../../apps/controller/src/composition/production.ts) require initialized state. |
| Identity and keys | [Native IAM](../../../packages/iam/src/index.ts) owns the shared administrator Role and bindings; the [auth wrapper](../../../apps/controller/src/auth/index.ts) owns Better Auth key issuance and verification. |
| Persistence and delivery | [PostgreSQL transactions](../../../packages/occ/src/state/postgres-state.ts) distinguish unknown COMMIT outcomes; [private output](../../../apps/controller/src/composition/bootstrap-output.ts) protects attempt-owned files. |
| Packaging and operator access | [Compose](../../../compose.yaml) and the [Helm Job](../../../deploy/helm/openclaw-enterprise/templates/jobs.yaml) run initialization before serving; [`scripts/occ-api`](../../../docs/guides/cli.md) sends protected operator requests. |

## Requirements -> Design Mapping

| Requirement | Selected mechanism |
| --- | --- |
| Both administrator identities with exact authority | Extend the fresh native IAM seed; share the human administrator Role. |
| Private initial delivery | Existing auth helper, exclusive owner-only JSON, existing PVC or dedicated development volume. |
| Reruns and concurrency | Existing singleton constraints; fail the losing initializer, then reload on a complete initialization retry. |
| One startup mechanism | Shared initializer after migration; API/worker only load initialized state. |
| Failure recovery | Attempt-owned best-effort cleanup for known failures; preserve uncertain outcomes for operator verification. |
| Lifecycle and existing installations | Existing issue/revoke APIs; no backfill, regeneration, or resurrection. |

## Selected design

See [Selected design](selected-design.md#selected-design).

## Delivery alternatives, tradeoffs, and open questions

Protected files fit both deployment environments and unattended import. Stdout/Job logs expose retained plaintext; an HTTP/UI channel misses production's script path. A Kubernetes Secret or external vault integration adds credentials, permissions and another failure boundary. Existing issue/revoke APIs suffice after setup. The selected file design accepts operator-managed retention and occasional orphan repair in exchange for avoiding a coordinator, recovery schema, and new API.

Selected defaults are no existing-installation backfill and the existing 30-day key lifetime. Whether a later opt-in provisioning tool, different lifetime, or named vault integration is needed remains separate product work; none blocks this design.

## Detailed File Plan

The file plan includes the approved shared-initializer revision; verification must follow the final source changes.

| File | Expected change |
| --- | --- |
| `packages/iam/src/index.ts` | Extend fresh bootstrap seed with the service identity and same-Role broad binding; leave additional human-account provisioning unchanged. |
| `apps/controller/src/composition/bootstrap-output.ts` | Retain protected JSON output and attempt-owned file cleanup. |
| `scripts/bootstrap-installation.mjs` | Replace the production-only filename with a common environment-selected initializer owning seed, issuance, output, commit, and scoped cleanup. |
| `apps/controller/src/composition/development-postgres.ts`, `apps/controller/src/server.mjs` | Remove internal HTTP bootstrap and credential creation; require and load initialized state. |
| `compose.yaml`, `Dockerfile`, `.env.example` | Run bootstrap after migration; mount output only into initializer; retain protected image directory ownership/mode and document direct initialization. |
| `deploy/helm/openclaw-enterprise/values.yaml`, `templates/jobs.yaml`, `templates/_helpers.tpl` | Key basename/path setting and validation using the existing PVC; no extra mounts, API credentials, or RBAC. |
| `docs/reference/{authentication,authorization,settings}.md`, `docs/guides/{quickstart,deploy}.md` | Publish bootstrap identity, output retrieval, permissions, rerun, and manual recovery contracts. |
| `docs/flows/{local-password-authentication,service-api-keys,development-startup,production-startup,platform-startup}.md`, `docs/ARCHITECTURE.md` | Explain initializer ownership, startup ordering, independent auth persistence, and failure boundaries. |
| `scripts/occ-api`, deployment/TUI guides and live tests | Share one Bash/curl/Python operator helper; remove executable helper duplication in Markdown and test scraping. |
| `tests/integration/{postgres-production-wireup,postgres-auth-accounts,postgres-service-api-keys,service-api-keys,production-kubernetes-packaging}.test.mjs`, focused bootstrap/file-helper tests | Verify the acceptance criteria below using real storage and entry points where relevant. |

## Planning & Milestones

### Milestone 1: Fresh bootstrap with privately delivered administrator key

**Delivery outcome:** Both supported fresh startup paths provision both administrators and a usable private credential, with rerun and manual recovery behavior documented.
**Tasks:** Share initialization and attempt cleanup; make API/worker load-only; order Compose/Helm after migration; isolate credential mounts; check in the operator helper; synchronize references, flows, and tests.
**Verification:** Complete the unit, integration, and manual criteria below before shipping code, chart, and docs together.

## Rollout Plan

Validate first on disposable PostgreSQL/Compose, then a selected disposable Helm Job/PVC, then ship the complete change. No feature gate or schema migration is needed. Existing installations receive no new identity, grant, key, or output. Fresh bootstrap fails if required output cannot be created.

**Rollback:** Stop an unfinished attempt and resolve uncertain commit state before downgrading. Retain database and credential storage when reverting binaries/chart; the identity and key use existing models. Explicitly revoke keys or remove the binding to retire automation. Never use old unconditional compensation against an unresolved attempt.

## Testing Plan

See [Testing Plan](verification.md#testing-plan).

## Implementation verification

See [Implementation verification](verification.md#implementation-verification).

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 22:41]: Verify the user-approved removal of automatic bootstrap recovery through fresh Compose/Helm model/TUI flows, corrected PostgreSQL failure coverage, output/packaging checks, and independent review; retain prior results as historical evidence and leave PR review pending. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440) (NOT_IN_SPEC)

- [2026-08-31 22:29]: Remove automatic bootstrap cleanup and retries by user approval; current behavior is owned by the authentication reference, and removal verification is pending. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440) (NOT_IN_SPEC)

- [2026-08-31 21:00]: Verify the shared initializer with both complete live model/TUI flows, PostgreSQL failure and startup coverage, worker/conformance/packaging checks, and the checked-in operator helper; retain the unrelated package-fixture 404 and PR review boundary. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213c)

- [2026-08-31 20:34]: Reopen the active specification for the user-approved shared initializer, initializer-only credential mount, and checked-in operator helper; repeat verification after implementation. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213c)

- [2026-08-31 19:44]: Rebase against `main` at `76bf269` without conflicts; switch development and production operator guides to bootstrap service-key authentication and verify both complete live model/TUI flows, including literal guide-helper requests. (01a05a3d-526f-7553-8cd8-070bd1847acb - 06c4bcc)

- [2026-08-31 19:04]: Complete implementation and local verification in `9da1e4c`; resolve PVC and PostgreSQL fixture review findings; retain the documented unrelated package-policy test failure and await PR review. (01a05a3d-526f-7553-8cd8-070bd1847acb - 9da1e4c)

- [2026-08-31 18:06]: Implement both bootstrap paths, protected credential output, shared administrator policy, packaging, and current documentation; final review and verification are in progress. (01a05a3d-526f-7553-8cd8-070bd1847acb - 0797098)

- [2026-08-31 17:33]: Apply approved simplification: retain existing bootstrap flows, share the administrator Role, deliver a private key file, and use scoped cleanup with operator recovery for partial or uncertain outcomes. (01a05a3d-526f-7553-8cd8-070bd1847acb - b43cc49)
- [2026-08-31 17:04]: Resolve independent review by adding all three owning startup flow documents and a documentation-parity acceptance criterion. (01a05a3d-526f-7553-8cd8-070bd1847acb)
- [2026-08-31 16:56]: Trace current bootstrap/IAM/key paths and propose atomic dual-identity bootstrap, private-file delivery, recovery, and verification. (01a05a3d-526f-7553-8cd8-070bd1847acb)
