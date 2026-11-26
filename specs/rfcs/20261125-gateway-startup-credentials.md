---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Gateway startup credentials

**RFC-20261125-gateway-startup-credentials** · Created 2026-11-25 · [Implementation plan](../plans/20261125-gateway-startup-credentials.md)

A Gateway needs usable credentials to connect to services such as Slack. Today, Slack uses Namespace Secrets. [Credential Design 1.0](20261124-credential-design-1-0/index.md) also lets TokenService own credentials, including material held by OpenShell outside Kubernetes. The Gateway has no startup path for those Sources.

**Approach:** An authorized caller explicitly selects a supported static CredentialSource in `Configuration.secretBindings`, including a Source also used by Credential Proxy. The OCC worker authorizes the binding and resolves the value; Compute delivers it only to the dedicated Gateway. Existing Namespace Secret delivery stays unchanged.

**Accepted tradeoff:** An explicit Gateway binding authorizes a usable copy outside Credential Proxy's request restrictions. Kubernetes stages that copy in the Gateway Pod namespace, where workload managers can mount it elsewhere. The running Gateway retains its startup value until managed redeploy; revocation does not erase its environment or immediately remove the staged copy.

## Delivery flow

1. **Admit:** OCC checks that the Source is ready, static, in the same Namespace, and owned by the selected TokenService instance; it records that instance in the revision. Model presets, Connection Templates, or other consumer bindings do not disqualify it. Reject unsupported or embedded Source delivery before saving the revision.
2. **Resolve:** The [worker](../../apps/controller/src/worker.ts) calls Compute's `prepareRevision`. Compute runs in the same process. When it needs exported credentials, it calls `context.gatewayStartupCredentials.resolve(signal)`. The worker verifies the claim, Agent, revision, owner, binding, and both principals' grants before and after reading from TokenService (or the selected Secret Driver for a supported export). It returns the bound Gateway values and, for each Source, its owner version in memory. Refuse Source delivery without a nonempty owner version.
3. **Deliver:** For exported Gateway values, Kubernetes Compute creates one staged Secret per Agent revision in the Gateway Pod namespace. It records Source versions by environment destination in a private annotation so retries can identify the staged version, and stages the values in `data`. The Gateway Deployment references only the values, as shown below. Existing canonical Namespace Secrets remain direct references. Other Compute Drivers must own a qualified startup transport or refuse delivery; the Secret Driver owns storage or export.
4. **Start:** When a revision uses exported delivery, Compute calls the worker-owned `authorize` callback for all Gateway bindings immediately before an operation that can start the Gateway, such as updating its Kubernetes Deployment. This includes mixed bindings and retries. Authorization, read, or staging failure prevents candidate startup. Dedicated deployment may already have stopped the predecessor, so a failure can interrupt service. Sanitize failures.

### Kubernetes Compute example

Suppose the worker resolves `GW_HOOK_TOKEN` from TokenService and passes its value to Compute in memory. Kubernetes Compute creates this Secret through the Kubernetes API (the value below is synthetic):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gateway-credentials-rev-123
  namespace: tenant-example
  annotations:
    openclaw.dev/gateway-source-versions: '{"GW_HOOK_TOKEN":"version-1"}'
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

### Revision lifetime and cleanup

The staged Secret belongs to the Agent revision. A replacement Pod for the same running revision reuses it; a new revision gets its own Secret. Kubernetes Compute owns cleanup: when a revision is stopped or retired, it waits for that revision's Gateway Pods to stop, then deletes the staged Secret in the Gateway namespace. It also removes copies for abandoned candidates once their Pods have stopped. Cleanup never deletes the original TokenService material or a canonical Namespace Secret. A failed deletion can leave the staged copy until cleanup succeeds.

An OCC-managed redeploy reads the current owner value. If an unlaunched candidate staged A and the owner changes to B, retry by replacing the staged values and Source-version annotation together with B and B's version. After an uncertain launch, observe the same workload before retrying. A kubelet-only Pod restart can reuse A; revocation blocks subsequent OCC-managed starts but does not erase an existing process's environment.

## Interface changes

### APIs

Extend [SecretBinding.source](../../packages/contracts/src/index.ts) with `CredentialSourceReference` alongside `SecretReference`. Keep exact same-Namespace references, environment destinations, limits, reserved names, and native Configuration validation. Do not add a Gateway-specific Source profile or field allowlist. Existing Slack discovery and preflight remain Namespace Secret-only. If an enabled Slack credential input selects a Source, refuse that unsupported integration until qualified; an environment name alone does not disqualify a Gateway binding.

### IAM

Reuse `operate` on each exact Secret or Source, with the normal Configuration, Agent, and deployment permissions. Configuration save and Agent assignment require the caller's grant; deployment requires both deployer and Agent service principal grants. These permissions authorize explicit Gateway export even when the Source is also used through Credential Proxy.

### Database entities

Persist references, never values, in Configuration and Agent revision. Record one private `gatewayTokenServiceInstanceId` for all Gateway Source bindings. Gateway bindings do not create Harness or Proxy bindings. Changing a Gateway binding must not change another consumer's binding. Block Source removal or withdraw all references and delivery copies first; include Configurations, Agents, queued or active revisions, and queued or running provisioning plans.

### Driver contracts

Add to [ComputeRevisionContext](../../packages/contracts/src/drivers/compute/index.ts):

```ts
readonly gatewayStartupCredentials?: {
  authorize(signal: AbortSignal): Promise<void>;
  resolve(signal: AbortSignal): Promise<
    Readonly<Record<string, { readonly value: string; readonly sourceVersion?: string }>>
  >;
};
```

For exported inputs, require both methods: `resolve` returns only the selected Gateway variables, with a nonempty `sourceVersion` required for Source bindings and absent for Secret Driver exports; `authorize` checks all bindings without reading values. Canonical Namespace Secret-only deployments retain their existing worker authorization path. Reuse [TokenService.resolveCredential](../../packages/contracts/src/drivers/token-service/index.ts) and optional [SecretDriver.withValue](../../packages/contracts/src/drivers/secret/index.ts). OCC must not expose exported values to the Harness, other containers, APIs, revisions, logs, or diagnostics.

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

- **AC1:** The Gateway observes A, keeps A after its Source is replaced with B, and observes B after managed redeploy. An unlaunched retry staged with A must stage B and record B's owner version before starting. Verify process identity and compare a digest without exposing plaintext; refuse a Source result without its version.
- **AC2:** Deny each principal, revoke during owner I/O, and deny staged reuse; each must prevent Gateway mutation. A queued provisioning plan as the sole reference must block Source deletion. Verify attributable evidence for the actor, exact Source and revision, without credential values, and sanitized failures.
- **AC3:** Verify Gateway-only projection, reuse on Pod replacement within a running revision, separate copies across revisions, and Compute cleanup after stop, retirement, or abandonment without deleting owner material or another revision's copy. Ordinary workload identities cannot read the copy or create workloads that mount it; namespace administrators remain trusted.
- **AC4:** Preserve Slack preflight and discovery checks. A canonical Secret update followed by bare Gateway Pod replacement must observe the update. Qualify actual OpenShell export separately.
- **AC5:** Explicitly bind a static Source already used through Credential Proxy. Verify that only the Gateway receives the exported copy, the original Proxy binding continues to enforce its request restrictions, and removing the Gateway binding leaves the Proxy binding intact. Without the Gateway binding, no Gateway copy is created.
