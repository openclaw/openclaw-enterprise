# Qualify interrupted session recovery

Run the dedicated Codex Pod-continuity case in
[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
with the [real Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets).
The existing `k3d-model` CI lane includes this case.

## What the case checks

The model writes a marker in its Harness workspace and waits in a tool call.
The test observes the write and active run, then exercises Gateway Pod replacement,
Agent redeployment that replaces both Gateway and Harness, and native Gateway
process loss with its wrapper alive. In the process-loss case, the finite remote
command remains active; recovery waits for it to finish before adopting its thread. It sends no additional user message for each
interrupted session. Native OpenClaw startup must admit a
continuation that inspects the retained work and produces a visible final answer.

The test checks the original session identity, one public restart-continuation
marker, one final result, and one workspace write. Completed and explicitly
cancelled sessions must remain unchanged. A healthy replacement Pod or a
successful new user turn alone does not satisfy these checks.

The [native recovery flow](../flows/harness-restart-recovery.md) describes the
workspace reconnect and remote-turn waits, including their refusal conditions.

Local ARM64 k3d qualification on November 17, 2026 passed all three recovery
scenarios and the negative controls with Codex 0.164.0 and `gpt-6-astra`.
The runtime used OpenClaw `b58996d69286d55d1bbbd9b5c03b4ad837baac45`
with the restart bridge in this checkout. This establishes those recovery cases;
it does not replace the required native container checks on both architectures
before merge.

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
