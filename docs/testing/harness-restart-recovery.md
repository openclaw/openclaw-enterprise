# Qualify interrupted session recovery

Run the dedicated Codex Pod-continuity case in
[`harness-topology-k3d-real.test.mjs`](../../tests/integration/harness-topology-k3d-real.test.mjs)
with the [real Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets).
The existing `k3d-model` CI lane includes this case. The QA matrix also exposes
`OCC_TEST_QA_SCENARIOS=native-restart`, with `OCC_TEST_QA_INSTALLATION=kubernetes`
and `OCC_TEST_QA_PRESET=Codex`. That explicit selection reuses this real workflow
and requires the same prepared `k3d-model` resources, images, model credentials,
and native-admin TLS inputs. It is not part of the default advisory selection.

After preparing the `k3d-model` file environment for
`harness-topology-k3d-real.test.mjs`, run the selected QA workflow from the
repository root. Keep the authorized model credentials in the calling environment:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=native-restart \
OCC_TEST_QA_INSTALLATION=kubernetes OCC_TEST_QA_PRESET=Codex \
  node --env-file=/path/to/prepared/test.env --test tests/integration/qa-matrix-real.test.mjs
```

The selected case must pass without skips. Use the preparation state's cleanup
command afterward; preserve unrelated clusters and the default kubeconfig.

## What the case checks

Each case starts new work without an OCE-projected restart scope. The model
writes a marker in its Harness workspace and waits in a tool call.
The test observes the write and active run, then exercises Gateway Pod replacement,
replacement of both Pods within the same Agent revision, and native Gateway
process loss with its wrapper alive, and Agent API redeployment. In the process-loss case, the finite remote
command remains active; recovery waits for it to finish before adopting its thread. It sends no additional user message for each
interrupted session. Native OpenClaw startup must admit a
continuation that inspects the retained work and produces a visible final answer.

The test checks the original session identity, one public restart-continuation
marker, one final result, and one workspace write. Completed and explicitly
cancelled sessions must remain unchanged. A healthy replacement Pod or a
successful new user turn alone does not satisfy these checks.

Stop followed by Deploy is a continuation case. The test denies workload deletion
to the fixture's worker, commits Stop through the Agent API, and observes failed
teardown with the desired state saved as stopped. It restores the original role
and deploys a replacement. Eligible work and a previously accepted queued input
must continue without another user send. See the
[Stop boundary](../reference/agents/interrupted-turns.md#recovery-boundary) and
[issue #6500](https://github.com/openclaw/openclaw-enterprise/issues/6500).

The native-profile control creates a session through the authenticated native-admin
WebSocket over a pinned local TLS ingress. It first proves recovery,
then assigns the profile a read-only role before another replacement. OCC's proxy
uses the shared `occ-workspace-files` profile, so this revocation also blocks OCC
readiness requests. The test proves refusal and a fresh shared-secret-owner turn
before restoring the profile's prior role and waiting for deployment to finish.
Later replacements must leave that refused session unchanged. This proves native
profile authority, not distinct identity propagation or revocation for each OCC user.

A harmless configuration-generation change is a separate continuation case on
the same Harness. Revoked native ownership remains a refusal control, verified
against a ready replacement that can complete a fresh model turn.

The PostgreSQL replacement suite separately checks Stop during preparation,
concurrent deployments, and superseded revisions with the real controller and
worker. Its Compute fixture does not prove native runtime behavior. Migration
coverage checks fresh installation and populated recovery metadata removal,
revision immutability, and limited application permissions.

The [native recovery flow](../flows/harness-restart-recovery.md) describes the
workspace reconnect and remote-turn waits, including their refusal conditions.

Run against images built from the final change, with unchanged upstream scope
policy and the pinned source's restart waits. Upstream CI runs
`session-restart-resume.scope.test.ts`, recovery, custody, and session-entry tests
at the pin; the image build does not repeat them. They cover normal unscoped
eligibility and scope mismatch refusal, including previously scoped records.
These source tests do not prove a real model workflow.

Continuation of old-scoped unfinished work is not required. Upstream may refuse
that work during transition, including queued input or completion custody where
applicable. No scope translator or behavior patch is supplied. The earlier
inverse-patch test results do not qualify this final policy.

Real-model proof and native image checks on both architectures remain required.
Current delivery evidence and gaps belong to
[TASK-0053](../../specs/plans/0053-native-restart-recovery.md).

## Recovery boundaries

OpenClaw owns interruption detection and continuation admission. OCC does not
add another startup scanner or `chat.send` caller. Recovery admits a new input;
it does not reconstruct an OS process, tool handle, or execution stack. The
Agent must check existing work before repeating an uncertain effect.

This case does not qualify abrupt whole-Pod loss, simultaneous crash of both
workloads, replacement of only the Harness Pod (the turn ends; see
[interrupted turns](../reference/agents/interrupted-turns.md#recovery-boundary)),
OpenShell replacement, hung remote executors, or exactly-once external effects. A live wrapper can
reap its native child and release that child's state lock. A replacement Pod
cannot assume an old lock owner is dead. Preserve the lock refusal and use the
[state-owner recovery procedure](../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner);
do not delete lock records to make a test pass.

Dedicated replacement still stops the predecessor first. Continuation does
not remove downtime or supply automatic rollback. See the
[Harness contract](../reference/harness-execution.md#limits) and
[runtime storage boundaries](../reference/security/runtime-isolation.md#agent-runtime-isolation).
