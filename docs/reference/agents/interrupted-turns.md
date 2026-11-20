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

Native OpenClaw checks retained state whenever a Gateway starts. The continuation
cases below describe work created without a scope; see the
[transition limit](#native-enforcement-and-limits) for previously scoped work. OCE does not
allocate recovery generations, compare recovery compatibility domains, or supply
a restart scope. Kubernetes, Docker, and SSH use their normal workload startup.
SSH recovery depends on the operator-installed native runtime.

| Operation                                                | Interrupted work                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Redeployment with retained state and a supported Harness | Eligible work can continue in the same session.                             |
| Gateway replacement, alone or with the Harness           | Eligible work can continue after reconnection.                              |
| Replacement of only the Harness (dedicated Codex)        | The turn ends and does not resume; send the request again.                  |
| [Stop](deployment.md#stop-and-resume), then deployment   | Stop shuts down the workload; the later startup may continue eligible work. |
| Harmless configuration change                            | No OCE compatibility filter prevents recovery. Native checks still apply.   |
| Explicit native `chat.abort`                             | Cancelled work does not become eligible on startup.                         |

A scheduled (cron) turn that a Gateway restart interrupts is left to its scheduler:
it gets no continuation and no failure notice. If a user's message was already
accepted into that turn, it continues like other eligible work.

Recovery runs only when a Gateway starts. When only the Harness of a dedicated
Codex Agent is replaced while its Gateway keeps running, for example after a node
drain or failure, an eviction, a Harness container restart, or a repository
session replacement, the Gateway sees its Codex connection close and ends the
turn. The reply shows "Couldn't finish this reply", and its details can say the
work may still be running, but the running command stopped with the Harness. The
session and its history remain. Check for partial effects, then send the request
again or select **Try again**. Redeployment, Stop then deployment, and upgrades
replace the Gateway too and use normal recovery.

Deploying a stopped Agent currently starts it again. Keeping stopped Agents
stopped on deployment is tracked separately by
[issue #6500](https://github.com/openclaw/openclaw-enterprise/issues/6500).
Workload Stop is distinct from native turn cancellation. A failed teardown does
not mean the old workload has stopped; normal ownership and replacement checks
still apply.

Changing Harnesses does not make an incompatible saved session usable. Retained
storage, native state validity, current authority, and Harness support remain
prerequisites. Deletion removes resources according to the Agent deletion contract.

### Native OpenClaw with the OpenShell SandboxDriver

On this development configuration, whose
[production qualification](../drivers/openshell-sandbox.md#qualification-contract)
remains open, the pinned runtime does not continue an interrupted turn after a
Gateway replacement or a redeployment. The resume fails when the new Gateway
starts. The same conversation then answers `500` with `internal error` until
about one minute after the new Gateway is ready, and then works again. Files
that the turn wrote with relative paths are no longer in the session's working
directory; send the task again.

When the Sandbox is lost, a request in flight gets no answer until the
[HTTP chat deadline](../agent-http-chat.md#availability-and-failures): `504`, or
a closed connection without `[DONE]` if its stream had already started. After
you deploy the Agent again, the same `user` label can keep answering `500`; use
a new label.

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
explicit cancellation before admitting continuation. Its optional restart-scope
fields and policy remain unchanged. OCE does not set the scope; new work created
without one uses normal native restart eligibility.

A retained nonempty scope does not match an unset startup scope. Previously scoped
unfinished work may therefore be refused during the transition, including queued
input and child-completion recovery where applicable. This accepted limit does not
prevent new unscoped work from using normal recovery. OCE does not translate native
records or patch this policy.

These are native Gateway authority checks. OCC's native browser proxy uses a
shared native identity; it does not give each OCC user a distinct native profile.
See [native authority](../agent-native-admin.md#native-authority-and-drift).

A surviving Codex turn can finish before adoption. Recovery waits for up to two
minutes of polling and refuses takeover if it stays active; an in-flight read
keeps its native RPC timeout. The reply then tells the user that the Gateway
restarted, that the work is still running and its result is not in this
reply, and to send a new message after it finishes. Completed or explicitly cancelled work does not
become eligible merely because a Gateway starts.

This is best-effort continuation. It does not guarantee exactly-once external
effects, recover a hung executor, remove exclusive replacement downtime, or add
rollback. See [runtime qualification](../../testing/harness-restart-recovery.md)
for the tested cases and [recovery flow](../../flows/harness-restart-recovery.md)
for source ownership.
