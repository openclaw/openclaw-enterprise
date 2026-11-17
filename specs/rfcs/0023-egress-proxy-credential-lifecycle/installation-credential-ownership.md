---
rfc: index.md
---

# Select one credential owner per Installation

This proposed amendment changes the v1 delivery decision in RFC-0023 and the OAuth custody decision in RFC-0027. An Installation selects a TokenService Driver. OCC owns source metadata, Agent bindings and IAM. The selected Driver owns usable values, issuer keys and refresh grants. OCC's implementation uses SecretDriver. OpenShell's implementation uses the configured Gateway and the Workspace established through the existing Namespace lifecycle. One registration can provide several capabilities. A change to Installation selection cannot transfer custody of a registered source.

## Register and use a source

OCC allocates the scoped source identity before sending write-only material and lifecycle settings to the selected owner. After success it records the selected Driver ID and any nonsecret backend reference. Reads of source metadata never return material. The owner can replace material or lifecycle settings, export the authorized usable value, start refresh and report its status. OCC resolves only after authorizing the consumer. Console discovery uses the authorized value directly. Compute delivers Gateway startup credentials at deployment. A Gateway must restart to pick up a replacement.

At deployment the deployer and Agent service principal both need operate permission on each bound source. The Agent needs no grant on the underlying Secret. Installation OAuth client registrations have their own identity and metadata. Their secrets remain with the owner and cannot be bound to an Agent. The issuer retains GitHub App keys, and OCC's Git repository and branch authorization applies with either owner.

OCC withdraws bindings before deleting owner material. If registration has an uncertain outcome, a supporting owner can remove material by the allocated identity even when OCC received no backend reference. The protocol requires no background repair operation.

## Configure delivery

For OCC-owned material, the proxy initializes a shared delivery resource from the current version on first use. It keys the resource by Namespace and source, and configures the placeholder and injection rule per deployment binding. A source change pushes a versioned value only to an existing delivery resource. A failed push leaves the new source value authoritative. OCC reports a sanitized failure and an authorized administrator can push again. Refresh status describes issuance. A subsequent deployment reuses the delivery resource without repairing it. Implementations must coordinate initialization with updates.

For OpenShell-owned material the embedded proxy attaches the registered native provider after checking its backend and Workspace. Missing or incompatible references fail preparation. OpenShell manages native renewal. An external proxy cannot deliver these sources in v1. The embedded proxy requires an OpenShell Sandbox. A standalone proxy requires an OCC owner and a Sandbox that enforces its routing. Withdrawing a deployment preserves shared resources still in use. The proxy can delete unused delivery resources. Only TokenService deletes authoritative material.

## Prepare an Agent revision

PluginDriver describes the selected tools, pinned artifacts, workload requirements, network grants and credential requirements for each named connection. OCC admits source references. Compute coordinates the appropriate runtime to install and verify the tools. SandboxDriver provisions an execution target and applies process restrictions, network policy and any mandatory proxy routing. CredentialProxyDriver configures injection per binding and returns projection descriptors. The runtime supplies fresh placeholders when the Harness starts.

Network access and injection each match the executable, destination and ports, with HTTP or MCP restrictions where required. A credentialless plugin can request network access alone. An allowed connection cannot use a placeholder outside its binding's injection rules. Admission enforces the Installation ceiling. Preparation fails if overlapping rules weaken a restriction, the target can bypass required routing, or either enforcing Driver cannot represent its policy. Preserve any additional request authorization required by a binding.

1. Compute sends the logical revision identity and admitted policies to the proxy. A standalone proxy can return a public trust bundle and mandatory routes for Sandbox creation. Its signing key stays with the proxy. If creation fails, Compute can release unbound proxy resources by revision identity.
2. The Sandbox stages a target with credential-using execution held. Subsequent calls identify its exact incarnation. For OpenShell, attach the providers to the staged target, then apply the combined network and injection configuration with the current native resource version. On conflict, read the current version and recompose the policy.
3. Compute observes network and proxy readiness for the same desired configuration after the final write. For OpenShell, the submitted base policy must be active and each provider must be ready for the current effective policy. A pending snapshot mismatch keeps the Harness held even when installation flags are true. A standalone proxy must verify the intended material is usable. Health and reload acknowledgments alone cannot establish that.
4. The runtime installs fresh projections and prepares the Harness. A standalone proxy can issue the placeholder. On OpenShell a fresh process or session receives the installed placeholder. The worker revisits pending preparation and activates only after tools, workload, routing and bindings are ready. Compute must observe activation of the intended Harness instance. Durable ownership and observation of that process across disconnects and restarts still need qualification.

A rejected withdrawal leaves the old policy in force and cannot count as completion. Enforce executable and port restrictions in the Sandbox if the proxy cannot distinguish them, or reject the policy. Reject stale or misplaced placeholders even on an allowed network request. Request-time sandbox pulls and automatic push recovery are deferred.

## Contract entry points

- [TokenServiceDriver](../../../packages/contracts/src/drivers/token-service/index.ts) owns the six source operations. OCC validates and persists its registration and supplies the recorded reference to trusted consumers. Client-registration material has a separate Installation identity and no delivery binding.
- [Plugin deployment](../../../packages/contracts/src/drivers/plugin/deployment.ts) describes one plugin at a time. Tool IDs connect each named credential to its consumer and reviewed request requirements. An installed plugin may declare a credential requirement with zero connected accounts.
- [Sandbox deployment](../../../packages/contracts/src/drivers/sandbox/deployment.ts) and [proxy deployment](../../../packages/contracts/src/drivers/credential-proxy/deployment.ts) share [deployment references and policies](../../../packages/contracts/src/credential-deployment.ts). Compute supplies both policies for the same target incarnation. Their implementing Drivers observe current desired state independently. Each conversion of an existing Driver and its real caller must land together.

## Qualification

Exercise OCC ownership with embedded and standalone proxies, and native ownership with the embedded proxy and no SecretDriver. Verify first use after a source update, sharing across Agents with different request policies, denied injection on an allowed connection, failed push and manual recovery, withdrawal and sandbox replacement. Verify native OAuth and Git issuance, shared client-secret rotation, Console export and Gateway restart with the selected owner. These are release requirements. The amendment alone establishes no runtime support.
