# Interrupted turns

A Gateway that shuts down gracefully aborts its active turns and records them for
restart recovery. A Gateway that later starts on the same retained state resumes a
recorded turn with one hidden system message. That message asks the Agent to check
the current state and continue.

A message that a signed-in user sends from the Agent UI while a turn runs steers
that turn: OCE keeps OpenClaw's default queue mode, `steer`.
Embedded OpenClaw adds the message after the running tool calls finish. Codex adds
it at the next model step: a command that is still running continues detached,
and the reply can answer only the new message, so ask for the command's output
again. A message the turn cannot take waits in the session's queue and follows
a resumed turn. An HTTP chat request is not in that queue; see
[HTTP chat callers](#http-chat-callers).

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

## HTTP chat callers

An [HTTP chat](../agent-http-chat.md) request that waits behind the turn is not
kept when the Gateway ends, in every case in the table. The caller gets an error:
`502` with code `BAD_GATEWAY` when the connection closes before a response, or an
error status that OCC passes on. On Kubernetes a graceful Gateway Pod deletion
usually gives a non-stream caller `503` with a `text/plain` body from the proxy in
front of the Gateway: `upstream connect error or disconnect/reset before headers`.
A streamed response that already started closes without `[DONE]`. Send the
request again. The caller of the interrupted turn gets the same error. If that
turn resumes, its reply goes to the conversation: send again with the same `user`
label to read it.

## Limits

- A Gateway that misses its graceful shutdown, for example after forced
  termination, leaves unfinished runs to the runtime's crash recovery, which does
  not check the revision.
- A runtime from before this scope wrote its records without one. The first
  Gateway restart after an upgrade to a scoped runtime clears such a record
  instead of resuming it, so a turn cut by that upgrade does not resume.
- A resumed turn runs with the session owner's current access, or with no caller
  when the session has no human owner.
