---
title: Report a crash-looping container in the deployment record
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Report a crash-looping container in the deployment record

At 14:03, Kubernetes reports that a deployment’s gateway container is waiting in `CrashLoopBackOff`. At 14:10, the deployment fails at its convergence deadline. An operator opening deployment status after the Pod is deleted should be able to read both facts, with their distinct meanings. The deadline explains why the attempt ended. The earlier observation tells the operator what Kubernetes reported, without claiming to know why the container exited.

A real crash loop no longer waits for that deadline; see [A real crash loop fails the deployment](#a-real-crash-loop-fails-the-deployment). The observation below covers the backoff that remains: a container below that threshold, or one restarting on purpose.

## What deployment status records

Compute reports the container state. The deployment worker records an optional observation in [pending deployment progress](../../docs/reference/agents/deployment.md#pending-deployment-progress), alongside the existing attempt reason. On failure, deployment status stops returning pending progress. For a convergence timeout, the worker must therefore persist qualifying evidence in the terminal error data before completing the attempt. Use the same optional observation field as [the pending-readiness proposal](https://github.com/openclaw/openclaw-enterprise/pull/2696) if it lands first. Expose only `code` (`RUNTIME_CONTAINER_CRASH_LOOP_BACKOFF`), `component` (`agent` or `gateway`), and `observedAt` (when OCE first observed the qualifying state in this sequence).

This applies during deployment, when OCE already inspects the selected, not-ready candidate. Only the current `waiting.reason` of its OCE-managed Kubernetes agent or gateway container can qualify, and it must equal `CrashLoopBackOff` exactly. For the observation, Pod phase, restart count and previous termination are insufficient. Bind the observation internally to this attempt and Pod UID. Do not publish the UID or copy free-form status text, events, logs or health output. Init containers, sidecars, provider-owned resources and monitoring after activation are outside scope.

## A real crash loop fails the deployment

Amended 2026-11-10 (owner decision on finding 3041, implemented in [#5348](https://github.com/openclaw/openclaw-enterprise/pull/5348)). Only unexplained exits count. When the agent or gateway container waits in `CrashLoopBackOff` after 3 consecutive unexplained exits, Kubernetes Compute returns startup failure evidence with check `crash-loop` and code `UNAVAILABLE`, and the deployment fails at once with `RUNTIME_STARTUP_FAILED`.

- **Deliberate restarts.** The gateway wrapper exits 75 (`EX_TEMPFAIL`) when it restarts its own container, for a changed Harness peer or workspace node, and logs startup phase `container-restart`. Exit 75 never counts and clears the count. A native Gateway exit with status 75 is reported as 1. No Harness wrapper restarts on purpose, so 75 is excused only for the gateway.
- **The count.** The kubelet keeps only the last exit. The gateway wrapper counts consecutive unexplained exits in the Pod's `/tmp` emptyDir and states the count in its termination message, which Compute reads from `lastState.terminated.message`. Each start counts its own exit in advance, so an out-of-memory kill counts; readiness restarts the count at 1. A Pod without a count (an older wrapper, or a Harness container) uses the restart count.
- **Naming.** The failure uses the existing `runtimeFailure` shape and deployment code, not a new one. `RUNTIME_CONTAINER_CRASH_LOOP_BACKOFF` stays the code of the proposed record-only observation, which #5348 does not implement.

## How the observation changes over an attempt

1. **First observed.** Persist the observation beside the current lifecycle reason, including `REVISION_INCOMPLETE` where applicable. Repeated qualifying reads of the same candidate leave `observedAt` unchanged and cause no writes solely to refresh it.
2. **No longer supported.** Clear the pending observation when accepted status shows readiness or no longer shows that waiting reason, or when candidate identity changes or becomes ambiguous. A later qualifying observation starts a new sequence, even for the same Pod.
3. **Deadline reached.** Preserve `CONVERGENCE_DEADLINE_EXCEEDED`, `timeoutMs` and any independently safe `runtimeFailure`. Extend the [deadline error validator](../../packages/occ/src/state/controller-work.ts) to accept the same closed observation shape. Copy the observation only if the latest relevant accepted status for that same bound candidate qualifies. Omit it if that binding cannot be established. No extra read at the deadline is required, and subsequent Pod deletion does not erase the terminal record.

The observation itself changes no deployment decision, including credential cleanup, retry timing, readiness, rollback or the deadline. Only the crash-loop failure above ends an attempt early. Existing authentication, startup, workspace and dependency failure paths retain their precedence and outcomes.

## Acceptance and rollout

In k3d, make a managed gateway restart deliberately, then exit unexplained at every start. Expect `RUNTIME_STARTUP_FAILED` with check `crash-loop` only after the third consecutive unexplained exit. For the observation, keep a gateway in backoff without reaching that count, verify pending progress, let the ordinary deadline expire, then delete the Pod and read deployment status again. Expect the deadline reason and the original observation time, with no live Pod required.

In one run, let the candidate recover and verify successful deployment clears the observation. In another, replace it with a Pod that stays unready for a different reason. Its eventual timeout must omit the old observation. Cover deduplication, ambiguous identity and excluded containers in focused tests. Before enabling writers, verify an existing client can read a record containing the field and a new client can read an older record without it.
