# Implementation plan: Send OpenShell sizing through template resources

- **ID:** TASK-0055
- **Delivery status:** Implemented and verified for review
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

| Required outcome                                  | Proof                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct requests and limits reach OpenShell       | Existing protobuf transport coverage plus actual Pod inspection in both modes.                                                              |
| Managed creation needs no caller driver config    | Real API-to-OpenShell deployment with that permission disabled.                                                                             |
| Resources remain immutable on managed replacement | Controlled Driver test with changed sizing on a stopped Sandbox. Live resize refusal requires a separate installation configuration change. |
| Missing or changed resource readback fails closed | Focused lifecycle coverage using real protobuf encoding and decoding.                                                                       |
| Operator storage and runtime still work           | Real Agent deployment, workspace access, and model turn with existing mounts.                                                               |

Live proof requires a disposable cluster with enforcing NetworkPolicies, compatible OpenShell managed-workspace APIs, digest-pinned runtime images, and existing authorized model credentials. Missing prerequisites remain a verification gap, not permission to substitute mocks.

## Delivery record

On 2026-11-20 the two `openshell-template-resources` stages passed on separate
disposable k3d installations with OpenShell 0.1.8 and a real Codex model. The
API and worker used `2479895a9e`. The matrix used the mode labels committed in
`a8370785f4`. Each stage ran separately because the host could run one cluster
at a time. See the [test procedure](../../docs/testing/openshell-managed.md#template-resource-delivery)
and [PR evidence](https://github.com/openclaw/openclaw-enterprise/pull/6754).

Both Agent containers requested 100m CPU, 768Mi memory and 256Mi ephemeral
storage. Their limits were 2 CPUs, 6Gi memory and 1Gi ephemeral storage.
The operator Pod mounted the `workspace` subpath at `/sandbox/enterprise`.
The managed gateway accepted the OCE deployment with caller config disabled
and rejected a separate create request that included caller config. Each Agent
wrote and read a file and completed a model turn.

A separate live upgrade started with the worker at `6967d8e4de`. In each mode
the test verified the old Sandbox format, wrote a marker through the workspace
API, exported it and completed a model turn. After upgrading the API, worker
and runtime, a fresh legacy revision read the marker from the retained volume.
Managed redeployment failed on the first attempt with `SANDBOX_RECREATION_REQUIRED`.
The original Sandbox kept its ID and stayed stopped. The test restored the
export to a new Agent and verified its contents before deleting the original.
Both upgraded Agents completed model turns. See the
[service upgrade procedure](../../docs/reference/drivers/kubernetes-openshell-compute.md#lifecycle-and-retained-files).

The focused startup, admission, wire, QA input and CI runner suites passed 351
cases with three image-dependent skips. The wire tests cover protobuf encoding
and the specific admission diagnostic. Controlled Driver tests cover missing
or changed resource readback and refusal of a resize while stopped.

## Changelog

- 2026-11-20: Verified both modes and workspace recovery. Assigned TASK-0055 after the channel egress plan took TASK-0054 on main. Session `01a1c729-7450-7201-9ce8-1bea3588d140`.

- 2026-11-20: Rebased TASK-0054 onto main `6967d8e4dea2b4c5bb769c8697e7d4cfd046c55a` and ported coverage to current TypeScript tests. Session `01a1f50f-138b-756e-be12-ada2880622e2`.

- 2026-11-19: Implemented TASK-0054 against `434ca70f7e7d60769865b780096886acbfc0219c`; live proof remains pending. Session `01a1f50f-138b-756e-be12-ada2880622e2`.

- 2026-11-19: Created the plan from source inspection at `a6089d7f0`; session `01a1f0bc-c154-715b-9d9c-79d3ec7982f4`.
