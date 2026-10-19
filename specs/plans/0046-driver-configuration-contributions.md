---
rfc: ../rfcs/0022-driver-configuration-contributions.md
---

# Implementation plan: Shared Driver configuration definitions

- **ID:** TASK-0046
- **Delivery status:** Planned
- **Owner:** Driver contracts, OCC admission, and console maintainers
- **Authority:** [RFC-0022](../rfcs/0022-driver-configuration-contributions.md)
- **Source baseline:** [PR #2599](https://github.com/openclaw/openclaw-enterprise/pull/2599), merged at `141515257737cccdb75137fabbeec707915856af` on 2026-10-19

## Outcome and ordered work

Deliver the [shared definition and two callers](../rfcs/0022-driver-configuration-contributions.md#decision-and-scope):
Installation startup and Agent network-policy editing. Existing owners retain
values and lifecycle. The RFC owns contracts and failure semantics; this plan
owns implementation and proof. No implementation has started.

1. Extend contracts with `ConfigurationDefinition<T>`, typed results, and the shared
   validation error. Extend existing `ErrorDetail` with safe messages and needed
   semantic codes. Use installed TypeBox validation and inferred concrete types.
   Update bundled/package definitions, factories, and API/worker composition in
   `apps/controller/src/composition/` together; construction consumes validated data.
2. Add the explicit Sandbox policy definition around
   `packages/contracts/src/sandbox-policy.ts`. Integrate OpenShell and OCC
   admission with the existing policy lifecycle. Preserve snapshot-returning
   admission and provider failure handling; do not add a registry or persistence.
3. Extend Installation discovery and policy GET, and add contextual preview beside
   `apps/controller/src/http/sandbox-policy.ts` facet routes. Update owning API
   schemas, generated OpenAPI, and affected Go decoding. Use the same save envelope,
   current admission checks, and shared `error.details` throughout.
4. Add shared schema rendering to the console's Installation inspection and Agent
   policy editor. Preserve its existing controls and draft guards. Update matching
   `scripts/console-storybook/` stories and workflow instructions.
5. Update [Driver development](../../docs/contributing/driver-development.md),
   [selection](../../docs/reference/drivers/selection.md),
   [Sandbox policy reference](../../docs/reference/sandbox-policies.md), its
   [guide](../../docs/guides/topics/agent-sandbox-policy.md) and
   [flow](../../docs/flows/agent-sandbox-policy.md), and the
   [package-loading flow](../../docs/flows/driver-plugin-loading.md). Regenerate API
   docs and check affected permission cheat sheets. Database and environment
   inventories remain unchanged. Keep current references honest until delivery.

## Required outcome proofs

All implementation proof remains **not run**. Extend existing real callers:

- `tests/integration/driver-plugin-installation.test.mjs` and startup coverage:
  package and bundled definitions, multiple nested structural errors, semantic
  refusals, malformed results, and throws; invalid input never constructs a Driver.
  Typecheck concrete factory inputs.
- Actual Fastify routes and PostgreSQL policy integration: authorized schema reads,
  exact denied operations, escaped/root/array error pointers, safe diagnostics,
  and no policy/job writes during preview. Change versions, permissions, or ceilings
  after preview and prove save/apply refusal without mutation. Permitted saves and
  revision snapshots retain admitted values.
- `tests/integration/qa-matrix-real.test.mjs`: OpenShell denial → edit/validate/save →
  apply → allowed connection → revoke → denial; a second Agent remains denied.
  Register coverage in `tests/helpers/qa-selection.mjs` and owning CI manifests.
- Browser walkthrough and rebuilt Storybook: empty, unsupported, loading, invalid,
  denied, conflict, saved, and apply-failed states, with draft retention and stale
  response rejection. Capture screenshots and a short interaction video.

Use documented disposable PostgreSQL/Kubernetes infrastructure, pinned runtime
images, and existing authorized credentials. Missing prerequisites leave required
proof incomplete; do not substitute a fake runtime. Keep media outside the checkout
and attach it to the implementation PR; label simulated UI proof separately.

Run applicable lint/typecheck, workspace, formatting, OpenAPI, documentation, and
selected integration checks under the repository testing skills. This document-only
revision uses documentation links/metadata, length, and scoped formatting checks;
no product tests. Completion requires both callers, required proof, and updated
current documentation, recorded here with the implementation revision.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16 09:53: Created the planned Driver configuration contract and #2599 integration specification. (`91ac04d6919860b7d7386444468a3dc0ddc90481`; session `01a14590-9cfc-7fa2-baf3-5840870223bc`)

- 2026-10-16: Linked RFC-0021 and moved its proposed contract to the decision document; retained TASK-0046 for delivery.

- 2026-10-19: Simplified delivery around RFC-0022 and merged #2599; retained TASK-0046 and its required real workflow proof.
