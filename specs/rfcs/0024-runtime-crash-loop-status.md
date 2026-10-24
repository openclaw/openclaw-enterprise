---
title: Report a crash-looping container in the deployment record
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Report a crash-looping container in the deployment record

At 14:03, Kubernetes reports that a deployment’s gateway container is waiting in `CrashLoopBackOff`. At 14:10, the deployment fails at its convergence deadline. An operator opening deployment status after the Pod is deleted should be able to read both facts, with their distinct meanings. The deadline explains why the attempt ended. The earlier observation tells the operator what Kubernetes reported, without claiming to know why the container exited.

## What deployment status records

Compute reports the container state. The deployment worker records an optional observation in [pending deployment progress](../../docs/reference/agents/deployment.md#pending-deployment-progress), alongside the existing attempt reason. On failure, deployment status stops returning pending progress. For a convergence timeout, the worker must therefore persist qualifying evidence in the terminal error data before completing the attempt. Use the same optional observation field as [the pending-readiness proposal](https://github.com/openclaw/openclaw-enterprise/pull/2696) if it lands first. Expose only `code` (`RUNTIME_CONTAINER_CRASH_LOOP_BACKOFF`), `component` (`agent` or `gateway`), and `observedAt` (when OCE first observed the qualifying state in this sequence).

This applies during deployment, when OCE already inspects the selected, not-ready candidate. Only the current `waiting.reason` of its OCE-managed Kubernetes agent or gateway container can qualify, and it must equal `CrashLoopBackOff` exactly. Pod phase, restart count and previous termination are insufficient. Bind the observation internally to this attempt and Pod UID. Do not publish the UID or copy free-form status text, events, logs or health output. Init containers, sidecars, provider-owned resources and monitoring after activation are outside scope.

## How the observation changes over an attempt

1. **First observed.** Persist the observation beside the current lifecycle reason, including `REVISION_INCOMPLETE` where applicable. Repeated qualifying reads of the same candidate leave `observedAt` unchanged and cause no writes solely to refresh it.
2. **No longer supported.** Clear the pending observation when accepted status shows readiness or no longer shows that waiting reason, or when candidate identity changes or becomes ambiguous. A later qualifying observation starts a new sequence, even for the same Pod.
3. **Deadline reached.** Preserve `CONVERGENCE_DEADLINE_EXCEEDED`, `timeoutMs` and any independently safe `runtimeFailure`. Extend the [deadline error validator](../../packages/occ/src/state/controller-work.ts) to accept the same closed observation shape. Copy the observation only if the latest relevant accepted status for that same bound candidate qualifies. Omit it if that binding cannot be established. No extra read at the deadline is required, and subsequent Pod deletion does not erase the terminal record.

The observation changes no deployment decision, including credential cleanup, retry timing, readiness, rollback or the deadline. Existing authentication, startup, workspace and dependency failure paths retain their precedence and outcomes.

## Acceptance and rollout

In k3d, make a managed gateway exit repeatedly. Observe the exact Kubernetes waiting reason, verify pending progress, let the ordinary deadline expire, then delete the Pod and read deployment status again. Expect the deadline reason and the original observation time, with no live Pod required.

In one run, let the candidate recover and verify successful deployment clears the observation. In another, replace it with a Pod that stays unready for a different reason. Its eventual timeout must omit the old observation. Cover deduplication, ambiguous identity and excluded containers in focused tests. Before enabling writers, verify an existing client can read a record containing the field and a new client can read an older record without it.
