# Interrupted turns

OpenClaw can continue eligible interrupted work by sending a new internal input to
the same retained session. The continuation uses saved context and checks the
session owner's current authority. It does not restore a process or tool handle.
Chat messages sent from the Agent UI while the turn ran wait in the session's
queue and follow it. HTTP chat requests are not in that queue; see
[HTTP chat callers](#http-chat-callers).

## Recovery boundary

For locally managed Kubernetes dedicated Codex, OCC stores a server-owned recovery
generation and compatibility domain. A compatible deployment retains this
generation. The selected Compute Driver compares the admitted execution settings,
retained storage, and exact Agent scope; image changes alone do not end continuity.
Configuration, policy, credential, placement, or Harness changes can change the
domain and end the generation.

| Operation                                                                    | Interrupted work                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Compatible redeployment of a running Agent                                   | Eligible work continues in its retained session.            |
| Gateway or Harness replacement within the generation                         | Eligible work continues after reconnection.                 |
| [Explicit stop](deployment.md#stop-and-resume), then one or more deployments | Stays stopped; the next deployment starts a new generation. |
| Incompatible deployment or deletion                                          | Ends the previous generation.                               |

Stop ends the generation in the lifecycle transaction, before workload teardown.
A failed stop cannot let a later deployment reuse that permission. An older
revision retry cannot prepare or activate with an ended generation.

Other Compute Drivers and provider-managed Harnesses use a new recovery scope
for each deployment. Missing Driver support never selects an Agent-wide scope.
[SSH Compute](../drivers/ssh-compute.md#namespace-and-revision-lifecycle) supplies the scope setting,
but stop protection depends on the operator-installed OpenClaw supporting it.

## HTTP chat callers

An [HTTP chat](../agent-http-chat.md) request that waits behind the turn is not
kept when the Gateway ends, in every case in the table. The caller gets an error
from OCC: `502` with code `BAD_GATEWAY` when the connection closes before a
response, or the runtime's own error status. A streamed response that already
started closes without `[DONE]`. Send the request again. The caller of the
interrupted turn gets the same error. If that turn resumes, its reply goes to the
conversation: continue with the same `user` label to read it.

## Native enforcement and limits

In OCE runtime images containing the recovery bridge, both graceful shutdown
markers and persisted crash ownership must match the Gateway's admitted scope. Missing or mismatched evidence prevents continuation
and cancels orphaned queued inputs. Recovery also refuses to reacquire child
completion custody from an ended scope. Current authority and cancellation checks
still apply; the generation grants no permissions.

A surviving Codex turn can finish before adoption. Recovery waits for up to two
minutes of polling and refuses takeover if it stays active; an in-flight read
keeps its native RPC timeout. Completed or explicitly cancelled work does not
become eligible merely because a Gateway starts.

This is best-effort continuation. It does not guarantee exactly-once external
effects, recover a hung executor, remove exclusive replacement downtime, or add
rollback. See [runtime qualification](../../testing/harness-restart-recovery.md)
for the tested cases and [recovery flow](../../flows/harness-restart-recovery.md)
for source ownership.
