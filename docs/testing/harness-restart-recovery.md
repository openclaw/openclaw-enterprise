# Qualify interrupted session recovery

Run the dedicated Codex Pod-continuity case in
[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
with the [real Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets).
The existing `k3d-model` CI lane includes this case.

## What the case checks

The model writes a marker in its Harness workspace and waits in a tool call.
The test observes the write and active run, then exercises Gateway Pod replacement,
replacement of both Pods within the same Agent revision, and native Gateway
process loss with its wrapper alive. In the process-loss case, the finite remote
command remains active; recovery waits for it to finish before adopting its thread. It sends no additional user message for each
interrupted session. Native OpenClaw startup must admit a
continuation that inspects the retained work and produces a visible final answer.

The test checks the original session identity, one public restart-continuation
marker, one final result, and one workspace write. Completed and explicitly
cancelled sessions must remain unchanged. A healthy replacement Pod or a
successful new user turn alone does not satisfy these checks.

Agent redeployment is a negative control. It creates a new revision and must
leave the predecessor's interrupted work stopped. The test completes a fresh
turn on the replacement before checking that the interrupted session has no
continuation or final result and that its workspace effect was not repeated.
See the [revision boundary](../reference/agents/interrupted-turns.md).

The [native recovery flow](../flows/harness-restart-recovery.md) describes the
workspace reconnect and remote-turn waits, including their refusal conditions.

Run the case against the current runtime containing both the revision-scope and
Harness-readiness bridges. Results from before revision scoping do not qualify
the current redeployment behavior. Real-model proof does not replace the required
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
