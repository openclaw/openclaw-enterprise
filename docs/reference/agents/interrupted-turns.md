# Interrupted turns

A Gateway that shuts down gracefully aborts its active turns and records them for
restart recovery. A Gateway that later starts on the same retained state resumes a
recorded turn with one hidden system message. That message asks the Agent to check
the current state and continue, and messages queued behind the turn follow it.

Kubernetes and Docker Compute scope that record to the Agent revision with
`OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE`. Every deployment creates a new revision
ID, so only a restart of the same revision resumes a turn.

| The Gateway ended because of                                                                  | The interrupted turn                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [Stop](deployment.md#stop-and-resume), then a new deployment                                  | Stays stopped. A message queued behind it is cancelled. |
| A replacement or a deletion                                                                   | Ends. The user sends the request again.                 |
| A rollout during a controller upgrade, a node drain or a Gateway restart of the same revision | Resumes once.                                           |

A replacement does not resume the turn because the next revision can carry
different configuration, policy and credentials.

## Limits

- A Gateway that misses its graceful shutdown, for example after forced
  termination, leaves unfinished runs to the runtime's crash recovery, which does
  not check the revision.
- A runtime from before this scope wrote its records without one. The first
  Gateway restart after an upgrade to a scoped runtime clears such a record
  instead of resuming it, so a turn cut by that upgrade does not resume.
- A resumed turn runs with the session owner's current access, or with no caller
  when the session has no human owner.
