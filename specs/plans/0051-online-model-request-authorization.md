---
rfc: ../rfcs/0023-egress-proxy-credential-lifecycle/index.md
---

# Implementation plan: authorize model credentials per request

- **ID:** TASK-0051
- **Delivery status:** Planned
- **Owner:** Credential Proxy maintainers
- **Related RFC:** [RFC-0023](../rfcs/0023-egress-proxy-credential-lifecycle/index.md).
- **Implementation:** [PR #5231](https://github.com/openclaw/openclaw-enterprise/pull/5231).
- **Source baseline:** `17ab99f557d108b82214a13c39c63577a1c4de48`.

## Outcome and scope

A dedicated Codex Agent can use HTTPS OpenAI Responses and protected native Git
in the same OpenShell Sandbox. Credential Proxy checks current authority before
releasing the model key to the trusted supervisor. The guest receives a placeholder.
Installation configuration selects the eligible provider by source type. Operators
create the source with its name, type, configuration, and Secret references, then
check that it reports `request-time` protection. The Credential Gateway owns
source metadata. The Codex guarantee ends at credential release for the
classified request. Existing strict profiles retain their guarantees.

This optional Codex path can ship independently of the
[1.0 push and native delivery design in #6396](https://github.com/openclaw/openclaw-enterprise/pull/6396).
The [dedicated OpenClaw proposal in #4932](https://github.com/openclaw/openclaw-enterprise/pull/4932)
requires a separate human decision and manual merge.

## Contract and source touchpoints

The [Driver contract](../../docs/reference/drivers/credential-proxy.md#online-model-requests)
owns supported behavior. The [runtime flow](../../docs/flows/credential-source-egress/model-requests.md)
traces its callers, and the [operator guide](../../docs/guides/credential-proxy/model-requests.md)
owns configuration and recovery.

| Owner                                                                                               | Implemented responsibility                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [OCC lifecycle](../../packages/occ/src/index.ts)                                                    | Installation-selected provider, Agent admission, native IAM checks, current revision and source authority, and versioned Secret reads.      |
| [Credential Proxy](../../packages/occ/src/credential-proxy.ts)                                      | Authenticate request correlation, consume one approval, enforce its remaining lifetime, and release only currently authorized material.     |
| [Approval persistence](../../packages/occ/src/state/request-credential-approvals.ts)                | Durable one-use correlation, bounded capacity, database-relative lease and replay retention. Online policy transactions use READ COMMITTED. |
| [OpenShell policy](../../apps/controller/src/drivers/sandbox/openshell-model-request-policy.ts)     | Exact Responses route, zero-cache token grant, mandatory middleware, provider binding and observed-policy validation.                       |
| [OpenShell transport](../../apps/controller/src/drivers/egress-proxy/openshell-exchange-binding.ts) | Bind authenticated middleware and HTTPS token redemption to the configured authority lifecycle.                                             |
| [Worker](../../apps/controller/src/worker.ts)                                                       | Integrate the combined model/Git admission with existing preparation, activation and withdrawal.                                            |
| [Helm](../../deploy/helm/openclaw-enterprise/templates/egress-authority.yaml)                       | Expose the authority and token listeners while preserving protected Git configuration.                                                      |

Model-only admission uses version 8; combined model and Git admission uses
version 9. A supervisor JWT-SVID and Gateway-signed middleware identity must
refer to the same admitted Sandbox. The final policy check and Secret read
exclude stale material from an OCC-managed rotation before release. An already
released request may finish. An outstanding approval alone cannot authorize a
later release after withdrawal.

## Implementation and delivery

1. **Retain the implemented contract.** Source creation uses the Installation's
   eligible provider. Agent deployment admits the source's recorded profile.
   Fail closed on unsupported IAM, mixed strict and online model routes, missing
   mandatory policy, or unverified recipient identity. Preserve the already applied
   approval migration's SQL and the published migration prefix during main integration.
2. **Finish installed qualification.** Use actual OpenShell supervision, native
   Codex HTTPS/SSE and native Git, with independently constructed API and Worker
   owners sharing PostgreSQL. Register the combined scenario through the owning
   OpenShell QA lane. Use controlled HTTPS origins and record exact process and
   image identities. A CA-only image derivative must be identified as a
   derivative, with unchanged executables verified separately.
3. **Qualify consequential denial.** Prove current source/IAM denial, replay,
   wrong recipient, rotation and authority failure before fresh credential or
   origin effects. Model IAM revocation must leave authorized Git usable. Remove
   Git's standing approval through its supported API; verify Git denial and
   record whole-runtime retirement when the existing lifecycle requires it.
   This profile adds no independent Git IAM grant or live policy reduction.
4. **Prepare the release.** Include the database-relative lease cap, finish the
   documentation, and commit the installed scenario and QA selection. Review the
   final main integration, run applicable CI, and record installed results.
5. **Verify the released deployment.** Build the merged controller, use the
   supported upgrade procedure, and repeat model/Git acceptance on the intended
   installation. A worker restart may require a fresh Agent deployment for
   protected Git; preserve the operator guide's interruption and recovery
   instructions. Keep credential values and installation-specific receipts
   outside the repository.

## Verification

| Required outcome                                    | Real check and prerequisites                                                                                                                      | Result or remaining proof                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Current policy and material govern release          | [PostgreSQL withdrawal cases](../../tests/integration/credential-proxy-withdrawal.test.ts), native IAM and versioned Secret reads                 | Local candidate passed all three online-request cases.                              |
| Authenticated middleware and one-use redemption     | [Transport integration](../../tests/integration/credential-proxy-request-transport.test.ts), TLS, signed identities and PostgreSQL                | Earlier source passed; not an installed supervisor claim.                           |
| Clock disagreement cannot extend an unused approval | Withdrawal case with a fast issuer and database-aligned redemption, including an actual expiry wait                                               | Local candidate passed the real expiry and returned-lease checks.                   |
| Strict behavior and Helm coexistence                | [Static egress](../../tests/integration/static-egress.test.mjs) and [packaging](../../tests/integration/production-kubernetes-packaging.test.mjs) | Check the final composition; renders do not establish network enforcement.          |
| Production listener startup                         | [Production image startup](../../tests/integration/production-image-startup.test.mjs)                                                             | Prior native amd64 image passed; release artifact needs exact-source qualification. |
| Same-Sandbox inference, Git and denials             | Installed OpenShell test with real supervisor identity and controlled origins                                                                     | Pending registration and execution.                                                 |
| Supported operator cutover                          | Released artifacts, current public JWT bundle, trusted token endpoint, supervisor-only identity and enforced networking                           | Pending final deployment acceptance.                                                |

## Open decisions and prerequisites

Installed qualification requires a reachable TLS token endpoint, a current
SPIFFE JWT trust bundle and a supervisor-only Workload API socket. Record who
refreshes the public trust bundle. Verify the guest cannot obtain or redeem the
supervisor identity, later middleware cannot broaden the approved request, and
no alternate network route bypasses the mandatory authorizer.

## Delivery record

The baseline integrates current main with the implemented request profile and
reviewed clock correction. The local candidate passed the three online-request PostgreSQL cases;
the combined installed proof, final composition review, hosted checks and
release acceptance remain open. Update this record only from completed checks.

## Manual Notes

## Changelog

- 2026-11-10: Recorded implemented source boundaries and remaining delivery gates
  from `17ab99f557d108b82214a13c39c63577a1c4de48`.
- 2026-11-19: Aligned scope with the Installation-selected provider in `abc218e67`
  and the 1.0 delivery design on `d3749595b`.
