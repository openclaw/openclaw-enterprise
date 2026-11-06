---
rfc: ../rfcs/0030-agent-harness-overrides.md
---

# Implementation plan: Harness overrides in Agent revisions

- **ID:** RFC-0030
- **Delivery status:** In progress
- **Owner:** kevinlin-openai
- **Authority:** [RFC-0030](../rfcs/0030-agent-harness-overrides.md)
- **Implementation source:** [99f5f7c](https://github.com/openclaw/openclaw-enterprise/commit/99f5f7ce8e4f236479d7a9f1b36199f7fc83fc88)
- **Source baseline:** `37144f62101a9e99b066f1abbbf75ede787d26dd`

## Outcome and scope

Operators can deploy Agents to independently authorized model endpoints in one
Installation. Each revision saves requested overrides and resolved Harness settings.
Recovery uses those settings after Installation defaults change. The RFC defines
replacement semantics, source consent, supported authentication, and network limits.

## Contract and source touchpoints

- `packages/contracts/src/`: generic revision settings and Compute resolution;
  Credential Gateway and Proxy receive the resolved settings through their contracts.
- `packages/occ/src/index.ts`: resolve before credential attachment and egress
  admission, save settings transactionally, and include overrides in intent identity.
- `packages/occ/src/state/`: preserve settings in revision storage and reads.
- `apps/controller/src/drivers/compute/`: Kubernetes owns provider validation,
  translation, fingerprints, and runtime probes.
- `apps/controller/src/drivers/credential-gateway/` and `egress-proxy/`:
  separate source authorization from route selection; recheck consent on delivery.
- HTTP route schemas, Console deployment controls, and `internal/occcli/`:
  accept overrides, preview destinations, and explicitly retain selected overrides.

## Implementation

1. Extend generic contracts and revision persistence. Resolve Harness settings
   before credential admission; reject requests unsupported by the selected Compute.
2. Implement Kubernetes validation and immutable execution settings. Keep unrelated
   providers and ChatGPT authentication on their existing paths.
3. Update Gateway registration and attachment and Proxy admission, dispatch,
   refresh, and withdrawal to preserve per-source consent and per-revision routing.
4. Integrate ordinary and first deployment, intent recovery, automated upgrades,
   Console and CLI. Update Storybook scenarios and inspect rebuilt interactions.
5. Update current provider reference, deployment guides, runtime flows, and
   generated API documentation. Complete validation and independent review.

## Verification

| Outcome                                                                                | Evidence                                                                                                                                            | Result                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Concurrent destinations, inherited defaults, source consent, and first-intent recovery | Regular HTTP Agent workflow with IAM, production Compute resolution and Proxy admission; external runtime observations use controlled wire fixtures | Passed in the 82-case focused integration batch                    |
| Immutable settings after default replacement or removal                                | Real PostgreSQL writes, a fresh State reader, and a new Compute instance                                                                            | 1/1 passed                                                         |
| PostgreSQL State constraints and bootstrap                                             | Shared State contract and native admin/provisioning workflows on a fresh database                                                                   | 13/13 passed, no skips                                             |
| Credential withdrawal                                                                  | PostgreSQL-backed Proxy withdrawal integration                                                                                                      | 2/2 passed                                                         |
| Contract behavior                                                                      | Full conformance run: 3,405 passed; three container cases lacked their pinned image. After provisioning it, their owning file passed 9/9            | No remaining failures or skips in the exercised cases              |
| Upgrade response recovery and retained requests                                        | Upgrade integration in the focused batch; Go CLI tests verify retained requests instead of old resolved defaults                                    | Passed                                                             |
| Console controls and revision details                                                  | Rebuilt Storybook, headless desktop Chromium at 1440×1000; preview, deploy, loading, denial, and retry recovery                                     | Captured and uploaded; simulated UI proof only                     |
| Static and documentation consistency                                                   | Typecheck, lint, formatting, workspace boundary, OpenAPI generation/check, docs checks, flow validators, CI suite audit                             | Passed                                                             |
| Installed two-destination model workflow                                               | Registered `harness-overrides` QA scenario with Kubernetes/OpenShell and supported runtime images                                                   | Input gate failed; live proof unverified                           |
| Independent review                                                                     | Shared autoreview, local candidate from the PR merge base, GPT-6 Astra, P0–P2                                                                       | `reviewer_unavailable`: authentication failure; no report produced |

The conformance container used the repository-pinned Node image and GitHub CLI.
PostgreSQL setup used the migrator role; application tests used the limited role.
The new scenarios were not run against the pre-implementation source. No
before/after regression-test result is claimed.

## Delivery record

Implementation is in [PR #4866](https://github.com/openclaw/openclaw-enterprise/pull/4866).
The RFC remains Proposed: implementation does not establish acceptance or release
readiness. Current behavior is owned by the
[provider reference](../../docs/reference/drivers/kubernetes-compute/model-provider.md).
The implementation includes deployment preview, normalized first-intent identity,
resolved Compute settings, source consent checks, Proxy route revalidation, CLI
and Console controls, and baseline override retention in image upgrades.

[Console screenshots and video](https://gist.github.com/kevinlin-openai/a74a353fbf02fc15918dc00067a90e44)
show `Pages/Agent detail/Harness overrides`, `Harness preview loading`,
`Harness preview denied`, and `Harness preview unavailable`. The uploaded bytes
were checked against the inspected local captures. Storybook does not establish
backend persistence, credential delivery, deployment, or model execution.

Live QA needs two authorized endpoint URLs, private API-key file paths, and a
model authorized at both destinations. Those inputs were requested separately
and remain unavailable. No live model, installed-cluster, endpoint-outage, or
upstream access-log proof is claimed. The integration scenario is registered for
an explicit run when those inputs are available.

Autoreview preparation passed with the installed native Codex CLI. Its first
launch hit the outer filesystem restriction; the same helper on the same host,
with reviewer isolation retained, then failed authentication. The helper reported
`report_produced: false`. The earlier RFC-only GitHub reviews do not review this
implementation. An authenticated independent review and current-head CI remain
required before merge.

Pages between 1,500 and 2,500 words remain together because each owns one complete
Driver contract or runtime workflow. Repeated provider details link to the owning
reference. No documentation length exception was added.

## Manual Notes

## Changelog

- 2026-11-06: Created the implementation plan from `37144f62101a9e99b066f1abbbf75ede787d26dd`.
