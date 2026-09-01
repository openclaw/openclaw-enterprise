# Feature Design: Bootstrap administrator service account

**Date:** 2026-08-31  
**Status:** Bootstrap recovery guarantees superseded; removal locally verified; PR review pending\
**Owner:** OCC bootstrap, authentication, and native IAM  
**Source baseline:** `openclaw/openclaw-enterprise` `main` at `b43cc49c45fa6275e79985be0eabb517743c6a23`  
**Affected references:** [Authentication](../docs/reference/authentication.md), [Authorization](../docs/reference/authorization.md), [Settings](../docs/reference/settings.md)

> The bootstrap recovery guarantees below are historical and are superseded by
> [the current authentication reference](../docs/reference/authentication.md#installation-and-account-ownership).
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

The service identity is a non-Agent IAM `ServicePrincipal`, with no human login, email, password, session, Namespace, or Agent owner. Namespace [ServiceAccount resources](../docs/reference/service-accounts.md) instead supply upstream workload credentials. The operator owns the delivered credential; native IAM owns identity and permissions; Better Auth owns key generation, hashing, expiry, and revocation.

This active, unshipped specification records the approved implementation under [the platform design](../docs/design.md). The user-approved simplification replaces the earlier retained-entrypoint decision with one initializer for Compose and Helm: migrate → initialize administrators and credentials → start API/worker. Native IAM provisioning and the public human-only bootstrap endpoint remain. A shared transaction coordinator, auth/OCC atomicity, receipt table or migration, recovery endpoint, external-IAM bootstrap, extra startup-YAML mounting, automatic rotation, and existing-installation backfill remain out of scope. Local verification of the shared-initializer revision and its predecessor is recorded below. No production rollout is included.

## Current state and evidence

The predecessor implementation at `b6f213c` had separate production-script and
development-composition bootstrap owners. Development created credentials,
constructed Fastify, signed into itself, and submitted HTTP bootstrap; production
committed directly. Both tracked credential output and cleanup. The shared
initializer removes that duplication and the internal HTTP error boundary.

| Area | Selected owner and source |
| --- | --- |
| Initialization | [`scripts/bootstrap-installation.mjs`](../scripts/bootstrap-installation.mjs) handles both environment modes, private output, commit, and failure cleanup. |
| API startup | [Development composition](../apps/controller/src/composition/development-postgres.ts) and [production composition](../apps/controller/src/composition/production.ts) require initialized state. |
| Identity and keys | [Native IAM](../packages/iam/src/index.ts) owns the shared administrator Role and bindings; the [auth wrapper](../apps/controller/src/auth/index.ts) owns Better Auth key issuance and verification. |
| Persistence and delivery | [PostgreSQL transactions](../packages/occ/src/state/postgres-state.ts) distinguish unknown COMMIT outcomes; [private output](../apps/controller/src/composition/bootstrap-output.ts) protects attempt-owned files. |
| Packaging and operator access | [Compose](../compose.yaml) and the [Helm Job](../deploy/helm/openclaw-enterprise/templates/jobs.yaml) run initialization before serving; [`scripts/occ-api`](../scripts/occ-api) sends protected operator requests. |

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

### Identity and permission scope

Add one random stable `spn_<uuid>` with `kind: service_principal` to the fresh bootstrap seed only. Omit `namespaceId` and `agentId`. Give it a separate binding to the **same Role ID** as the human administrator, omitting binding `namespaceId`, `resourceKind`, and `resourceId`. IAM records inherit the singleton Installation; no new ownership fields are needed.

Reuse the IAM-owned permission definition exactly:

| Resource kind | Allowed actions |
| --- | --- |
| `installation` | `administer`, `read` |
| `namespace` | `create`, `read`, `delete` |
| `configuration`, `service_account`, `secret` | `create`, `read`, `update`, `delete` |
| `secret` additionally | `operate` |
| `agent` | `create`, `read`, `update`, `deploy`, `operate` |
| `agent_revision` | `read` |

These grants cover current and future Namespaces in this Installation, subject to Restrictions and exact request authorization. They confer no provider/Kubernetes privileges, wildcard bypass, or Agent-delete permission. The credential name is `bootstrap-admin`; it is a label, never an identity lookup key.

Installation administrators manage credentials through existing APIs, including service administrators rotating their own keys. The identity survives removal of its original human administrator. Revocation/expiry rejects later authentication; removal of identity/binding/Role or a matching Restriction denies later authorization. Already authorized work may finish. Human-account creation and HTTP bootstrap remain human-only. There is no new principal-management API.

### Bootstrap sequence and failure behavior

1. Run `scripts/bootstrap-installation.mjs` after migration with `NODE_ENV=development` or `production`, application-role PostgreSQL, and Better Auth settings. Load persisted Installation state. If already bootstrapped, retain existing administrator verification and return without issuing keys or touching output, including installations predating this feature. Missing files, expired/revoked keys, or removed identities/grants never trigger regeneration or repair.
2. For fresh native-IAM bootstrap, validate private absolute output paths, create the human as today, and extend its seed with the service identity/binding. Call existing `auth.createServiceKey` for that identity with Installation scope, `bootstrap-admin`, and a 30-day lifetime.
3. Write and fsync the private key file before the existing Installation/IAM/audit commit; production also retains its password-file write. Better Auth persists independently: the key may authenticate before OCC commits, but cannot authorize normal OCC operations without its committed identity/binding. Do not start serving until confirmed bootstrap success.
4. Both modes use the same direct controller transaction and one attempt scope. API and worker startup require the committed Installation and IAM state; development no longer constructs Fastify or signs into itself to bootstrap. A losing initializer exits unsuccessfully. A later complete initialization retry reloads the winner's persisted Installation/IAM instead of serving generated loser IDs. The public `POST /installation/bootstrap` route remains human-session-only and does not issue bootstrap credentials.
5. Existing singleton database constraints select at most one committed Installation/IAM seed. Concurrent attempts can temporarily create independent auth records and files. After a known losing commit, best-effort cleanup removes only that attempt's recorded user/key IDs and files it exclusively created; never the winner's or preexisting resources.

Ordinary failures before OCC commit use the same scoped cleanup and return failure. Attempt each cleanup independently even when an earlier cleanup fails. Retain handles/identity checks sufficient to avoid deleting replaced files. Report cleanup failures with safe IDs and paths so an operator can repair them; do not retry issuance over existing output or adopt users by email/name.

An **unknown commit outcome** preserves all accounts, keys, and output and stops for operator verification. Both modes preserve `PostgresCommitOutcomeUnknownError` directly; there is no internal HTTP translation of the commit outcome. Existence of any Installation is not proof that this attempt committed. Compare the recorded attempt Installation/principal IDs with authoritative Installation/IAM/key state, and confirm the original transaction has finished before deciding cleanup. Database unavailability remains unresolved; no destructive compensation or automatic retry runs.

Abrupt termination can leave auth accounts, key hashes, or partial output without a committed IAM seed. Operator repair is an accepted tradeoff: establish the transaction outcome, identify this attempt's orphan IDs, remove only proven orphans, quarantine stale output privately, then rerun. When the matching seed committed, retain its credentials and use normal recovery if output was lost. File existence alone never proves bootstrap success.

### Private delivery and recovery

Use path-only `OCC_BOOTSTRAP_SERVICE_KEY_FILE`, required on fresh direct initialization. Production requires a distinct sibling of `OCC_BOOTSTRAP_PASSWORD_FILE`. The protected file helper uses the exclusive-create pattern: reject unsafe parents/symlinks and existing destinations, open with `O_EXCL`, enforce `0600`, write complete JSON, and fsync file and parent directory before OCC commit. The protected directory is writable only by the runtime identity and trusted storage administrators. Never overwrite output.

Use the existing response-compatible shape so [service-key client examples](../docs/reference/setup.md#credential-retrieval-and-replacement) can consume `data.key`:

```json
{"data":{"id":"<key-id>","servicePrincipalId":"<spn_uuid>","name":"bootstrap-admin","expiresAt":"<UTC-expiry>","key":"<generated-occ-key>"},"meta":{"installationId":"<installation-id>"}}
```

| Entry point | Delivery and user experience |
| --- | --- |
| Production/Helm | Add `bootstrap.serviceKey.fileName`, default `initial-admin-service-key.json`, under the existing password mount; validate a distinct simple basename and pass the full path. Only bootstrap mounts the PVC. Retrieve via approved PVC/storage access after Job success; a completed container is not an exec endpoint. |
| Development Compose | The one-shot `bootstrap` service follows `migrate` and alone mounts `occ_bootstrap_data` at `/var/lib/openclaw/bootstrap`. The development image prepares UID/GID 1000 and `0700`. After confirmed exit `0`, use `docker compose cp bootstrap:/var/lib/openclaw/bootstrap/initial-admin-service-key.json` to copy into an operator-owned `0700` directory under `umask 077`, then enforce local `0600`. API/worker do not mount bootstrap output. |
| Direct development | Run the shared initializer before API/worker startup with an explicit private absolute key-file path, `OPENCLAW_DEV_EMAIL`, `OPENCLAW_DEV_PASSWORD`, and `OPENCLAW_DEV_INSTALLATION_NAME` or their existing defaults. It writes no password file. |
| Unattended installer | Wait for confirmed script/Job/startup success, import the file into existing credential storage, retain key/principal IDs, then remove delivery copies according to policy. Import failures retry the same file without issuing another key. |

“One-time disclosure” means one generated output and no server-side plaintext retrieval; the file remains readable until removed. Bootstrap emits safe outcome/Installation/principal/key IDs, expiry and path only. Never place secrets in stdout/stderr, process arguments, HTTP bootstrap responses, audit, manifests, or image layers. Redact `x-api-key` in request logs and exclude output from diagnostics. Operators own protection of copied files, backups, snapshots, and crash dumps. First-use proof is a key-authenticated Installation read and Namespace create/read.

Lost or exposed token with retained IDs: sign in as the human, revoke the old ID with `DELETE /api/auth/service-keys/:keyId`, then issue a replacement for the recorded principal using `POST /api/auth/service-keys`, omitting Namespace, and save its one-time response privately. Lost file **and IDs** require operator database inspection of existing IAM and key metadata; there is no discovery endpoint. Missing IAM authority is not restored by key issuance. Planned rotation is issue → switch clients → check a real request → revoke old ID. Compromise may require revoking additional keys issued by that administrator; revocation does not cascade. Loss of all admin access requires existing operator recovery, never rerunning bootstrap as a reset.

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

- **Unit:** Fresh-only seed shares the exact Role and permission matrix; private JSON is complete, `0600`, fsynced, and rejects existing files/symlinks/unsafe parents without overwrite. Known-failure cleanup touches only attempt-owned files/IDs; uncertain outcomes preserve them.
- **Integration:** Real fresh development and production paths create one committed Installation, human, service principal and usable key; prove Installation and Namespace operations plus Restriction/removed-binding denial. Confirm hashed storage and no secret leakage through logs, audit, HTTP bootstrap, or packaging.
- **Integration:** Reruns preserve IDs/key/file bytes, older installations remain unchanged, and expiry/revocation/removal never resurrects credentials. Race fresh starts with same/different output paths; one seed wins, the loser exits unsuccessfully, cleanup leaves the winner intact, and a whole-startup retry reloads it. Fault an ambiguous commit and prove no credential deletion even when acknowledgement is lost.
- **Manual:** Verify Compose UID 1000 volume/copy permissions and actual Job/PVC retrieval, human sign-in, first key request, saved-ID loss recovery and lost-file/IDs operator recovery, planned rotation/revocation, and unattended import only after success. Rendered Helm alone does not prove PVC permissions; unavailable runtime prerequisites remain explicit gaps.

Use focused real integration tests, `pnpm test:postgres`, `pnpm typecheck`, and `pnpm check:workspace` after implementation. The implementation also validates actual Compose output/copy behavior and a disposable initialization Job/PVC; production deployment remains outside this change.

## Implementation verification

**Shared-initializer revision:** Local verification passed: 32 PostgreSQL tests with no failures and five documented skips, eight standalone worker tests without skips, 140 conformance tests, four packaging tests, TypeScript, workspace, OpenAPI, formatting, and documentation checks. One PostgreSQL skip is an already-bootstrapped guard after the fresh-bootstrap case; four require the separate live Kubernetes Configuration Driver. The PostgreSQL suite covers both production race variants, the development race, unknown COMMIT preservation in both modes, and independent known-failure cleanup diagnostics. A focused fresh-database rerun also verifies that API startup fails before initialization.

Both selected live suites passed without skips: development Compose passed its complete model/TUI flow in 128.8 seconds; production Helm on disposable k3d passed in 158.7 seconds, including TUI model turns before and after revision cutover, network denial, and private credential boundaries. Both exercised the checked-in `scripts/occ-api` helper for `GET /installation` and Namespace creation against actual APIs. Development also verified protected key retrieval from the stopped initializer container. These live runs preceded the subsequent IPv6 loopback allowlist correction; two focused real-entrypoint tests passed for that correction.

The broader non-live integration run had 94 passes, 58 selector-dependent skips, and one unchanged Driver-package fixture failure: the release-age policy requests unpublished local fixture packages from npm and receives 404. The two IPv6 tests are included in those 94 passes; package policy was retained. The PR remains unmerged, and no production rollout is included.

**Predecessor verification at `b6f213c`:** Local validation passed for the earlier bootstrap contract: 31 PostgreSQL tests (five documented skips), eight standalone worker tests, 140 conformance tests, and TypeScript, formatting, workspace, OpenAPI, and flow-document checks. Actual Compose and initialization Job/PVC proofs cover private delivery, human/service access, rotation and revocation, retry preservation, and file permissions. Three review rounds resolved the PVC procedure and shared PostgreSQL fixture issues.

The predecessor development and production deployment paths used the bootstrap service key instead of operator cookies. Both selected real E2E suites passed without skips: Compose covered embedded and dedicated gateway model replies and a two-turn TUI session; production Helm on disposable k3d covered trusted HTTPS provisioning, two-turn TUI sessions before and after revision cutover, network denial, least privilege, and credential-output boundaries. The literal documented `occ_api` helper completed Installation reads and Namespace creation against both live APIs. Guide links, shell syntax, and the two affected flow-document validators passed.

The broader non-live integration run had 92 passes, 57 infrastructure skips, and one unchanged Driver-package fixture failure: pnpm's release-age policy queries unpublished local fixture packages on npm and receives 404. Package policy was retained. Production rollout remains outside this verification.

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
