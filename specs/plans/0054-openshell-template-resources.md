# Implementation plan: Send OpenShell sizing through template resources

- **ID:** TASK-0054
- **Delivery status:** In progress — implementation complete; live verification pending
- **Authority:** [OpenShell Sandbox Driver](../../docs/reference/drivers/openshell-sandbox.md) and [managed OpenShell runtime](../../docs/reference/drivers/kubernetes-openshell-compute.md)
- **Source baseline:** OCE `a6089d7f0`; OpenShell `96fabf3e3b0f`

## Outcome and scope

The regular Agent deployment workflow sends Harness resource requests and limits through OpenShell's `spec.template.resources`, not `spec.template.driver_config.kubernetes.containers.agent.resources`.

Apply this to operator and managed workspace modes. Preserve each mode's current sizing rules, validation, and defaults, including ephemeral-storage request `256Mi` and limit `1Gi`. Operator mode retains its existing per-Agent overrides; extending override support in managed mode is separate work.

Managed mode omits `driver_config` when it has no driver-specific settings. Operator mode retains that field for volumes and volume mounts. Do not send resource values in both places or add a fallback to the old representation.

This is an implementation change, with no new Driver configuration or public interface. In-place resizing, storage changes, image-version changes, and cluster reconfiguration are out of scope. If implementation requires a Driver contract change, submit an RFC before that work.

## Implementation

1. **Move resource serialization.** In [`openshell.ts`](../../apps/controller/src/drivers/sandbox/openshell.ts), pass resources separately from driver-specific layout settings and encode `template.resources` as a protobuf Struct. In [`managed.ts`](../../apps/controller/src/drivers/sandbox/openshell/managed.ts), use the same serializer and omit the now-unneeded resource-only `driver_config`. Keep operator mounts unchanged.
2. **Preserve lifecycle checks.** Normalize protobuf values in `template.resources` within `canonicalSandboxSpec`. Keep resources in adoption, workload readback, and managed immutable-workload comparisons. A resource mismatch must still refuse adoption or replacement; do not silently accept server-dropped fields or add legacy-format conversion.
3. **Extend focused coverage.** Update existing Sandbox adoption, managed-workload, native Harness, and protobuf transport cases. Protect resource defaults, operator override inheritance, round-trip equality, mismatch refusal, and operator mount preservation. Update response fixtures to decode both resource Structs correctly; do not treat fixtures as cluster proof.
4. **Add real workflow proof.** Extend the [QA matrix Agent workflow](../../tests/integration/qa-matrix-real.test.mjs), with selection and CI registration. Deploy through the OCE API into real OpenShell, inspect the resulting Agent container resources, and verify workspace access and a model turn. Managed mode must work with caller `driver_config` disabled; operator mode must retain its approved mount configuration.
5. **Update current documentation.** Update the Sandbox reference, managed runtime reference, and owning [provisioning](../../docs/flows/openshell-sandbox-provisioning.md) and [managed workload](../../docs/flows/openshell-managed-workload.md) flows. No architecture overview change is expected because ownership and lifecycle stay unchanged.

## Verification and dependencies

| Required outcome                                  | Proof                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Correct requests and limits reach OpenShell       | Existing protobuf transport coverage plus actual Pod inspection in both modes.                |
| Managed creation needs no caller driver config    | Real API-to-OpenShell deployment with that permission disabled.                               |
| Resources remain immutable on managed replacement | Attempt a changed sizing specification; verify refusal without starting the changed workload. |
| Missing or changed resource readback fails closed | Focused lifecycle coverage using real protobuf encoding and decoding.                         |
| Operator storage and runtime still work           | Real Agent deployment, workspace access, and model turn with existing mounts.                 |

Live proof requires a disposable cluster with enforcing NetworkPolicies, compatible OpenShell managed-workspace APIs, digest-pinned runtime images, and existing authorized model credentials. Missing prerequisites remain a verification gap, not permission to substitute mocks.

## Delivery record

Implemented resource serialization, canonical readback, focused lifecycle and wire
coverage, and current reference and flow updates. The QA lane now selects
`openshell-template-resources`; [test setup](../../docs/testing/openshell-managed.md#template-resource-delivery)
defines its prepared operator and managed installations. It checks actual Pod
resources, managed caller-config refusal, operator mounts, workspace access and a
model turn. Hosted advisory jobs do not prepare these installations.

Focused startup, workspace-admission and protobuf wire tests pass: 230 passed,
three existing runtime-image-dependent cases skipped. Reverting only the runtime
repair makes the extended adoption and managed-rendering cases fail because
resources remain in `driver_config`; restoring it passes. Typecheck, lint,
workspace isolation and CI lane audit pass. Existing QA fixture/input and CI
runner tests also pass: 199 passed, no skips. Formatting, documentation/link/spec
checks, documentation length checks and both flow validators pass.

Documentation review: the two updated flows, Sandbox reference and QA advisory
page exceed 1,500 words but remain below 2,500. Each covers one coherent Driver
reference, lifecycle or test workflow. Keep those workflows together; detailed setup remains in the linked
testing page. This change adds no image versions, public configuration variables,
API operations or navigation entries.

Live verification remains blocked: this session has no explicitly selected
cluster, prepared installation input files or authorized model credentials. An
explicit QA selection fails at the required
`OCC_TEST_OPENSHELL_RESOURCES_INPUT_FILE` check, without skips or infrastructure
changes. Actual Pod sizing, managed caller-config-disabled creation, mounts,
workspace/model execution and cluster refusal of changed managed sizing are not
verified. Controlled lifecycle tests prove OCE refuses changed sizing and missing
or changed readback, but do not replace that cluster proof. Keep delivery open
until the required live outcomes pass.

### Rebase verification, 2026-11-20

Rebased only TASK-0054 onto `origin/main` at
`6967d8e4dea2b4c5bb769c8697e7d4cfd046c55a`. The managed implementation is already
in main through PR #6641; its older prerequisite commits are not replayed.
Rendering coverage now extends
`tests/integration/sandbox-driver-managed-startup-rendering-cases.ts`, preserving
main's Provider update, obsolete-key deletion and security checks. The QA input
labels map to current `legacy` and `service` integration modes.

On this base, focused startup, workspace-admission and wire tests pass: 239 passed,
three existing runtime-image-dependent cases skipped. QA fixture/input and CI
runner tests pass: 111 passed, no skips. Typecheck, lint, formatting, documentation,
flow validators, workspace isolation and CI registration audit pass. Live QA still
fails at the missing `OCC_TEST_OPENSHELL_RESOURCES_INPUT_FILE` prerequisite;
no live runtime or cluster proof is claimed.

## Changelog

- 2026-11-20: Rebased TASK-0054 onto main `6967d8e4dea2b4c5bb769c8697e7d4cfd046c55a` and ported coverage to current TypeScript tests. Session `01a1f50f-138b-756e-be12-ada2880622e2`.

- 2026-11-19: Implemented TASK-0054 against `434ca70f7e7d60769865b780096886acbfc0219c`; live proof remains pending. Session `01a1f50f-138b-756e-be12-ada2880622e2`.

- 2026-11-19: Created the plan from source inspection at `a6089d7f0`; session `01a1f0bc-c154-715b-9d9c-79d3ec7982f4`.
