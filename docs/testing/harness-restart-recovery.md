# Qualify interrupted session recovery

Run the dedicated Codex Pod-continuity case in
[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
with the [real Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets).
The existing `k3d-model` CI lane includes this case.

## What the case checks

The model writes a marker in its Harness workspace and waits in a tool call.
The test observes the write and active run, then exercises Gateway Pod replacement,
replacement of both Pods within the same Agent revision, and native Gateway
process loss with its wrapper alive, and compatible Agent API redeployment. In the process-loss case, the finite remote
command remains active; recovery waits for it to finish before adopting its thread. It sends no additional user message for each
interrupted session. Native OpenClaw startup must admit a
continuation that inspects the retained work and produces a visible final answer.

The test checks the original session identity, one public restart-continuation
marker, one final result, and one workspace write. Completed and explicitly
cancelled sessions must remain unchanged. A healthy replacement Pod or a
successful new user turn alone does not satisfy these checks.

Explicit stop is a negative control. The case denies workload deletion to the
fixture's scoped worker, commits stop through the Agent API, and observes failed
teardown with a cleared recovery generation. It restores the original role and
deploys a replacement. A fresh turn must complete while the stopped session has
no continuation or final result and its workspace effect was not repeated.
See the [generation boundary](../reference/agents/interrupted-turns.md).

The native-profile control creates a session through the authenticated native-admin
WebSocket over a pinned local TLS ingress. It first proves compatible recovery,
then assigns the profile a read-only role before another replacement. OCC's proxy
uses the shared `occ-workspace-files` profile, so this revocation also blocks OCC
readiness requests. The test proves refusal and a fresh shared-secret-owner turn
before restoring the profile's prior role and waiting for deployment to finish.
Later replacements must leave that refused session unchanged. This proves native
profile authority, not distinct identity propagation or revocation for each OCC user.

An incompatible configuration is a separate refusal control. Neither refusal is
proved by an unready runtime: each replacement must complete a fresh model turn.

The PostgreSQL replacement suite separately checks concurrent deployments, stop
followed by two admissions before activation, changed and unsupported domains,
and the database pair constraint. It uses the real controller and worker with a
Compute fixture; it does not prove native runtime behavior.

The [native recovery flow](../flows/harness-restart-recovery.md) describes the
workspace reconnect and remote-turn waits, including their refusal conditions.

Run the case against the current runtime containing generation scoping for
graceful, crash, and child-completion recovery and the Harness-readiness bridge.
Earlier results without this lifecycle contract do not qualify redeployment. Real-model proof does not replace the required
native container checks on both architectures before merge.

## Recovery boundaries

OpenClaw owns interruption detection and continuation admission. OCC does not
add another startup scanner or `chat.send` caller. Recovery admits a new input;
it does not reconstruct an OS process, tool handle, or execution stack. The
Agent must check existing work before repeating an uncertain effect.

This case does not qualify abrupt whole-Pod loss, simultaneous crash of both
workloads, OpenShell replacement, hung remote executors, or exactly-once external effects. A live wrapper can
reap its native child and release that child's state lock. A replacement Pod
cannot assume an old lock owner is dead. Preserve the lock refusal and use the
[state-owner recovery procedure](../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner);
do not delete lock records to make a test pass.

Dedicated replacement still stops the predecessor first. Continuation does
not remove downtime or supply automatic rollback. See the
[Harness contract](../reference/harness-execution.md#limits) and
[runtime storage boundaries](../reference/security/runtime-isolation.md#agent-runtime-isolation).
