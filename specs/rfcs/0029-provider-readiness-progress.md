---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Report which provider readiness check is still pending

**RFC-0029 · Proposed October 17, 2026.** [Provisioning investigation](https://github.com/openclaw/openclaw-enterprise/issues/2658) · [Draft implementation](https://github.com/openclaw/openclaw-enterprise/pull/2695)

A deployment can spend eight minutes “waiting for the runtime to become ready” without telling the operator where to look. We propose that the Kubernetes Compute Driver report the first readiness check it reached that was still pending. Compute and deployment maintainers must decide whether to expose that observation through the Driver contract and retain it on deployment progress. Readiness, deadlines and recovery would continue to use their existing inputs.

## What the operator would learn

In [one run on main](https://github.com/openclaw/openclaw-enterprise/actions/runs/39000684973/job/117302764514), both Compose and Kubernetes first-Agent tests reached their provisioning deadline. The worker had recorded only `REVISION_INCOMPLETE`. A later observation found a Ready Gateway Pod and a Ready Agent Pod. Those observations can both be true; what we lost was the worker’s view at the time.

For a provider-managed Harness, Compute already checks the provider Pod, then the workspace connection, then credential attachments when required. Add three optional values to [`ComputePendingReason`](../../packages/contracts/src/drivers/compute/index.ts):

| First check still pending             | What Compute reports              | Where the operator looks next                  |
| ------------------------------------- | --------------------------------- | ---------------------------------------------- |
| One matching Ready provider Pod       | `PROVIDER_HARNESS_POD_PENDING`    | Pod selection and readiness                    |
| Workspace node connected to Gateway   | `PROVIDER_WORKSPACE_NODE_PENDING` | Node startup and its connection to the Gateway |
| Expected credential attachments ready | `CREDENTIAL_ATTACHMENT_PENDING`   | Attachment status, not credential values       |

A pending Pod says nothing about the two checks Compute has yet to reach. A runtime failure, quota limit, scheduling problem, or image pull failure that Compute already observes takes precedence. Other Drivers need not report a new value. The proposal requires no additional Kubernetes reads, provider calls, permissions, identifiers, or free-form reasons.

## Keep observation separate from recovery

The worker should retain `REVISION_INCOMPLETE` as its durable lifecycle reason and record the more specific observation alongside it. An older worker uses that reason to recognize progress beyond credential bootstrap. Replacing it with a value the old worker does not recognize could make rollback retire a candidate that had already progressed.

While deployment is pending, [deployment progress](../../docs/reference/agents/deployment.md) would show the last recorded observation, using the existing `WORKSPACE_NODE_PENDING` code for the workspace case. Record changes, suppress identical repeats, and show generic readiness progress for absent or unknown detail. An older worker may leave the previous detail in place. A client's deadline can expire while deployment is still pending. A later Ready Pod cannot establish when the earlier check passed. Terminal deployments expose their result and clear progress.

## Decision and verification

Keeping the Driver contract unchanged would let tests inspect resources after timeout, but those reads cannot reconstruct the worker’s earlier observation. We are not proposing a progress-event framework.

Driver tests exercise all three pending checks. PostgreSQL tests use the current worker to verify the durable reason an older worker recognizes, duplicate suppression, and cleanup after a dependency outage.

An [earlier OpenShell run](https://github.com/openclaw/openclaw-enterprise/actions/runs/39006219175/job/117319152661) on `f164c4cc620d` missed the guided provisioning deadline. Deployment progress showed `WORKSPACE_NODE_PENDING`. A later read found one Ready Gateway Pod and one Ready Agent Pod. Before landing, capture the worker's observation on the final candidate during a provider-managed attempt. The provisioning issue remains open.
