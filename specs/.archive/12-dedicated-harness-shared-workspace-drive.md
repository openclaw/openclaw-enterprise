# Feature Spec: Dedicated Harness Shared Workspace Drive

**Date:** 2026-08-25
**Status:** Planning
**Owner:** KubernetesComputeDriver

## Problem and Decision

A dedicated Agent gateway and Codex harness run in separate Pods with private,
ephemeral filesystems. Give them one Agent-owned `ReadWriteMany` persistent
volume containing the workspace, gateway sessions, generated images, and
bundled/plugin skills. Preserve each category's existing ownership, keep
credentials private, and reuse the volume across Agent revisions.

The current gateway file inventory
defines the shared categories and directions; the
legacy shared-volume research
confirms the per-Agent `ReadWriteMany` workspace pattern.

## Scope

Shared-storage implementation is limited to dedicated `KubernetesComputeDriver`
execution. Verify it with real k3d and protect dedicated `DockerComputeDriver`
execution with a real end-to-end regression. Embedded execution, Docker Driver
changes, public APIs, additional storage backends, synchronization services,
and whole-state/config sharing are excluded.

## Contract

Create one `40Gi` PVC per Agent, matching the current gateway workspace volume,
with `accessModes: ["ReadWriteMany"]`. Use the existing Agent ownership
metadata, namespace, and default StorageClass. Keep the claim's identity stable
across Agent revisions; reject foreign ownership. Do not fall back to
`ReadWriteOnce` or ephemeral storage.

Mount only these `subPath` directories; never mount the PVC root. `RO` means
`readOnly: true`, and `RW` means read-write.

| Category                          | PVC `subPath`      | Gateway path                                                 | Harness path                                             |
| --------------------------------- | ------------------ | ------------------------------------------------------------ | -------------------------------------------------------- |
| `openclaw-workspace`              | `workspace`        | `/home/node/workspace` (RW)                                  | `/home/node/workspace` (RW)                              |
| `openclaw-sessions`               | `sessions`         | `/home/node/.openclaw/agents/main/sessions` (RW)             | `/home/node/.openclaw/agents/main/sessions` (RO)         |
| `openclaw-codex-generated-images` | `generated-images` | `/home/node/.openclaw/codex-artifacts/generated_images` (RO) | `/home/node/.codex/generated_images` (RW)                |
| `openclaw-bundle-skills`          | `bundled-skills`   | `/home/node/openclaw-runtime-assets/bundled-skills` (RW)     | `/home/node/openclaw-runtime-assets/bundled-skills` (RO) |
| `openclaw-plugin-skills`          | `plugin-skills`    | `/home/node/openclaw-runtime-assets/plugin-skills` (RW)      | `/home/node/openclaw-runtime-assets/plugin-skills` (RO)  |

Set `OPENCLAW_WORKSPACE_DIR=/home/node/workspace` for the gateway. On startup,
the gateway publishes its `/app/skills` and `/app/plugin-skills` image trees to
their shared directories without mounting over those image paths.

Keep each Pod's existing private `/home/node` volume. Except for the listed
session and generated-image directories, gateway state and `CODEX_HOME`,
including `auth.json`, configuration, databases, credentials, and tokens,
remain private. Preserve existing workload identities and security contexts.

Retiring an old revision preserves the PVC. Existing final-gateway teardown
deletes only the owning Agent's PVC. Embedded execution creates no shared PVC.

## Implementation

1. Extend [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
   to create/reuse the Agent-owned PVC, render the five directional mounts, and
   delete the claim through existing gateway teardown. Add only required
   namespaced PVC access to [worker RBAC](../../deploy/helm/openclaw-enterprise/templates/rbac.yaml).
2. Update the [gateway runtime entrypoint](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
   to publish bundled and plugin skills; set the gateway workspace environment.
3. Configure disposable k3d fixtures so their existing storage provisioner can
   bind `ReadWriteMany` claims. Keep storage-bootstrap mechanics in the fixture
   and [operator documentation](../../docs/reference/drivers/kubernetes-compute.md).
4. Extend the existing [real Kubernetes integration](../../tests/integration/kubernetes-compute-real.test.ts)
   and [real gateway/Codex k3d integration](../../tests/integration/harness-topology-k3d-real.test.mjs);
   run the existing [real Docker Compute integration](../../tests/integration/docker-compute-real.test.mjs)
   as dedicated gateway/Codex regression coverage.

## Verification

One real dedicated k3d scenario must prove:

1. Exactly one bound `40Gi`, `ReadWriteMany` PVC belongs to the Agent; both Pods
   mount only the five declared subdirectories, and another Agent cannot access
   it.
2. Workspace writes are bidirectional; sessions and both skill trees are
   gateway-owned and read-only to Codex; generated images are Codex-owned and
   read-only to the gateway; credentials and other private state are absent.
3. Restarting the harness and activating a new revision preserve the same PVC
   and its contents; final gateway teardown deletes only that Agent's claim.
4. An unavailable `ReadWriteMany` volume fails closed. Existing real embedded
   coverage remains successful and creates no shared PVC.

The real Docker Compute integration must also deploy a dedicated Agent through
the authenticated OCC API, run separate Docker gateway/Codex containers, prove
their authenticated app-server connection and a real provider-backed model
response, and verify the model credential is present only in the Codex
container. Run it with `OCC_TEST_DOCKER_COMPUTE_REAL=1`; skipped execution,
mocks, and readiness-only checks do not satisfy this regression.

Follow the repository's [real k3d prerequisites](../../AGENTS.md#running-integration-tests);
mocks or skipped infrastructure-dependent checks do not satisfy this proof.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-25 09:19]: Defined dedicated-only Agent-owned k3d workspace persistence, private-state boundaries, revision reuse, terminal cleanup, and real-cluster acceptance evidence. (01a0399b-a827-7512-bbcd-51e40b5c85e8 - de70b0d9c81edbceac3a6234548d806ed2924411)
- [2026-08-25 10:44]: Added gateway-owned read-only session and bundled/plugin-skill access plus Codex-owned generated-image export through isolated subpaths on the existing Agent PVC; preserved private authentication and added real-k3d directionality evidence. (01a0399b-a827-7512-bbcd-51e40b5c85e8 - de70b0d9c81edbceac3a6234548d806ed2924411)
- [2026-08-25 10:46]: Required one Agent-owned ReadWriteMany claim and defined source-backed shared-filesystem configuration of k3d's existing local-path provisioner, without adding storage infrastructure or weakening fail-closed acceptance. (01a0399b-a827-7512-bbcd-51e40b5c85e8 - de70b0d9c81edbceac3a6234548d806ed2924411)
- [2026-08-25 10:54]: Simplified to the Agent-owned ReadWriteMany storage contract, five directional mounts, existing lifecycle, private credentials, and focused real-k3d acceptance proof. (01a0399b-a827-7512-bbcd-51e40b5c85e8 - de70b0d9c81edbceac3a6234548d806ed2924411)
- [2026-08-25 10:58]: Matched the dedicated Agent claim to the current claw-gateway workspace volume's 40Gi storage request while retaining ReadWriteMany and real-k3d size verification. (01a0399b-a827-7512-bbcd-51e40b5c85e8 - de70b0d9c81edbceac3a6234548d806ed2924411)
- [2026-08-25 11:01]: Rebased onto Docker Compute support and required a real dedicated Docker gateway-to-Codex provider turn as regression coverage without expanding Kubernetes-only shared-storage implementation. (01a0399b-a827-7512-bbcd-51e40b5c85e8 - 589ce2f0d49160bdcb023305ef90ac29d9905d53)
