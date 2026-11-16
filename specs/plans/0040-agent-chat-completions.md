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
| AC-1 intake | Normal provisioning through Fastify/PostgreSQL/IAM; human and service JSON/SSE; harmless tool action; OCC outside Kubernetes | Not run |
| AC-2 authority | Denied credentials/grants/routing inputs cause no turn; direct Gateway and other private-route paths fail closed | Not run |
| AC-3 conversations | Fresh defaults, same-principal continuation, cross-principal/Agent separation, service-key rotation | Not run |
| AC-4 failures | Live revocation/revision/stop/disconnect/deadline/body-size cases; ordered statuses with no forwarding or retries | Not run |
| AC-5 deployment | Each supported Harness mode, default/explicit auth, opt-out, isolation and content-free audit outcomes; Docker/SSH unsupported | Not run |
| Static and generated contracts | Build/typecheck, lint, format, workspace, OpenAPI generation/check, CI selection audit, docs/link/length checks | Passed on the working candidate; rerun after final changes |
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
- The focused admission and Kubernetes conformance run passed 415 tests with
  no failures or skips. This does not prove real runtime behavior.
- Shared autoreview passed isolation preflight but failed reviewer authentication
  on pass 1 and produced no report. Independent implementation review is blocked.
- Native runtime assembly uses the recorded source pin. The first build compiled
  Node, then failed a dependency TLS check. Its retry uses the existing host CA
  through the supported build-secret mount and retains the compiled cache.
- No runtime acceptance criterion is complete.

## Manual Notes

## Changelog

- 2026-11-16: Created the implementation plan after RFC submission.
