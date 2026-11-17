---
rfc: ../rfcs/0020-anonymous-public-github-reads.md
---

# Public Git alongside protected Git implementation plan

- **ID:** TASK-0051
- **Delivery status:** In progress
- **Owner:** russellb
- **Source baseline:** `bdb4e1aad80d6f417b9e0b19f563d9c747e74caf`
- **Integrated upstream:** `44c2f77b6`, merged without rewriting in `c00065ccee26b4132d062c6ab8712b7a6e11d304`

> Execute tasks with the subagent-driven-development workflow. Each task uses failing integration checks before implementation, followed by independent review.

**Goal:** Dedicated Codex Agents clone and fetch public GitHub repositories with ordinary URLs while retaining protected repository access, with server-enforced Installation and Agent scopes.

**Architecture:** Compute contributes a generic service-access descriptor before Sandbox normalization. Sandbox freezes and acknowledges it; the paired Credential Proxy independently validates it. The reader authenticates revision capabilities and forwards only anonymous read requests to GitHub.

**Tech stack:** TypeScript, Node.js HTTPS and streams, Kubernetes, OpenShell, Podman and k3d.

**Spec:** [RFC-0020 extension](../rfcs/0020-anonymous-public-github-reads.md#proposed-extension-public-git-alongside-protected-git). Preserve the original [ordinary-reader plan](0020-anonymous-public-github-reads.md).

## Global constraints

- No GitHub App installation is required for public reads. Ordinary GitHub HTTPS URLs and stored remotes stay unchanged.
- Default access is none. Effective access is the intersection of the current Installation ceiling and the frozen Agent selection.
- Public reads support smart HTTP discovery and upload-pack; receive-pack, SSH, LFS, redirects and arbitrary proxy destinations are refused.
- Git limits: 4 MiB encoded request body, 1 GiB response, 10-minute transfer deadline; keep existing API limits.
- No implementation-specific branches in OCC. Driver contracts own service contributions and admission.
- Protect internal service capabilities with verified TLS; never forward them or caller credentials to GitHub.
- Preserve the protected workload-to-supervisor fence, existing repository grants and artifact rules.
- Run only owned disposable resources. Never install or run TruffleHog or `npm run precommit`.

## Review focus

- Canonical repository identity, including case and `.git`, must agree across scopes and transport dispatch (Tasks 1–3).
- A second Agent must not borrow a broader authorization by changing headers or calling the reader directly (Tasks 1 and 4).
- Revocation and reader/controller restart must not restore a withdrawn capability (Tasks 1 and 3).
- Shared provider reads must authenticate each caller before sharing data (Task 1).
- Git cancellation or a partial pack must fail instead of reporting success or releasing a still-running provider slot (Tasks 1 and 4).

## Task 1: Authenticated reader and streaming Git

**Files:** `apps/controller/src/drivers/repo/github/public-read/access.ts`, `server.ts`, `git.ts`; `tests/integration/public-github-read-http.test.mjs`, `public-github-git-read.test.mjs`.

**Interfaces:** Export `PublicGithubReadPolicy` as `{mode:"all"}` or `{mode:"repositories",repositories:readonly string[]}`; `canonicalPublicGithubRepository(value:string):string|undefined`; `publicGithubReadPolicy(value:unknown):PublicGithubReadPolicy`; and `publicGithubReadAllowed(policy,repository):boolean`. Export `PublicGithubReadAuthorization` with `installationId`, `namespaceId`, `agentId`, `revisionId`, `tokenSha256`, `policy`, and ISO `validUntil`. Reader options include a current ceiling and an authorization loader; missing configuration denies all repository requests. Production startup requires TLS certificate/key and reads policy and authorization files from mounted configuration.

- [x] Write HTTP checks for missing/forged capability, policy intersection, two Agents, API bypass, withdrawal, expired/unreadable registry, and credential absence. Observe failure on current code.
- [x] Implement reader authentication before API deduplication and provider I/O. A Bearer capability is `revisionId.random-32-byte-base64url`; compare its SHA-256 with the stored verifier. Identity and policy come from the registry, never request headers.
- [x] Add strict `/git/OWNER/REPOSITORY.git/info/refs?service=git-upload-pack` and `/git/OWNER/REPOSITORY.git/git-upload-pack` routes to fixed `https://github.com`; use streaming backpressure and the RFC limits. Reject writes, malformed paths, bodies and redirects before forwarding credentials.
- [x] Extend real Git HTTP fixtures using `git http-backend` behind verified TLS. Clone and incremental fetch must transfer real objects; denied operations must not reach the provider.
- [x] Run `node --test tests/integration/public-github-read-http.test.mjs tests/integration/public-github-git-read.test.mjs`; expect no failures. Commit with sign-off.

## Task 2: Generic admission and paired OpenShell enforcement

**Files:** `packages/contracts/src/sandbox-policy.ts`, `drivers/compute/index.ts`, `drivers/sandbox/index.ts`, top-level exports; `packages/occ/src/index.ts`; OpenShell Sandbox and Credential Proxy policy modules; relevant conformance/integration tests.

**Interfaces:** Add `ComputeServiceAccess {id,driverId,implementation,endpoint,configuration}` with a nonsecret opaque configuration document. Add optional `ComputeDriver.admitServiceAccess({installationId,configuration,harness})` returning descriptors. Persist them as optional `SandboxPolicySnapshot.serviceAccess`. Add optional `SandboxDriver.admitProtectedNetworkPolicy(version,serviceAccess)` returning `{purpose:"protected-network",declaredRuleNames,snapshot}`. Keep the artifact-only method for revisions without service contributions. OCC validates exact acknowledgement and descriptor identity without vendor interpretation.

- [x] Add failing normal Agent deployment admission tests: source settings survive Sandbox normalization, exact acknowledgement persists, unsupported or changed contributions fail closed, old revisions gain no service.
- [x] Invoke the Compute producer before `agentRuntimeConfiguration`. Feed descriptors through generic network-policy admission for ordinary and protected dedicated Codex repository execution. Keep existing protected Agent additions refusal.
- [x] Implement OpenShell rule compilation for only `id:"public-github-read"`, HTTPS endpoint and its frozen scope/peer. Inspect GET and upload-pack POST only. Independently validate the same descriptor in the Credential Proxy before release; do not qualify it as an artifact.
- [x] Extend provider runtime-file projection to bounded public-reader skill, transport source/config, trust and separate private capability material through the existing Compute-to-Sandbox requirements. Preserve model and repository paths, including token retirement.
- [x] Run owning conformance and integration checks; expect all selected cases to pass. Commit with sign-off.

## Task 3: Managed Git transport and Kubernetes lifecycle

**Files:** `public-read/transport.mjs`, `codex.ts`; Compute `plugin-runtime.ts`, Kubernetes modules and plugin runtime launcher; chart values/templates and profile renderer/tests.

**Interfaces:** The managed helper consumes a read-only JSON configuration containing reader `endpoint`, `caPath`, a private `capabilityPath` or the dedicated capability environment name, and canonical `authenticatedRepositories`. The launcher consumes separate nonsecret endpoint/CA/routing material. Its launcher sets a private `GIT_EXEC_PATH` while preserving discovery of the image's original helpers. It delegates bound repositories unchanged and rewrites eligible unbound GitHub reads only inside the child HTTP transport. It never saves reader URLs in repository configuration.

Compute descriptor configuration carries `policy`, `peer:{namespace,podLabels}`, `installationId`, `authorizationConfigMapName`, and public `caBundle`. OCC supplies the runtime-owned ID at admission; it is absent from Compute startup configuration. Profile/Helm input uses the actual ID only for registry ownership. The existing recursive startup ID rejection remains unchanged. The reader endpoint is verified HTTPS. Agent selection is `plugins.entries.codex.config.publicGithubRead` with the policy shape from Task 1; omission/empty list means no selection. Native network denies remain narrowing constraints.

Compute creates one owned revision Secret with a random capability, and publishes only its verifier, identities, scope and lease in a dedicated reader ConfigMap's `authorizations.json`, using resource-version compare-and-swap. The reader mounts this ConfigMap read-only and has no Kubernetes service-account token. Compute refreshes a 10-minute lease through 30-second maintenance, without redeployment; unchanged capabilities stay stable across restart. Reader health returns global and per-revision authorization digests. Withdrawal expires authorization and attempts the correct owner-provisioned Harness shutdown before waiting for the reader's revision acknowledgement. An unavailable reader or registry cannot prevent that shutdown attempt or report successful withdrawal. The operator initializes the mutable registry outside Helm; chart upgrades never render its contents.

- [x] Write failing transport checks for real clone/fetch, canonical unchanged remotes, bound-repository delegation, credentials stripped on public path, helper discovery, and no fallback on denial.
- [x] Implement the managed helper and launch environment. Refuse conflicting Git helper configuration; preserve inherited credential settings on the authenticated path.
- [x] Implement Compute service contribution, owned capability and registry lifecycle, lease refresh and withdrawal acknowledgement. Extend runtime projection for ordinary and protected Harnesses. Protect secret material from descriptions/logs.
- [x] Add supervisor-only reader egress for protected execution; keep ordinary selected Harness egress. Deliver trust and authorization registry through Helm/profile inputs, with explicit all/list Installation scope and required verified TLS. Approve both GitHub Git and API destination CIDRs.
- [x] Run transport, Compute lifecycle, chart/profile and runtime-file checks. Commit with sign-off.
- [x] Correct the runtime Installation identity handoff and prove full startup-file loading with the reader enabled; startup inputs must not contain the reserved ID field.

## Task 4: Local deployment proof, QA registration and current docs

**Files:** `tests/integration/qa-matrix-real.test.mjs`, `tests/helpers/qa-selection.mjs`, `scripts/ci/test-suites/qa-matrix.json`, `.github/workflows/qa-advisory.yml`; public-reader reference, guide, source-backed flow and CI coverage documentation.

- [ ] Register a regular Agent workflow scenario using the paired OpenShell Sandbox and Credential Proxy: public clone/fetch and protected fork read/write coexist, unauthorized/private reads fail, and a model turn works.
- [ ] Use Podman for the local OCE services and k3d for Kubernetes Compute with OpenShell. Give the run its own state directory, cluster, database and disposable provider repository; preserve existing environments and default kubeconfig. Record real object IDs and scope-denial evidence without credentials.
- [ ] Verify different Agent selections, replacement, controller/reader cold recovery, capability withdrawal, and fork-token rotation/expiry without removing public reads. Run-owned cleanup must complete.
- [ ] Update supported configuration, operator procedure, source-backed flow, QA selection and manifests; distinguish controlled-provider, live anonymous GitHub and stock OpenShell proof.
- [ ] Run workspace, formatting, lint, types, generated API, CLI, relevant conformance/integration and documentation checks. Record exact results and unavailable prerequisites.
- [ ] Obtain independent task and whole-branch review, resolve material findings, push signed-off commits to PR #4505 and update its description. Keep draft if required implementation or runtime proof remains incomplete.

## Delivery record

2026-11-03: User approved implementation and requested Podman + k3d + OpenShell local proof. RFC amendment was submitted on PR #4505 at `647f5828ee175a13f8c9196175503108b91631c2`.

Tasks 1–3 are implemented in `da9c3f7a2`, `cec046516`, `83a172891` and `08eef0277`. Independent canonical Codex reviews found no actionable P0–P2 findings in their supplied scope; the lifecycle review lacked full RFC-0023 context. These reviews do not qualify an installed runtime. The bounded reader file owner retained its security guard: 179 checks pass. Worker expiry recovery passes all 34 teardown tests, including seven expiry variants. After the main merge, full typechecking and 204 admission/compiler/runtime-material checks pass without skips. Controlled Git/TLS transport passes 18 checks; five existing reader quota cases need unavailable macOS loopback aliases. The owned Kubernetes authorization test passes, including restart and permanent withdrawal.

Task 4 remains in progress. CI registration covers controlled Git reads/transport and the real Kubernetes registry lifecycle. The selected Podman + k3d + OpenShell Agent journey is being executed. Stock supervisor trust needs a qualified CA image layer or operator admission injection; no general supervisor mount override exists. Public-only protected composition requires empty artifact defaults. Live protected fork writes, private-provider denial and expiry isolation remain qualification requirements; fixture results do not establish them.

The instrumented local run reproduced a startup refusal before Agent creation: the new Compute reader `installationId` field conflicts with the existing recursive startup-file guard. An offline probe in the selected controller image confirmed it. The correction supplies OCC's runtime identity through generic admission context and removes it from Compute startup inputs. The guard remains intact. Full installed proof is still pending.

PostgreSQL admission and reload now preserve generic Compute service descriptors and exact Sandbox acknowledgement. Real database regression cases cover ordinary and protected selected-reader admission, malformed snapshot refusal, and legacy revisions without service grants. This persistence proof does not qualify an installed Agent.

The native TLS correction seeds selected-process Codex upstream trust while preserving inherited roots, then composes current tool trust for each managed Git/API operation. The managed skill and regular callers share the bounded helper. Controlled TLS tests cover fresh roots and refusal/cleanup boundaries; the [read flow](../../docs/flows/public-github-reads.md) owns the current lifecycle. Exact-source Linux native and installed OpenShell qualification remain pending; source checks do not complete Task 4.

## Manual Notes

## Changelog

- 2026-11-03: Created the implementation plan from the approved RFC amendment and inspected source baseline.
