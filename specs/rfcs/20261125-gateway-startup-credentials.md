---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Gateway startup credentials

**RFC-20261125-gateway-startup-credentials** · Created 2026-11-25 · [Implementation plan](../plans/20261125-gateway-startup-credentials.md)

A Gateway needs usable credentials to connect to services such as Slack. Today, Slack uses Namespace Secrets. [Credential Design 1.0](20261124-credential-design-1-0/index.md) also lets TokenService own credentials, including material held by OpenShell outside Kubernetes. The Gateway has no startup path for those Sources.

**Approach:** Use `Configuration.secretBindings` to select credentials for Gateway startup. An authorized caller can explicitly bind any supported static CredentialSource, including one also used by Credential Proxy. The OCC worker authorizes the exact binding and resolves TokenService's value; Compute delivers it only to the dedicated Gateway. No Gateway-specific Source profile or native field allowlist is required. Preserve existing Namespace Secret delivery.

**Accepted tradeoff:** An explicit Gateway binding authorizes a usable copy outside Credential Proxy's request restrictions. Kubernetes stages that copy in the Gateway Pod namespace, where workload managers can mount it elsewhere. The running Gateway retains its startup value until managed redeploy; revocation does not erase its environment or immediately remove the staged copy.

## Delivery flow

1. OCC admits a ready static Source from the same Namespace when its recorded owner matches the selected TokenService instance and dedicated Gateway export is supported. Model presets, Connection Templates, and other consumer bindings do not disqualify it. Record the selected instance in the revision. Reject unsupported or embedded Source delivery before saving the revision.
2. The [worker](../../apps/controller/src/worker.ts) calls Compute's `prepareRevision`. Compute runs in the worker process and invokes `context.gatewayStartupCredentials.resolve(signal)`. The worker verifies the claim, Agent, revision, owner, supported binding, and both principals' grants before and after reading from TokenService (or the selected Secret Driver for a supported export). It returns only the explicitly bound Gateway environment names and values in memory.
3. The selected Compute Driver owns delivery. Kubernetes Compute creates a revision-specific Secret in the Gateway Pod namespace and references it from the Gateway Deployment, as shown below. Existing canonical Namespace Secrets remain direct references. Other Compute Drivers must use their own qualified transport or refuse delivery. The Secret Driver owns storage or export, not startup transport.
4. For exported delivery, Compute authorizes all Gateway bindings immediately before any mutation that can start the Gateway, including mixed bindings and retries. Authorization, read, and staging failures precede that mutation; a later Kubernetes `Recreate` rollout failure can interrupt the predecessor. Sanitize errors and remove abandoned or retired copies without deleting owner material.

If a candidate staged A but has not launched when the owner changes to B, retry with B. Observe the same workload after an uncertain launch. An OCC-managed redeploy uses the newly resolved value. A kubelet-only restart can reuse the old staged copy; revocation blocks subsequent OCC-managed starts.

### Kubernetes Compute example

Suppose the worker resolves `GW_HOOK_TOKEN` from TokenService and passes its value to Compute in memory. Kubernetes Compute creates this Secret through the Kubernetes API (the value below is synthetic):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gateway-credentials-rev-123
  namespace: tenant-example
type: Opaque
data:
  GW_HOOK_TOKEN: ZXhhbXBsZQ==
```

It then references the Secret in the Gateway Deployment's Pod template:

```yaml
# Deployment excerpt; the Deployment uses the same namespace as the Secret.
spec:
  template:
    spec:
      containers:
        - name: gateway
          env:
            - name: GW_HOOK_TOKEN
              valueFrom:
                secretKeyRef:
                  name: gateway-credentials-rev-123
                  key: GW_HOOK_TOKEN
```

The kubelet reads that Secret and supplies the decoded value in the Gateway container's environment at startup. The Deployment, container image, and OCC Configuration do not contain the token. The Kubernetes Secret does contain a usable copy: `data` is base64-encoded, not encrypted by that encoding.

## Interface changes

### APIs

Extend [SecretBinding.source](../../packages/contracts/src/index.ts) with `CredentialSourceReference` alongside `SecretReference`. Keep exact same-Namespace references, environment destinations, limits, reserved names, and native Configuration validation. Do not add a Gateway field allowlist. Existing Slack discovery and preflight remain Namespace Secret-only. If an enabled Slack credential input selects a Source, refuse that unsupported integration until qualified; an environment name alone does not disqualify a Gateway binding.

### IAM

Reuse `operate` on each exact Secret or Source, with the normal Configuration, Agent, and deployment permissions. Configuration save and Agent assignment require the caller's grant; deployment requires both deployer and Agent service principal grants. These permissions authorize explicit Gateway export even when the Source is also used through Credential Proxy.

### Database entities

Persist references, never values, in Configuration and Agent revision. Record one private `gatewayTokenServiceInstanceId` for all Gateway Source bindings. Gateway bindings do not create Harness or Proxy bindings. Changing a Gateway binding must not change another consumer's binding. Block Source removal or withdraw all references and delivery copies first; include Configurations, Agents, queued or active revisions, and queued or running provisioning plans.

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

| Owner or Compute                               | Scope                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Kubernetes Namespace Secret                    | Existing Slack path; preserve canonical Secret freshness when a Pod is replaced.                       |
| OCC TokenService                               | Propose static Sources with Kubernetes dedicated Gateway delivery.                                     |
| OpenShell TokenService                         | Preserve external custody; qualify authorized operator export and Gateway startup delivery separately. |
| Other Secret Drivers or non-Kubernetes Compute | Refuse until secure read or projection, startup delivery, and cleanup are qualified.                   |

## Simplifications

Keeping only Namespace Secrets would be simpler, but would not let a Gateway consume TokenService-owned material. Having the Gateway fetch from TokenService avoids a delivery copy but requires new Gateway integration and authorization. The proposed worker path reuses current owner resolution and Compute startup delivery. No infrastructure simplifications.

## Acceptance Criteria

Use the real API, PostgreSQL worker, Kubernetes Compute, and native Gateway process:

- **AC1:** The Gateway observes A, keeps A after its Source is replaced with B, and observes B after managed redeploy. An unlaunched retry staged with A must start with B. Verify process identity and compare a digest without exposing plaintext.
- **AC2:** Deny each principal, revoke during owner I/O, and deny staged reuse; each must prevent Gateway mutation. A queued provisioning plan as the sole reference must block Source deletion. Verify attributable evidence for the actor, exact Source and revision, without credential values, and sanitized failures.
- **AC3:** Verify Gateway-only projection, cleanup, and that ordinary workload identities cannot read the copy or create workloads that mount it. This does not protect against namespace administrators.
- **AC4:** Preserve Slack preflight and discovery checks. A canonical Secret update followed by bare Gateway Pod replacement must observe the update. Qualify actual OpenShell export separately.
- **AC5:** Explicitly bind a static Source already used through Credential Proxy. Verify that only the Gateway receives the exported copy, the original Proxy binding continues to enforce its request restrictions, and removing the Gateway binding leaves the Proxy binding intact. Without the Gateway binding, no Gateway copy is created.
