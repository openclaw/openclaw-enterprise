---
status: Proposed
status_note: "Needs human review before landing. The accompanying draft implements step 1 only."
---

# Proposal: Report a crash-looping runtime in the deployment record

- **ID:** RFC-0050
- **Owner:** Controller worker and Kubernetes Compute Driver. Review: API contract owners.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** this PR (draft)
- **Related:** dogfood finding D263 from live testing of #696 and #747; the
  Collector half of D263 (`gateway.startup_failed`) is a separate fix; current
  contracts in [deployment status](../../docs/reference/agents.md) and
  [agent logs](../../docs/guides/topics/agent-logs.md).

## Summary

A Gateway that exits on every start (for example `gateway.bind=custom` without
`gateway.customBindHost`) is invisible in the deployment record for the whole
15-minute convergence window. The record reads `running` with
`lastAttempt REVISION_INCOMPLETE "Waiting for the runtime to become ready."`, with
no error or warning. Then it fails with a generic
`CONVERGENCE_DEADLINE_EXCEEDED` and no `runtimeFailure`. The cause is visible
only through `occ agent logs --previous`. This RFC proposes three steps:

1. The Kubernetes Driver reports a crash loop as runtime-failure evidence
   (`component`, `check: "container"`, `code: "CONTAINER_CRASH_LOOP"`, exit time).
   This uses the existing `runtimeFailure` shape.
2. The pending deployment progress names it while the deadline runs.
3. Optionally, the deployment fails early when the loop cannot recover.

## Motivation

On the dogfood install, the lane's crash-looping embedded Agent restarted 5
times between 23:20 and 23:35. `occ agent get` showed `active` with no
revision. The console offered no hint until the deadline, and the deadline
failure carried no evidence. Plugin install failures and model-authentication
failures already surface early: plugin warnings during pending, and
`RUNTIME_AUTHENTICATION_FAILED` as an early permanent failure. A container that
never reaches the wrapper's status endpoint has no equivalent.

## Design

### Step 1: evidence (draft in this PR)

`safeRuntimeFailureObservation` already returns wrapper-published failures and
`WORKSPACE_SETUP_FAILED` from init-container status. After those checks, it
now reads the revision's runtime Pods (Gateway Pods from the Gateway
namespace). A runtime container whose `restartCount >= 3` and whose
`lastState.terminated.exitCode` is nonzero yields:

```json
{
  "component": "gateway",
  "check": "container",
  "code": "CONTAINER_CRASH_LOOP",
  "checkedAt": "<finishedAt>"
}
```

Termination messages and reasons never leave the Driver. This is a new value
of an existing open identifier, not a schema change. With step 1 alone, the
deadline failure carries `data.runtimeFailure`, and the console's existing
failure panel shows component, check and code.

### Step 2: visible while pending (needs a contract decision)

`progress.lastAttempt` exposes only the attempt code and a fixed message, and
`warnings` is a closed union. The options are:

- **A. New progress code `RUNTIME_CRASH_LOOP`** (recommended). The worker
  records the pending attempt with this code when the observation carries
  `CONTAINER_CRASH_LOOP`. `deploymentProgressForWork` maps it to "The runtime
  keeps restarting. Run `occ agent logs <agent> --previous` to see why." The
  schema is unchanged, because `code` is a bounded string, but the code is new
  public vocabulary. The worker's readiness recheck delay, keyed on
  `REVISION_INCOMPLETE` today, must also cover it.
- **B. New deployment warning `RUNTIME_CRASH_LOOP`** with `component` and
  `exitCode`. This changes the closed `warnings` union and the console warning
  rendering, and regenerates OpenAPI.
- **C. `progress.lastAttempt.data.runtimeFailure`.** This reuses the evidence
  shape in pending progress. It is an additive schema change to `progress`.

### Step 3: fail early (owner decision)

Some crash loops recover. A container that exits because a dependency is not
ready yet may start once that dependency is up. A configuration error such as
the one above cannot recover until a new version is deployed. Failing early on
`CONTAINER_CRASH_LOOP` (as `RUNTIME_AUTHENTICATION_FAILED` does) would end a
doomed deployment after about 2 minutes instead of 15. It would also fail a
loop that would have recovered. The proposal is to fail early only after a
higher threshold, for example 6 restarts with the same nonzero exit code, or
not at all.

## Open questions

- Should step 2 use A, B or C?
- Should step 3 happen, and at what threshold?
- Should the Docker Compute Driver report the same evidence? Its restart
  policy differs.

## Verification of the draft

A new conformance test,
`Kubernetes embedded Gateway crash loop reports fixed evidence after three restarts`,
covers the threshold (2 restarts: no evidence; 4: evidence), the exit-time
mapping, and that termination messages do not leave the Driver.
