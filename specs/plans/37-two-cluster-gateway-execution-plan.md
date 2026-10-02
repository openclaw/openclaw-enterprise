# Two-cluster dedicated Gateway execution plan

Status: Experimental implementation with passing local full-stack two-cluster E2E; release and broader runtime qualification remain open. Keep the PR draft for review.

Original base: `e5f1dedbdb42931886ffd3e4f58789d8323d9140`, including merged PR #327.
Updated against main `d39727589b549243fecbc8aa5611f44e4e27874e`.

## Outcome and scope

Follow PR #327 with one explicitly configured control-plane Kubernetes target and
one explicitly configured data-plane Kubernetes target per Installation. OCC
manages dedicated Gateway resources in the control-plane target and Harness
resources in the data-plane target through the regular Agent API/worker lifecycle.
Do not equate namespace isolation or passing single-cluster tests with this support.

The implementation below is experimental. It defines a bounded network contract
and must complete acceptance with
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
- [x] Define explicit Kubernetes API, verified HTTPS, DNS, and NetworkPolicy inputs.
- [ ] Select a released runtime pin satisfying all acceptance prerequisites.
- [x] Implement explicit plane-aware lifecycle and bounded TLS transport.
- [x] Complete the local dedicated Codex two-cluster E2E and deployment docs.
- [ ] Complete the separately listed release, plugin and broader runtime qualification.

## Verification record

The first local experiment installed independent Kubernetes 1.35.8 clusters,
Envoy Gateway 1.6.7, cert-manager 1.18.4, PostgreSQL 18.6, and the standard OCE
migration/bootstrap/API/worker Helm release. Explicit component credentials and
five tenant RoleBindings exercised the normal API lifecycle.

Observed: CP-only Gateway, DP-only Harness, successful deployment, real model
answer, authenticated workspace read/write, and retained workspace plus another
model answer after replacing the Harness Pod. Missing and incorrect app-server
tokens returned 401. The DP delivery contained the selected model key, transport
token and revision node material; the Gateway password remained in CP.

Runtime: OpenClaw source revision `20db76a79212c7d0c4f2106fea4d61fdce9972a3`
with Codex 0.156.0, local image manifest
`sha256:df395d2c951dcecd708ffcd62956504089a9e410b94d1ea77a509f77c23d5dd5`.
This source-built image is experimental, not a qualified release pin.

Open findings: the selected runtime's workspace-template hash differs from OCE's
pin; custom initial documents fail closed. Ubuntu AppArmor denies bubblewrap's
network namespace setup despite the reviewed localhost seccomp profile. Gateway
replacement exposed a native five-minute owner lease after shutdown. Do not
clear that lease or weaken sandbox controls to claim acceptance. Replacement
eventually succeeded and served another model answer after approximately six
to seven minutes. Plugin-enabled transport, partial-target failure, and
same-cluster integration still need completed evidence. `running` deployment status is in-progress;
`succeeded` is the success condition.

After the main refresh, 301 focused Kubernetes, credential delivery, repository
material, plugin, HTTPS transport and real Helm renderer checks passed. The complete local stack
passed the new real API/worker integration without skips in 118 seconds:
placement, workspace RPC, Harness Pod reconnect, revision replacement, predecessor
retirement, Agent deletion, and deletion of both tenant namespaces. The HTTPS
helper test separately rejects wrong token/revision, missing CA, redirects and
plaintext; it does not prove an installed plugin workflow.
The upstream dedicated repository credential capability remains supported in
single-cluster mode; two-cluster admission rejects it until its currently local
service has a qualified remote endpoint. CI fixture automation remains pending; the `k3d-two-cluster` lane consumes an
explicit preinstalled test environment.

A broader macOS conformance run is not green: Linux fixture dependencies
(including `/usr/bin/gh`), control-directory validation, process cancellation,
and SSH preflight failed outside the changed Kubernetes implementation. One
Linux-only case skipped. The changed Secret-delivery fixture was repaired and
passed in the focused rerun; do not describe the broad run as passing.

## Subsequent local qualification

The repository runtime recipe now builds successfully at OpenClaw source
`2765f7a3341b8be4835afacbff3d04c6e3c3c79b`, Codex 0.156.0, local manifest
`sha256:2a7a1409f0d84d49d7343ff939ee18389843c377c104df6a5dd4dee715b4d759`.
A fresh stock Debian 13 Lima VM passed the reviewed sandbox positive probe,
RuntimeDefault negative probe, and missing-profile rejection without weakening
Pod security. The standard production Helm helper installed PostgreSQL, limited
roles, migration/bootstrap, API and worker into its new CP cluster; a distinct
DP cluster received the execution chart and component credentials.

The expanded real API/worker test passed without skips in 176 seconds. In
addition to the original lifecycle it proves model-key source updates leave the
active revision unchanged, redeployment delivers an invalid key and rejects its
native model probe, restoring the key permits a successor, and a short real DP
node outage preserves deleting metadata before automatic recovery and cleanup.
Separate real-model calls returned the expected response and executed a shell
command whose exact random marker was independently read from the DP workspace.
Current-pin initial workspace setup also passed with the selected defaults hash
and exact caller-supplied content, resolving the earlier runtime/template
mismatch for this locally built image. Another Agent served a model reply after
DP recovery. Installed ingress negative checks rejected missing/wrong tokens,
stale-revision status credentials, an unknown tenant route, and absent CA trust.
No optional plugin manifest was configured; successful plugin installation is
not implied by those checks.

Two fixture prerequisites were discovered: wait for actual DNS resolution after
custom CoreDNS installation, and preserve the test's local-path/CoreDNS changes
across k3s restart using its supported AddOn skip files. The current local guide
records both. The failed startup fixture in CI now passes with explicit physical
plane addresses; all 13 startup cases pass locally and its CI lane is green.

Open follow-up: prolonged cluster failure can exhaust the existing five-attempt
worker budget. The Agent remains `deleting`, and repeated DELETE does not
requeue terminal work. Both behaviors are present on main and are not changed
by the two-cluster Driver. Track a supported lifecycle recovery entrypoint;
do not count short-outage recovery as proof of unlimited retry. The retained
failed fixture is evidence, not successful cleanup. Remote Codex plugin
qualification still needs a ChatGPT-backed credential; the API-key test does
not provide it. Current-pin replacement after a model turn succeeded and served
another model reply after 396 seconds; the native owner-lease startup failure
remains a latency issue. Complete same-cluster real-model regression remains
distinct acceptance work.
Two expanded stop/resume runs observed a valid-key Pod fail its native startup
probe. A policy watch found the shared authentication NetworkPolicy alternating
between the rejected and new candidates every second. Preparation now creates
revision-owned authentication policies; shutdown removes only the terminated
revision's grant. The original failed runs and policy-watch evidence remain
recorded, and their resources were removed through the normal API. The real
integration now asserts concurrent candidate grants, stop cleanup, retired-grant
cleanup, and actual model-driven shell execution.
The final expanded run passed in 238 seconds, one test, zero failures and zero
skips, including both candidate grants and their cleanup. Controller production
image manifest: `sha256:37305bba4beb2d9f8fab4c7088dd4b701e2f47806485a0c64bd29e6753070ac5`.
The 131 Compute plus 25 related Kubernetes conformance checks, TypeScript, full
lint/format, workspace boundary, suite accounting and documentation checks passed.

The retained Agent subsequently failed live reconnection after the final outage:
its durable node state survived, but the selected native `--pair-if-needed` path
rejected the expired setup code before loading saved node configuration. Model
HTTP returned 500 with workspace discovery unavailable. This is separate from
the passing deletion-recovery test and requires native runtime qualification;
normal OCE redeploy with fresh enrollment material is only an operator recovery.
The earlier post-outage model success occurred before setup-code expiry.

## Documentation owners

Update [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md),
[networking and isolation](../../docs/reference/drivers/kubernetes-compute/networking-and-isolation.md),
[storage and credentials](../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md),
[workload design](../../docs/design/workloads.md), and the existing
[credential delivery flow](../../docs/flows/secret-storage-and-delivery.md) with
the implementation. Put supported setup under the deployment guides and proof
selection under [Kubernetes testing](../../docs/testing/kubernetes.md). This plan
does not change those pages' current single-cluster support claims.
