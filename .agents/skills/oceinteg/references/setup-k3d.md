# Set up local k3d with Helm OCC

Use this setup for main's Kubernetes-only local target. Start with
[Local Setup](../../../../docs/guides/quickstart.md) and follow the
[local Kubernetes guide](../../../../docs/guides/deploy/local-kubernetes-development.md)
for prerequisites, isolation, optional capabilities, and lifecycle. PostgreSQL,
OCC, its worker, and Agent workloads run in the disposable cluster; Docker or
Podman hosts k3d rather than OCC application containers.

## Follow the guides in order

1. Resolve a fresh private state directory, cluster name, bridge subnet, free
   API/browser/Kubernetes ports, immutable images, and retention choice. Use the
   guide's engine and cgroup prerequisites. Preserve unrelated clusters, engine
   state, and default kubeconfig/context.
2. Select the documented Kubernetes-only profile explicitly:
   `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes`,
   `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`, and
   `OCC_DEVELOPMENT_SANDBOX_DRIVER=none`. Run the guide's CLI build and startup
   procedure. The sandbox setting does not disable the dedicated Codex workspace
   sandbox. Retain the launcher's same-image sandbox proof and rollback evidence.
3. For main's broker-omitted case, supply no broker inputs. For its configured
   fresh case, prepare [local repository credentials](../../../../docs/guides/deploy/local-repository-credentials.md)
   before startup. Do not retrofit undocumented flags into an existing release.
4. Import only the generated public browser CA as described by Local Setup.
   Use the printed HTTPS Console address and protected administrator credentials;
   retain the printed release, namespace, kubeconfig, and context identities.
5. Complete the local guide's
   [Slack proxy procedure](../../../../docs/guides/deploy/local-kubernetes-development.md#require-both-proxies-before-enabling-slack).
   Apply both protected inputs to the correct release and verify API directory
   lookup and gateway messaging separately. Do not rerun fresh startup to update
   an existing installation.

## Hand off and clean up

Verify actual Helm workloads, Console access, presets, routing, database readiness,
NetworkPolicy enforcement, and image provenance. Then execute main through the
Console, using separate fresh Installations where runtime Driver selection differs.
No EKS result may be inferred from this local proof.

Apply [main's retention decision](./runtime-acceptance.md#completion) first.
Preserve requested running Agents and their dependencies; the shutdown steps
below apply only to resources selected for disposal.

Stop run-owned Agents and resolve broker disposal before following
[local shutdown](../../../../docs/guides/deploy/local-operations.md#stop-development-safely).
Use the original state directory and engine selection. Verify only the owned
cluster was removed; remove its public browser trust entry when discarding it.
If retention was requested, record the cluster, claims, state directory, and
remaining processes instead of deleting them.
