import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.mjs";
import { deployFiniteAgent, observeUntil } from "../helpers/finite-git-agent.ts";
import { createFiniteGitProviderObservation } from "../helpers/finite-git-providers.ts";
import {
  createFiniteGitConversation,
  finiteGitConversationFailureStage,
} from "../helpers/finite-git-conversation.ts";
import { createOpenShellGitDenial } from "../helpers/openshell-git-denial.mjs";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";

const selected = process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";

test(
  "OpenShell retains a finite Agent after repository removal until model authority is withdrawn",
  { skip: !selected, timeout: 45 * 60_000 },
  async (t) => {
    let phase = "setup";
    try {
      const finite = new AbortController();
      const context = {
        signal: AbortSignal.any([t.signal, finite.signal]),
        after: t.after.bind(t),
        diagnostic: t.diagnostic.bind(t),
      } as TestContext;
      const fixture = await createOpenShellGitInstallation(context, { witnessIssuedGit: true });
      const { origin, gatewayClient, workspace, checkpoint } = fixture;
      const a = await deployFiniteAgent(context, fixture);
      const remaining = () => {
        context.signal.throwIfAborted();
        assert.ok(
          Date.now() < a.deadlineWallMs,
          "finite removal proof exceeded its original deadline",
        );
        return a.deadlineWallMs - Date.now();
      };
      const timer = setTimeout(() => finite.abort(), remaining());
      t.after(() => clearTimeout(timer));
      const sameExecution = async () => {
        remaining();
        assert.deepEqual((await a.readExecution()).identity, a.original.identity);
      };
      const execute = createManagedWorkloadExec(context, {
        backend: fixture.gatewayBackend,
        gatewayClient,
        workspace,
        checkpoint,
      });
      const executable = await execute(a.target, [
        "sh",
        "-ceu",
        'readlink -f "$(git --exec-path)/git-remote-https"',
      ]);
      const denial = createOpenShellGitDenial({
        gatewayClient,
        workspace,
        sandbox: a.original.sandbox.name,
        sandboxId: a.original.sandbox.id,
        supervisor: a.supervisor,
        readSupervisor: () => fixture.verifySupervisorImage(a.target),
        executable: executable.stdout.toString("utf8").trim(),
        signal: context.signal,
      });
      assert.match(origin.repository, /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
      const git =
        "LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c protocol.version=2 ls-remote --exit-code --refs https://github.com/" +
        origin.repository +
        ".git refs/heads/main";
      phase = "initial Git";
      const beforeGit = origin.snapshot();
      const priorAttempts = origin.gitAttemptIndices().length;
      const read = await execute(a.target, ["sh", "-ceu", git]);
      assert.equal(
        read.stdout.toString("utf8").trim() === origin.initialSha + "\trefs/heads/main",
        true,
      );
      const indices = [...new Set<number>(origin.gitAttemptIndices().slice(priorAttempts))];
      assert.equal(indices.length, 1);
      const index = indices[0];
      assert.ok(index !== undefined);
      assert.ok(
        origin.snapshot().endpoints["upload-advertise:200"] >
          (beforeGit.endpoints["upload-advertise:200"] ?? 0),
      );
      await checkpoint("initial-git-succeeded", {
        revisionId: a.revision.id,
        sha: origin.initialSha,
        connections: origin.snapshot().connections,
        requests: origin.snapshot().requests,
      });
      const providers = await createFiniteGitProviderObservation({
        fixture,
        agent: a,
        signal: context.signal,
        remaining,
      });
      const conversation = createFiniteGitConversation({
        kube: fixture.kube,
        agent: {
          id: a.agent.id,
          namespaceId: fixture.namespace.id,
          revision: { id: a.revision.id },
        },
        signal: context.signal,
        readExecution: a.readExecution,
        originalIdentity: a.original.identity,
      });
      phase = "initial conversation";
      let reply = await conversation.turn(undefined, remaining());
      await checkpoint("finite-removal-conversation", {
        stage: "before-removal",
        revisionId: a.revision.id,
        ...reply,
      });
      const witness = async (stage: string) => {
        phase = stage;
        let status: number | undefined;
        const record = () => {
          let outcome = status === undefined ? "unconfirmed" : "refused";
          if (status === 200) {
            outcome = "accepted";
          }
          return checkpoint("withdrawal-origin-witness", {
            stage,
            status: status ?? null,
            outcome,
            targetedRetirementRefusals: origin.snapshot().targetedRetirementRefusals,
          });
        };
        try {
          remaining();
          assert.ok(remaining() > 5_000, "insufficient time for issuer witness");
          status = await origin.probeIssuedGit(index);
          assert.equal(status, 200, "the original issuer credential must remain valid");
          remaining();
        } catch (error) {
          try {
            await record();
          } catch {
            // Preserve the failed probe if diagnostics also fail.
          }
          throw error;
        }
        await record();
      };
      const noGitTraffic = (before: ReturnType<typeof origin.snapshot>) => {
        const after = origin.snapshot();
        const nonRetirement = (snapshot: typeof before) =>
          Object.entries(snapshot.endpoints).filter(([key]) => !key.startsWith("revoke:"));
        const retirements = (snapshot: typeof before) =>
          Object.entries(snapshot.endpoints).reduce(
            (sum, [key, value]) => sum + (key.startsWith("revoke:") ? Number(value) : 0),
            0,
          );
        assert.deepEqual(nonRetirement(after), nonRetirement(before));
        assert.equal(after.requests - before.requests, retirements(after) - retirements(before));
        assert.equal(after.issued, before.issued);
      };
      const attemptedDenial = async (postDetach: boolean, expectedWorker?: string) => {
        await witness(
          postDetach ? "replacement witness before denial" : "live witness before denial",
        );
        phase = postDetach ? "replacement denial" : "live denial";
        await sameExecution();
        const identity = { sandboxId: a.target.sandboxId, revisionId: a.revision.id };
        // The original worker blocks the route before provider detachment too.
        // Include its mapped access_withdrawn decisions in both sides of the interval.
        const signedBefore = await fixture.gitWithdrawalDenials(identity);
        if (expectedWorker !== undefined) {
          assert.equal(signedBefore.workerUid, expectedWorker);
        }
        const baseline = await denial.snapshot();
        const before = origin.snapshot();
        const attempts = origin.gitAttemptIndices().length;
        const startedAt = Date.now();
        // The command returns only a fixed category. Missing Git, success, or a
        // generic transport error without supplier evidence cannot pass this case.
        const result = await execute(a.target, [
          "sh",
          "-ceu",
          "set +e; error=$(" +
            git +
            ' 2>&1); status=$?; set -e; test "$status" -ne 0; test "$status" -ne 126; test "$status" -ne 127; case "$error" in *"returned error: 403"*|*"response 403"*) printf signed ;; *) printf transport ;; esac',
        ]);
        const endedAt = Date.now();
        const category = result.stdout.toString("utf8");
        if (category === "signed") {
          assert.equal(postDetach, false, "completed detach must refuse before HTTP");
          const fresh = await observeUntil(
            "fresh signed removal denial",
            context.signal,
            async () => {
              const next = await fixture.gitWithdrawalDenials(identity);
              assert.equal(next.workerUid, signedBefore.workerUid);
              const ids = next.requestIds.filter(
                (id: string) => !signedBefore.requestIds.includes(id),
              );
              return ids.length ? [...new Set(ids)] : undefined;
            },
            Math.min(10_000, remaining()),
          );
          assert.equal(fresh.length, 1);
          await checkpoint("finite-removal-live-denial", {
            boundary: "signed-access-withdrawn",
            signer: "exercised",
            requestId: fresh[0],
            workerUid: signedBefore.workerUid,
          });
        } else {
          assert.equal(category, "transport");
          const markerHost = `git-retention-${randomUUID()}.invalid`;
          await execute(a.target, [
            "node",
            "-e",
            "require('node:dns').lookup(process.argv[1], { family: 4 }, () => {});",
            `${markerHost}.`,
          ]);
          const proof = await denial.expectAfter(baseline, {
            startedAt,
            endedAt,
            markerHost,
            markerEndedAt: Date.now(),
          });
          await checkpoint("git-policy-denied", {
            stage: postDetach ? "after-worker-restart" : "after-removal",
            ...proof,
          });
          if (!postDetach) {
            await checkpoint("finite-removal-live-denial", {
              boundary: "supervisor-policy",
              signer: "unexercised",
              requestId: null,
              workerUid: signedBefore.workerUid,
            });
          }
        }
        noGitTraffic(before);
        if (postDetach) {
          assert.deepEqual(
            origin.snapshot(),
            before,
            "post-detach Git must cause no origin traffic",
          );
        }
        assert.equal(origin.gitAttemptIndices().length, attempts);
        await sameExecution();
        await witness(
          postDetach ? "replacement witness after denial" : "live witness after denial",
        );
      };
      phase = "binding removal";
      remaining();
      origin.refuseTokenRetirement(index);
      // Keep one monotonic baseline across removal, observation gaps and retirement.
      const issuedBeforeRemoval = origin.snapshot().issued;
      await fixture.request("PATCH", a.path, {
        configurationId: a.configuration.id,
        repositoryBindings: [],
      });
      const removed = await fixture.request("GET", a.path);
      assert.equal(removed.repositoryBindings, undefined);
      assert.equal(removed.activeRevisionId, a.revision.id);
      // Do not hold cleanup to force the signed-request race. Require whichever
      // actual boundary answered this ordinary workload request.
      await attemptedDenial(false);
      phase = "issuer refusal";
      await observeUntil(
        "targeted issuer refusal",
        context.signal,
        async () => {
          remaining();
          const snapshot = origin.snapshot();
          assert.ok(snapshot.targetedRetirementRefusals <= 1);
          return snapshot.targetedRetirementRefusals === 1 ? true : undefined;
        },
        Math.min(180_000, remaining()),
      );
      phase = "confirmed provider removal";
      const beforeRestartGeneration = await providers.waitForRemoval();
      phase = "worker replacement";
      const originBeforeRestart = origin.snapshot();
      const restart = await fixture.restartWorker({
        agentId: a.agent.id,
        revisionId: a.revision.id,
      });
      remaining();
      assert.notEqual(restart.afterUid, restart.beforeUid);
      assert.equal(restart.completion.code, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.equal(restart.completion.workerUid, restart.afterUid);
      await checkpoint("worker-restarted", restart);
      phase = "reduced supplier generation";
      const reducedGeneration = await providers.readReduced();
      assert.equal(
        isDeepStrictEqual(reducedGeneration, beforeRestartGeneration),
        true,
        "worker replacement changed the reduced generation",
      );
      await checkpoint("finite-removal-reduced", {
        revisionId: a.revision.id,
        ...restart.completion,
        ...reducedGeneration,
      });
      assert.deepEqual(
        origin.snapshot(),
        originBeforeRestart,
        "worker replacement must not replay issuance or retirement",
      );
      phase = "replacement denial";
      await attemptedDenial(true, restart.afterUid);
      phase = "replacement conversation";
      const beforeReply = origin.snapshot();
      reply = await conversation.turn(reply, remaining());
      assert.deepEqual(origin.snapshot(), beforeReply);
      await checkpoint("finite-removal-conversation", {
        stage: "after-replacement",
        revisionId: a.revision.id,
        ...reply,
      });
      assert.equal(isDeepStrictEqual(await providers.readReduced(), reducedGeneration), true);
      phase = "required model withdrawal";
      remaining();
      const withdrawal = await fixture.request(
        "POST",
        `${a.path}/credential-sources/${fixture.modelSource.id}/withdraw`,
      );
      assert.equal(withdrawal.revisionId, a.revision.id);
      assert.equal(withdrawal.state, "pending");
      // Observe actual retirement before the original deadline; neither a stop
      // request nor teardown is allowed to manufacture the acceptance result.
      await observeUntil(
        "original runtime retirement",
        context.signal,
        async () => {
          remaining();
          const current = await fixture.request("GET", a.path);
          assert.ok(
            current.activeRevisionId === undefined || current.activeRevisionId === a.revision.id,
          );
          const sandbox = await gatewayClient.getSandbox(
            { workspace, name: a.original.sandbox.name },
            context.signal,
          );
          const pods = JSON.parse(
            await fixture.kube([
              "get",
              "pods",
              "-A",
              "-l",
              `openclaw.dev/agent=${a.agent.id}`,
              "-o",
              "json",
            ]),
          );
          const sandboxes = JSON.parse(
            await fixture.kube(["get", "sandboxes.agents.x-k8s.io", "-A", "-o", "json"]),
          );
          const originalPresent = sandboxes.items.some(
            (item: { metadata: { uid: string } }) =>
              item.metadata.uid === a.original.identity.sandboxUid,
          );
          return current.activeRevisionId === undefined &&
            sandbox === undefined &&
            pods.items.length === 0 &&
            !originalPresent
            ? true
            : undefined;
        },
        Math.min(180_000, remaining()),
      );
      remaining();
      const final = origin.snapshot();
      assert.equal(
        final.issued,
        issuedBeforeRemoval,
        "removal must not issue replacement credentials",
      );
      assert.equal(final.targetedRetirementRefusals, 1);
      assert.equal(
        final.tokens.find((token: { index: number; revoked: boolean }) => token.index === index)
          ?.revoked,
        false,
      );
      await checkpoint("withdrawal-retirement-refused", {
        outcome: "passed",
        status: 503,
        targetedRetirementRefusals: final.targetedRetirementRefusals,
      });
      await checkpoint("finite-removal-retired", {
        revisionId: a.revision.id,
        cause: "required-model-withdrawn",
        deadlineWallMs: a.deadlineWallMs,
        observedAt: Date.now(),
        activeRevisionCleared: true,
        sandboxAbsent: true,
        agentPodsAbsent: true,
      });
    } catch (error) {
      // Keep only our fixed stage labels; command errors can contain private data.
      const stage = finiteGitConversationFailureStage(error);
      // eslint-disable-next-line preserve-caught-error -- Raw tool errors may contain credentials.
      throw new Error(
        `Finite Git removal acceptance failed (${phase}${stage ? `: ${stage}` : ""}).`,
      );
    }
  },
);
