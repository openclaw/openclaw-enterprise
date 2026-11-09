import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type {
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { verifyFirstAgentModel } from "../../scripts/first-agent-model.mjs";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.mjs";
import { deployFiniteAgent, observeUntil } from "../helpers/finite-git-agent.ts";
import { createFiniteGitProviderObservation } from "../helpers/finite-git-providers.ts";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";
import {
  createFiniteGitConversation,
  finiteGitConversationFailureStage,
} from "../helpers/finite-git-conversation.ts";
import {
  createOpenShellGitDenial,
  openShellGitDenialFailureStage,
} from "../helpers/openshell-git-denial.mjs";

const selected = process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";

interface OriginToken {
  uses: number;
  revoked: boolean;
}

test(
  "OpenShell retains its runtime after Git expiry and worker restart",
  { skip: !selected, timeout: 45 * 60_000 },
  async (t) => {
    // This owns a real Helm installation, PostgreSQL and authenticated stock Gateway.
    // The only controlled upstream is a private Git server and its App token issuer.
    const fixture = await createOpenShellGitInstallation(t);
    const {
      namespace,
      modelSource,
      origin,
      gatewayClient,
      workspace,
      checkpoint: evidence,
    } = fixture;
    const { agent, revision, suffix, deadlineWallMs, readExecution, original, target, supervisor } =
      await deployFiniteAgent(t, fixture);
    const modelKubectl = async (...args: (string | { input?: string; timeout?: number })[]) => {
      const options = args.pop();
      assert.ok(options && typeof options === "object");
      assert.ok(args.every((argument) => typeof argument === "string"));
      return fixture.kube(args, options);
    };
    const verifyModelTurn = async (stage: string) => {
      const before = origin.snapshot();
      assert.deepEqual((await readExecution()).identity, original.identity);
      // The existing first-Agent probe sends an authenticated, nonce-only turn
      // through the real Gateway and Codex bridge. Its password stays in the
      // Gateway Pod; the model credential remains in the protected Sandbox.
      const proof = await verifyFirstAgentModel(modelKubectl, {
        namespaceId: namespace.id,
        agentId: agent.id,
        revisionId: revision.id,
        prompt: undefined,
        apiKey: undefined,
        expectProviderKey: false,
      });
      assert.deepEqual((await readExecution()).identity, original.identity);
      assert.deepEqual(origin.snapshot(), before, `${stage}: model turn used the Git origin`);
      await evidence("model-turn-succeeded", { stage, nonce: proof.nonce });
    };
    const providers = original.sandbox.spec?.providers;
    assert.ok(Array.isArray(providers) && providers.length >= 3);
    const retained: {
      name: string;
      provider: OpenShellProviderResponse;
      profile: OpenShellStoredProviderProfile;
      definition: Readonly<Record<string, unknown>>;
    }[] = [];
    for (const name of providers) {
      const provider = await gatewayClient.getProvider(workspace, name, t.signal);
      assert.ok(provider);
      const profile = await gatewayClient.getProviderProfile(
        provider.profileWorkspace || null,
        provider.type,
        t.signal,
      );
      assert.ok(profile?.definition);
      if (profile.definition.inference_capable || provider.type === "oce-codex-runtime") {
        retained.push({ name, provider, profile, definition: profile.definition });
      }
    }
    assert.equal(retained.length, 2, "retain the real model and ordinary runtime-file providers");
    const inference = retained.find(({ definition }) => definition.inference_capable);
    assert.equal(inference?.provider.labels["openclaw.dev/credential-source-id"], modelSource.id);
    const runtime = retained.find(({ provider }) => provider.type === "oce-codex-runtime");
    assert.ok(runtime);
    // Stock omits empty repeated fields on the wire. Reading this naturally
    // endpointless profile must succeed both now and during the worker's subtraction.
    assert.deepEqual(runtime.definition.endpoints, []);
    assert.deepEqual(runtime.definition.credentials, []);
    assert.ok(Array.isArray(runtime.definition.files) && runtime.definition.files.length > 0);
    const retainedNames = retained.map(({ name }) => name).sort();

    const execute = createManagedWorkloadExec(t, {
      backend: fixture.gatewayBackend,
      gatewayClient,
      workspace,
      checkpoint: fixture.checkpoint,
    });
    const executable = await execute(target, [
      "sh",
      "-ceu",
      'readlink -f "$(git --exec-path)/git-remote-https"',
    ]);
    const gitDenial = createOpenShellGitDenial({
      gatewayClient,
      workspace,
      sandbox: original.sandbox.name,
      sandboxId: original.sandbox.id,
      supervisor,
      readSupervisor: () => fixture.verifySupervisorImage(target),
      executable: executable.stdout.toString("utf8").trim(),
      signal: t.signal,
    });
    assert.match(origin.repository, /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
    const gitUrl = `https://github.com/${origin.repository}.git`;
    const directory = `/sandbox/enterprise/git-retention-${suffix}`;
    const git = `LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c protocol.version=2 ls-remote '${gitUrl}' refs/heads/main`;
    assert.ok(Date.now() < deadlineWallMs, "initial Git must start before its finite deadline");
    const beforeGit = origin.snapshot();
    const successfulGit = await execute(target, [
      "sh",
      "-ceu",
      `mkdir '${directory}'; printf '%s' '${suffix}' > '${directory}/identity'; ${git}`,
    ]);
    assert.equal(
      successfulGit.stdout.toString("utf8").trim(),
      `${origin.initialSha}\trefs/heads/main`,
    );
    const afterGit = origin.snapshot();
    assert.ok(Date.now() < deadlineWallMs, "initial Git must finish before its finite deadline");
    assert.ok(afterGit.connections > beforeGit.connections);
    assert.ok(afterGit.requests > beforeGit.requests);
    assert.ok(afterGit.tokens.some((token: OriginToken) => token.uses > 0 && !token.revoked));
    await evidence("initial-git-succeeded", {
      revisionId: revision.id,
      sha: origin.initialSha,
      connections: afterGit.connections,
      requests: afterGit.requests,
    });
    await verifyModelTurn("before-expiry");
    assert.ok(Date.now() < deadlineWallMs, "initial model turn must finish before Git expires");

    await observeUntil(
      "the admitted Git deadline",
      t.signal,
      async () => (Date.now() >= deadlineWallMs ? true : undefined),
      deadlineWallMs - Date.now() + 10_000,
    );
    const expiry = await fixture.waitForExpiry({ agentId: agent.id, revisionId: revision.id });
    await evidence("git-expiry-observed", { deadlineWallMs, ...expiry });
    // Wait for acknowledged retirement and observable supplier subtraction, so a
    // background token DELETE cannot be mistaken for a denied Git connection.
    await observeUntil("Git expiry and token retirement", t.signal, async () => {
      const { sandbox, identity } = await readExecution();
      assert.deepEqual(identity, original.identity);
      const attached = sandbox.spec?.providers;
      const snapshot = origin.snapshot();
      return Array.isArray(attached) &&
        attached.length === retainedNames.length &&
        retainedNames.every((name) => attached.includes(name)) &&
        snapshot.tokens.length > 0 &&
        snapshot.tokens.every((token: OriginToken) => token.revoked)
        ? true
        : undefined;
    });
    const retiredOrigin = origin.snapshot();

    const verifyRetainedExecution = async (stage: string) => {
      // Keep the pre-restart baseline: replacement-worker maintenance must not
      // issue a new token or contact the origin before this verification starts.
      const before = retiredOrigin;
      assert.deepEqual(origin.snapshot(), before, `${stage}: retired Git origin changed`);
      const { sandbox, identity } = await readExecution();
      assert.deepEqual(identity, original.identity, `${stage}: runtime identity changed`);
      assert.deepEqual(await fixture.verifySupervisorImage(target), supervisor);
      const attached = sandbox.spec?.providers;
      assert.ok(Array.isArray(attached));
      assert.deepEqual([...attached].sort(), retainedNames);
      for (const saved of retained) {
        const provider = await gatewayClient.getProvider(workspace, saved.name, t.signal);
        assert.ok(provider);
        // Compare maps semantically without printing private runtime material
        // when an assertion fails or treating protobuf map order as identity.
        assert.equal(
          isDeepStrictEqual(provider, saved.provider),
          true,
          `${stage}: independent provider changed`,
        );
        const profile = await gatewayClient.getProviderProfile(
          provider.profileWorkspace || null,
          provider.type,
          t.signal,
        );
        assert.equal(
          isDeepStrictEqual(profile, saved.profile),
          true,
          `${stage}: independent profile changed`,
        );
      }
      await verifyModelTurn(stage);
      // Fixed exit codes identify the failed check without returning Git output.
      // Every nonzero exit still fails the managed Exec and this installed case.
      try {
        const baseline = await gitDenial.snapshot();
        const startedAt = Date.now();
        const result = await execute(target, [
          "sh",
          "-ceu",
          [
            `test "$(cat '${directory}/identity')" = '${suffix}' || exit 41`,
            `printf '%s' '${stage}' > '${directory}/non-git' || exit 42`,
            `test "$(cat '${directory}/non-git')" = '${stage}' || exit 43`,
            "git --version >/dev/null || exit 44",
            `set +e; ${git} >'${directory}/git.out' 2>'${directory}/git.err'; status=$?; set -e`,
            'test "$status" -ne 0 || exit 45',
            'test "$status" -ne 126 && test "$status" -ne 127 || exit 46',
            `test ! -s '${directory}/git.out' || exit 47`,
            "printf '%s' 'non-git-succeeded;fresh-git-failed'",
          ].join("; "),
        ]);
        const endedAt = Date.now();
        assert.equal(result.stdout.toString("utf8"), "non-git-succeeded;fresh-git-failed");
        // A fresh absolute name avoids resolver search domains. Stock emits the
        // DNS refusal before answering, even if it supplies a synthetic address;
        // only that ordered supplier marker, not lookup status, closes observation.
        const markerHost = `git-retention-${randomUUID()}.invalid`;
        await execute(target, [
          "node",
          "-e",
          "require('node:dns').lookup(process.argv[1], { family: 4 }, () => {});",
          `${markerHost}.`,
        ]);
        const markerEndedAt = Date.now();
        // Stock mediates workload connect() before HTTP. Require its explicit
        // policy denial during this isolated attempt, not a generic Git failure.
        const denial = await gitDenial.expectAfter(baseline, {
          startedAt,
          endedAt,
          markerHost,
          markerEndedAt,
        });
        assert.deepEqual(origin.snapshot(), before, `${stage}: denied Git reached the origin`);
        await evidence("git-policy-denied", { stage, ...denial });
      } catch (error) {
        // Retain only counters and equality, including when a shell subcheck
        // fails before the normal no-origin assertion. Diagnostics are best effort.
        try {
          const after = origin.snapshot();
          await evidence("retained-execution-failed", {
            stage,
            connectionsBefore: before.connections,
            connectionsAfter: after.connections,
            requestsBefore: before.requests,
            requestsAfter: after.requests,
            originUnchanged: isDeepStrictEqual(after, before),
          });
        } catch {
          // Preserve the original Exec failure if checkpointing also fails.
        }
        throw error;
      }
      assert.deepEqual((await readExecution()).identity, original.identity);
      await evidence(stage, {
        ...identity,
        nonGit: "succeeded",
        freshGit: "transparent-policy-denied",
        connections: before.connections,
        requests: before.requests,
      });
    };
    await verifyRetainedExecution("after-expiry");
    // An actual Deployment restart discards all worker and Driver memory. Its
    // PostgreSQL route and custody Secret must still identify this same execution.
    const restart = await fixture.restartWorker({ agentId: agent.id, revisionId: revision.id });
    assert.deepEqual(
      origin.snapshot(),
      retiredOrigin,
      "worker restart used the retired Git origin",
    );
    await evidence("worker-restarted", restart);
    await verifyRetainedExecution("after-worker-restart");
  },
);

test(
  "OpenShell isolates Git withdrawal before worker replacement and retains denial afterward",
  { skip: !selected, timeout: 45 * 60_000 },
  async (t) => {
    let phase = "setup";
    const generationFields = [
      "attachmentEpoch",
      "providerEnvRevision",
      "configRevision",
      "policyHash",
      "sessionId",
      "processInstanceId",
      "networkInstanceId",
    ] as const;
    const describeDifferences = (
      actual: Record<string, unknown>,
      expected: Record<string, unknown>,
      fields: readonly string[],
    ) => {
      try {
        const changed = fields.filter(
          (field) => !isDeepStrictEqual(actual[field], expected[field]),
        );
        if (changed.length) {
          phase += `: ${changed.join(", ")}`;
        }
      } catch {
        // Preserve the exact assertion below if diagnostic comparison itself fails.
      }
    };
    const phases = {
      live: {
        witnessBefore: "live witness before denial",
        witnessAfter: "live witness after denial",
        denied: "live denied Git",
        marker: "live DNS marker",
        supervisor: "live supervisor evidence",
        worker: "live worker observation",
        workerIdentity: "live worker identity",
        receipt: "live denial receipt",
        signed: "live signed decision",
        origin: "live origin checks",
      },
      replacement: {
        witnessBefore: "replacement witness before denial",
        witnessAfter: "replacement witness after denial",
        denied: "replacement denied Git",
        marker: "replacement DNS marker",
        supervisor: "replacement supervisor evidence",
        worker: "replacement worker observation",
        workerIdentity: "replacement worker identity",
        receipt: "replacement denial receipt",
        signed: "replacement signed decision",
        origin: "replacement origin checks",
      },
    } as const;
    try {
      const finite = new AbortController();
      const context = {
        signal: AbortSignal.any([t.signal, finite.signal]),
        after: t.after.bind(t),
        diagnostic: t.diagnostic.bind(t),
      } as TestContext;
      const fixture = await createOpenShellGitInstallation(context, { witnessIssuedGit: true });
      const { origin, workspace, gatewayClient } = fixture;
      // The finite clock starts at deploy. Neither Agent borrows the other's admission.
      const agents = await Promise.allSettled([
        deployFiniteAgent(context, fixture),
        deployFiniteAgent(context, fixture),
      ] as const);
      const [a, b] = agents.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }
        return result.value;
      });
      assert.ok(a && b);
      assert.notEqual(a.agent.id, b.agent.id);
      assert.notEqual(a.target.sandboxId, b.target.sandboxId);
      const deadline = Math.min(a.deadlineWallMs, b.deadlineWallMs);
      const remaining = () => {
        assert.ok(Date.now() < deadline, "expiry would invalidate explicit-withdrawal evidence");
        return Math.max(1, deadline - Date.now());
      };
      const timer = setTimeout(() => finite.abort(), remaining());
      t.after(() => clearTimeout(timer));
      const finiteSignal = context.signal;
      const conversation = createFiniteGitConversation({
        kube: fixture.kube,
        agent: {
          id: a.agent.id,
          namespaceId: fixture.namespace.id,
          revision: { id: a.revision.id },
        },
        signal: t.signal,
        readExecution: a.readExecution,
        originalIdentity: a.original.identity,
      });
      const execute = createManagedWorkloadExec(
        { signal: finiteSignal, after: t.after.bind(t) },
        {
          backend: fixture.gatewayBackend,
          workspace,
          gatewayClient,
          checkpoint: fixture.checkpoint,
        },
      );
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
        signal: finiteSignal,
      });
      assert.match(origin.repository, /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
      const git =
        "LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c protocol.version=2 ls-remote --exit-code --refs https://github.com/" +
        origin.repository +
        ".git refs/heads/main";
      const read = async (actor: typeof a) => {
        remaining();
        const before = origin.snapshot();
        const priorAttempts = origin.gitAttemptIndices().length;
        const outcome = await execute(actor.target, ["sh", "-ceu", git]);
        assert.equal(
          outcome.stdout.toString("utf8").trim() === origin.initialSha + "\trefs/heads/main",
          true,
          "authorized Git must return the expected ref",
        );
        const after = origin.snapshot();
        const used = [...new Set<number>(origin.gitAttemptIndices().slice(priorAttempts))];
        assert.ok(
          used.length === 1 && used[0] !== undefined,
          "one Git credential for this successful read",
        );
        assert.ok(
          after.endpoints["upload-advertise:200"] > (before.endpoints["upload-advertise:200"] ?? 0),
        );
        return used[0];
      };
      const indexA = await read(a);
      const indexB = await read(b);
      assert.notEqual(indexA, indexB, "two Agents must use distinct credentials");
      const providers = await createFiniteGitProviderObservation({
        fixture,
        agent: a,
        signal: finiteSignal,
        remaining,
      });
      const inTime = () => {
        remaining();
      };
      phase = "before chat";
      let previousReply = await conversation.turn(undefined, remaining());
      phase = "withdrawal";
      inTime();
      // Keep A's exact upstream credential valid while OCE withdraws access. A real 503
      // leaves retirement unconfirmed; the issuer must refuse any accidental replay too.
      origin.refuseTokenRetirement(indexA);
      const issuedBeforeRemoval = origin.snapshot().issued;
      await fixture.request("PATCH", a.path, {
        configurationId: a.configuration.id,
        repositoryBindings: [],
      });
      const saved = await fixture.request("GET", a.path);
      assert.equal(saved.repositoryBindings, undefined);
      assert.equal(saved.activeRevisionId, a.revision.id);
      const identity = { sandboxId: a.target.sandboxId, revisionId: a.revision.id };
      const witness = async (stage: string) => {
        phase = stage;
        let status: number | undefined;
        const checkpoint = async () => {
          let outcome = status === undefined ? "unconfirmed" : "refused";
          if (status === 200) {
            outcome = "accepted";
          }
          await fixture.checkpoint("withdrawal-origin-witness", {
            stage,
            outcome,
            status: status ?? null,
            targetedRetirementRefusals: origin.snapshot().targetedRetirementRefusals,
          });
        };
        try {
          inTime();
          assert.ok(remaining() > 5_000, "insufficient time for the bounded origin witness");
          status = await origin.probeIssuedGit(indexA);
          assert.equal(status, 200, "A's original credential must still allow discovery");
          inTime();
        } catch (error) {
          try {
            await checkpoint();
          } catch {
            // Preserve the witness failure if diagnostic retention also fails.
          }
          throw error;
        }
        await checkpoint();
      };
      const verify = async (replacement?: {
        expectedWorker: string;
        checkOrigin: (completedWitnesses: number) => void;
      }) => {
        const mode = replacement ? "replacement" : "live";
        const expectedWorker = replacement?.expectedWorker;
        const step = phases[mode];
        replacement?.checkOrigin(0);
        await witness(step.witnessBefore);
        replacement?.checkOrigin(1);
        phase = step.signed;
        const diagnostics = {
          mode,
          workerReady: false,
          workerComparison: "unchecked",
          freshRequests: 0,
          logReads: 0,
          logReadSuccesses: 0,
          logReadFailures: 0,
          linesRead: 0,
          parsedEvents: 0,
          parseFailures: 0,
          tailLimitReads: 0,
          candidates: 0,
          rejectedCode: 0,
          rejectedReason: 0,
          rejectedOperation: 0,
          rejectedRequestId: 0,
        };
        let before: ReturnType<typeof origin.snapshot>;
        try {
          const previous = await fixture.gitWithdrawalDenials(identity, diagnostics);
          if (expectedWorker !== undefined) {
            diagnostics.workerComparison =
              previous.workerUid === expectedWorker ? "same" : "different";
            assert.equal(
              previous.workerUid === expectedWorker,
              true,
              "replacement denial must use the named Worker",
            );
          }
          phase = step.origin;
          assert.deepEqual((await a.readExecution()).identity, a.original.identity);
          const baseline = await denial.snapshot();
          before = origin.snapshot();
          const attempts = origin.gitAttemptIndices().length;
          phase = step.denied;
          const startedAt = Date.now();
          // Keep the raw Git error inside the workload. A transport category only
          // qualifies with the exact, ordered supervisor evidence below.
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
            assert.equal(mode, "live", "completed detach must refuse before HTTP");
            phase = step.signed;
            const observation = await observeUntil(
              "withdrawal decision for original Sandbox and revision",
              finiteSignal,
              async () => {
                const next = await fixture.gitWithdrawalDenials(identity, diagnostics);
                diagnostics.workerComparison =
                  next.workerUid === previous.workerUid ? "same" : "different";
                assert.equal(
                  next.workerUid,
                  previous.workerUid,
                  "Worker changed inside the denial interval",
                );
                const fresh = next.requestIds.filter(
                  (id: string) => !previous.requestIds.includes(id),
                );
                diagnostics.freshRequests = new Set(fresh).size;
                return fresh.length ? fresh : undefined;
              },
              Math.min(10_000, remaining()),
            );
            assert.equal(new Set(observation).size, 1, "ambiguous signed Git denial interval");
            await fixture.checkpoint("finite-removal-live-denial", {
              signer: "exercised",
              boundary: "signed-access-withdrawn",
              requestId: observation[0],
              workerUid: previous.workerUid,
            });
          } else {
            assert.equal(category, "transport");
            phase = step.marker;
            const markerHost = `git-retention-${randomUUID()}.invalid`;
            await execute(a.target, [
              "node",
              "-e",
              "require('node:dns').lookup(process.argv[1], { family: 4 }, () => {});",
              `${markerHost}.`,
            ]);
            phase = step.supervisor;
            const proof = await denial.expectAfter(baseline, {
              startedAt,
              endedAt,
              markerHost,
              markerEndedAt: Date.now(),
            });
            phase = step.worker;
            const next = await fixture.gitWithdrawalDenials(identity, diagnostics);
            phase = step.workerIdentity;
            assert.equal(
              next.workerUid,
              previous.workerUid,
              "Worker changed inside the denial interval",
            );
            phase = step.receipt;
            await fixture.checkpoint("git-policy-denied", {
              stage: mode === "live" ? "after-removal" : "after-worker-restart",
              ...proof,
            });
            if (mode === "live") {
              await fixture.checkpoint("finite-removal-live-denial", {
                boundary: "supervisor-policy",
                signer: "unexercised",
                requestId: null,
                workerUid: previous.workerUid,
              });
            }
          }
          phase = step.origin;
          assert.equal(origin.gitAttemptIndices().length, attempts);
          replacement?.checkOrigin(1);
        } catch (error) {
          if (phase === step.signed) {
            try {
              await fixture.checkpoint("withdrawal-decision-unconfirmed", diagnostics);
            } catch {
              // Preserve the original observation failure if diagnostic retention fails.
            }
          }
          throw error;
        }
        phase = step.origin;
        const after = origin.snapshot();
        // Retirement has its own endpoint. No fresh Git request (including a denied GET),
        // unexpected API request, or new issuance may be hidden by the probes.
        const countsWithoutRetirement = (snapshot: typeof before) =>
          Object.entries(snapshot.endpoints).filter(([name]) => !name.startsWith("revoke:"));
        assert.deepEqual(countsWithoutRetirement(after), countsWithoutRetirement(before));
        const revocations = (snapshot: typeof before) =>
          Object.entries(snapshot.endpoints).reduce(
            (sum, [key, n]) => sum + (key.startsWith("revoke:") ? Number(n) : 0),
            0,
          );
        assert.equal(
          after.requests - before.requests,
          revocations(after) - revocations(before),
          "unexpected origin request during withdrawal",
        );
        assert.equal(after.issued, before.issued);
        await witness(step.witnessAfter);
        replacement?.checkOrigin(2);
        assert.deepEqual((await a.readExecution()).identity, a.original.identity);
        inTime();
      };
      await verify();
      phase = "live B positive";
      assert.equal(await read(b), indexB, "B must reuse its original credential after A's denial");
      assert.equal(origin.snapshot().issued, issuedBeforeRemoval);
      assert.deepEqual((await b.readExecution()).identity, b.original.identity);
      inTime();
      phase = "after chat";
      previousReply = await conversation.turn(previousReply, remaining());
      // The live denial does not wait for cleanup. The restart must follow the actual
      // issuer refusal so the replacement cannot pass before retirement was attempted.
      phase = "retirement refusal before restart";
      await observeUntil(
        "A's targeted retirement refusal",
        finiteSignal,
        async () => {
          inTime();
          const snapshot = origin.snapshot();
          assert.ok(snapshot.targetedRetirementRefusals <= 1, "retirement must not replay");
          if (snapshot.targetedRetirementRefusals === 0) {
            return undefined;
          }
          assert.equal(
            snapshot.tokens.find((token: OriginToken & { index: number }) => token.index === indexA)
              ?.revoked,
            false,
            "the issuer must not revoke A's original credential",
          );
          return true;
        },
        Math.min(180_000, remaining()),
      );
      inTime();
      // Issuer refusal does not prevent local policy subtraction. Observe it before
      // requiring a pre-HTTP denial from the replacement Worker.
      phase = "confirmed provider removal";
      const beforeRestartGeneration = await providers.waitForRemoval();
      const originBeforeRestart = origin.snapshot();
      const checkReplacementOrigin = origin.observeReplacementOrigin(indexA, indexB);
      const restartTraffic = origin.observeRestartTraffic(indexA, indexB);
      phase = "restart invocation";
      const restart = await fixture.restartWorker({
        agentId: a.agent.id,
        revisionId: a.revision.id,
      });
      phase = "restart deadline";
      inTime();
      phase = "restart identity";
      assert.ok(
        typeof restart.afterUid === "string" &&
          restart.afterUid.length > 0 &&
          restart.afterUid !== restart.beforeUid,
        "the replacement must name a new Worker",
      );
      assert.equal(restart.completion.code, "REPOSITORY_ACCESS_WITHDRAWN");
      assert.equal(restart.completion.workerUid, restart.afterUid);
      await fixture.checkpoint("worker-restarted", restart);
      phase = "reduced supplier read";
      const reducedGeneration = await providers.readReduced((check) => {
        phase = `reduced supplier read: ${check}`;
      });
      phase = "reduced supplier equality";
      describeDifferences(reducedGeneration, beforeRestartGeneration, generationFields);
      assert.equal(
        isDeepStrictEqual(reducedGeneration, beforeRestartGeneration),
        true,
        "worker replacement changed the reduced generation",
      );
      phase = "restart origin equality";
      const afterRestartOrigin = origin.snapshot();
      describeDifferences(afterRestartOrigin, originBeforeRestart, [
        "connections",
        "requests",
        "pullCreateRequests",
        "endpoints",
        "issued",
        "tokens",
        "targetedRetirementRefusals",
      ]);
      const channels = restartTraffic();
      if (channels.length) {
        phase += `; ${channels.join(", ")}`;
      }
      checkReplacementOrigin(0);
      phase = "reduced supplier checkpoint";
      await fixture.checkpoint("finite-removal-reduced", {
        revisionId: a.revision.id,
        ...restart.completion,
        ...reducedGeneration,
      });
      await verify({ expectedWorker: restart.afterUid, checkOrigin: checkReplacementOrigin });
      phase = "replacement chat";
      previousReply = await conversation.turn(previousReply, remaining());
      phase = "post-chat supplier read";
      const postChatGeneration = await providers.readReduced((check) => {
        phase = `post-chat supplier read: ${check}`;
      });
      phase = "post-chat supplier equality";
      describeDifferences(postChatGeneration, reducedGeneration, generationFields);
      assert.equal(isDeepStrictEqual(postChatGeneration, reducedGeneration), true);
      // This extra control follows both finite Git observations and does not spend their budget.
      clearTimeout(timer);
      phase = "alternate-key mismatch";
      await conversation.rejectSubstitution(previousReply, 180_000);
      phase = "targeted retirement refusal";
      checkReplacementOrigin(2);
      const finalOrigin = origin.snapshot();
      assert.equal(
        finalOrigin.issued,
        issuedBeforeRemoval,
        "removal must not issue replacement credentials",
      );
      assert.equal(finalOrigin.targetedRetirementRefusals, 1, "retirement must run exactly once");
      assert.equal(
        finalOrigin.tokens.find((token: OriginToken & { index: number }) => token.index === indexA)
          ?.revoked,
        false,
        "the issuer must not revoke A's original credential",
      );
      await fixture.checkpoint("withdrawal-retirement-refused", {
        outcome: "passed",
        status: 503,
        targetedRetirementRefusals: finalOrigin.targetedRetirementRefusals,
      });
    } catch (error) {
      // Keep only our fixed stage labels; command errors can contain private data.
      const stage =
        finiteGitConversationFailureStage(error) ?? openShellGitDenialFailureStage(error);
      // eslint-disable-next-line preserve-caught-error -- Raw tool errors may contain credentials.
      throw new Error(
        `Finite Git withdrawal verification failed (${phase}${stage ? `: ${stage}` : ""}).`,
      );
    }
  },
);
