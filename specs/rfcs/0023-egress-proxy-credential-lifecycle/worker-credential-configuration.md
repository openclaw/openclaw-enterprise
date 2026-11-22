---
rfc: index.md
---

# Configure a staged target through the worker

This amendment proposes worker-owned configuration and release-authorization callbacks, a staged Sandbox capability, and staged operations directly on the selected Credential Proxy Driver. It implements the ownership boundaries in the [Installation credential ownership amendment](installation-credential-ownership.md#prepare-an-agent-revision) and the [TokenService instance amendment](token-service-instance-and-updates.md#contract-and-verification-scope). It does not change their readiness or startup sequence.

The [native delivery amendment](#amendment-select-native-delivery-independently) supersedes the proxy interface choice below.

## Caller and contract

OCC provisions the Namespace before Agent deployment. Compute prepares the backing namespace, then the selected OpenShell Sandbox Driver ensures the configured Gateway, checks Gateway readiness when configured, verifies Gateway health, and creates or verifies the active Workspace. This includes a Namespace-owned Gateway selected through `gateway.namespaceGatewayResources`. OCC marks the Namespace ready after each selected lifecycle participant completes. Agent Compute uses that ready Namespace backend and existing Workspace; it does not create the shared Gateway or Workspace during Agent staging. See [Namespace-owned Gateway setup](../../../docs/reference/drivers/openshell-sandbox/namespace-gateway.md) for qualification limits.

Installation validation rejects incompatible selectors before Agent admission. OCC TokenService with the native OpenShell proxy and OpenShell Sandbox is a valid selection. The native proxy requires an OpenShell Sandbox, and OpenShell TokenService with an external proxy is unsupported. Deployment separately validates the exact native Provider identity and Workspace before attaching a binding.

The worker calls `ComputeDriver.prepareRevision`. Compute creates or reconciles the Sandbox target during that call, so the worker cannot configure the proxy for the verified target beforehand. Configuring delivery through [CredentialProxyDriver](../../../packages/contracts/src/drivers/credential-proxy/index.ts) needs a source-bound resolver. Compute cannot call that operation directly without receiving the resolver. A callback lets the worker configure delivery for the actual target while Compute continues to orchestrate preparation. Splitting `prepareRevision` would require another lifecycle operation and a way to retain the intermediate target.

Add these optional members to [ComputeRevisionContext](../../../packages/contracts/src/drivers/compute/index.ts):

```ts
readonly configureCredentialDeployment?: (
  expected: CredentialDeploymentConfiguration,
  signal: AbortSignal,
) => Promise<{ readonly credentialProjections: readonly CredentialProjection[] }>;
readonly verifyCredentialDeploymentRelease?: (
  startup: HarnessStartupRef,
  signal: AbortSignal,
) => Promise<void>;
```

The historical [HarnessStartupRef](https://github.com/openclaw/openclaw-enterprise/blob/840e8ac0044e0d803f7975632ce4d58e3c9f9006/packages/contracts/src/drivers/sandbox/deployment.ts) included the Namespace, Agent, revision, Sandbox incarnation, configuration ID, process instance, and startup ID. The release callback returned no credential or grant. The fresh-start amendment below supersedes this interface.

The worker captures the admitted revision, current claim, selected TokenService instance, proxy, bindings, and injection policies. When Compute supplies the staged target and configuration ID, the worker verifies its claim, current source authority, the target's Namespace and Agent ownership, and its live association with the admitted revision and configuration before source resolution. It calls `configureDeployment` with a resolver authorized for each binding's source. Before calling a resolver or attaching material, the scoped proxy verifies the actual Sandbox incarnation against that bound context. The proxy alone calls the resolver and retains credential material and any private delivery version. The callback returns only the contract's nonsecret projections.

Expose staged Sandbox operations through the selected `SandboxDriver`:

- `SandboxDriver.credentialDeployment(context)` returns `SandboxDeploymentContract`. The context binds the actual Namespace, immutable Agent revision, trusted Kubernetes client, and Harness transport token. Each operation verifies its deployment and target against that context.

Put the staged proxy operations directly on `CredentialProxyDriver` and remove `CredentialProxyDeploymentContract` and its export. Each deployment operation receives the trusted Namespace, Agent revision, and cancellation signal separately from its requested deployment or target. It rejects a request that does not match that context. The existing `ProxyRevisionContext` projection avoids requiring the protected path's `ProxyPlan`.

```ts
deployProxy?(
  context: Pick<ProxyRevisionContext, "namespace" | "revision" | "signal">,
  input: {
    readonly deployment: CredentialDeploymentRef;
    readonly networkAccessPolicy: NetworkAccessPolicy;
    readonly injectionPolicies: readonly CredentialInjectionPolicy[];
  },
): Promise<{ readonly proxyRouting?: CredentialProxyRouting }>;
configureDeployment?(
  context: Pick<ProxyRevisionContext, "namespace" | "revision" | "signal">,
  input: CredentialDeploymentConfiguration & {
    readonly bindings: readonly {
      readonly binding: DeploymentCredentialBinding;
      readonly resolveCredential: () => Promise<ResolvedCredential>;
      readonly sharedProviderRef?: Readonly<Record<string, string>>;
    }[];
    readonly injectionPolicies: readonly CredentialInjectionPolicy[];
  },
): Promise<{ readonly credentialProjections: readonly CredentialProjection[] }>;
getDeploymentStatus?(
  context: Pick<ProxyRevisionContext, "namespace" | "revision" | "signal">,
  expected: CredentialDeploymentConfiguration,
): Promise<CredentialDeploymentReadiness>;
removeDeployment?(
  context: Pick<ProxyRevisionContext, "namespace" | "revision" | "signal">,
  input:
    | { readonly targetRef: CredentialDeploymentTarget; readonly bindingRefs?: readonly string[] }
    | { readonly unboundDeployment: CredentialDeploymentRef },
): Promise<void>;
notifyCredentialUpdated?(
  notification: CredentialUpdateNotification,
  resolveCredential: () => Promise<ResolvedCredential>,
  signal: AbortSignal,
): Promise<void>;
```

`configureDeployment` calls a binding's resolver only for first-use material transfer, never to attach a shared Provider. `getDeploymentStatus` observes without repair, reload, or upstream operations. For the expected configuration, each pushed binding requires a serving copy on this target, and every serving copy must have the expected version. Shared Provider bindings require the current effective policy.

`notifyCredentialUpdated` belongs to source scope and receives no Agent revision. Its resolver is authorized only for the notification's exact source. With no delivery resource, the update succeeds without resolving material or creating a resource. Otherwise, it resolves material only when transfer is needed. A material push requires a version on the resolved material and acknowledges only after every serving copy can use that version. Concurrent updates cannot restore an older version. Move `CredentialUpdateNotification` to the Driver's public types. Implementing source-scoped push updates through TokenService and Credential Proxy remains future work.

Admission rejects staged TokenService credential delivery if a required Driver operation is absent. Compute requires both worker callbacks on that staged path. Existing protected and unprotected revisions retain their current Driver paths. Vendor-specific policy contributions stay private to the paired Drivers.

Compute stages a credential-unaware Sandbox target with credential-using execution held. If the selected proxy requires routes or a public trust bundle to stage the target, Compute prepares those nonsecret inputs first. Once the target is reconciled, Compute invokes the worker callback to configure the proxy for that exact target. Compute then applies the complete network access policy through the Sandbox and independently observes Sandbox network status and proxy injection status for the same configuration. OCC rejects unsupported or weakening overlaps at admission. The Sandbox owns network enforcement; the proxy owns per-binding injection. Paired OpenShell implementations can combine their supplier configuration privately without adding credential types to the Sandbox contract.

After both observations are ready, Compute authenticates the held startup, installs and acknowledges its projections, and rechecks readiness. Immediately before signing release, Compute calls and awaits `verifyCredentialDeploymentRelease(startup, signal)`. The worker freshly verifies its claim, the target's Namespace and Agent ownership and live revision/configuration association, and that the Agent remains active, desires running, and still authorizes the candidate revision. It calls the Sandbox's `getHarnessProcessStatus(startup, signal)` and requires the authenticated result to identify the exact supplied startup as held with projections installed. It derives the exact source references from the admitted bindings configured through the first callback and verifies each against the selected TokenService instance, current authority, and withdrawal state. A missing callback, cancellation, rejection, or identity mismatch prevents signing and release. Compute then signs and delivers release for that startup and verifies serving before activation. The worker activates and reconciles the revision. After a lost reply, Compute observes the existing startup before retrying. If target staging fails, it can remove only unbound proxy resources through the existing removal operation.

## Acceptance criteria

Use the regular Agent deployment workflow to prove that the worker configures the actual Sandbox ID and returns only projections to Compute. Denied source authority, the wrong target or configuration, failed delivery, stale readiness, a missing startup acknowledgment, or a failed release callback must prevent release. Source withdrawal after configuration, an Agent stop, or a superseding revision while startup is held must also prevent release. Verify that Compute signs only for the acknowledged startup and that a retry cannot release a replacement with an earlier grant. Qualify an allowed Agent request and a denial before the origin through the selected real runtime.

Select OCC TokenService, a dedicated Harness, and the native embedded Credential Proxy with the ready Namespace Gateway and Workspace. Use one OCC-owned static source and prove that the worker-authorized, source-bound resolver supplies its credential to the native OpenShell proxy before startup release. The held startup and combined native network and injection configuration belong to this path. Embedded Harness mode is outside this qualification.

## Amendment: select native delivery independently

The earlier decision put staged operations on the then-current `CredentialProxyDriver`, which also required the legacy protected-source catalog and revision-wiring operations. Rename that serving contract to `LegacyEgressProxyDriver`. The new `CredentialProxyDriver` owns staged credential delivery and does not implement or forward legacy operations.

Move the five staged operations above, with their existing inputs and results, to the canonical `CredentialProxyDriver`, temporarily registered as `credential_proxy_delivery`. Its four deployment operations use a neutral `CredentialDeploymentContext` (Namespace, Agent revision, signal) and are required; source update notification remains optional. Keep the `credential_proxy` selection for `LegacyEgressProxyDriver` until legacy protected serving is removed. Then remove the legacy contract and give the canonical Driver the `credential_proxy` selection. When OCC TokenService is selected, composition pairs native delivery with its selected Sandbox and Backend, without another installation setting. An OpenShell Gateway service and Workspace do not require selecting the legacy `CredentialGatewayDriver`. The staged Worker and Compute callers use the selected delivery capability, while current protected callers retain their existing selection and owner identity.

Keep one public definition of each staged operation. Do not expose credential material through composition or Compute. A missing operation, source authority, exact target, current version, enforced policy, or held-startup acknowledgment prevents release. The native implementation remains unqualified until the regular Agent workflow proves allowed and denied requests through the real runtime.

## Amendment: hold startup until revision activation

The first staged managed-credential deployment is supported. Replacement involving a staged managed-credential revision is unsupported until the post-CP2 routing and drain work. Refuse that replacement before preparing the candidate, changing the active pointer, releasing a Harness, or changing predecessor routes or backends. Refuse withdrawal of its TokenService source before saving state or queuing work until that operation is supported. If a failed launch already selected a revision, complete Stop and confirm retirement before retrying.

This amendment changes the release timing in the staged sequence above. Kubernetes Compute `prepareRevision` prepares the exact Sandbox target, configures credential delivery and network policy, checks both effective readiness observations, and obtains the held startup's projection acknowledgment. A distinct prepared observation permits activation without claiming the Harness is ready. Preparation neither releases credential-using execution nor requires a serving Harness or connected workspace node.

After committing the selected revision, the worker calls `activateRevision`. Compute checks the same startup and current policy and proxy readiness, requests one Worker authorization check for the Agent and exact CredentialSources, and releases that startup. An authorized operation may finish while a grant changes. Compute confirms authenticated Harness serving and workspace-node readiness before exposing Agent routing or completing activation. An incomplete observation keeps activation pending. On retry, Compute observes and adopts the same startup after an uncertain release; it does not release a replacement or launch another Harness. An absent staged Sandbox or proxy adapter still refuses admission.

Verify this order through the real worker and PostgreSQL: preparation must not release the Harness; release requires ordinary source authorization; and routing requires a serving Harness and ready workspace node.

## Amendment: activate a fresh Harness

The [fresh Harness amendment](installation-credential-ownership.md#amendment-start-a-fresh-harness-at-activation) supersedes the held-startup and signed-release mechanics above. Compute provides the authenticated Gateway operator route for node enrollment and prepares an idle target, credential route, effective policies, and fresh launch inputs. Worker authorizes the Agent and its exact source once before activation. The Sandbox starts the Harness at activation, and Compute publishes user chat and delegated browser routes after normal readiness. Remove the superseded startup challenge, signed release, and dispatch-fence contract rather than keeping them as compatibility paths.
