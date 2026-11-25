# Run the Strands Box companion

Build the provider layer from [its Dockerfile](../../deploy/runtime/strands-box/Dockerfile) against the OCE runtime for the target architecture. In the build context, supply the reviewed `strands-box`, `strands-box-sock-alias` and `strands-box-contain-trampoline` binaries. Put the matching bridge modules in `bridge/`. Set the build arguments `OCE_RUNTIME_IMAGE` and `STRANDS_BOX_SOURCE_REVISION`. The image runs as `node`. The Sandbox Driver owns Pod creation and admission.

## Default receiver startup and transport

1. The supervisor reads the mounted manifest and runs Box with `/etc/strands-box/box.toml`. [outer.mjs](../../deploy/runtime/strands-box/outer.mjs) owns the child lifetime. Box supplies the private PID namespace. Its standard input and output carry framed channel messages. Child logs go to standard error.
2. The contained [bootstrap](../../deploy/runtime/strands-box/inner.mjs) opens the projected files named by `secretEnvironment` and starts the admitted `command` in `workspace`. Model credentials belong to that process. Keep their values out of the manifest and Box configuration.
3. The [listener initializer](../../deploy/runtime/strands-box/initialize-listener.mjs) creates a certificate for the Pod. The Gateway and worker verify the admitted certificate before sending credentials. The [supervisor](../../deploy/runtime/strands-box/supervisor.mjs) validates the revision bearer before passing native traffic to the contained process. The diagnostic listener accepts the revision readiness request and cannot upgrade to a native session. The [handshake](../../deploy/runtime/strands-box/handshake.mjs) checks native initialization. Readiness retains capacity when session channels are full.
4. The contained proxy forwards the configured Gateway address over the private stream. Other destinations use Box's policy proxy. A failed connection closes the channel. A normal EOF lets the destination finish its queued writes.

## Stock launcher

The [opt-in preview](../reference/drivers/strands-box.md#stock-launcher-preview)
uses released Box 0.3.1 on ARM64. Only the trusted Box container receives the
provider key. The workspace node connects to the Gateway. The Agent has no
Gateway tunnel. Its model traffic goes directly through Box to OpenAI.

**Use an isolated cluster.** The `oce-strands-box` RuntimeClass requires a
Pod Security exemption. An exemption skips every Pod Security check for that
class across the cluster. Keep tenant labels Restricted. A separate validating
policy must remain in force for the full lifetime of the exemption.

1. Pin the provider image by digest and verify the Box release binaries.
   Restrict scheduling to reviewed nodes. Install the
   [node profiles](../../deploy/runtime/strands-box/profiles/README.md) in enforce mode.
   The seccomp generator requires the OCI Linux specification from an ordinary
   Restricted container using the reviewed containerd defaults.
2. Install the [admission policy and deny binding](../../deploy/runtime/strands-box/admission/render.mjs)
   for the tenant name, exact image and ReplicaSet controller ServiceAccount.
   Verify policy status before installing the class and its exemption.
   Only trusted operators may change policy, bindings, the class or node profiles.
   Keep workload templates, configuration, Secrets and exec or attach access
   exclusive to trusted operators and OCE. Exclude untrusted mutating webhooks.
   The Pod creator check identifies the controller, not the Deployment author.
3. Check [admission](../../deploy/runtime/strands-box/admission/check.mjs)
   against the generated Deployment. The lab uses the
   `kube-system:replicaset-controller` ServiceAccount. Compare sensitive path access inside Box
   and in a child process with a Restricted container on the same node.
   Repeat qualification after node or runtime upgrades.
4. Stop the Agent and confirm its Pods are gone before teardown. Remove the
   exemption before removing the guard. Deleting the policy or binding first
   removes protection even with `failurePolicy: Fail`.

Box starts the workload in private Linux namespaces. The launcher replaces
present sensitive procfs entries with empty mounts. Startup checks the masks
and enforced profiles. No application sandbox is required. The listener waits
up to 180 seconds for its pinned certificate receipt. A mismatch prevents
Box from starting. The launcher then has 60 seconds to connect over the
private socket for Harness frames. Loss of supervision ends the
workload. The key remains a startup snapshot.

## Kubernetes startup convergence

[Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts) requests the Harness endpoint, then reads its status. The [Sandbox Driver](../../apps/controller/src/drivers/sandbox/strands-box.ts) reuses an owned, immutable listener receipt with a valid pinned certificate. Without a receipt, startup is pending only for an empty Pod list or one revision-labelled Pod with a valid UID, no deletion request and a verified controller chain through its ReplicaSet to the expected Deployment. Its phase must be absent, `Pending` or `Running`. The initializer must be absent, running, or waiting with no reason, `ContainerCreating` or `PodInitializing`.

Pending startup raises `TransientDependencyError` without creating a receipt or granting readiness. A successful initializer must provide a certificate matching the Pod UID and both Service hostnames, with a valid self-signature and non-CA status. Ownership, state and certificate failures refuse discovery. Endpoint preparation spends an attempt on these refusals. The later status read also treats `DependencyUnavailableError` as transient.

The [Worker](../../apps/controller/src/worker.ts) defers pending startup, and the [PostgreSQL queue](../../packages/occ/src/state/postgres-work-queue.ts) restores the attempt. The [deadline](../reference/controller/reconciliation.md#deferred-namespace-and-agent-convergence) defaults to 15 minutes from operation creation. Startup still pending at the deadline fails with `SANDBOX_GATEWAY_UNAVAILABLE`. The [status tests](../../tests/conformance/strands-box-status.test.ts) cover refusals.

Run `node --test tests/conformance/strands-box-transport.test.ts` for channel limits, proxy handling and shutdown. When startup stalls, check for a refused native handshake, a failed child, or missing projected files. An HTTP 401 on the native listener indicates missing or invalid transport credentials. Inspect revision and Pod status without logging bearer headers or Secret values.
