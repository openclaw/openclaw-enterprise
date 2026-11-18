# Interrupted turns

A Gateway that shuts down gracefully aborts its active turns and records them for
restart recovery. A Gateway that later starts on the same retained state resumes a
recorded turn with one hidden system message. That message asks the Agent to check
the current state and continue, and messages queued behind the turn follow it.

OCE scopes that record to the Agent revision with
`OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE`. Every deployment creates a new revision
ID, so only a restart of the same revision resumes a turn. Whether this holds
depends on the Compute Driver:

- **Kubernetes Compute:** covered. The runtime image supports the setting, and stop
  allows 330 seconds for the graceful shutdown.
- **SSH Compute:** the systemd unit sets the scope. It takes effect only once the
  OpenClaw that the operator installs on the host supports the setting. Until
  then, a turn cut by stop resumes at the next deployment.
- **Docker Compute** (development only): stop kills an embedded Gateway without a
  graceful shutdown. That forced termination is not covered: the runtime's crash
  recovery can resume the turn.

The table applies where the scope is in effect.

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
