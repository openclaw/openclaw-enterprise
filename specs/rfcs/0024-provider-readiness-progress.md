---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Report which provider readiness check is still pending

**RFC-0024 · Proposed October 17, 2026.** [Provisioning investigation](https://github.com/openclaw/openclaw-enterprise/issues/2658) · [Draft implementation](https://github.com/openclaw/openclaw-enterprise/pull/2695)

A deployment can spend eight minutes “waiting for the runtime to become ready” without telling the operator where to look. We propose that the Kubernetes Compute Driver report the first readiness check it reached that was still pending. Compute and deployment maintainers must decide whether to expose that observation through the Driver contract and retain it on deployment progress. Readiness, deadlines and recovery would continue to use their existing inputs.

## What the operator would learn

In [one run on main](https://github.com/openclaw/openclaw-enterprise/actions/runs/39000684973/job/117302764514), both Compose and Kubernetes first-Agent tests reached their provisioning deadline. The worker had recorded only `REVISION_INCOMPLETE`. A later observation found a Ready Gateway Pod and a Ready Agent Pod. Those observations can both be true; what we lost was the worker’s view at the time.

For a provider-managed Harness, Compute already checks the provider Pod, then the workspace connection, then credential attachments when required. Add three optional values to [`ComputePendingReason`](../../packages/contracts/src/index.ts):

| First check still pending             | What Compute reports              | Where the operator looks next                  |
| ------------------------------------- | --------------------------------- | ---------------------------------------------- |
| One matching Ready provider Pod       | `PROVIDER_HARNESS_POD_PENDING`    | Pod selection and readiness                    |
| Workspace node connected to Gateway   | `PROVIDER_WORKSPACE_NODE_PENDING` | Node startup and its connection to the Gateway |
| Expected credential attachments ready | `CREDENTIAL_ATTACHMENT_PENDING`   | Attachment status, not credential values       |

A pending Pod says nothing about the two checks we did not reach. A known runtime failure, quota limit, or scheduling problem remains more useful and takes precedence. Other Drivers need not report any new value. We add no Kubernetes read, provider call, permission, identifier, or free-form reason to collect this information.

## Keep observation separate from recovery

The worker should retain `REVISION_INCOMPLETE` as its durable lifecycle reason and record the more specific observation alongside it. An older worker uses that reason to recognize progress beyond credential bootstrap. Replacing it with a value the old worker does not recognize could make rollback retire a candidate that had already progressed.

[Deployment progress](../../docs/reference/agents/deployment.md) would show the last recorded observation, using its existing `WORKSPACE_NODE_PENDING` wording for the workspace case. Record a change of observation; suppress identical repeats; show generic progress for absent or unknown detail. If a deployment reaches its deadline, the detail describes the last check the worker recorded. An older worker may leave that detail in place. A later Ready Pod does not establish when the earlier check passed.

## Decision and verification

Keeping the Driver contract unchanged would let tests inspect resources after timeout, but those reads cannot reconstruct the worker’s earlier observation. We are not proposing a progress-event framework.

The draft exercises all three pending checks and mixed-version recovery against PostgreSQL. Before landing the implementation, capture an actual provider-managed attempt and distinguish what its worker reported from any later Pod observation. Keep the provisioning issue open regardless: a better explanation is not a faster deployment.
