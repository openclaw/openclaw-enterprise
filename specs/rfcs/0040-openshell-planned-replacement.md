---
status: Proposed
implementation_status: Not implemented
author: Kimiyu-186
---

# Let tasks finish on an OpenShell executor before replacement

- **ID:** RFC-0040
- **Created:** 2026-11-16
- **Related:** [Bounded planned replacement](0036-bounded-planned-replacement.md), [Sandbox Driver contract](../../packages/contracts/src/drivers/sandbox/index.ts)

## Problem and decision

In isolated Kubernetes replacements, a parent waiting for a child received an
interrupted wait. A command that had started on the predecessor also lost its
process handle. The new revision served new turns, but neither original task
delivered its result. Both failures happened when the serving executor stopped.

Qualify the existing per-Agent completion wait for ordinary image upgrades of
dedicated Codex on OpenShell. Keep the serving Gateway, Sandbox, and current
credentials available while the original work finishes. Use the same
predecessor record, deadline, and committed stop as RFC-0036.

## Eligibility

Compute must be able to verify the serving revision's exact Gateway process
and its OpenShell executor. Bind the observation to the original revision,
Sandbox instance and running executor instance. A service URL, Sandbox name,
or successful new model turn can survive an executor replacement and cannot
identify the old process. The current [status and endpoint operations](../../packages/contracts/src/drivers/sandbox/index.ts)
establish readiness and routing. Qualification must show whether an existing
authenticated startup identity remains readable across worker retries and
changes on executor restart. If it cannot, the smallest proposed contract
extension is a read-only executor identity on the authenticated provider
observation. Polling must never provision a replacement Sandbox or renew a
revoked credential.

Only image changes qualify. Verify that the old and new admissions select
compatible execution, provider, authorization and egress settings. Preserve
the existing stop path when equivalence cannot be established. Recheck
authority and both process identities on every reconciliation. Loss of
identity or authority ends the wait.

## Stop and delivery

Use RFC-0036's Gateway completion observation and reject independent new
requests while waiting. The original parent may collect a child result or
continue polling its original process handle. The Agent may stop when the
accepted work and its final writes settle. Each busy Agent has the same
fixed 30-minute deadline. At the cutoff the next authorized reconciliation
commits the existing stop. Other Agents can upgrade independently.

A lost executor can leave an external effect with an unknown outcome.
Keep the original interruption visible in its conversation. Never start a
second command or child to recreate its outcome. Resuming after forced loss
would need separate evidence that the original execution or its completed
result is still available.

## Acceptance before enabling the provider

1. Use the OCE release path to upgrade both Gateway and OpenShell Codex. At
   cutover observe an original parent waiting on its identified child. Repeat
   with an original command that has a live process handle. In both cases verify
   one start, one completion, and one delivered original result before stop.
2. Replace only the executor behind a stable endpoint during the wait. Verify
   that the new executor cannot inherit the old identity or execute the old tool.
   Repeat with revoked authority and a changed egress policy.
3. Exceed the real 30-minute limit, including a worker restart during the wait.
   Verify the original deadline, forced progress and an idle Agent's independent
   upgrade. Verify an explicit retry of a rejected message executes once.
4. Record Gateway, Sandbox and executor identities, the original run, tool effect
   count and destination receipt. Qualify both runtime paths before extending
   support claims to OpenShell.
