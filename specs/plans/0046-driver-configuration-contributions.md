---
rfc: ../rfcs/0022-driver-configuration-contributions.md
---

# Implementation plan: Discoverable Driver configuration contributions

- **ID:** TASK-0046
- **Delivery status:** In progress
- **Owner:** Driver contracts, OCC admission, and console maintainers
- **Authority:** [RFC-0022](../rfcs/0022-driver-configuration-contributions.md)
- **Source baseline:** [PR #2599](https://github.com/openclaw/openclaw-enterprise/pull/2599), merged at `141515257737cccdb75137fabbeec707915856af` on 2026-10-19

## Outcome and ordered work

Deliver the [shared definition and two callers](../rfcs/0022-driver-configuration-contributions.md#decision-and-scope):
Installation startup and Agent network-policy editing. Existing owners retain
values and lifecycle. The RFC owns contracts and failure semantics; this plan
owns implementation and proof. Implementation resumed after the registry and discovery revision. Shared definitions,
registry dispatch, discovery/preview routes, schema-driven console sections, and
worker rechecks are implemented locally; verification and review remain in progress.

1. Extend contracts with `ConfigurationDefinition<T>`, typed results, and the shared
   validation error. Extend existing `ErrorDetail` with safe messages and needed
   semantic codes. Use installed TypeBox validation and inferred concrete types.
   Update bundled/package definitions, factories, and API/worker composition in
   `apps/controller/src/composition/` together; construction consumes the original structurally validated input. Driver callbacks
   return only semantic error lists; the platform checks structure once per admission,
   isolates callback input, and validates diagnostics without a returned-data envelope.
2. Register startup definitions and named `ConfigurationContribution` entries by
   capability, Driver ID, scope, and key. Add owner bindings and reject unsupported
   or ambiguous registrations. Add the Sandbox policy contribution around
   `packages/contracts/src/sandbox-policy.ts`. Integrate OpenShell and OCC
   admission with the existing policy lifecycle. Preserve snapshot-returning
   admission and provider failure handling. Keep existing persistence and defer
   ceiling configuration integration while preserving its enforcement.
3. Expose the common descriptor through Installation and Agent discovery and
   policy GET. Resolve contributions through the registry and add contextual preview beside
   `apps/controller/src/http/sandbox-policy.ts` facet routes. Update owning API
   schemas, generated OpenAPI, and affected Go decoding. Use the same save envelope,
   current admission checks, and shared `error.details` throughout.
4. Discover configuration sections dynamically in Installation administration and
   the Agent editor. Add shared schema rendering and owner lifecycle adapters;
   derive actions from contextual descriptors without Driver-specific forms.
   Preserve existing controls and draft guards. Update matching
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

Current local proof: startup integration passed 87 tests without skips;
PostgreSQL policy integration passed 3, including reduced-ceiling rechecks;
real HTTP browser workflows passed 4, including conflict reload and draft retention.
Broader selected checks passed 201 Driver cases and 465 Compute/profile/QA cases.
The formerly skipped native initializer and all 12 Helm cases subsequently passed
with prepared prerequisites. Credential-boundary checks passed 93; all four real
Kubernetes fixture cases passed without skips and their resources were removed.
Storybook was rebuilt and inspected, with screenshots and an interaction video
captured outside the repository. These are simulated UI evidence. Native GitHub
media attachments remain unavailable through the current upload tooling.

The focused real OpenShell QA scenario passed on 2026-10-19: one runtime test and
its two-test matrix wrapper, both with zero failures or skips. It used a disposable
enforcing cluster, digest-pinned runtime images, and authorized model execution.
The Agent reached the Installation-default control on port 8082 and was denied
the independently reachable target on port 8083. Discovery/preview/save/apply
permitted that target; a second Agent remained denied; removal restored denial
while preserving default access. Native provider decisions corroborated the
commands. The worker recovered an interrupted write without repeating it, and
both required permission revocations prevented native writes. Revision snapshots
remained immutable. The test's cleanup hooks completed.
Owned disposable clusters and databases and the private test credential copy were
removed after preserving the redacted proof and UI captures outside the checkout.

The broader suite separately hit an external TLS control failure and an unrelated
OAuth refresh interruption; its existing coverage remains intact. The focused
selector excludes those unrelated phases without omitting required policy checks.
The merged `manage_policy`/policy `update` authority is unchanged. Independent
review stopped at authentication and produced no assessment. Native media uploads
and review remain delivery blockers.
Implementation is in [PR #2980](https://github.com/openclaw/openclaw-enterprise/pull/2980).
The runtime proof covers implementation commit `4d57c6eda955a37643cb0d8e9818f09994b29b1f`;
the subsequent delivery-record update changes documentation only. No merge has occurred.
A later Storybook-only fix removes a root-package import from isolated asset
preparation. Its build and refreshed browser walkthrough passed without changing
the runtime implementation or policy proof.

The PR fix pass restores Local Setup’s canonical validation before provisioning,
retains safe field-specific startup diagnostics, bounds execution-cluster certificate
parsing, and constructs flagged synthetic URL fixtures through the existing helper.
Targeted Go, SSH, Helm packaging, certificate, and API/worker startup checks passed.
These startup and fixture fixes do not change the runtime policy lifecycle above.
Final-head CI and input-safety re-evaluation remain pending.

The 2026-10-20 ownership simplification removes Driver-side structural validation
and returned configuration data. The platform validates structure, runs semantic
checks on an isolated frozen copy, validates field errors, and returns the original
input. Constructor admission remains for independent callers. The existing
executionCluster recursive configuration algorithm is unchanged and remains
separate follow-up work. The preceding head `01ee10b27` passed all 28 selected CI
jobs (one unselected native-container lane); focused local proof for this refactor passed 202 checks, with one existing
image-backed initializer skipped because its runtime image was not selected.
This includes package construction/refusal, original-input and callback-reference
isolation, bundled startup, and API/worker/Helm diagnostic paths. Typechecking,
lint, OpenAPI, credential/workspace boundaries, and documentation checks passed.
Hosted qualification is recorded in PR #2980. No UI
or wire-result change is intended.

Required proof through existing real callers:

- `tests/integration/driver-plugin-installation.test.mjs` and startup coverage:
  package and bundled definitions, multiple nested structural errors, semantic
  refusals, malformed error arrays, mutation attempts, rejected data envelopes, and throws; invalid input never constructs a Driver.
  Reject duplicate keys, unknown scopes, missing owner bindings, and invalid
  schemas. Typecheck concrete factory inputs.
- Actual Fastify routes and PostgreSQL policy integration: authorized schema reads,
  owner-filtered Agent discovery, distinct Driver/facet dispatch, exact denied
  operations, escaped/root/array error pointers, safe diagnostics,
  and no policy/job writes during preview. Change versions, permissions, or ceilings
  after preview and prove save/apply refusal without mutation. Permitted saves and
  revision snapshots retain admitted values.
- `tests/integration/qa-matrix-real.test.mjs`: OpenShell denial → edit/validate/save →
  apply → allowed connection → revoke → denial; a second Agent remains denied.
  Register coverage in `tests/helpers/qa-selection.mjs` and owning CI manifests.
- Browser walkthrough and rebuilt Storybook: dynamically discovered contributions
  without Driver-specific forms; empty, unsupported, loading, invalid,
  denied, conflict, saved, and apply-failed states, with draft retention and stale
  response rejection. Capture screenshots and a short interaction video.

Use documented disposable PostgreSQL/Kubernetes infrastructure, pinned runtime
images, and existing authorized credentials. Missing prerequisites leave required
proof incomplete; do not substitute a fake runtime. Keep media outside the checkout
and attach it to the implementation PR; label simulated UI proof separately.

Run applicable lint/typecheck, workspace, formatting, OpenAPI, documentation, and
selected integration checks under the repository testing skills. Completion requires both callers, required proof, and updated
current documentation, recorded here with the implementation revision.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16 09:53: Created the planned Driver configuration contract and #2599 integration specification. (`91ac04d6919860b7d7386444468a3dc0ddc90481`; session `01a14590-9cfc-7fa2-baf3-5840870223bc`)

- 2026-10-16: Linked RFC-0021 and moved its proposed contract to the decision document; retained TASK-0046 for delivery.

- 2026-10-19: Simplified delivery around RFC-0022 and merged #2599; retained TASK-0046 and its required real workflow proof.

- 2026-10-19: Paused implementation and aligned delivery with restored registry, scope/key dispatch, and generic configuration discovery.

- 2026-10-20: Simplified validation ownership to platform structural checks and Driver semantic error lists; retained independent entry-point validation and existing runtime proof.
