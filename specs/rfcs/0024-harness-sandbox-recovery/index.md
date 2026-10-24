---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Recover a lost Harness Sandbox by resuming it

- **ID:** RFC-0024
- **Created:** 2026-10-22
- **Last updated:** 2026-10-23
- **RFC PR:** [#3233](https://github.com/openclaw/openclaw-enterprise/pull/3233)
- **Related:** [Sandbox Driver contract](../../../docs/reference/drivers/sandbox.md),
  [Compute Driver contract](../../../docs/reference/drivers/compute.md),
  [controller worker flow](../../../docs/flows/controller-worker.md)
- **Decisions:** [owner answers of 2026-10-23 and remaining choices](decisions.md)

<a id="problem-and-decision"></a>

## Summary

After a node restart, the OpenShell Sandbox of a dedicated Agent revision stays stopped. The Agent's
Gateway comes back, the Agent still reads `active`, and every chat fails until someone deploys a new
version. This RFC makes the OCC worker watch each running dedicated revision's Sandbox and resume the same
Sandbox with OpenShell `StartSandbox` when it is lost. The same revision then serves again. Recovery runs
under the authority of the account that deployed the revision, is bounded, and shows as `recovering`,
`recovered`, `stalled`, or `lost` wherever the Harness status shows today.

## Motivation

- `observeHarness` reads the Sandbox record, and `GET .../harness-status`, `occ agent get`, and the Console
  show **Sandbox lost**. Nothing acts on it; the documented remedy is to deploy a new version
  ([Harness Sandbox status](../../../docs/reference/drivers/sandbox.md#harness-sandbox-status)).
- Kubernetes Compute declares no maintenance interval, so an ordinary dedicated revision gets no worker
  pass after activation. Preparing a stopped Sandbox fails with "has stopped; remove the stale Sandbox".
- A revision with a standing repository approval and a lost Sandbox re-checks every 5 seconds or less,
  with no end and no visible status (`REPOSITORY_EXECUTION_UNVERIFIED`).
- A new version re-admits current Agent settings, replaces the Sandbox, and closes repository Git access.
  A node restart must not require it.

<a id="scope"></a>

## Goals

- Detect a lost Sandbox of a running dedicated revision within about two intervals.
- Resume the same Sandbox for the same revision, without new authority.
- Never resume a Sandbox that an operator stopped through OCC, or a revision that a newer revision replaces.
- Bound every retry and show recovery state in the API, CLI, Console, events, and metrics.
- Keep repository Git custody fail-closed.

## Non-goals

- Embedded Harnesses and Gateway Pods. Kubernetes already restarts Gateways.
- Changing `occ agent stop`, which continues to delete the Sandbox.
- Restarting an exited Harness process. OpenShell `restart_policy: ALWAYS` does that.

<a id="design"></a>

## Proposal

### Ownership

The OCC worker owns detection and recovery. It already holds the OpenShell client, the per-Agent work
claim, revision reauthorization, and repository Git custody. The Gateway is not used: it is the Agent's own
workload, cannot authorize an effect, and does not know stop intent. A Kubernetes controller that watches
`sandboxes.agents.x-k8s.io` is not used: OpenShell owns those resources, OCC has no access to them, and
their conditions are the same for a reboot and a stop.

### What OpenShell provides

At the pinned OpenShell 0.1.5 (`bdb956f2`):

- After a node restart, the Kubernetes driver's 30-second reconcile suspends a Sandbox whose supervisor Pod
  is gone, with the same patch as `StopSandbox`. The Sandbox reads `STOPPED`. No field records whether a
  stop was requested. Only an explicit `StopSandbox` passes through the short `STOPPING` phase.
- `StartSandbox` accepts `STOPPED`, `COMPLETED`, `STARTING`, an `ERROR` from a failed main process, and an
  `ERROR` from a provisioning timeout after its cleanup. `READY` is a no-op. It needs the
  `sandbox:write` scope and workspace `user` role that OCC already holds.
- `StartSandbox` refuses any other `ERROR`, but `StopSandbox` now accepts one (upstream #4231), so
  "stop, then start" recovers it in place.
- A start keeps the Sandbox ID, stored spec, endpoints, and storage. All durable Agent state is on
  OCE-owned volumes that only Agent deletion removes; OCE's mount under `/sandbox` turns off
  OpenShell's own per-Sandbox volume ([what a Sandbox keeps](decisions.md#question-1-what-a-sandbox-keeps)). It creates new Pods, rotates the
  Sandbox's gateway token and bootstrap secrets, starts a new supervisor session, and admits the stored
  provider configuration again.
- Each mutation sent with a `request_id` holds one of 1,000 durable admissions for OCC's identity, and a
  failed one never expires. Recovery omits `request_id`. If the worker loses the reply, it records the attempt and observes the Sandbox before deciding whether another start is safe.

### Detection

1. A revision is **watched** while it is the active revision of an `active` Agent set to run, its Namespace
   is `ready`, its Harness is dedicated with a Sandbox Driver, and Compute implements `observeRevision`. It
   must also pass the maintenance preamble: its deployment did not fail terminally, no later saved revision
   requires stopped predecessors, and its required model credential is not withdrawn. Otherwise watching
   ends. After a failed redeploy, the predecessor stays down, as the
   [exclusive replacement](../../../docs/reference/drivers/compute.md) contract requires.
2. A watched revision without a maintenance chain gets one work item, `agent_revision:<id>:watch`, at
   activation, with the deploying account as actor. Each pass rereads the Agent under the claim, calls
   `observeRevision`, and defers the same item by the interval without evidence or audit. It does not
   prepare. Revisions that have a maintenance chain observe at its start.
3. `OCC_WORKER_HARNESS_WATCH_INTERVAL_MS` sets the interval (default `60000`; `0` disables watching).
4. On worker start, a bounded sweep inserts the missing watch items for revisions activated before the
   upgrade. It copies the actor from the revision's deployment work and spreads the first passes over one
   interval.
5. The per-Agent claim lets one worker act on an Agent at a time, exclusive with its deploy, stop, and
   delete work. No leader election is added.

Each pass costs a Namespace list and read, a gateway `GetSandbox`, and about four short transactions.
For 1,000 dedicated Agents at 60 seconds, that is about 17 passes, 50 API calls, and 70 transactions per
second across all workers. A per-worker Namespace cache can remove most of the API calls.

### Stop intent

OpenShell records no stop reason, so OCC state is the record of intent. `Agent.desiredRuntimeState`
records an OCC stop before any effect, and OCC stops a revision by deleting its Sandbox, never with
`StopSandbox`. Therefore:

- Every pass and recovery step rereads the Agent under its claim, and a stop ends the incident.
- If a watch read sees `STOPPING`, someone called `StopSandbox`. The revision goes `lost` with
  `SANDBOX_STOPPED_EXTERNALLY` and is not resumed.
- Otherwise, a `STOPPED` Sandbox of an Agent that OCC wants running counts as involuntary and is resumed.
- Before OCC itself calls `StopSandbox` to recover an `ERROR`, the incident records it, so OCC's own
  `STOPPING` is not read as an outside stop.

OCC asks OpenShell for a durable stop reason. When one exists, OCC never resumes a requested stop.

### Incidents

| Observation        | Rule                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `running`          | No action. An open incident runs one full maintenance preparation and closes `recovered`. |
| `starting`         | No action. After 15 minutes without an incident, open a status-only `stalled` incident.   |
| `unknown`          | No action and no attempt spent.                                                           |
| First `lost`       | Observe again after 10 seconds.                                                           |
| Second `lost`      | Open an incident and start recovery.                                                      |
| Attempts exhausted | `lost`. Observe every 5 minutes; a later `running` closes it `recovered`.                 |
| Lost again         | Within one hour of `recovered`, reopen the same incident with its attempt count.          |

Attempts back off 0 s, 30 s, 1 min, 2 min, 5 min, and 10 min: about 20 minutes of backoff across six attempts. Each start also has a 10-minute serving deadline.
The worker keeps observing a pending start. It cannot issue another while the outcome remains unknown. The incident record owns the next attempt
time and is written in the same transaction as the work item.

### Recovery attempt

Under the Agent's work claim:

1. Repeat the watch checks, and require the Agent's Harness volume to be the one recorded at
   activation: present, bound, not deleting, same UID. Otherwise the incident ends `lost` with
   `HARNESS_STORAGE_MISSING` and recovery creates nothing.
2. Reauthorize as maintenance does: `deploy` on the Agent as the deploying account, the Backend binding,
   the revision's credential sources, pending credential withdrawals, and repository authority. A refusal
   ends the incident `lost` with the refusal code.
3. Build the revision's preparation context, then call `ComputeDriver.resumeRevision`, which calls
   `SandboxDriver.resumeHarness`. The OpenShell Driver:
   - requires the Sandbox's revision annotation and the same stored-spec check that preparation uses;
   - decides from the read whether a start is allowed, and makes no call when it is not;
   - refreshes the workspace node setup material before the start;
   - rereads the Agent's desired state and pending withdrawals;
   - for an `ERROR` that `StartSandbox` refuses (question 1), records its own stop and calls `StopSandbox` first;
   - calls `StartSandbox` for at most 60 seconds. A timeout leaves the outcome unknown. The next pass reads the same Sandbox.
     It waits through `STARTING`, prepares a running Sandbox, and sends no new mutation on an unreadable phase.
4. When the Sandbox reads `running`, run the revision's normal maintenance preparation. Success closes the
   incident `recovered`.

Each attempt writes the audit event `openclaw.agents.lifecycle.recover` with the Agent, the deploying
account, the incident, and the outcome.

This adds no authority. The actor, checks, and admitted revision are those of a maintenance pass, and
maintenance already repairs a running revision through preparation, including creating a missing Sandbox.
A stop or credential withdrawal committed during the start waits at most for the bounded call; the stop
then deletes the resumed Sandbox.

### Fallbacks

- **Missing Sandbox:** maintenance preparation already creates it again for revisions without Git. It
  binds the same volumes and runtime-home subpath, so it keeps the same state, and it now passes the
  volume check first.
- **Unstartable `ERROR`:** stop, then start, keeping the same Sandbox and volumes. Question 1 asks the
  owner to approve this and the missing-Sandbox case, both only under the volume check. Never for
  repository Git revisions.
- **New revision:** never automatic.

### Repository Git revisions

A resumed Sandbox has new Pods and a new supervisor. The Git route pins both, so it closes for good. In
the first delivery, a lost Git revision goes `lost` with **Deploy again** (option A of
[question 2](decisions.md#question-2-repository-git-options)). Its work item is completed and queued
again at 5 minutes, never failed permanently, because a permanent failure retires the runtime. If the
owner chooses re-attachment (option B), a later delivery needs its own security review and must:

1. withdraw the old Git provider generation before the start, because OpenShell re-admits stored providers;
2. keep the old route and standing execution closed, and adopt nothing;
3. bootstrap a new route epoch in first-deployment order, with launch witness, new continuity pins, and full
   repository authority;
4. add an epoch to the standing execution record and decide its deadline rule;
5. allow at most three epochs per revision.

### Status

- A table holds each revision's last incident: state, times, attempts, next attempt, last observation,
  outcome, and whether a stop was seen.
- `GET .../harness-status` adds `recovery` (`state`, `since`, `attempts`, `maxAttempts`, `nextAttemptAt`,
  `code`, `recoveredAt`, `hint`). `occ agent get` prints it.
- Agent lists show a **Health** badge from the table, without a Driver call: Recovering, Stalled,
  Stopped outside OCE, or Needs attention. Running Agents show none.
- The Console's **Live serving** shows a plain message, a "Likely cause" hint from OpenShell platform
  events, and **Start**, **Try again**, or **Deploy again**. Raw phases and events stay in a collapsed
  details block ([user experience](decisions.md#what-the-user-sees)).
- **Start** and **Try again** (`occ agent recover`) need `operate` on the Agent and open a new incident.
- Deployment status adds `HARNESS_RECOVERING`, `HARNESS_RECOVERED`, `HARNESS_STALLED`, `HARNESS_LOST`, and a
  message for `REPOSITORY_EXECUTION_UNVERIFIED`.
- The worker emits `worker.harness-recovery`. Metrics: `occ_harness_recovery_attempts_total{outcome}`,
  `occ_harness_incidents_total{result}`, and `occ_harness_incidents{state}`, with no per-Agent labels.
- The 5-second loop observes first. A lost Sandbox follows the incident rules; an unverified execution backs
  off to 60 seconds and shows its status after two minutes.

### Contract changes

All are optional. A Driver without them keeps today's behavior plus the status.

- `ComputeDriver.resumeRevision?(revision, context, signal)`
- `SandboxDriver.resumeHarness?(context)`
- `observeHarness` lost code `SANDBOX_STOPPING`
- OCC's OpenShell protocol copy adds `StartSandbox`, `StopSandbox`, and the Sandbox conditions.
- The revision records its Harness volume UID at activation.

### Request lifecycle

Proposed flow; nothing is implemented.

```mermaid
sequenceDiagram
  participant Q as Work queue
  participant W as OCC worker
  participant I as IAM and State
  participant S as OpenShell gateway
  Q->>W: Watch pass (Agent claim)
  W->>S: GetSandbox
  S-->>W: STOPPED on the second read
  W->>I: Reread Agent, check successors, reauthorize
  alt Stopped, replaced, or refused
    I-->>W: Refusal
    W->>Q: End or mark lost, no effect
  else Authorized
    W->>S: Refresh setup material, StartSandbox
    S-->>W: STARTING
    W->>Q: Defer
    Q->>W: Next pass
    W->>S: GetSandbox
    S-->>W: READY
    W->>W: Maintenance preparation
    W->>Q: Recovered, continue watching
  end
```

## Delivery and verification

1. Status only: watch items, seeding, incident table, list badges, hints, `lost` and `stalled`,
   **Deploy again** for Git revisions, and a bounded 5-second loop.
2. Resume for revisions without Git, under the volume check, with **Start**, **Try again**, audit,
   metrics, and docs.
3. Stop then start for an unstartable `ERROR`, and creating a missing Sandbox again, if the owner
   approves question 1.
4. Git re-attachment, if the owner chooses it in question 2, after a security review.

Required evidence:

- Shared test helpers: one fake OpenShell gateway with `StartSandbox`, `StopSandbox`, `STOPPING`, and scripted phases, and
  one PostgreSQL worker fixture for watched revisions.
- Worker integration with the real queue: a reboot resumes once and closes `recovered`; `STOPPING` blocks
  resume; an OCC stop, a saved successor, a withdrawn model credential, or a revoked account calls nothing;
  an unreadable gateway spends no attempt; two workers start once; a Git revision never fails permanently;
  a missing or replaced volume creates nothing; OCC's own stop is not read as an outside stop; the watch
  item adds no rows. Each case has a mutant that it catches.
- Real OpenShell 0.1.5 on k3d: restart the node under a dedicated Codex and a native OpenClaw Agent; each
  must read `recovered` and complete a chat turn. Record the phases after a node restart, a deleted
  supervisor or workload Pod, a drain, and an out-of-band stop. This also shows whether a resumed native
  node host reconnects.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Automatic new revision:** re-admits current settings and closes Git access. The owner asked to avoid it.
- **Recreate before resume:** replaces the Sandbox's identity. Stop then start covers an unstartable
  `ERROR` in place.
- **Gateway self-report or Kubernetes controller:** see [Ownership](#ownership).
- **OpenShell list or watch:** `ListSandboxes` has no phase filter and `WatchSandbox` is one stream per
  Sandbox. A cached per-workspace list can replace per-revision reads if cost requires it.
- **A new maintenance row per pass:** work rows are kept until the Agent is deleted, so one deferred item
  per revision is used instead.
- **Keep today's behavior:** every node restart needs a manual deploy of each dedicated Agent.

## Decisions (owner, 10-23)

- **Out-of-band stop:** resume a `STOPPED` Sandbox when no `STOPPING` was seen. The worker reads the
  phase, conditions, and platform events; each edge case has a decision and a user-facing state
  ([edge cases](decisions.md#edge-cases)).
- **Status scope:** Agent lists show a Health badge, and messages carry plain-language cause hints from
  node and Pod events. Hints never trigger or block an action.
- **Defaults:** a 60-second interval (the only operator setting), six attempts with about 20 minutes of total backoff,
  then every 5 minutes, and `stalled` after 15 minutes.

## Unresolved questions

The owner decides both. Evidence and options are in [the decisions companion](decisions.md).

1. **Automatic rebuild.** Disk and chat history are kept: they live on OCE-owned volumes, not in the
   Sandbox. Proposed: rebuild (stop then start, or create again) only when the Agent's recorded volume is
   still there; otherwise show **Needs your decision**, because a new volume would be empty.
2. **Repository Git.** A: deploy again (proposed now). B: resume and re-attach Git through route epochs.
   C: resume without Git until a deploy. D: an automatic new version.

## References

- [Sandbox Driver contract](../../../docs/reference/drivers/sandbox.md)
- [Compute Driver contract](../../../docs/reference/drivers/compute.md)
- [Controller worker flow](../../../docs/flows/controller-worker.md)
- [Agent troubleshooting](../../../docs/guides/topics/agent-troubleshoot.md)
- OpenShell 0.1.5: `proto/openshell.proto`, `crates/openshell-server/src/compute/mod.rs`,
  `crates/openshell-driver-kubernetes/src/driver.rs`
