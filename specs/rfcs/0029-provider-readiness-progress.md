---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Report the first pending provider readiness check

**RFC-0029 · Proposed October 17, 2026.**

When a provider-managed Harness is not ready, the Kubernetes Compute Driver should report which check is still pending. The worker should save that observation for the operator without changing how it decides to retry, retire, or activate the revision.

In [a first-Agent run](https://github.com/openclaw/openclaw-enterprise/actions/runs/39000684973/job/117302764514), the client timed out with only a generic readiness message. Both Pods were Ready when inspected later. Reading the Pods after a timeout cannot tell the operator which check the worker was waiting for.

## What Compute reports

Extend the existing optional [Compute pending reason](../../packages/contracts/src/drivers/compute/index.ts) with three values. Use the checks Compute already makes, in order:

| What Compute is waiting for                               | Driver reason                     | What the operator should inspect                        |
| --------------------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| One matching Ready provider Pod                           | `PROVIDER_HARNESS_POD_PENDING`    | Pod selection and readiness                             |
| The Gateway is Ready; its workspace node is not yet ready | `PROVIDER_WORKSPACE_NODE_PENDING` | Node enrollment and its connection to the ready Gateway |
| All expected credential attachments to be ready           | `CREDENTIAL_ATTACHMENT_PENDING`   | Attachment status                                       |

Report only a check that Compute reached. If the Pod is not ready, the node and attachments may not have been checked. A more specific failure or workload condition already observed by Compute takes precedence. No new provider calls, Kubernetes reads, permissions, or credential details are needed. Other Drivers can omit the reason.

## What the worker records

Store all three provider observations alongside the existing lifecycle reason `REVISION_INCOMPLETE`. The provider workspace wait previously used `WORKSPACE_NODE_PENDING` as its stored code. An older worker recognizes both stored codes as progress past credential bootstrap. Storing only the new Driver reason could cause that worker to retire the candidate after a rollback.

While the deployment is pending, [deployment progress](../../docs/reference/agents/deployment.md) shows the last recorded observation. The workspace reason displays as the existing `WORKSPACE_NODE_PENDING`; the other two keep their Driver names. Record a change of reason once. Missing or unknown detail gives the generic readiness message. An older worker may leave the last detail in place. Terminal deployments have no pending progress.

[Implementation #2695](https://github.com/openclaw/openclaw-enterprise/pull/2695) tracks verification, including a provider-managed attempt that captures the worker’s observation on the final candidate. This proposal explains a wait; [the provisioning failure](https://github.com/openclaw/openclaw-enterprise/issues/2658) remains a separate investigation.
