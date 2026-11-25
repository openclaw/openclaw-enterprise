---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Gateway startup credentials

**RFC-20261125-gateway-startup-credentials** · Created 2026-11-25

A Gateway needs usable credentials to connect to services such as Slack. Today, Slack uses Namespace Secrets. [Credential Design 1.0](20261124-credential-design-1-0/index.md) also lets TokenService own credentials, including material held by OpenShell outside Kubernetes. The Gateway has no startup path for those Sources.

**Approach:** Keep the dedicated Gateway's existing canonical Namespace Secret projection and embedded Secret delivery unchanged. For a CredentialSource, the OCC deployment worker authorizes the exact binding, resolves its value from the admitted TokenService owner, and gives Compute the value for dedicated Gateway startup.

**Tradeoff:** This works without changing the Gateway or transferring authoritative custody. But Kubernetes needs a second usable copy in the Gateway Pod namespace. Anyone allowed to create or change workloads there can mount that copy elsewhere. A running Gateway also retains its old value until redeploy, and revocation cannot erase its environment. Source delivery must remain disabled until this exposure is approved or stronger isolation is available.

## Delivery flow

1. OCC admits only eligible, ready Sources from the selected TokenService instance, with supported dedicated Gateway delivery. Every Source's immutable owner must match both the selected instance and the instance saved in the revision. Reject Source or exported Gateway delivery in embedded mode, and reject unsupported bindings before saving the revision.
2. The [worker](../../apps/controller/src/worker.ts) calls the selected Compute Driver's `prepareRevision` with a revision context. The Driver runs in the worker process; there is no separate Compute Pod receiving the value. When it needs startup material, the Driver invokes `context.gatewayStartupCredentials.resolve(signal)`. This worker-owned callback verifies the claim, Agent state, revision, owner, eligibility, and both principals' grants before and after reading from TokenService (or the selected Secret Driver for a supported export), then returns a map of Gateway environment names to values in process memory. The Driver cannot select another Source or destination; there is no fallback.
3. The selected Compute Driver owns delivery. **Kubernetes Compute** writes the exported values through the Kubernetes API into a revision-specific Secret in the Gateway Pod namespace. It configures the Gateway container's `env[].valueFrom.secretKeyRef` to reference that Secret; the kubelet reads it and supplies the environment when starting the Pod. Existing canonical Namespace Secrets remain direct references. A different Compute Driver must provide its own qualified startup transport or reject the binding; it does not automatically create a Kubernetes Secret. Where used, the selected Secret Driver owns Secret storage or export; it does not choose Compute's startup transport.
4. For exported delivery, Compute authorizes all Gateway bindings immediately before any mutation that can start the Gateway, including mixed bindings and retries. Authorization, read, and staging failures precede that mutation; a later Kubernetes `Recreate` rollout failure can interrupt the predecessor. Sanitize errors and remove abandoned or retired copies without deleting owner material.

If a candidate staged A but has not launched when the owner changes to B, retry with B. Observe the same workload after an uncertain launch. An OCC-managed redeploy uses the newly resolved value. A kubelet-only restart can reuse the old staged copy; revocation blocks subsequent OCC-managed starts.

## Interface changes

### APIs

Extend [SecretBinding.source](../../packages/contracts/src/index.ts) with `CredentialSourceReference` alongside `SecretReference`. Keep exact same-Namespace references, environment destinations, limits, and reserved names. Existing Slack discovery and preflight stay unchanged; refuse Source-backed Slack fields until those consumers are separately extended and qualified.

### IAM

Reuse `operate` on each exact Secret or Source. Configuration save and Agent assignment require the caller's grant; deployment requires both deployer and Agent service principal grants.

### Database entities

Persist references, never values, in Configuration and Agent revision. Record one private `gatewayTokenServiceInstanceId` for all Gateway Source bindings. Do not add them to Harness credential lists. Block Source removal or withdraw its references and delivery copies first; include Configurations, Agents, queued or active revisions, and queued or running provisioning plans. Gateway-only Sources must not acquire Proxy or other consumer associations through enrollment, update, or withdrawal.

### Driver contracts

Add to [ComputeRevisionContext](../../packages/contracts/src/drivers/compute/index.ts):

```ts
readonly gatewayStartupCredentials?: {
  authorize(signal: AbortSignal): Promise<void>;
  resolve(signal: AbortSignal): Promise<Readonly<Record<string, string>>>;
};
```

For exported inputs, require both methods: `resolve` returns only the selected Gateway variables; `authorize` checks all bindings without reading values. Secret-only deployments retain their existing worker authorization path. Reuse [TokenService.resolveCredential](../../packages/contracts/src/drivers/token-service/index.ts) and optional [SecretDriver.withValue](../../packages/contracts/src/drivers/secret/index.ts). Keep canonical Namespace Secret projections direct. OCC must not expose exported values to the Harness, other containers, APIs, revisions, logs, or diagnostics.

## Initial support

| Owner or Compute                               | Scope                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes Namespace Secret                    | Existing Slack path; preserve canonical Secret freshness when a Pod is replaced.                                                        |
| OCC TokenService                               | Propose static Sources with Kubernetes dedicated Gateway delivery.                                                                      |
| OpenShell TokenService                         | Preserve external custody and authorized operator export. Its current OpenAI model profile does not qualify Gateway channel enrollment. |
| Other Secret Drivers or non-Kubernetes Compute | Refuse until secure read or projection, startup delivery, and cleanup are qualified.                                                    |

## Simplifications

Keeping only Namespace Secrets would be simpler, but would not let a Gateway consume TokenService-owned material. Having the Gateway fetch from TokenService avoids a delivery copy but requires new Gateway integration and authorization. The proposed worker path reuses current owner resolution and Compute startup delivery. No infrastructure simplifications.

## Decisions needed

- Accept access by Gateway namespace workload managers, or require stronger isolation.
- Define the Gateway-only profile and allowed fields for the existing `static` Source type; qualify OpenShell separately.
- Decide whether immediate copy removal on revocation or current values on bare Pod restart are required. Recommend OCC-managed redeploy as the initial freshness guarantee.

## Acceptance Criteria

Use the real API, PostgreSQL worker, Kubernetes Compute, and native Gateway process:

- **AC1:** The Gateway observes A, keeps A after its Source is replaced with B, and observes B after managed redeploy. An unlaunched retry staged with A must start with B. Verify process identity and compare a digest without exposing plaintext.
- **AC2:** Deny each principal, revoke during owner I/O, and deny staged reuse; each must prevent Gateway mutation. A queued provisioning plan as the sole reference must block Source deletion. Check sanitized failures.
- **AC3:** Verify Gateway-only projection, cleanup, and that ordinary workload identities cannot read the copy or create workloads that mount it. This does not protect against namespace administrators.
- **AC4:** Preserve Slack preflight and discovery checks. A canonical Secret update followed by bare Gateway Pod replacement must observe the update. Qualify actual OpenShell export separately.
