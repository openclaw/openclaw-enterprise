# Report: Architecture and security audit

**Last updated:** 2026-09-01\
**Status:** Complete audit; findings unresolved\
**Authoring agent session:** [01a05f75-a97e-70c0-bfe4-e14b74e6ba3d](codex://threads/01a05f75-a97e-70c0-bfe4-e14b74e6ba3d)

## Context

This is an audit of **upstream commit `5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c`**, fetched on September 1, 2026, from `https://github.com/openclaw/openclaw-enterprise.git`. Source links below are pinned to that commit.

The canonical checkout is `/Users/kevinlin/code/openclaw-enterprise`; the project-local link resolves there. Its current branch, `dev/kevinlin/deploy-guide-tui-rewrite`, is at `264d6d2f58cd97504c2b8b58d607d002cd62cc5e`, with **2 commits ahead and 15 behind** fetched main. Updating it would require reconciling unrelated history. No merge, rebase, reset, stash, checkout, or worktree creation was performed. This is a **fetched-main audit**, not an audit of the updated working branch.

The pre-existing changes to `specs/README.md`, `specs/19-github-actions-test-coverage.md`, and `specs/reports/openclaw-testing-infrastructure.md` were preserved. The uncommitted CI proposal/report were not treated as implementation evidence. This report is the only repository file added.

Review scope covered implemented code, current design/reference/flow documentation, relevant implementation specs, deployment defaults, and repository organization. Ordinary unfinished capabilities were excluded unless the existing implementation creates a concrete structural or security risk. One initial review pass used five scoped reviewers for authentication/IAM, state/reconciliation, runtime isolation, provider/credential ownership, and deployment/docs. A targeted challenge/validation pass included parent classification and an independent skeptical reviewer. Major findings remain unresolved; no fixer pass ran because this task is audit-only.

## Assessment and priorities

The strongest defects are at integration boundaries: the HTTP wrapper bypasses a library security control, activation can leave contradictory durable/runtime state after recovery stops, and Docker retry reconstructs only one side of an authentication relationship. No confirmed cross-Namespace authorization bypass, credential disclosure, or container escape was established in the inspected paths.

| Priority | Finding | Classification | Confidence |
| --- | --- | --- | --- |
| P1 | Password sign-in bypasses the configured rate limiter | Confirmed security-control integration defect | High, source-confirmed |
| P1 | Failed Kubernetes activation can leave a permanently false active revision | Confirmed lifecycle/persistence defect | High, source-confirmed |
| P2 | Docker retry can give gateway and Codex different transport tokens | Confirmed development-runtime defect | High; diagnostic below |
| P2 | Production setup assigns an unprepared kubeconfig path | Confirmed operator-documentation defect | High |
| P3 | Architecture limitations incorrectly exclude service-principal API authentication | Confirmed documentation drift | High |

P1 means resolve before relying on the platform for a shared multi-user pilot; it does not mean an internet-reachable exploit was demonstrated. P2 affects a supported operational path. P3 is a bounded documentation correction.

## Confirmed findings

See [Confirmed findings](confirmed-findings.md#confirmed-findings).

## Open Questions

- **Bootstrap-helper network isolation: bounded hardening question.** The pre-Helm preparation Pod lacks the release-instance label selected by the chart's default-deny policy ([scripts/prepare-bootstrap-volume:124](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/scripts/prepare-bootstrap-volume#L124-L192); [deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml:1](https://github.com/openclaw/openclaw-enterprise/blob/5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c/deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml#L1-L10)). Thus chart policies do not establish its isolation; a namespace policy must already cover it. The Pod has no service-account token, uses an empty PVC, receives no bootstrap credentials, and is not privileged: it runs UID 0 with only CHOWN/FOWNER restored. No practical compromise path was demonstrated. Decide whether the helper owns a temporary deny policy or the guide requires namespace-level coverage before execution.
- **Session transport policy:** sign-in/sign-out/session routes lack the controller's forwarded-header rejection. This alone did not establish a credential theft or authorization bypass; it was rejected as a standalone major finding. If hardening those routes, use a pre-auth transport check, not an identity-required admission hook that would prevent sign-in. The limiter issue above is independently substantive.

## Coverage, safeguards, and limitations

| Area | Evidence inspected and conclusion |
| --- | --- |
| Trust boundaries, authentication, authorization | Fastify routes, admission verifier, Better Auth integration, IAM bindings/restrictions, API schemas and auth tests. Exact-resource authorization remains separate from authentication; no concrete cross-Namespace IAM bypass found. |
| Namespace isolation and runtime | Kubernetes/Docker ownership checks, placement, projected identity, network/RBAC manifests, readiness, revision/gateway lifecycle, Sandbox/OpenShell contracts and fixtures. Docker retry defect found; no tested container escape or live network-enforcement claim. |
| Secrets, service accounts, providers, Drivers | Installation selection and plugin composition, private provider bindings, account issuance/deletion, Secret/Configuration storage and delivery, worker revalidation, API-only provider-admin mounting. No confirmed provider-binding or credential-ownership bypass found. |
| Persistence and concurrency | OCC state and SQL constraints, queue claim/lease fencing, worker retries, revision CAS and recovery tests. Claim-token fencing and same-Agent queue serialization are present; terminal activation compensation is missing. |
| Deployment, documentation, layout | Helm/Compose/defaults/bootstrap scripts, current architecture/reference/flows, documentation ownership, active workspace boundary. Two actionable doc errors and one bounded network hardening question identified. No maintainability finding was based on file size or abstraction count alone. |

Explicitly deferred public OAG/federation, SecretBroker, brokered model credentials, restricted model-egress proxy, automatic credential rotation, and stock OpenShell compatibility were not counted as new defects. Current references disclose env-delivery/restart semantics, temporary public TCP/443 model egress, and the worker's effective namespace-level trust. Older specs and project notes were used as context, not as proof that current code implements or violates an obsolete design.

### Verification performed

An isolated **non-Git** diagnostic directory was populated from `git archive 5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c`; it is not another checkout or worktree. No ambient credentials, kubeconfig, or live provider configuration were passed to test processes. Node 24.16.0 ran:

- `node scripts/verify-workspace-boundary.mjs`: passed; one application, five packages, 104 scanned sources.
- `utils.test.mjs`, `bootstrap-output.test.mjs`, `production-healthcheck.test.mjs`: **10 passed, 0 failed, 0 skipped**.
- `audit.test.mjs`, `compute-lifecycle-hooks.test.mjs`: **21 passed, 0 failed, 0 skipped**. A small loader mapped workspace package names to their exact exported source files; no library behavior was stubbed for these tests.
- Docker retry transport diagnostic: **mismatch reproduced**, with the production Driver logic and fake daemon state retained across process death. [Diagnostic script](/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-diagnostic.mjs), [result](/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-result.json), and [stdout](/private/tmp/enterprise-audit-a1hg863_/docker-token-retry-stdout.log) are temporary local evidence, not repository tests.

These tests establish only their named boundaries. Full Fastify/Better Auth, PostgreSQL, Kubernetes, Helm, Docker-runtime, OpenShell, provider, and model-turn suites were not run. The canonical checkout has no `node_modules`; no dependencies were installed. The audit did not change deployed systems, call credentialed external provider operations, or run a dependency-CVE scan. It is a scoped source audit with limited local execution, not a claim of complete production enforcement.

### Simplicity Audit

- [x] Identified the implemented request, persistence, and runtime paths and the security/ownership boundaries they must retain.
- [x] Traced authoritative owners for auth decisions, provider bindings, credentials, active revision state, and runtime routing.
- [x] Compared development, production, bootstrap, request handling, and persistence paths.
- [x] Required a concrete consumer or failure mode for each disputed abstraction; did not elevate style preferences.
- [x] Checked routes, storage/queue constraints, and the pinned library's public/server API distinction.
- [x] Distinguished current authored reference from generated API material, historical specs, and uncommitted proposals.
- [x] Proposed targeted correction at the owning boundary rather than new general frameworks.
- [ ] No post-fix diff exists: this was audit-only and no source fixes were authorized or applied.

### Test Audit and dispositions

No repository tests were added, changed, or deleted. The inspected auth-security, provider-ownership, lifecycle, packaging, and real-runtime suites should be **kept** for their distinct boundaries. The report identifies missing regression cases for findings 1–3; it does not propose deleting meaningful existing security coverage.

- [x] Mapped cited tests to actual routes, ownership, lifecycle states, and observable behavior.
- [x] Separated dependency-free execution, transport simulation, source inspection, and infrastructure-backed proof.
- [x] Preserved the distinction between render/fixture checks and actual runtime enforcement.
- [ ] Full infrastructure/application suites could not be executed here; their assertions were inspected where relevant.
- [ ] Missing sign-in throttling and terminal/partial-recovery regressions remain unresolved.
- [ ] No remediation or post-fix regression verification was performed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 17:32 PDT: Audited fetched upstream `5eb9561b3225306ab32d8aec6ba0d4ea0fc8a05c`; recorded prioritized findings, skeptical validation, exact sources, and verification limits. Session `01a05f75-a97e-70c0-bfe4-e14b74e6ba3d`; working checkout HEAD `264d6d2f58cd97504c2b8b58d607d002cd62cc5e`.
