---
rfc: ../rfcs/0021-driver-configuration-contributions.md
---

# Implementation plan: Driver configuration contributions

- **ID:** TASK-0046
- **Delivery status:** Planned
- **Owner:** Driver contracts, OCC admission, and console maintainers
- **Authority:** [RFC-0021](../rfcs/0021-driver-configuration-contributions.md)
- **Source baseline:** `c655fd7f4ecb4bb9a1f67566e105ba84f04da892`; [PR #2599](https://github.com/openclaw/openclaw-enterprise/pull/2599) at `bc3ba215dd9927692bc2882ffaf06a35c27fed4a`

## Outcome and scope

Deliver RFC-0021 through both Installation startup and the regular Agent policy
workflow. The [RFC owns the interfaces, ownership, and failure semantics](../rfcs/0021-driver-configuration-contributions.md#proposal);
this plan owns implementation and proof. The RFC remains Proposed and this work
remains Planned.

PR #2599 is an open dependency; its TASK-0045 and branch remain independently owned.
Shared contract work can proceed independently, but Agent integration must use its
final reviewed baseline. No implementation in another author's branch is authorized
by this plan. Recheck task numbering before merging.

## Contract and source touchpoints

Implement the [shared definition](../rfcs/0021-driver-configuration-contributions.md#shared-definition-and-result),
[registration](../rfcs/0021-driver-configuration-contributions.md#registration-and-construction),
[policy admission](../rfcs/0021-driver-configuration-contributions.md#sandbox-policy-contribution-and-admission),
[wire contracts](../rfcs/0021-driver-configuration-contributions.md#occ-wire-contracts-and-routes),
and [console behavior](../rfcs/0021-driver-configuration-contributions.md#console-behavior)
as one connected capability. Current architecture and feature references remain
authoritative for implemented behavior until delivery updates them.

## Implementation

1. Add shared types and structural conversion in contracts; adapt definitions and
   registration in `apps/controller/src/composition/`. Preserve inferred concrete
   types and update existing direct validation callers.
2. On #2599's reviewed baseline, update `packages/contracts/src/sandbox-policy.ts`,
   the Sandbox contract, its OpenShell implementation, and OCC admission. Preserve
   current policy persistence and worker lifecycle; change result consumption only.
3. Add descriptor projection and validation routes in controller HTTP handlers and
   `packages/contracts/src/api/`; update shared errors, OpenAPI, and the Go client
   where its decoding needs the new fields. No database entities are added.
4. Add shared schema rendering to the existing console modules and wire both real
   callers. Update `scripts/console-storybook/` stories and workflow instructions.
5. Update [Driver development](../../docs/contributing/driver-development.md),
   [selection](../../docs/reference/drivers/selection.md), Sandbox reference, and
   [package-loading flow](../../docs/flows/driver-plugin-loading.md). Update #2599's
   policy guide/flow after landing. Register new documentation only if needed;
   refresh API and permission cheat sheets. Database/environment inventories do not
   change. Current references must not claim this proposal is already implemented.

## Verification

All implementation proof below remains **not run**. New functionality requires
integration through actual callers; unit or Storybook fixtures alone are insufficient.

| Required outcome                                | Required proof                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed startup data and fail-closed construction | Extend `tests/integration/driver-plugin-installation.test.mjs` and startup coverage: real package loading, bundled validation, several nested issues, semantic refusal, malformed results, and no construction after refusal. Typecheck concrete factory inputs.                       |
| Authorized inspection and validation            | Actual Fastify routes with selected implementations: descriptor projection, unknown-key/range errors, escaped/numeric paths, denied reads/writes, safe diagnostics, and no policy/job writes during preview.                                                                           |
| Admission remains current                       | Extend #2599's PostgreSQL policy integration: validate, change version/ceiling/permissions, attempt save/apply, and prove refusal without mutation. Prove permitted save and revision snapshot retain the admitted values.                                                             |
| Real Agent policy application                   | Extend `tests/integration/qa-matrix-real.test.mjs` using the reviewed OpenShell runtime: denial → edit/validate/save → apply → allowed connection → revoke → denial; a second Agent remains denied. Register the scenario in `tests/helpers/qa-selection.mjs` and owning CI manifests. |
| Reviewable console behavior                     | Browser walkthrough and rebuilt Storybook: empty, unsupported, loading, invalid, denied, conflict, saved, and apply-failed states; capture screenshots and a short interaction video, including late-validation handling.                                                              |

Use the documented disposable Kubernetes/PostgreSQL setup, pinned runtime images,
and existing authorized credentials. Missing prerequisites leave runtime proof
incomplete; never substitute a fake runtime. Keep UI evidence outside the checkout
and attach final media to the implementation PR. Clearly label simulated Storybook
proof separately from persistence and runtime proof.

For implementation, run applicable lint/typecheck, workspace, formatting, OpenAPI,
documentation, and selected integration checks under the repository testing skills.
For this document-only change, run documentation links/metadata, length, and scoped
formatting checks; do not run product tests.

## Delivery record

Specification only; implementation has not started. Agent integration depends on
#2599's final contract. Completion requires both startup and Agent callers, the
proof above, and updated current documentation. RFC-0021 owns the proposed contract; this plan tracks its implementation and proof.

The initial plan passed documentation and formatting checks. RFC publication reruns
the applicable document checks; no product tests run for this prose-only change.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16 09:53: Created the planned Driver configuration contract and #2599 integration specification. (`91ac04d6919860b7d7386444468a3dc0ddc90481`; session `01a14590-9cfc-7fa2-baf3-5840870223bc`)

- 2026-10-16: Linked RFC-0021 and moved its proposed contract to the decision document; retained TASK-0046 for delivery.
