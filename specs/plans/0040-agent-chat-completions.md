---
rfc: ../rfcs/0040-agent-chat-completions.md
---

# Implementation plan: Agent HTTP chat completions

- **ID:** RFC-0040
- **Delivery status:** In progress
- **Owner:** kevinlin-openai
- **Authority:** [RFC-0040](../rfcs/0040-agent-chat-completions.md), submitted in [PR #6336](https://github.com/openclaw/openclaw-enterprise/pull/6336). The decision remains Proposed.
- **Source baseline:** `f2359730fa6e3762944dd3f64a539db5cc273769`

## Outcome and scope

Human sessions and service API keys can submit Agent turns with exact-Agent
`operate` through `POST /agents/:agentId/chat`. Implement the complete
[RFC contract and acceptance criteria](../rfcs/0040-agent-chat-completions.md#acceptance-criteria)
for supported Kubernetes Compute modes. Preserve browser access behavior and
Docker/SSH defaults. No console changes, persistence entities, or automatic
retries are included.

## Contract and source touchpoints

- [Compute contract](../../packages/contracts/src/drivers/compute/index.ts): optional endpoint resolution with explicit capability results and curated top-level exports.
- [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts): configuration normalization, runtime qualification, exact private completion route, identity/scope injection, lifecycle and networking.
- [Controller](../../packages/occ/src/index.ts): stored Agent ownership, exact authorization, ordered selection and revision pinning. Core code consumes the Compute contract.
- [HTTP composition](../../apps/controller/src/index.ts) and [HTTP handlers](../../apps/controller/src/http/): existing admission, session/CSRF checks, service credentials, audit sink and response handling. A dedicated Agent chat handler owns relay deadlines, cancellation and backpressure.
- [API contracts](../../packages/contracts/src/api/) and [API generator](../../scripts/generate-occ-openapi.ts): route schema, supported responses and generated references.
- [QA matrix](../../tests/integration/qa-matrix-real.test.mjs) and [selection](../../tests/helpers/qa-selection.mjs): supported provisioning and real turn callers. Extend these owners and register the scenario in CI.

## Implementation

1. Qualify the exact [runtime pin](../../deploy/runtime/openclaw-source.json),
   `513c12703ad9a9161cc123e0b8ed4ecb811aa6b3`. Inspect HTTP authorization,
   native Agent selection, session scheduling and tool execution. Prove narrow
   HTTP authority with the real runtime. If it requires an upstream change,
   stop dependent implementation and report that prerequisite; do not substitute
   a broader scope or change an unassigned upstream branch.
2. Extend Compute and Kubernetes configuration together. Preserve explicit
   opt-out, reject incompatible auth, require trusted identity and scope
   headers, and expose only the exact completion POST. Keep unsupported,
   disabled and unavailable results distinct and ordered. Use the existing
   Kubernetes route and network owners; do not route through browser launch.
3. Add the OCC operation through normal authentication and IAM. Resolve stored
   ownership, preserve visibility rules, then enforce the RFC's status order.
   Scope continuation by the stable principal and Agent tuple. Reject reserved
   routing input and build upstream headers explicitly.
4. Relay JSON and SSE once with native response bodies, backpressure, request
   limits, connection/body/total deadlines and lifecycle cancellation. Recheck
   credentials, principal, permission and revision every 25 seconds with a
   5-second deadline. Admit only after audit succeeds; record terminal or
   uncertain outcomes without messages, credentials or conversation labels.
5. Update the owning API, Agent and Compute references, operator guide,
   source-backed flow, permissions sheet and QA/CI documentation. Generate API
   output from route schemas. The architecture overview needs no feature
   inventory entry; change it only if an existing architectural claim becomes
   inaccurate.
6. Run the checks below, clean the scoped diff with deslop, and complete
   independent autoreview. Resolve findings and publish evidence on the assigned
   PR. Do not merge.

## Verification

Use run-owned loopback k3d with enforcing NetworkPolicies, dedicated PostgreSQL
roles/database, digest-pinned Gateway and selected Harness images, and existing
authorized model credentials. Keep model credentials only in Agent-owned
Harness workloads. Preserve the default kubeconfig and unrelated resources;
remove only run-owned resources. Follow the [Kubernetes](../../docs/testing/kubernetes.md)
and [database](../../docs/testing/postgresql.md) procedures.

| Required outcome | Real check | Result or remaining proof |
| --- | --- | --- |
| AC-1 intake | Normal provisioning through Fastify/PostgreSQL/IAM; human and service JSON/SSE; harmless tool action; OCC outside Kubernetes | Partial: see the authorized retry record below |
| AC-2 authority | Denied credentials/grants/routing inputs cause no turn; direct Gateway and other private-route paths fail closed | Partial: see the authorized retry record below |
| AC-3 conversations | Fresh defaults, same-principal continuation, cross-principal/Agent separation, service-key rotation | Partial: see the authorized retry record below |
| AC-4 failures | Live revocation/revision/stop/disconnect/deadline/body-size cases; ordered statuses with no forwarding or retries | Partial: see the authorized retry record below |
| AC-5 deployment | Each supported Harness mode, default/explicit auth, opt-out, isolation and content-free audit outcomes; Docker/SSH unsupported | Partial: see the authorized retry record below |
| Static and generated contracts | Build/typecheck, lint, format, workspace, OpenAPI generation/check, CI selection audit, docs/link/length checks | Passed: build, typecheck, lint, format, workspace, OpenAPI, CI registration and documentation checks |
| Independent review | Shared autoreview against the final scoped diff | Blocked: reviewer authentication failed before pass 1 produced a report |

## Delivery record

- RFC submitted at `292afc4c5` in PR #6336 before Driver implementation.
- Initial documentation checks could not run because the fresh checkout lacked
  dependencies and its default Node version did not meet the engine requirement.
  A verified Node 24.22.1 download is available for subsequent checks.
- The downloaded runtime source archive matches its recorded SHA-256. Source
  inspection does not establish live HTTP authority or model execution.
- The API, Compute resolution, revision-specific Kubernetes routes, relay and
  source-backed documentation are implemented in the working candidate.
- The final focused admission and Kubernetes conformance run passed 455 tests
  with no failures or skips. This does not prove real runtime behavior.
- Shared autoreview passed isolation preflight but failed reviewer authentication
  on pass 1 and produced no report. Independent implementation review is blocked.
- Native runtime assembly completed using the recorded pin and supported host CA
  build secret. The scoped public npm approval added only pinned `ts-pattern@5.9.2`
  to the lockfile; frozen installation passed and global registry settings stayed unchanged.
- The real Compose OCC / Kubernetes Compute / OpenClaw QA attempt used commit
  `30dd5bff0a89ef82a2e25199b0fcaddc554caf19`, Node 24.22.1 and k3s 1.36.4.
  PostgreSQL bootstrap and cluster creation ran. Before Agent provisioning, the
  shipped sandbox check failed with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.
  Its Localhost seccomp profile and pinned Codex 0.164.0 verification passed;
  sandbox entry failed. The exact denying host layer remains undetermined.
- Tested runtime digest: `sha256:6082f0b5c6cb3a319ac63d150898655c5b8d9dd23472494519e47e79d745475b`.
  Controller digest: `sha256:a3c54d993edcae0243207b02963b452f0acd96d0f5eeaf9ee0e4508d067e4d72`.
  The model-call count is zero. The QA runner reported 9 failed test nodes caused
  by setup failure and blocked dependent cases, with zero passes and zero skips.
- The launcher rolled back its owned cluster and database. A compatible host or
  an operator-reviewed sandbox policy fix is required to continue real QA; see
  [sandbox diagnostics](../../docs/guides/deploy/codex-sandbox.md#identify-the-restriction).
- A subsequent Fastify/native-IAM regression reproduced missing audit evidence
  for a concealed cross-Namespace service-key denial. The fix preserves 404 and
  records the exact authorization denial; all four admission tests pass.
- Cleanup removed both run-owned clusters, the failed QA database/network and
  the temporary credential copy. The default kubeconfig is unchanged. Local
  images, build caches and diagnostic artifacts remain available for resumption.
- No runtime acceptance criterion is complete.

## Authorized full-access retry

The user authorized `danger-full-access` only for bounded test Agent runtimes.
The development agent retains workspace-write and its approval controls. Host
AppArmor, sysctls and container isolation must remain unchanged. The supplied
host audit identified AppArmor denials for the bundled Bubblewrap path.

The cached runtime at the digest above authenticated with the existing test API
credential. Codex 0.164.0 reported no managed requirements and granted
`:danger-full-access`, `on-request`, and `auto_review`. One genuine model turn
completed one shell tool action; its independently read output matched the
requested harmless marker. A separate credential-free startup probe passed
with container networking disabled. These are smoke results, not HTTP API proof.

The development verification selector and explicit QA Agent configuration keep
startup and runtime modes coherent. Standard presets remain unchanged. The first two native smoke variants (explicit profile and legacy sandbox selector)
each completed one genuine model/tool turn with the same approval controls.

The regular Compose/Kubernetes retry at `9f342c940` reached both Harnesses.
Embedded OpenClaw completed 10 JSON responses, two incremental SSE responses and
two independently verified tool actions, including principal/Agent conversation
separation and service-key rotation. A later stop-during-stream assertion failed;
terminal delivery now rechecks admission. Dedicated Codex returned native HTTP
500 on its first completion. This is not evidence that full-access was refused:
both pinned-runtime selector smokes passed. The pinned plugin source shows that
Standard Codex's named network proxy profile overrides the sandbox selector.
The authorized test configuration now disables that inner profile while preserving
Kubernetes NetworkPolicies and the Agent's approval controls. Bounded redacted native diagnostics
will identify that failure on retry. Internal provider call counts are unobserved;
normal provisioning also runs model probes. The run reported seven passing test
nodes, ten failed nodes (including parent aggregates), and no skips.

Independent review retried with the existing route and CLI 0.171.0-alpha.9.
The helper planned two passes and failed authentication on pass 1 without a report.
At `625a3f77d`, embedded OpenClaw passed the complete selected HTTP scenario:
10 JSON responses, two SSE responses and two verified tool actions. This included
the previously failing stop case, replacement, revocation, read-only denial,
isolation, conversation separation, rotation and opt-out. Dedicated Codex then
completed one human JSON response and tool action. Its native turn trace verified
`danger-full-access` and `on-request`; its following SSE response contained a
native application error. Structured native SSE diagnostics were added for the
next retry. Service-key Codex turns remain unverified.
A second dedicated-Codex run reproduced the native error: “Assistant output cannot
be represented as an append-only response stream.” The pinned native encoder
rejects unrepresentable replacements; OCC passes that failure through. The controlled final-answer-only, single-line request at `9c6ad48d9` reproduced
the same error. The exact producer/normalization cause remains unverified.
The error is emitted by the pinned native
[`openai-compatible-http.ts`](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/openai-compatible-http.ts),
which rejects replacements of already-streamed text. No native error was hidden,
no buffered JSON was presented as successful SSE, and no upstream code or image
pin was changed. Codex SSE needs a qualified native-runtime fix/configuration
before the remaining dependent proof can pass.

The latest dedicated run reported four passing test nodes, six failures including
parent aggregates, and zero skips. It completed one human JSON response and one
verified tool action; successful SSE responses were zero. Native turn evidence
again showed `danger-full-access` and `on-request`. This does not establish that
every Codex SSE request is unsupported, only that qualification failed for both
selected request forms on this pin.

The HTTP acceptance matrix remains incomplete. Kubernetes-hosted OCC, the three
fixture cases, full connect/total-deadline coverage, independent upstream-failure
coverage, and complete persisted audit qualification remain unverified. The
reviewer authentication route also remains unavailable; no independent report
covers these implementation commits.

## Retry handoff

- Last combined real run: `625a3f77d413e25e4be0aad5e0e67898f0c2def0`,
  Compose OCC, PostgreSQL/IAM, loopback k3d 1.36.4 and both Harness presets.
  OpenClaw passed its selected scenario; the complete run reported 11 passes,
  six failures including parent aggregates, and zero skips because Codex SSE failed.
- Latest controlled Codex run: `9c6ad48d9285f95201964d1b3371f583cadc4cb6`. Four test nodes passed,
  six failed including parent aggregates, and zero skipped. Human JSON/tool
  execution and native full-access/on-request policy passed. SSE returned the
  native append-only error; later dependent cases remain unverified.
- Controller image: `sha256:c3b7cc5bfaebb849b91798b23e51575a07f62429b2c92777f7aa2ccc103c87e8`.
  The native image digest above remains unchanged. Internal provider request
  counts are unobserved; report HTTP completion counts and startup/smoke proof separately.
- Final local build/type, lint, format, workspace, OpenAPI, documentation, flow
  and Go formatting/vet checks passed. The four admission and two advisory tests
  passed; the earlier 455-test conformance result remains scoped to its candidate.
- CI on the merged candidate exposed stale admission/configuration and QA-matrix
  expectations. Updated fixtures and deduplicated shared QA credential requirements.
  Affected local coverage passed 245 non-database tests, four pinned-image tests
  and the real PostgreSQL persistence test, with no skips. The database used a
  migrated limited application role and its disposable container was removed.
- All seven recorded QA environments have no remaining containers, volumes or
  networks. Run-owned private state and the temporary model credential copy were
  removed. Default kubeconfig and unrelated resources are unchanged; images,
  caches and non-credential evidence remain available.
- Completion needs a qualified native streaming fix/configuration and working
  reviewer authentication. No upstream source, global auth/security setting,
  default Preset, merge or force push was changed to bypass either blocker.

## Simplification pass

Review of `8d3f95dd5` accepted M1–M5. Source commit
`1279bde62f5765b040b35efb9beeffd08d6f1e15` removes the synthetic full-access
startup probe, uses the Controller's denial resource, shares one in-flight
admission check and relay cleanup owner, stabilizes generated resource order,
and trusts renderer-normalized auth fields. Scope-header and legacy-admission
checks remain. All 24 changed test files and their distinct outcomes remain.
Earlier container-probe receipts above are historical; startup now reports
workspace-write proof not applicable/not performed for explicit full-access.

Diff sizes use base `f2359730f`; authored counts exclude the three generated API files.

| Scope | Reviewed head | Initial M1–M5 pass |
| --- | --- | --- |
| Total additions/deletions | +8,269/−4,842 | +3,464/−112 |
| Authored additions/deletions | +3,045/−107 | +2,970/−110 |
| Generated API reference | +4,835/−4,735 | +105/−2 |

Key source sizes in lines: container probe 75 → 0; seccomp library 1,428 → 1,361;
preparation entrypoint 88 → 83; relay 327 → 324; Fastify owner 5,431 → 5,424;
Kubernetes Driver 17,987 → 17,981; API generator 766 → 795. The generator adds
stable section ordering while removing movement of existing reference sections.

Affected Fastify/IAM, Kubernetes and default seccomp/startup coverage passed
612 test nodes with zero skips. The Go startup package, build/type, lint,
format, workspace, OpenAPI, documentation and flow checks passed. Independent
re-review of this delta is pending.

The real OpenClaw-only HTTP/lifecycle retry uses Compose OCC, PostgreSQL/IAM,
owned loopback k3d and the unchanged native runtime. Its controller is
`sha256:a7cf2dcdd53a7fd9e31096f8087540766ecb4cbabfe2e85117b32ae32a446577`.
The HTTP scenario passed 29 requests: ten JSON completions, two SSE completions
and two independently verified tool actions. It retained human/service admission,
conversation isolation and rotation, revocation/replacement/stop interruptions
and opt-out. Provider-call counts remain unobserved. Workspace-write startup
proof was not performed; no startup containment claim is made. The selected run
passed ten test nodes, with zero failures or skips. Cleanup verified no owned
containers, volumes or networks; private state and temporary model input are
removed. Default kubeconfig and unrelated resources are unchanged. Known Codex
SSE failure and canonical reviewer authentication were not retried or bypassed.

### Fresh terminal-check correction

At `93bfd4c8786f2a6e284d38a1171dcac11f25f1a9`, terminal delivery first awaits
any periodic check and its `finally` cleanup, then starts a fresh check after
the native body completes. One in-flight owner prevents overlapping admission
mutation; timers, terminal withholding and audit outcomes remain unchanged.
The earlier `1279bde62` live run does not validate this corrected gate.

Focused HTTP/API validation first passed 131 test nodes; one CLI fixture failed
because its Go cache was not selected. With the existing task cache, its targeted
retry passed all three nodes with no skips. Build/type, lint, format, workspace
and documentation checks passed. Unchanged Go and Kubernetes suites and the
612-test batch were not repeated.

The corrected OpenClaw-only real run uses controller
`sha256:b5dceea603114e241cdf7c40ca3433046f6da0fe509cf930bdc32ee6792287b1`
and the unchanged native image. Its first run reported four passing nodes, six
failed nodes including parents, and zero skips. It completed 27 HTTP requests,
ten JSON responses, two SSE responses and two verified tool actions. Revocation,
replacement and stop interruptions passed; the following deployment model probe
returned `rate_limit`, so final opt-out checks were not reached. Its owned
cluster/database and private state were cleaned. One identical bounded retry
passed ten nodes with zero failures or skips: 29 HTTP requests, ten JSON
completions, two SSE completions and two verified tool actions, including final
opt-out checks. Provider-call counts are unobserved. Both attempts have no
remaining owned containers, volumes or networks; private state and temporary
model input are removed. Default kubeconfig and unrelated resources are preserved.
Final cumulative diff against `f2359730f`: +3,499/−112; authored: +3,005/−110.
Generated API reference remains +105/−2; the corrected relay is 327 lines.

## Manual Notes

## Changelog

- 2026-11-16: Created the implementation plan after RFC submission.
