# Two-cluster dedicated Gateway execution plan

Status: Accepted for implementation; runtime implementation and acceptance are pending.

Base: `e5f1dedbdb42931886ffd3e4f58789d8323d9140`, including merged PR #327.

## Outcome and scope

Follow PR #327 with one explicitly configured control-plane Kubernetes target and
one explicitly configured data-plane Kubernetes target per Installation. OCC
manages dedicated Gateway resources in the control-plane target and Harness
resources in the data-plane target through the regular Agent API/worker lifecycle.
Do not equate namespace isolation or passing single-cluster tests with this support.

This is a proposed implementation plan, not an implemented capability. The
first implementation must define a bounded network contract and prove it with
two local disposable clusters; a selected cloud deployment is not a prerequisite. Keep the existing same-cluster mode supported. Embedded
execution, N-target scheduling, sharding, automatic VPC networking, migration,
cloud-specific provisioning, and a general credential broker are outside this change.
Keep cluster access, cross-cluster endpoints, TLS trust and network-policy inputs
explicit. Prefer standard Kubernetes APIs and configuration over an unneeded
cloud adapter framework; introduce an adapter only for a demonstrated platform
difference. Cloud portability is a design constraint, not cloud acceptance proof.

## Source observations

- `apps/controller/src/drivers/compute/kubernetes/index.ts` has one
  `KubernetesComputeDriverOptions.authentication` and one cached `clients()`.
  CRUD, readiness, Sandbox context, pod proxy, node enrollment and cleanup must
  address the intended cluster explicitly. A namespace string alone is not a
  complete physical resource address once two clusters are supported.
- `deployment` constructs `APP_SERVER_URL` using the Harness `.svc` name.
  Cross-cluster transport needs a reachable endpoint, verified server trust,
  and the existing exact-Agent admission checks; cluster-local DNS and label
  selectors do not extend across clusters.
- `prepareWorkspaceNode` issues revision-scoped setup material. The node connects
  back to the Gateway route; `workspaceNodeNetworkPolicy` currently selects an
  Envoy Pod in the same cluster. Cover this reverse path and reconnect.
- `runtime-entrypoints.ts:readPeerPluginRuntimeStatus` derives plain HTTP on a
  private port from `APP_SERVER_URL` and accepts only `ws://` URLs. Resolve this
  existing path explicitly; do not silently disable plugin status under TLS.
- Kubernetes Configuration and Secret Drivers discover canonical control-plane
  namespaces using their own configured credentials. Keep them on the CP target;
  workload delivery writes only authorized, selected execution material to DP.

## Implementation sequence

1. Define a pair of disposable local clusters and a portable TLS endpoint
   contract for each required connection direction. Supply local DNS, trust
   roots, routing and observed policy addresses through the deployment profile.
   Cloud operators supply equivalent reachable endpoints and network prerequisites;
   outbound-only execution networks are outside this first profile.
2. Extend Kubernetes Compute with two explicit targets and route every operation
   using both cluster identity and namespace. Keep both API connections verified
   and independently authorized; expose neither credential to workloads.
3. Implement the selected bounded network path in the existing Driver/runtime
   owners: Gateway to app-server, workspace node to Gateway, and plugin status.
   Fail closed on missing endpoints, trust, credentials, or unsupported modes.
   Do not add a general multi-cluster controller or topology plugin framework.
4. Preserve canonical CP credentials and revision-owned DP delivery. Test
   credential refresh by updating the source and invoking OCE deployment.
5. Exercise preparation, readiness, activation, replacement, stop, retirement,
   Agent deletion and Namespace deletion across both targets. A partial failure
   must remain retryable without deleting a successor, another Agent/tenant, or
   shared infrastructure. An unreachable cluster is not an absent resource.
6. Provide repeatable deployment configuration and per-cluster administrator RBAC
   instructions. Update the current feature references and existing flow docs.
7. Install the complete OCE stack through supported deployment packaging,
   including database, migration, bootstrap, API and worker, then extend the
   real API/worker integration path to two distinct disposable
   clusters/contexts. Register the test in normal CI selection and accounting;
   selected cases must not skip. Keep full runtime acceptance distinct from
   fixture integration, with immutable runtime pins recorded for both.

## Acceptance

- Deployment creates Gateway resources only in CP and Harness resources only in
  DP; use two independent API servers and verify objects on both.
- Actual Gateway/Harness transport and workspace operations succeed. Wrong Agent,
  tenant, token, or server trust fails; cluster-local label checks are not counted
  as remote authentication proof.
- Plugin status remains observable under the selected transport.
- Restart/reconnect and revision replacement retain expected state and reject
  stale traffic; API/worker cleanup is exact and repeatable after partial failures.
- Canonical channel credentials and Gateway password never reach Harness; only
  selected model/transport/node material is delivered there. Workloads cannot
  access Kubernetes control credentials or other tenants' material.
- Existing single-cluster integration still passes.

## Progress

- [x] Inspect the current single-cluster implementation and review request.
- [x] Merge PR #327 after refreshing its branch and passing CI (run 35933004388).
- [x] Select full local dual-cluster OCE setup as the first acceptance target.
- [ ] Define the portable network contract and select compatible runtime images.
- [ ] Implement two-target lifecycle and bounded transport.
- [ ] Complete dual-cluster integration, runtime acceptance and deployment docs.

## Verification record

No dual-cluster implementation or execution has been performed for this plan.
Single-cluster CI on PR #327 remains evidence for that PR's stated scope only.

## Documentation owners

Update [Kubernetes Compute](../docs/reference/drivers/kubernetes-compute.md),
[networking and isolation](../docs/reference/drivers/kubernetes-compute/networking-and-isolation.md),
[storage and credentials](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md),
[workload design](../docs/design/workloads.md), and the existing
[credential delivery flow](../docs/flows/secret-storage-and-delivery.md) with
the implementation. Put supported setup under the deployment guides and proof
selection under [Kubernetes testing](../docs/testing/kubernetes.md). This plan
does not change those pages' current single-cluster support claims.
