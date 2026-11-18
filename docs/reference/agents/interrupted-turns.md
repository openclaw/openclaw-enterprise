# Interrupted turns

OpenClaw can continue eligible interrupted work by sending a new internal input to
the same retained session. The continuation uses saved context and checks the
session owner's current authority. It does not restore a process or tool handle.

A message that a signed-in user sends from the Agent UI while a turn runs steers
that turn: OCE keeps OpenClaw's default queue mode, `steer`.
Embedded OpenClaw adds the message after the running tool calls finish. Codex adds
it at the next model step: a command that is still running continues detached,
and the reply can answer only the new message, so ask for the command's output
again. A message the turn cannot take waits in the session's queue and follows
a resumed turn. An HTTP chat request is not in that queue; see
[HTTP chat callers](#http-chat-callers).

## Recovery boundary

Native OpenClaw checks retained state whenever a Gateway starts. OCE does not
allocate recovery generations, compare recovery compatibility domains, or supply
a restart scope. Kubernetes, Docker, and SSH use their normal workload startup.
SSH recovery depends on the operator-installed native runtime.

| Operation                                                | Interrupted work                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Redeployment with retained state and a supported Harness | Eligible work can continue in the same session.                             |
| Gateway or Harness replacement                           | Eligible work can continue after reconnection.                              |
| [Stop](deployment.md#stop-and-resume), then deployment   | Stop shuts down the workload; the later startup may continue eligible work. |
| Harmless configuration change                            | No OCE compatibility filter prevents recovery. Native checks still apply.   |
| Explicit native `chat.abort`                             | Cancelled work does not become eligible on startup.                         |

Deploying a stopped Agent currently starts it again. Keeping stopped Agents
stopped on deployment is tracked separately by
[issue #6500](https://github.com/openclaw/openclaw-enterprise/issues/6500).
Workload Stop is distinct from native turn cancellation. A failed teardown does
not mean the old workload has stopped; normal ownership and replacement checks
still apply.

Changing Harnesses does not make an incompatible saved session usable. Retained
storage, native state validity, current authority, and Harness support remain
prerequisites. Deletion removes resources according to the Agent deletion contract.

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

## Native enforcement and limits

Native OpenClaw checks session identity, the owner's current authority, and
explicit cancellation before admitting continuation. The OCE runtime removes the
upstream supervisor-scope filter for graceful markers, crash recovery, queued
inputs, and child completion custody. Previously recorded scope metadata does
not authorize or prevent continuation.

These are native Gateway authority checks. OCC's native browser proxy uses a
shared native identity; it does not give each OCC user a distinct native profile.
See [native authority](../agent-native-admin.md#native-authority-and-drift).

A surviving Codex turn can finish before adoption. Recovery waits for up to two
minutes of polling and refuses takeover if it stays active; an in-flight read
keeps its native RPC timeout. The reply then tells the user that the Gateway
restarted, that the work still runs in the Agent's workspace and its result is
not in this reply, and to send a new message after it finishes. Completed or explicitly cancelled work does not
become eligible merely because a Gateway starts.

This is best-effort continuation. It does not guarantee exactly-once external
effects, recover a hung executor, remove exclusive replacement downtime, or add
rollback. See [runtime qualification](../../testing/harness-restart-recovery.md)
for the tested cases and [recovery flow](../../flows/harness-restart-recovery.md)
for source ownership.
