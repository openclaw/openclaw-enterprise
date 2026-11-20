---
rfc: index.md
---

# Configure a staged target through the worker

This amendment proposes worker-owned configuration and release-authorization callbacks and exposes the existing staged Sandbox and Credential Proxy contracts through the selected Drivers. It implements the ownership boundaries in the [Installation credential ownership amendment](installation-credential-ownership.md#prepare-an-agent-revision) and the [TokenService instance amendment](token-service-instance-and-updates.md#contract-and-verification-scope). It does not change their readiness or startup sequence.

## Caller and contract

OCC provisions the Namespace before Agent deployment. Compute prepares the backing namespace, then the selected OpenShell Sandbox Driver ensures the configured Gateway, checks Gateway readiness when configured, verifies Gateway health, and creates or verifies the active Workspace. This includes a Namespace-owned Gateway selected through `gateway.namespaceGatewayResources`. OCC marks the Namespace ready after each selected lifecycle participant completes. Agent Compute uses that ready Namespace backend and existing Workspace; it does not create the shared Gateway or Workspace during Agent staging. See [Namespace-owned Gateway setup](../../../docs/reference/drivers/openshell-sandbox/namespace-gateway.md) for qualification limits.

Installation validation rejects incompatible selectors before Agent admission. OCC TokenService with the native OpenShell proxy and OpenShell Sandbox is a valid selection. The native proxy requires an OpenShell Sandbox, and OpenShell TokenService with an external proxy is unsupported. Deployment separately validates the exact native Provider identity and Workspace before attaching a binding.

The worker calls `ComputeDriver.prepareRevision`. Compute creates or reconciles the Sandbox target during that call, so the worker cannot configure the proxy for the verified target beforehand. The [proxy deployment contract](../../../packages/contracts/src/drivers/credential-proxy/deployment.ts) needs a source-bound resolver to initialize delivery. Compute cannot call that operation directly without receiving the resolver. A callback lets the worker call the existing staged proxy API for the actual target while Compute continues to orchestrate preparation. Splitting `prepareRevision` would require another lifecycle operation and a way to retain the intermediate target.

Add these optional members to [ComputeRevisionContext](../../../packages/contracts/src/drivers/compute/index.ts):

```ts
readonly configureCredentialDeployment?: (
  expected: CredentialDeploymentConfiguration,
  signal: AbortSignal,
) => ReturnType<CredentialProxyDeploymentContract["configureDeployment"]>;
readonly verifyCredentialDeploymentRelease?: (
  startup: HarnessStartupRef,
  signal: AbortSignal,
) => Promise<void>;
```

The existing [HarnessStartupRef](../../../packages/contracts/src/drivers/sandbox/deployment.ts) includes the Namespace, Agent, revision, Sandbox incarnation, configuration ID, process instance, and startup ID. The release callback returns no credential or grant.

The worker captures the admitted revision, current claim, selected TokenService instance, proxy, bindings, and injection policies. When Compute supplies the staged target and configuration ID, the worker verifies its claim, current source authority, the target's Namespace and Agent ownership, and its live association with the admitted revision and configuration before source resolution. It calls `configureDeployment` with a resolver authorized for each binding's source. Before calling a resolver or attaching material, the scoped proxy verifies the actual Sandbox incarnation against that bound context. The proxy alone calls the resolver and retains credential material and any private delivery version. The callback returns only the contract's nonsecret projections.

Expose the staged operations as revision-scoped capabilities of the selected Drivers:

- `SandboxDriver.credentialDeployment(context)` returns `SandboxDeploymentContract`. The context binds the actual Namespace, immutable Agent revision, trusted Kubernetes client, and Harness transport token. Each operation verifies its deployment and target against that context.
- `CredentialProxyDriver.credentialDeployment(context)` returns the deployment operations from `CredentialProxyDeploymentContract`: `deployProxy`, `configureDeployment`, `getDeploymentStatus`, and `removeDeployment`. The context binds the actual Namespace and Agent revision. The Driver exposes `notifyCredentialUpdated` once at source scope, using the existing contract signature; source updates do not require an Agent revision.

Admission requires these Driver capabilities when an Agent revision selects staged TokenService credential delivery. Compute requires both worker callbacks on that staged path. Existing protected and unprotected revisions retain their current Driver paths. Vendor-specific policy contributions stay private to the paired Drivers.

Compute stages a credential-unaware Sandbox target with credential-using execution held. If the selected proxy requires routes or a public trust bundle to stage the target, Compute prepares those nonsecret inputs first. Once the target is reconciled, Compute invokes the worker callback to configure the proxy for that exact target. Compute then applies the complete network access policy through the Sandbox and independently observes Sandbox network status and proxy injection status for the same configuration. OCC rejects unsupported or weakening overlaps at admission. The Sandbox owns network enforcement; the proxy owns per-binding injection. Paired OpenShell implementations can combine their supplier configuration privately without adding credential types to the Sandbox contract.

After both observations are ready, Compute authenticates the held startup, installs and acknowledges its projections, and rechecks readiness. Immediately before signing release, Compute calls and awaits `verifyCredentialDeploymentRelease(startup, signal)`. The worker freshly verifies its claim, the target's Namespace and Agent ownership and live revision/configuration association, and that the Agent remains active, desires running, and still authorizes the candidate revision. It calls the Sandbox's `getHarnessProcessStatus(startup, signal)` and requires the authenticated result to identify the exact supplied startup as held with projections installed. It derives the exact source references from the admitted bindings configured through the first callback and verifies each against the selected TokenService instance, current authority, and withdrawal state. A missing callback, cancellation, rejection, or identity mismatch prevents signing and release. Compute then signs and delivers release for that startup and verifies serving before activation. The worker activates and reconciles the revision. After a lost reply, Compute observes the existing startup before retrying. If target staging fails, it can remove only unbound proxy resources through the existing removal operation.

## Acceptance criteria

Use the regular Agent deployment workflow to prove that the worker configures the actual Sandbox ID and returns only projections to Compute. Denied source authority, the wrong target or configuration, failed delivery, stale readiness, a missing startup acknowledgment, or a failed release callback must prevent release. Source withdrawal after configuration, an Agent stop, or a superseding revision while startup is held must also prevent release. Verify that Compute signs only for the acknowledged startup and that a retry cannot release a replacement with an earlier grant. Qualify an allowed Agent request and a denial before the origin through the selected real runtime.

Select OCC TokenService, a dedicated Harness, and the native embedded Credential Proxy with the ready Namespace Gateway and Workspace. Use one OCC-owned static source and prove that the worker-authorized, source-bound resolver supplies its credential to the native OpenShell proxy before startup release. The held startup and combined native network and injection configuration belong to this path. Embedded Harness mode is outside this qualification.
