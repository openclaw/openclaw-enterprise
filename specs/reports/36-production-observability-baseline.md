# Local Kubernetes baseline verification

Verified on 2026-09-23 before production observability implementation changes.
The tested product source was commit
`db81b524d76d8a6335e6eb5000b87653262d3d4b`. The existing untracked patch was
not applied. Repository changes were limited to the proposal, plan, and this
verification record.

## Environment

- macOS arm64 with Podman 6.1.2, using its existing rootful connection through
  a temporary local socket. The default rootless connection remained unchanged.
- k3d 5.8.3; a disposable two-node Kubernetes `v1.35.8+k3s1` cluster with bridge
  packet filtering enabled and VM-native XFS storage.
- Installed Node 24.15.0, Corepack/pnpm 11.15.1, Helm 4.2.0, and kubectl 1.35.4.
- The unchanged controller Dockerfile was built from the current checkout and
  cached immutable Node 24 base. Its imported manifest was
  `sha256:e7d64362862f097791970c8b38cf554758af04c9007a7a1da952876da3f8bc03`.
  Controller, Node proxy, and PostgreSQL references were verified in both nodes.
- No model credentials were supplied to the baseline processes; no model calls
  were made. The Helm configuration's runtime image was not exercised.

## Results

The existing `k3d-fixture-configuration` lane ran through
`scripts/ci/prepare.mjs` and `scripts/ci/run-tests.mjs`:

| Existing integration case                                                      | Result |
| ------------------------------------------------------------------------------ | ------ |
| Compute Driver isolation, gateways, identities, revisions, and deletion        | Passed |
| Preservation of an externally managed tenant namespace                         | Passed |
| Authenticated PostgreSQL API/worker deployment, Secret bindings, and revisions | Passed |

Final accounting: **3 passed, 0 failed, 0 skipped, 0 TODO**; per-file cleanup passed.
These cases use the existing HTTP runtime fixture. They prove cluster, Driver,
API, persistence, lifecycle and network behavior, not gateway/Codex model execution.

Separately, a temporary validation script invoked the unchanged
`tests/helpers/production-helm-real.mjs` helper to install the actual production
chart in its own namespace. This deployment used its own in-cluster PostgreSQL
instance, migrator/application roles, and fresh bootstrap storage. Checks passed:

- Bootstrap output directory ownership was UID/GID 1000 with mode `0700`.
- Helm initialization completed and API/worker Deployments became Ready.
- An unauthenticated Installation request returned 401; the generated bootstrap
  service key successfully read the Installation.
- An authenticated Namespace mutation persisted; the worker provisioned its
  tenant namespace, which reached `ready` after the documented RoleBindings.
- A supported Configuration and embedded Agent draft were created and read back.
- Actual API request events appeared in container logs.
- Installed values confirmed `metrics.enabled: false` and
  `logging.collector.enabled: false`; there was no Collector DaemonSet.
- A browser signed into the loopback HTTPS console and displayed the saved Agent
  draft. The captured Agents page showed revision `db81b524` and the correct
  Namespace. The disposable endpoint used a self-signed certificate.

## Environment issues resolved without product changes

The rootless connection failed k3s startup because its delegated cgroups lacked
`cpuset`. The existing rootful connection started the cluster without modifying
the default connection or restarting the VM. Corepack and Helm were already
installed but required explicit PATH selection.

The initial macOS-shared storage could not satisfy the bootstrap ownership
check. Recreating only the owned cluster with a VM-native `/var/tmp` storage
path made the unchanged check pass. A transient Podman journal-reader failure
interrupted one creation attempt; a direct log-read check succeeded, and one
retry of the same preparation command succeeded. Failed/aborted attempts were
retained separately from the final passing result.

## Scope and disposition

This establishes an unchanged, functional local deployment before
[implementation](../36-production-observability-plan.md#task-1-enable-secure-production-defaults).
It does not prove the proposed telemetry defaults, OTLP export, demonstration
observability stack, real model turns, or hosted CI execution.

The sanitized screenshot and local result artifacts were retained for the task
conversation. The owned Helm release, cluster, database, temporary credentials,
VM storage, socket tunnel, and controller image tags were removed. The existing
rootless workloads remained running; the default connection and kubeconfig/context
were not changed.
