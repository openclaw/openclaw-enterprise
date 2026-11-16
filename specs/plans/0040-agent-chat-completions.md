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
| AC-1 intake | Normal provisioning through Fastify/PostgreSQL/IAM; human and service JSON/SSE; harmless tool action; OCC outside Kubernetes | Unverified: real QA stopped during sandbox setup |
| AC-2 authority | Denied credentials/grants/routing inputs cause no turn; direct Gateway and other private-route paths fail closed | Unverified: real QA stopped during sandbox setup |
| AC-3 conversations | Fresh defaults, same-principal continuation, cross-principal/Agent separation, service-key rotation | Unverified: real QA stopped during sandbox setup |
| AC-4 failures | Live revocation/revision/stop/disconnect/deadline/body-size cases; ordered statuses with no forwarding or retries | Unverified: real QA stopped during sandbox setup |
| AC-5 deployment | Each supported Harness mode, default/explicit auth, opt-out, isolation and content-free audit outcomes; Docker/SSH unsupported | Unverified: real QA stopped during sandbox setup |
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
The HTTP acceptance matrix remains incomplete.

## Manual Notes

## Changelog

- 2026-11-16: Created the implementation plan after RFC submission.
