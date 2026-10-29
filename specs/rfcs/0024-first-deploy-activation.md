---
status: Proposed
implementation_status: Implemented
author: freeqaz
status_note: "The Kubernetes driver implements this behavior. Compute and Security review of the activation and permission boundaries is pending."
---

# RFC-0024: Activate a dedicated Agent after its Gateway loads the workspace node

On the first deploy of a dedicated Codex Agent, its workspace node can pair with the Gateway before the Gateway loads the binding that enables file transfer. We propose keeping the Harness and Gateway running while the binding arrives. Compute owners must decide what evidence permits activation. Security and tenant operators must decide whether the permissions that make in-place enrollment possible are acceptable.

<a id="problem-and-decision"></a>
<a id="scope"></a>
<a id="design"></a>

## When the controller may activate

This decision covers a model-key-authenticated Kubernetes Harness running as a Deployment. The controller starts the Harness and Gateway with optional mounts. Once the Gateway is ready it delivers a single-use setup code to the Harness. After pairing, it records the device ID, removes the code from the Secret, and publishes the revision and device IDs to the Gateway's binding ConfigMap. Preparation can finish at this point.

- **With a configured control-plane status proxy**, the controller waits for the running Gateway to report that it loaded the file-transfer plugin for the paired node. The private response must identify the expected revision, Gateway container, observed Pod UID and device ID. The controller then checks node readiness. If the binding is late, activation stays pending and the same workloads can finish on a later pass. If the Gateway reports `GATEWAY_UNAUTHORIZED`, the controller fails the revision with `AGENT_GATEWAY_UNAUTHORIZED`.
- **Without a configured status proxy**, the controller adds the device ID to the Gateway Pod specification and starts a replacement Gateway. It checks Gateway and node readiness. Compute owners must decide whether to retain this fallback with its weaker evidence or require the private status path for every installation. A configured proxy that fails to return an acknowledgment never triggers the fallback.

The [driver](../../apps/controller/src/drivers/compute/kubernetes/index.ts) owns activation. The [conformance cases](../../tests/conformance/kubernetes-compute.test.mjs) distinguish a published binding from a binding the Gateway has loaded. They cover delayed acknowledgment, unauthorized activation and the second Gateway start without a proxy. A successful transfer requires exercising the data path separately.

<a id="alternatives-and-open-decisions"></a>

## Permissions required for in-place enrollment

**Pairing-code access.** The controller projects only the setup code in a mode-0440 Secret volume. Processes running as the Harness user can read it, and the node process receives it as an argument. Removing the code after pairing takes effect on the mount asynchronously. Security owners must decide whether single use and expiry justify exposing it to the Harness user. Rejecting that boundary requires a delivery path isolated from the other Harness processes. [Enrollment change and review request](https://github.com/openclaw/openclaw-enterprise/pull/616).

**Tenant Pod patches.** The worker annotates the running Pods to prompt kubelet to refresh the projected values. The tenant RoleBinding grants Pod patch permission, which also allows changes to labels used by Services. Tenant operators and Security must decide whether faster projection warrants that authority. Waiting for the normal kubelet refresh would remove the need for these annotation patches at the cost of slower first deploys. [Projection experiment](https://github.com/openclaw/openclaw-enterprise/pull/612).

The controller bounds acknowledgment waits and yields when another Agent has claimable work. This decision concerns first deploy only. Replacement availability belongs to [the replacement proposal](https://github.com/openclaw/openclaw-enterprise/pull/1045). The [storage and credential contract](../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md) describes the workload mounts.
