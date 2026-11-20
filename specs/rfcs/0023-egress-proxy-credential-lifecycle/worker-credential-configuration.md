---
rfc: index.md
---

# Configure a staged target through the worker

This amendment proposes one worker-owned configuration callback and exposes the existing staged Sandbox and Credential Proxy contracts through the selected Drivers. It implements the ownership boundaries in the [Installation credential ownership amendment](installation-credential-ownership.md#prepare-an-agent-revision) and the [TokenService instance amendment](token-service-instance-and-updates.md#contract-and-verification-scope). It does not change their readiness or startup sequence.

## Caller and contract

The worker calls `ComputeDriver.prepareRevision`. Compute creates the Sandbox during that call, so the worker cannot configure the exact target beforehand. The [proxy deployment contract](../../../packages/contracts/src/drivers/credential-proxy/deployment.ts) needs a source-bound resolver to initialize delivery. Compute cannot call that operation directly without receiving the resolver. A callback lets the worker call the existing staged proxy API for the actual target while Compute continues to orchestrate preparation. Splitting `prepareRevision` would require another lifecycle operation and a way to retain the intermediate target.

Add this optional member to [ComputeRevisionContext](../../../packages/contracts/src/drivers/compute/index.ts):

```ts
readonly configureCredentialDeployment?: (
  expected: CredentialDeploymentConfiguration,
  signal: AbortSignal,
) => ReturnType<CredentialProxyDeploymentContract["configureDeployment"]>;
```

The worker captures the admitted revision, current claim, selected TokenService instance, proxy, bindings, and injection policies. When Compute supplies the provisioned target and configuration ID, the worker checks the revision and configuration identity, verifies its claim and current source authority, and calls `configureDeployment` with a resolver authorized for each binding's source. Before calling a resolver or attaching material, the scoped proxy verifies that the supplied Sandbox ID is the actual target incarnation owned by its bound Namespace and revision. The proxy alone calls the resolver and retains credential material and any private delivery version. The callback returns only the contract's nonsecret projections.

Expose the staged operations as revision-scoped capabilities of the selected Drivers:

- `SandboxDriver.credentialDeployment(context)` returns `SandboxDeploymentContract`. The context binds the actual Namespace, immutable Agent revision, trusted Kubernetes client, and Harness transport token. Each operation verifies its deployment and target against that context.
- `CredentialProxyDriver.credentialDeployment(context)` returns the deployment operations from `CredentialProxyDeploymentContract`: `deployProxy`, `configureDeployment`, `getDeploymentStatus`, and `removeDeployment`. The context binds the actual Namespace and Agent revision. The Driver exposes `notifyCredentialUpdated` once at source scope, using the existing contract signature; source updates do not require an Agent revision.

Admission requires these capabilities when an Agent revision selects staged TokenService credential delivery. Existing protected and unprotected revisions retain their current Driver paths. Vendor-specific policy contributions stay private to the paired Drivers.

Compute stages a credential-unaware Sandbox target with credential-using execution held. If the selected proxy requires routes or a public trust bundle at creation, Compute prepares those nonsecret inputs first. Once the target exists, Compute invokes the worker callback to configure the proxy for that exact target. Compute then applies the complete network access policy through the Sandbox and independently observes Sandbox network status and proxy injection status for the same configuration. OCC rejects unsupported or weakening overlaps at admission. The Sandbox owns network enforcement; the proxy owns per-binding injection. Paired OpenShell implementations can combine their supplier configuration privately without adding credential types to the Sandbox contract.

After both observations are ready, Compute authenticates the held startup, installs and acknowledges its projections, rechecks readiness, signs and delivers release, and verifies serving before activation. The worker activates and reconciles the revision. After a lost reply, Compute observes the existing startup before retrying. If Sandbox creation fails, it can remove only unbound proxy resources through the existing removal operation.

## Acceptance criteria

Use the regular Agent deployment workflow to prove that the worker configures the actual Sandbox ID and returns only projections to Compute. Denied source authority, the wrong target or configuration, failed delivery, stale readiness, or a missing startup acknowledgment must prevent release. Verify that Compute signs only for the acknowledged startup and that a retry cannot release a replacement with an earlier grant. Qualify an allowed Agent request and a denial before the origin through the selected real runtime.
