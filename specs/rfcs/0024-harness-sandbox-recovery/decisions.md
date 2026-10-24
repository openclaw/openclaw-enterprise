---
rfc: index.md
---

# Harness Sandbox recovery: owner decisions and remaining choices

This companion records the owner's answers of 2026-10-23 to the questions in
[RFC-0024](index.md), the evidence behind the two questions that stay open, and the
user experience the answers ask for. Code references are to OCE main `29ac81c7d` and
OpenShell 0.1.5 (`bdb956f2`), the pinned version.

## Summary

| Question                              | Owner answer                                            | Result                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1. Rebuild a broken Sandbox           | Easy if disk and prompts are kept; murkier otherwise    | **Open.** They are kept. Proposed rule in [Question 1](#question-1-what-a-sandbox-keeps).                                        |
| 2. Repository Git revisions           | "What are the options?"                                 | **Open.** Four options in [Question 2](#question-2-repository-git-options).                                                      |
| 3. Resume when no `STOPPING` was seen | Yes; query the state; think through edge cases; nice UX | **Decided.** [Question 3](#question-3-state-queries-and-edge-cases).                                                             |
| 4. Health in Agent lists, event hints | Yes; whatever is good UX                                | **Decided.** [Question 4](#question-4-health-in-lists-and-cause-hints).                                                          |
| 5. Interval and bounds                | "That seems fine"                                       | **Decided.** 60 s, six attempts with about 20 minutes of backoff, `stalled` after 15 minutes. Only the interval is configurable. |

## Question 1: what a Sandbox keeps

### Where an Agent's state lives

A dedicated Agent keeps no durable state inside its Sandbox. OCE owns all of it:

| State                                                                                               | Where                                                                                       | Removed by       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------- |
| Configuration, instructions, model and tool settings                                                | OCC database (the revision)                                                                 | Agent deletion   |
| Chat transcripts, sessions, Gateway database, media                                                 | Gateway's own volume `gateway-state-<agent>`, mounted by the Gateway Pod, not the Sandbox   | Agent deletion   |
| Workspace files (including the initial workspace documents), Codex thread history, generated images | Agent's Harness volume `workspace-<agent>` (40 GiB, `ReadWriteOnce`), subpaths per category | Agent deletion   |
| Workspace node identity                                                                             | Same Harness volume, `workspace-node-*` subpath                                             | Agent deletion   |
| Per-version runtime home (native workers' home and temporary files, hook state)                     | Same Harness volume, subpath `openshell-runtime-<revision hash>`                            | Agent deletion   |
| Model and credential-source access, runtime setup                                                   | OpenShell providers, stored by the OpenShell gateway                                        | Revision cleanup |
| Codex `CODEX_HOME` apart from sessions, `/tmp`, running processes                                   | Inside the Sandbox's Pod                                                                    | Any restart      |

Evidence: `kubernetes/index.ts` (`HARNESS_WORKSPACE_CATEGORIES`, `GATEWAY_PRIVATE_STATE_CATEGORIES`,
`harnessWorkspaceClaim`; "Only Agent deletion owns durable state"), `sandbox/openshell.ts`
(`workspaceVolumeMounts`, `sandboxDataMount`, `cleanupResources`), and
[harness execution](../../../docs/reference/harness-execution.md): the Gateway keeps the authoritative transcripts.

OpenShell keeps nothing of its own either. OCE mounts the Agent's volume under `/sandbox`, which
turns off OpenShell's default per-Sandbox volume (`has_explicit_sandbox_data_mount` in the Kubernetes
driver). `DeleteSandbox` deletes the Sandbox resource and its Pods and Secrets; it never deletes a
volume it only references.

### Answer: yes, disk and prompts are kept

- **Resume** (`StartSandbox` on a stopped Sandbox) keeps everything in the table except the last row.
- **Stop, then start** now covers the broken case. OpenShell 0.1.5 accepts `StopSandbox` on an
  `ERROR` Sandbox (upstream #4231), and its documented recovery is "stop, then start". This keeps the
  same Sandbox, so no delete is needed for an unstartable `ERROR`.
- **Delete and create again** for the same revision binds the same volumes and the same runtime-home
  subpath, so it keeps the same state. It also replaces the Sandbox ID, its host key and its service
  endpoint, which preparation reads and checks again. OCE already does this for a missing Sandbox.

Every path loses the work in flight: a reply that was running when the Sandbox died, open terminal
sessions, and Pod-local files. Codex thread history is kept, though resuming a thread after a restart
is not guaranteed.

### When state is not kept

State is lost only when the volume is gone or out of reach:

- someone deleted the Harness volume, or its storage failed;
- the volume uses node-local storage and that node does not come back.

Today a preparation pass silently creates a missing volume again, empty. Workspace setup then
refuses to start, because its completion marker is missing and OCC deleted the document bytes at
activation. The user would see a failed start with no explanation.

### Proposed rule (owner decision)

1. OCC records the Harness volume's UID when a revision activates.
2. Automatic recovery (resume, stop then start, or create again) runs only when that volume still
   exists, is not being deleted, is bound, and has the recorded UID. The worker can read volumes
   (`get` on PersistentVolumeClaims); it does not create one during recovery.
3. Otherwise recovery stops and the Agent shows **Needs your decision**: "This Agent's storage is
   gone. Workspace files and Codex history can't be restored; chat history is kept. Deploy again to
   start with an empty workspace." Deploying again is a human action.
4. A volume that exists but can't be mounted (its node is gone) shows **Stalled** with the hint
   "Its storage is on a server that is offline." An operator decides whether to wait or delete it.

Alternatives: never rebuild automatically, and always ask (simplest, slower recovery); or rebuild
even on a new, empty volume (not recommended: it hides data loss).

## Question 2: repository Git options

A Git-bound revision's route pins the exact Pods and supervisor it watched launch. Any restart replaces
them, so the route closes for good (`REPOSITORY_GIT_ROUTE_BLOCKED`) and only a new version restores Git.
The Sandbox holds a placeholder; the worker holds the credential and checks every request, so a closed
route already fails closed.

| Option                                     | What the user sees                                                                                                                                | What is lost                                                                                                                          | Security                                                                                                                                                                                                                                                                                              | Rough cost                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **A. Deploy again** (recommended for now)  | "Sandbox lost. This Agent has repository access, so OCE can't restart it on its own." A **Deploy again** button reuses the current configuration. | Down until someone deploys. The new version starts a fresh runtime home; files, Codex history and chats stay. Changed settings apply. | Nothing new. The new version gets the full first-deployment proof and repository checks.                                                                                                                                                                                                              | Small: status plus the button, in delivery step 1.                        |
| B. Resume and re-attach Git (route epochs) | The same automatic recovery as other Agents: "Recovering, reconnecting repository access."                                                        | Nothing beyond the in-flight work.                                                                                                    | Touches credential custody. Must withdraw and confirm the old Git credential generation before the start, keep the old route closed, prove the new launch like a first deployment, key the standing execution record by epoch against replay, and cap epochs at three. Needs its own security review. | Large: schema change, custody changes, review, real-cluster proof. Weeks. |
| C. Resume without Git                      | "Running. Repository access is paused; deploy again to restore it." Chat and files work; `git` fetch and push fail with a clear error.            | Git until someone deploys.                                                                                                            | Reuses Git-only removal: detach the Git provider and confirm before the start. Needs model access that does not depend on Git; otherwise the runtime retires as today.                                                                                                                                | Medium.                                                                   |
| D. Automatic new version                   | Automatic recovery, plus a new version in the history.                                                                                            | Runtime home; settings changed since the last deploy apply without a human.                                                           | OCE would create versions on its own under the old deployer's authority. Grants that need a human still block it.                                                                                                                                                                                     | Medium. The owner asked to avoid redeploys.                               |

Recommendation: **A now**, and measure with `occ_harness_incidents_total` how often Git Agents are
lost. Build B if that matters; C only if partial service is worth the confusion of a healthy-looking
Agent that can't push.

## Question 3: state queries and edge cases

### What OCE can read

| Source                   | Signals                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenShell `GetSandbox`   | Phase; conditions with type, status, reason (`PodTerminated`, `DependenciesNotReady`, `MainProcessFailed`) and transition time; provisioning record; restart count; exit code. |
| OpenShell `WatchSandbox` | Platform events (Kubernetes reasons and messages) with a resumable cursor. Hints only.                                                                                         |
| Kubernetes, worker role  | Pods in the Agent's Namespace (`get`, `list`), Harness volume (`get`). Not Nodes.                                                                                              |
| OCC                      | `desiredRuntimeState`, the revision's state, the incident (stop seen, own stop, attempts).                                                                                     |

No source says who stopped a Sandbox: OpenShell 0.1.5 still records no stop reason. OCE's ask for a
durable one stands.

### Edge cases

| Case                                       | Decision                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node reboot                                | `STOPPED`, or `ERROR` (`DependenciesNotReady`) on a single node. Two reads, then resume, or stop then start.                                               |
| `occ agent stop` during recovery           | The stop is written first. Every step rereads it under the Agent claim; the incident ends `ended` and the stop deletes the Sandbox.                        |
| Stop or redeploy during a deploy           | A saved successor ends watching for the old revision; the new deploy owns the Agent. The watcher never brings back a predecessor.                          |
| OCE's own stop (stop then start)           | The incident records "OCE stopping" before `StopSandbox`, so its own `STOPPING` is not read as an outside stop.                                            |
| Outside stop (`STOPPING` seen)             | No resume. **Stopped outside OCE**, with a **Start** action.                                                                                               |
| Outside stop, `STOPPING` missed            | Read as a reboot and resumed. The audit event names it. An admin who wants it down stops the Agent in OCE.                                                 |
| OpenShell gateway restart or unreachable   | `unknown`: no attempt spent, no state change. An interrupted start reads `STARTING`, which a repeated `StartSandbox` drives on.                            |
| Agent Gateway Pod restart                  | Not a Sandbox event. The Sandbox reads `running`; existing enrollment and readiness handle it.                                                             |
| Worker restart mid-attempt                 | The incident holds the next attempt time; another worker continues.                                                                                        |
| Clock skew                                 | Deadlines use the database clock only. OpenShell times are shown, never compared.                                                                          |
| Repeated failures                          | Six attempts per incident. A loss within one hour of `recovered` reopens the same incident with its count, so a flapping Sandbox ends **Needs attention**. |
| Revision superseded mid-resume             | Deploy, stop and delete work wait for the Agent claim; the start call is bounded to 60 s. The next pass sees the successor and stops watching.             |
| Account or credential withdrawn            | Reauthorization fails: no effect, **Needs attention** with the reason.                                                                                     |
| Operator action in OpenShell or Kubernetes | A manual start reads `READY` (no-op). A deleted Sandbox is created again when its volume passes the Question 1 check. A deleted volume needs a decision.   |
| Storage on an offline node                 | `starting` until **Stalled** at 15 minutes, with the storage hint.                                                                                         |

### What the user sees

| State               | Console and CLI message                                                                                             | Action                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Running             | Nothing extra.                                                                                                      |                                 |
| Recovering          | "The sandbox stopped unexpectedly. Restarting it (attempt 2 of 6, next try in 1 min)." With a hint when one exists. |                                 |
| Recovered           | "Recovered at 10:42. Files and chat history were kept; a reply running at 10:31 may have stopped." Shown for 24 h.  |                                 |
| Stalled             | "The sandbox has been starting for 15 minutes." Plus the hint.                                                      | **Try again**                   |
| Stopped outside OCE | "Someone stopped this sandbox outside OCE."                                                                         | **Start**                       |
| Needs attention     | "Couldn't restart the sandbox after 6 tries: <reason>."                                                             | **Try again**, **Deploy again** |
| Needs your decision | Storage gone (Question 1) or repository Git (Question 2, option A).                                                 | **Deploy again**                |

**Start** and **Try again** need `operate` on the Agent, like stop, and open a new incident under the
deploying account's reauthorization. The CLI gets `occ agent recover <agent>`.

## Question 4: health in lists and cause hints

- Agent lists show a **Health** badge from the incident table, without a Driver call: Recovering,
  Stalled, Stopped outside OCE, Needs attention. Running Agents show no badge, so a list never claims
  health it did not read. The list can filter to "Needs attention", and the Agents page header counts them.
- The badge tooltip is the one-line message above. The Agent's **Live serving** section adds the
  action, the attempt history and a collapsed **Details** block with the raw phase, condition reason
  and events. Kubernetes terms appear only there.
- Hints come from OpenShell platform events and the Sandbox condition, mapped to plain words and
  prefixed "Likely cause:": a node restart ("the server it runs on restarted"), a volume node-affinity
  failure ("its storage is on a server that is offline"), an image pull failure ("the Agent image
  couldn't be downloaded"), eviction ("Kubernetes moved it off a busy server"), out of memory ("it ran
  out of memory"). A hint never triggers or blocks an action.

## Question 5: defaults

Accepted: a 60-second watch interval, six attempts with about 20 minutes of total backoff, then a check every
5 minutes, and `stalled` after 15 minutes of starting. Only the interval is an operator setting
(`OCC_WORKER_HARNESS_WATCH_INTERVAL_MS`; `0` turns watching off), because it trades API load
against detection time. The attempt schedule and the stall time stay constants until an operator needs
otherwise.
