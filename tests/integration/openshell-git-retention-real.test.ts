import { compileOpenShellBoundGitRule } from "../../apps/controller/src/drivers/sandbox/openshell-git-network-policy.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { InstallationDeploymentInventory } from "@openclaw-enterprise/contracts";

import type {
  OpenShellProviderResponse,
  OpenShellSandboxCreateRequest,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { verifyFirstAgentModel } from "../../scripts/first-agent-model.ts";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.ts";
import {
  deployFiniteAgent,
  deployStandingAgent,
  directGitLaunchVerifier,
  observeUntil,
  traceDirectGitBootstrap,
} from "../helpers/finite-git-agent.ts";
import { createFiniteGitProviderObservation } from "../helpers/finite-git-providers.ts";
import { OpenShellPreparedGitProvider } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";
import { waitForStockSupervisor } from "../helpers/openshell-stock-supervisor-readiness.ts";
import { ownFirstAgentWork } from "../helpers/local-first-agent-stack.mjs";
import {
  createFiniteGitConversation,
  finiteGitConversationFailureStage,
} from "../helpers/finite-git-conversation.ts";
import {
  createGitAclDenialCommand,
  createGitAclEnvironmentGuard,
  createOpenShellGitDenial,
  gitRemovalDenialCategory,
  gitRemovalDenialCommand,
  openShellGitDenialFailureStage,
} from "../helpers/openshell-git-denial.ts";

const selected = process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";

// The installed lane keeps its declared cases. Ordinary integration runs exercise polling off-cluster.
if (!selected) {
  test("stock Supervisor readiness pins the Pod and its container", async (t) => {
    const digest = "sha256:" + "a".repeat(64);
    const configDigest = "sha256:" + "b".repeat(64);
    const otherDigest = "sha256:" + "c".repeat(64);
    const expected = {
      sandboxId: "sandbox",
      sandboxUid: "sandbox-uid",
      image: `registry.example/supervisor@${digest}`,
      digests: [digest, configDigest],
    };
    const pod = {
      metadata: {
        uid: "pod-uid",
        name: "supervisor",
        labels: {
          "openshell.ai/boundary-role": "supervisor",
          "openshell.ai/boundary-pair": "pair",
        },
        annotations: { "openshell.ai/sandbox-id": expected.sandboxId },
        ownerReferences: [{ kind: "Sandbox", uid: expected.sandboxUid }],
      },
      spec: { containers: [{ name: "supervisor", image: expected.image }] },
    };
    const running = {
      name: "supervisor",
      ready: true,
      imageID: `containerd://${configDigest}`,
      containerID: "containerd://owned",
      state: { running: {} },
    };
    const ready = { ...pod, status: { phase: "Running", containerStatuses: [running] } };
    const pending = {
      ...pod,
      status: {
        phase: "Pending",
        containerStatuses: [
          { name: "supervisor", ready: false, state: { waiting: { reason: "ContainerCreating" } } },
        ],
      },
    };
    const noRead = async () =>
      assert.fail("must check the initial identity and image before reading");
    await t.test(
      "waits for the selected container's ready status and runtime digest",
      async (t) => {
        let reads = 0;
        const readPod = async (signal: AbortSignal) => {
          assert.equal(signal.aborted, false);
          reads++;
          return ready;
        };
        assert.deepEqual(
          await waitForStockSupervisor(pending, readPod, expected, t.signal),
          running,
        );
        assert.equal(reads, 1);
        assert.deepEqual(await waitForStockSupervisor(ready, noRead, expected, t.signal), running);
      },
    );
    await t.test("rejects a wrong requested or resolved image before readiness", async (t) => {
      await assert.rejects(
        waitForStockSupervisor(
          { ...pending, spec: { containers: [{ name: "supervisor", image: "other" }] } },
          noRead,
          expected,
          t.signal,
        ),
        /must select the verified stock image/,
      );
      const wrongImage = {
        ...ready,
        status: {
          ...ready.status,
          containerStatuses: [{ ...running, ready: false, imageID: otherDigest }],
        },
      };
      await assert.rejects(
        waitForStockSupervisor(wrongImage, noRead, expected, t.signal),
        /running supervisor image must match/,
      );
    });
    await t.test("refuses a replaced Pod or restarted container during the wait", async (t) => {
      await assert.rejects(
        waitForStockSupervisor(
          pending,
          async () => ({ ...ready, metadata: { ...pod.metadata, uid: "replacement" } }),
          expected,
          t.signal,
        ),
        /supervisor Pod UID changed/,
      );
      const starting = {
        ...ready,
        status: { ...ready.status, containerStatuses: [{ ...running, ready: false }] },
      };
      const replacement = {
        ...ready,
        status: {
          ...ready.status,
          containerStatuses: [{ ...running, containerID: "containerd://replacement" }],
        },
      };
      await assert.rejects(
        waitForStockSupervisor(starting, async () => replacement, expected, t.signal),
        /supervisor container identity changed/,
      );
    });
    await t.test("reports the last waiting reason when startup does not finish", async (t) => {
      await assert.rejects(
        waitForStockSupervisor(pending, noRead, expected, t.signal, 25),
        /did not become ready within 25 ms \(phase=Pending, reason=ContainerCreating/,
      );
      const cancellation = new Error("cancelled fixture");
      await assert.rejects(
        waitForStockSupervisor(pending, noRead, expected, AbortSignal.abort(cancellation)),
        (error) => error === cancellation,
      );
    });
  });
}

interface OriginToken {
  uses: number;
  revoked: boolean;
}

test(
  "OpenShell standing Git remains available when a controller-only upgrade refuses worker replacement",
  { skip: !selected, timeout: 45 * 60_000 },
  async (t) => {
    const fixture = await createOpenShellGitInstallation(t, { allowStandingApprovals: true });
    const { agent, revision, path, readExecution, original, target } = await deployStandingAgent(
      t,
      fixture,
    );
    const { namespace, origin } = fixture;
    const conversation = createFiniteGitConversation({
      kube: fixture.kube,
      agent: { id: agent.id, namespaceId: namespace.id, revision: { id: revision.id } },
      signal: t.signal,
      readExecution,
      originalIdentity: original.identity,
    });
    const execute = createManagedWorkloadExec(t, {
      backend: fixture.gatewayBackend,
      gatewayClient: fixture.gatewayClient,
      workspace: fixture.workspace,
      checkpoint: fixture.checkpoint,
    });
    assert.match(origin.repository, /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
    const readGit = async () => {
      const before = origin.snapshot();
      const result = await execute(target, [
        "sh",
        "-ceu",
        "LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 " +
          "git -c protocol.version=2 ls-remote --exit-code --refs https://github.com/" +
          origin.repository +
          ".git refs/heads/main",
      ]);
      assert.equal(result.stdout.toString("utf8").trim(), `${origin.initialSha}\trefs/heads/main`);
      assert.ok(
        origin.snapshot().requests > before.requests,
        "the fresh read reached the private origin",
      );
    };

    // Establish both kinds of service before asking the real upgrade helper to
    // retain the revision. The installation API must classify the live grant.
    await readGit();
    const reply = await conversation.turn(undefined, 180_000);
    await observeUntil("the original worker's standing Git launch evidence", t.signal, async () => {
      const inventory: InstallationDeploymentInventory = await fixture.request(
        "GET",
        "/installation/deployment-inventory",
      );
      const retained = inventory.namespaces
        .find(({ id }) => id === namespace.id)
        ?.agents.find(({ id }) => id === agent.id);
      assert.equal(retained?.activeRevisionId, revision.id);
      assert.equal(retained?.deploymentInProgress, false);
      return retained?.repositoryWorkerRestart === "original-worker-required" ? true : undefined;
    });

    const revisionsBefore = await fixture.request("GET", `${path}/revisions`);
    const upgrade = await fixture.upgradeController();
    assert.equal(upgrade.code, 1);
    assert.ok(
      upgrade.stderr.includes(
        `Namespace "${namespace.id}", Agent "${agent.id}", revision "${revision.id}": original-worker-required`,
      ),
      "the canonical controller-only helper must refuse this exact retained revision",
    );
    assert.match(
      upgrade.stderr,
      /Stop and settle these Agents under an authorized interruption, or plan a normal revision replacement/u,
    );
    assert.deepEqual(
      upgrade.after,
      upgrade.before,
      "Helm and both writer processes must stay unchanged",
    );

    await conversation.turn(reply, 180_000);
    await readGit();
    assert.deepEqual((await readExecution()).identity, original.identity);
    assert.deepEqual(await fixture.request("GET", `${path}/revisions`), revisionsBefore);
  },
);

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
    const modelKubectl = async (...args: unknown[]): Promise<string> => {
      const options = args.pop();
      assert.ok(options && typeof options === "object");
      assert.ok(args.every((argument) => typeof argument === "string"));
      const output: unknown = await fixture.kube(args, options);
      assert.ok(typeof output === "string");
      return output;
    };
    // The same Git-enabled Installation must also start a model-only Agent. This uses the
    // ordinary API, real worker, Gateway attachment and a genuine model turn before Git starts.
    const model = process.env.OCC_TEST_OPENAI_MODEL;
    assert.ok(model);
    const base = `/namespaces/${namespace.id}`;
    const configuration = await fixture.request("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", model),
    });
    const modelOnly = await fixture.request("POST", `${base}/agents`, {
      name: `model-only-${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: modelSource.id },
      credentialSources: [{ sourceId: modelSource.id }],
    });
    const role = await fixture.request("POST", `${base}/iam/roles`, {
      name: `model-only-${randomUUID()}`,
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    await fixture.request("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: modelOnly.servicePrincipalId,
      roleId: role.id,
      resourceKind: "credential_source",
      resourceId: modelSource.id,
    });
    const modelPath = `${base}/agents/${modelOnly.id}`;
    await fixture.request("POST", `${modelPath}/runtime-credentials`, {});
    const modelRevision = await fixture.request("POST", `${modelPath}/deploy`);
    await observeUntil(
      "model-only Agent startup",
      t.signal,
      async () => {
        const deployment = await fixture.request(
          "GET",
          `${modelPath}/deployments/${modelRevision.id}`,
        );
        assert.notEqual(deployment.status, "failed");
        return deployment.status === "succeeded" ? deployment : undefined;
      },
      600_000,
    );
    await verifyFirstAgentModel(modelKubectl, {
      namespaceId: namespace.id,
      agentId: modelOnly.id,
      revisionId: modelRevision.id,
      prompt: undefined,
      apiKey: undefined,
      expectProviderKey: false,
    });
    await fixture.request("POST", `${modelPath}/stop`);
    t.diagnostic("Fresh Gateway model source completed a model-only turn with Git configured.");

    const { agent, revision, suffix, deadlineWallMs, readExecution, original, target, supervisor } =
      await deployFiniteAgent(t, fixture);
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
          const result = await execute(a.target, gitRemovalDenialCommand(git));
          const endedAt = Date.now();
          const category = gitRemovalDenialCategory(result);
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

function settleBeforeFixtureTeardown(run: (t: TestContext) => Promise<void>) {
  return (t: TestContext) => ownFirstAgentWork(t)(run(t));
}

// Run in an approved disposable window with the documented OpenShell prerequisites:
// OCC_TEST_OPENSHELL_K3D_REAL=1 node --test --test-name-pattern='OpenShell enforces installed Git repository ACLs with managed Basic credentials' tests/integration/openshell-git-retention-real.test.ts
test(
  "OpenShell enforces installed Git repository ACLs with managed Basic credentials",
  { skip: !selected, timeout: 45 * 60_000 },
  settleBeforeFixtureTeardown(async (t) => {
    const fixture = await createOpenShellGitInstallation(t, { networkAcl: true });
    const { gatewayClient, workspace, origin } = fixture;
    const network = origin.network;
    assert.ok(network && network.token);
    assert.match(fixture.sandboxImage, /@sha256:[a-f0-9]{64}$/);
    assert.match(origin.initialSha, /^[a-f0-9]{40}$/u);
    const workspaceResource = await gatewayClient.getWorkspace(workspace, t.signal);
    const workspaceId = workspaceResource?.id;
    assert.ok(workspaceId);
    // The fixture owns the cluster and its operator credential. One test owns
    // these random Sandbox names, never reuses them, and owns cluster teardown.
    const runLabel = "openclaw.dev/git-acl-test-run";
    const runId = randomUUID();
    const managedExec = createManagedWorkloadExec(t, {
      backend: fixture.gatewayBackend,
      gatewayClient,
      workspace,
      checkpoint: fixture.checkpoint,
    });

    const token = network.token;
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const denialCommand = createGitAclDenialCommand(token);
    type Target = { sandboxName: string; sandboxId: string };
    const execute = async (target: Target, command: string[]) => {
      const result = await managedExec(target, command);
      // Fail before parsing or reporting any guest output that exposes the broad credential.
      for (const output of [result.stdout, result.stderr]) {
        assert.ok(!output.includes(token) && !output.includes(basic), "ACL_CREDENTIAL_IN_OUTPUT");
      }
      return result;
    };

    // Calibrate the exact broad credential at the origin outside OpenShell.
    // The repository grants apply at OpenShell, while the origin checks authentication.
    const directory = await temporaryDirectory(t, "installed-git-acl-control-");
    const ca = join(directory, "ca.pem");
    await writeFile(ca, origin.tls.ca, { mode: 0o600 });
    const port = new URL(origin.origin).port;
    assert.ok(port, "ACL_OWNED_ORIGIN_PORT");
    const controlEnv = cleanEnvironment({
      HOME: directory,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSL_CAINFO: ca,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "http.extraHeader",
      GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_2: "http.curloptResolve",
      GIT_CONFIG_VALUE_2: `github.com:${port}:${fixture.originBridge}`,
      NO_PROXY: "github.com",
      no_proxy: "github.com",
    });
    const control = (args: string[]) =>
      run("git", args, { cwd: directory, env: controlEnv, signal: t.signal });
    await control(["clone", `https://github.com:${port}/fixture/a.git`, "a"]);
    await control(["-C", "a", "push", "origin", "HEAD:refs/heads/approved"]);
    assert.equal(await network.ref("fixture/a", "refs/heads/approved"), origin.initialSha);
    await control(["clone", `https://github.com:${port}/fixture/c.git`, "c"]);
    await control(["-C", "c", "push", "origin", "HEAD:refs/heads/control"]);
    assert.equal(await network.ref("fixture/c", "refs/heads/control"), origin.initialSha);

    const createSandbox = async (
      name: string,
      providers: string[],
      gitRule?: ReturnType<typeof compileOpenShellBoundGitRule>,
    ) => {
      const selector = { workspace, name };
      assert.ok(!(await gatewayClient.getSandbox(selector, t.signal)), "ACL_NAME_ALREADY_USED");
      const request: OpenShellSandboxCreateRequest = {
        name,
        workspace,
        requestId: randomUUID(),
        labels: { [runLabel]: runId },
        annotations: {},
        serviceExposures: [],
        spec: {
          template: { image: fixture.sandboxImage },
          command: ["/bin/sh", "-c", "sleep 3600"],
          providers,
          policy: {
            version: 1,
            filesystem: {
              read_only: ["/usr", "/bin", "/lib", "/lib64", "/etc"],
              read_write: ["/tmp", "/dev/null"],
            },
            process: { run_as_user: "1000", run_as_group: "1000" },
            network_policies: gitRule ? { [gitRule.name]: gitRule } : {},
          },
        },
      };
      const verifyLaunch = directGitLaunchVerifier(request);
      const created = await gatewayClient.createSandbox(request, t.signal);
      assert.ok(created.id);
      await observeUntil(
        "disposable Git Sandbox startup",
        t.signal,
        async () => {
          const current = await gatewayClient.getSandbox(selector, t.signal);
          assert.ok(current?.id === created.id, "ACL_SANDBOX_IDENTITY");
          assert.equal(current.workspace, workspace);
          assert.equal(current.labels[runLabel], runId);
          // Verify the intended attachment while the Sandbox is starting.
          assert.deepEqual(current.spec?.providers ?? [], providers);
          return current.phase === "SANDBOX_PHASE_READY" || current.phase === 2
            ? current
            : undefined;
        },
        180_000,
      );
      return { sandboxName: name, sandboxId: created.id, verifyLaunch };
    };

    // Resolve the real networking executables in the selected image before binding
    // the Provider. The probe has no credential or network grant.
    const probe = await createSandbox(`gp-${randomBytes(8).toString("hex")}`, []);
    const paths = await execute(probe, [
      "sh",
      "-ceu",
      'readlink -f "$(git --exec-path)/git-remote-https"; readlink -f "$(command -v curl)"',
    ]);
    const [gitHelper, curl] = paths.stdout.toString("utf8").trim().split("\n");
    assert.ok(
      /^\/(usr\/lib(?:exec)?\/git-core)\/git-remote-http(?:s)?$/.test(gitHelper ?? ""),
      "ACL_GIT_HELPER_IDENTITY",
    );
    assert.ok(/^\/[A-Za-z0-9_./-]+$/.test(curl ?? ""), "ACL_CURL_IDENTITY");

    assert.ok(gitHelper && curl);

    const install = async (
      repositoryNetworkPolicy: Parameters<typeof compileOpenShellBoundGitRule>[0],
    ) => {
      const name = `ga-${randomBytes(8).toString("hex")}`;
      const scope = {
        workspace,
        workspaceId,
        sandbox: name,
        executionId: randomUUID(),
        installationId: origin.installationId,
        gitOrigin: "https://github.com",
        apiOrigin: "https://api.github.com",
        binaries: [gitHelper, curl],
        nativeGit: "v1" as const,
        repositoryNetworkPolicy,
        expectedProviders: [],
        managedSandbox: true as const,
      };
      const observation = traceDirectGitBootstrap(gatewayClient);
      const provider = new OpenShellPreparedGitProvider(observation.client, scope);
      // The first generation holds only a sentinel. The real credential is
      // eligible for delivery after the selected Sandbox loads its bound rules.
      const bootstrap = await provider.bootstrap(t.signal);
      const rule = compileOpenShellBoundGitRule(
        repositoryNetworkPolicy,
        bootstrap.provider,
        scope.binaries,
      );
      const target = await createSandbox(name, [bootstrap.provider], rule);
      const supervisor = await fixture.verifySupervisorImage(target);
      await fixture.checkpoint("installed-supervisor", supervisor);
      const observeBootstrap = () => {
        observation.reset();
        return provider.observe(
          bootstrap,
          target.sandboxId,
          t.signal,
          undefined,
          target.verifyLaunch,
        );
      };
      const initial = await observeUntil(
        "loaded Git policy with bootstrap Provider",
        t.signal,
        observeBootstrap,
        120_000,
      ).catch((error: unknown) => {
        try {
          const evidence = observation.summary(bootstrap, target.sandboxId, rule);
          t.diagnostic(`OpenShell bootstrap readback: ${JSON.stringify(evidence)}`);
        } catch {
          t.diagnostic("OpenShell bootstrap readback unavailable");
        }
        throw error;
      });
      assert.equal(initial.credentialState, "bootstrap");

      const expiresAt = Date.now() + 3_500_000;
      const binding = await provider.rotate(
        bootstrap,
        async () => {
          // After the Gateway client authenticates, recheck the same loaded
          // generation and the complete Provider attachment inventory.
          const current = await observeBootstrap();
          assert.ok(current && isDeepStrictEqual(current, initial), "ACL_BOOTSTRAP_CHANGED");
          assert.ok(
            await gatewayClient.readExclusivePreviewWorkspace(
              workspace,
              target.sandboxId,
              t.signal,
              bootstrap.provider,
            ),
            "ACL_PROVIDER_RECIPIENT",
          );
          const isCurrent = () =>
            !t.signal.aborted &&
            Date.now() < expiresAt &&
            provider.repositoryPolicyIsFresh(current);
          return { value: token, expiresAt: new Date(expiresAt).toISOString(), isCurrent };
        },
        t.signal,
      );
      assert.ok(binding, "ACL_GUARDED_CREDENTIAL_UPDATE");
      assert.equal(binding.providerId, bootstrap.providerId);
      assert.notEqual(binding.resourceVersion, bootstrap.resourceVersion);
      const installed = await observeUntil(
        "installed managed Git Provider",
        t.signal,
        () => provider.observe(binding, target.sandboxId, t.signal, undefined, target.verifyLaunch),
        120_000,
      );
      assert.equal(installed.credentialState, "active");
      assert.equal(installed.providerResourceVersion, binding.resourceVersion);
      assert.equal(installed.attachmentEpoch, initial.attachmentEpoch);
      assert.equal(installed.policyHash, initial.policyHash);
      return { target, supervisor, installed, provider, binding };
    };

    const original = await install([
      { repository: "fixture/a", access: "read" },
      { repository: "fixture/b", access: "write" },
    ]);
    const sandboxResource = ({ sandboxName }: Target) =>
      fixture.kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        sandboxName,
        "-n",
        workspace,
        "--ignore-not-found",
        "-o",
        'jsonpath={.metadata.uid}{" "}{.metadata.labels.openshell\\.ai/sandbox-id}',
      ]);
    const originalResource = await sandboxResource(original.target);
    const [originalUid, originalSandboxId] = originalResource.split(" ");
    assert.ok(originalUid && /^[a-f0-9-]{36}$/.test(originalUid), "ACL_SANDBOX_UID");
    assert.equal(originalSandboxId, original.target.sandboxId);

    const guest = (target: Target, script: string, command: string[] = []) =>
      execute(target, ["sh", "-ceu", script, "--", ...command]);
    // Check the stable alias and absence of the credential in the launch environment.
    // Only fingerprints of the synthetic credential enter the workload command.
    const requirePlaceholderOnly = createGitAclEnvironmentGuard(token);
    const gitSetup = `${requirePlaceholderOnly}; export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false; export HOME=/tmp; git config --global credential.helper '!f() { printf "%s\\n" username=x-access-token "password=$GITHUB_TOKEN"; }; f'`;
    // Start with empty object stores and independently require an authenticated
    // upload-pack POST for each ref fetched into them.
    const freshFetch = async (
      target: Target,
      repository: "a" | "b",
      ref: "main" | "approved",
      directory: string,
      expected: string,
    ) => {
      const before = network.requests().length;
      const branch = "refs/heads/" + ref;
      const fetched = await guest(
        target,
        `${gitSetup};
test ! -e '${directory}';
git init -q --initial-branch=acl-empty '${directory}';
git -C '${directory}' remote add origin 'https://github.com/fixture/${repository}.git';
git -C '${directory}' fetch -q origin '${branch}:${branch}';
git -C '${directory}' rev-parse '${branch}^{commit}';
git -C '${directory}' checkout -q '${ref}'`,
      );
      assert.ok(fetched.stdout.toString("utf8").trim() === expected, "ACL_FRESH_FETCH_OBJECT");
      assert.ok(
        network
          .requests()
          .slice(before)
          .some(
            (request: {
              repository: string;
              operation: string;
              method: string;
              authenticated: boolean;
            }) =>
              request.repository === `fixture/${repository}` &&
              request.operation === "upload-pack" &&
              request.method === "POST" &&
              request.authenticated,
          ),
        "ACL_FRESH_FETCH_ORIGIN",
      );
    };

    await freshFetch(original.target, "a", "main", "/tmp/a", origin.initialSha);
    await freshFetch(original.target, "b", "main", "/tmp/b", origin.initialSha);
    const beforeAllowed = network.requests().length;
    const success = await guest(
      original.target,
      `${gitSetup}; cd /tmp; git -C b -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m change; git -C b push -q origin HEAD:refs/heads/approved; git -C b rev-parse HEAD`,
    );
    const pushed = success.stdout.toString("utf8").trim();
    assert.ok(/^[a-f0-9]{40}$/.test(pushed), "ACL_PUSH_IDENTITY");
    assert.equal(await network.ref("fixture/b", "refs/heads/approved"), pushed);
    assert.equal(await network.hasObject("fixture/b", pushed), true);
    assert.ok(
      network
        .requests()
        .slice(beforeAllowed)
        .some(
          (request: {
            repository: string;
            operation: string;
            method: string;
            authenticated: boolean;
          }) =>
            request.repository === "fixture/b" &&
            request.operation === "receive-pack" &&
            request.method === "POST" &&
            request.authenticated,
        ),
      "ACL_B_PUSH_ORIGIN",
    );

    // First send each exact wire shape with broad material directly to the
    // owned origin. Then require OpenShell to refuse it before parsed HTTP.
    const requests = [
      { service: "upload", method: "GET", allowed: "a", denied: ["c"] },
      { service: "upload", method: "POST", allowed: "a", denied: ["c"] },
      { service: "receive", method: "GET", allowed: "b", denied: ["a", "c"] },
      { service: "receive", method: "POST", allowed: "b", denied: ["a", "c"] },
    ] as const;
    type Probe = Pick<(typeof requests)[number], "service" | "method">;
    const wireRequest = (repository: string, { service: operation, method }: Probe) => {
      const service = `git-${operation}-pack`;
      const discovery = method === "GET";
      const path = `/fixture/${repository}.git/${discovery ? "info/refs" : service}`;
      const target = discovery ? `${path}?service=${service}` : path;
      const body =
        operation === "upload" ? `0032want ${origin.initialSha}\n00000009done\n` : "0000";
      return {
        path,
        target,
        rpc: discovery
          ? []
          : ["-H", `Content-Type: application/x-${service}-request`, "--data-binary", body],
        responseType: `application/x-${service}-${discovery ? "advertisement" : "result"}`,
      };
    };
    const checkOrigin = (before: number, repository: string, { method, service }: Probe) => {
      const observed = network.requests().slice(before);
      assert.equal(observed.length, 1, "ACL_CALIBRATION_COUNT");
      assert.ok(
        observed[0]?.repository === `fixture/${repository}` &&
          observed[0]?.operation === `${service}-${method === "GET" ? "advertise" : "pack"}` &&
          observed[0]?.method === method &&
          observed[0]?.authenticated,
        "ACL_CALIBRATION_ORIGIN",
      );
    };
    const probeCurl = ["-q", "--noproxy", "*", "--proto", "=https", "--max-time", "10", "-s"];
    const statusFormat = "%{http_code} %{content_type}";
    const replay = (target: Target, repository: string, probe: Probe, deny: boolean) => {
      const { path, target: requestTarget, rpc } = wireRequest(repository, probe);
      const args = [...probeCurl, "-X", probe.method, ...rpc, `https://github.com${requestTarget}`];
      if (deny) {
        return guest(
          target,
          `${requirePlaceholderOnly}; exec "$@"`,
          denialCommand({ kind: "rest", method: probe.method, path, host: "github.com" }, [
            curl,
            ...args,
          ]),
        );
      }
      // Inputs come from literal routes and options, plus a validated Git OID.
      const argumentsForShell = args.map((arg) => `'${arg}'`).join(" ");
      return guest(
        target,
        `${requirePlaceholderOnly}; '${curl}' ${argumentsForShell} -u "x-access-token:$GITHUB_TOKEN" -o /dev/null -w '${statusFormat}'`,
      );
    };
    const denyReplay = async (target: Target, repository: string, probe: Probe) => {
      const request = wireRequest(repository, probe);
      const priorRequests = network.requests().length;
      // Strict TLS, fixed private resolution, and no proxies or redirects.
      // The exact fixture credential travels on stdin only.
      const priorOriginRequests = origin.snapshot().requests;
      const witness = await run(
        "curl",
        [
          ...probeCurl,
          "--resolve",
          `github.com:${port}:${fixture.originBridge}`,
          "--cacert",
          ca,
          "-H",
          "Host: github.com",
          "-H",
          "@-",
          "-X",
          probe.method,
          ...request.rpc,
          "-o",
          "/dev/null",
          "-w",
          statusFormat,
          `https://github.com:${port}${request.target}`,
        ],
        {
          cwd: directory,
          env: cleanEnvironment({ HOME: directory }),
          input: `Authorization: Basic ${basic}\n`,
          signal: t.signal,
        },
      );
      assert.ok(witness.stdout === `200 ${request.responseType}`, "ACL_EXACT_TOKEN_BYPASS");
      assert.equal(origin.snapshot().requests, priorOriginRequests + 1, "ACL_WITNESS_ORIGIN_COUNT");
      checkOrigin(priorRequests, repository, probe);

      const before = origin.snapshot().requests;
      const response = await replay(target, repository, probe, true);
      assert.equal(origin.snapshot().requests, before, "ACL_DENIAL_ORIGIN");
      assert.ok(
        response.stdout.toString("utf8") === "403 native-rest-policy\n",
        "ACL_NATIVE_REST_DENIAL",
      );
    };
    for (const request of requests) {
      const before = network.requests().length;
      const calibration = await replay(original.target, request.allowed, request, false);
      assert.ok(
        calibration.stdout.toString("utf8") ===
          `200 ${wireRequest(request.allowed, request).responseType}`,
        "ACL_CALIBRATION_HTTP",
      );
      checkOrigin(before, request.allowed, request);
      for (const repository of request.denied) {
        await denyReplay(original.target, repository, request);
      }
    }

    // Require Git's HTTP 403 after screening both output streams in the guest.
    const denied = async (target: Target, args: string[]) => {
      const before = origin.snapshot().requests;
      const result = await guest(
        target,
        `${gitSetup}; export LC_ALL=C; exec "$@"`,
        denialCommand({ kind: "git" }, ["git", ...args]),
      );
      assert.equal(origin.snapshot().requests, before, "ACL_NATIVE_DENIAL_ORIGIN");
      assert.ok(result.stdout.toString("utf8") === "403 native-git\n", "ACL_NATIVE_HTTP");
    };
    // Use B's independently verified new commit so a successful push would change A.
    assert.notEqual(pushed, origin.initialSha);
    await denied(original.target, [
      "-C",
      "/tmp/b",
      "push",
      "-q",
      "https://github.com/fixture/a.git",
      "HEAD:refs/heads/approved",
    ]);
    assert.equal(await network.ref("fixture/a", "refs/heads/approved"), origin.initialSha);
    await denied(original.target, [
      "clone",
      "-q",
      "https://github.com/fixture/c.git",
      "/tmp/denied-c",
    ]);

    // This fixture installs the Provider directly into a fresh Sandbox. The
    // Agent configuration, revision admission, and rollout are separate paths.
    const replacement = await install([
      { repository: "fixture/a", access: "read" },
      { repository: "fixture/b", access: "read" },
    ]);
    assert.notEqual(replacement.target.sandboxId, original.target.sandboxId);
    assert.notEqual(replacement.binding.providerId, original.binding.providerId);
    assert.notEqual(replacement.installed.policyHash, original.installed.policyHash);
    assert.notEqual(replacement.supervisor.workloadPodUid, original.supervisor.workloadPodUid);
    assert.notEqual(replacement.supervisor.supervisorPodUid, original.supervisor.supervisorPodUid);

    // DeleteSandbox selects by name. Check both recorded identities and the
    // run label immediately before the single deletion in this owned cluster.
    const previous = { workspace, name: original.target.sandboxName };
    assert.equal(await sandboxResource(original.target), originalResource);
    const current = await gatewayClient.getSandbox(previous, t.signal);
    assert.ok(
      current?.id === original.target.sandboxId &&
        current.name === previous.name &&
        current.workspace === workspace &&
        current.labels[runLabel] === runId,
      "ACL_RETIREMENT_IDENTITY",
    );
    await gatewayClient.deleteSandbox(previous, t.signal);

    // A terminal Gateway delete is necessary. Independently require the same
    // accessible Workspace, no Sandbox record, and no Kubernetes resource or
    // Pod for the old Sandbox, including a recreated Pod with a different UID.
    assert.equal((await gatewayClient.getWorkspace(workspace, t.signal))?.id, workspaceId);
    assert.ok(!(await gatewayClient.getSandbox(previous, t.signal)), "ACL_RETIRED_SANDBOX_VISIBLE");
    await observeUntil("old Sandbox and Pods to be removed", t.signal, async () => {
      const resource = await sandboxResource(original.target);
      assert.ok(resource === "" || resource === originalResource, "ACL_SANDBOX_REPLACED");
      if (resource !== "") {
        return undefined;
      }
      const podIdentities = await fixture.kube([
        "get",
        "pods",
        "-n",
        workspace,
        "-o",
        'jsonpath={range .items[*]}{.metadata.uid}{" "}{.metadata.annotations.openshell\\.ai/sandbox-id}{" "}{.metadata.ownerReferences[*].uid}{"\\n"}{end}',
      ]);
      const oldIdentities = [
        originalUid,
        original.target.sandboxId,
        original.supervisor.workloadPodUid,
        original.supervisor.supervisorPodUid,
      ];
      const identities = new Set(podIdentities.split(/\s+/u));
      return oldIdentities.some((identity) => identities.has(identity)) ? undefined : true;
    });
    await original.provider.remove(t.signal);
    assert.ok(
      !(await gatewayClient.getProvider(workspace, original.binding.provider, t.signal)),
      "ACL_RETIRED_PROVIDER_VISIBLE",
    );
    assert.ok(
      !(await gatewayClient.getProviderProfile(workspace, original.binding.provider, t.signal)),
      "ACL_RETIRED_PROFILE_VISIBLE",
    );

    // Build a real fast-forward candidate from the exact ref the original
    // Sandbox pushed. A no-op, wrong parent, or locally unavailable object
    // cannot count as a denied push. The marker file gives the push new data.
    const b = "https://github.com/fixture/b.git";
    const approved = "refs/heads/approved";
    const candidate = (
      await guest(
        replacement.target,
        `${gitSetup};
git clone -q --branch approved '${b}' /tmp/b;
printf '%s\\n' acl-downgrade > /tmp/b/acl-downgrade;
git -C /tmp/b add acl-downgrade;
git -C /tmp/b -c user.name=Fixture -c user.email=fixture@example.test commit -q -m acl-downgrade;
git -C /tmp/b rev-parse HEAD HEAD^`,
      )
    ).stdout
      .toString("utf8")
      .trim()
      .split("\n");
    const [attempted, parent] = candidate;
    assert.ok(
      candidate.length === 2 && /^[a-f0-9]{40}$/.test(attempted!),
      "ACL_DOWNGRADE_CANDIDATE",
    );
    assert.equal(parent, pushed);
    assert.notEqual(attempted, pushed);
    assert.equal(await network.ref("fixture/b", approved), pushed);
    assert.equal(await network.hasObject("fixture/b", attempted), false);
    await denied(replacement.target, ["-C", "/tmp/b", "push", "-q", "origin", `HEAD:${approved}`]);
    assert.equal(await network.ref("fixture/b", approved), pushed);
    assert.equal(await network.hasObject("fixture/b", attempted), false);
    t.diagnostic("Git ACL downgrade: replacement push returned HTTP 403 with zero origin requests");

    await freshFetch(replacement.target, "a", "main", "/tmp/fresh-a", origin.initialSha);
    await freshFetch(replacement.target, "b", "approved", "/tmp/fresh-b", pushed);
    assert.equal(await network.ref("fixture/b", approved), pushed);
    t.diagnostic("Git ACL downgrade: fresh A and B fetches returned the unchanged origin refs");

    // Keep A read-only and C absent after replacing B's grant. The native B
    // push stops at discovery, so independently check direct receive-pack.
    for (const request of requests) {
      const deniedRepositories =
        request.service === "receive" ? [...request.denied, "b"] : request.denied;
      for (const repository of deniedRepositories) {
        await denyReplay(replacement.target, repository, request);
      }
    }
    assert.equal(await network.ref("fixture/a", approved), origin.initialSha);
    assert.equal(await network.ref("fixture/b", approved), pushed);
    assert.equal(await network.hasObject("fixture/b", attempted), false);
  }),
);
