import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import type {
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { verifyFirstAgentModel } from "../../scripts/first-agent-model.mjs";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";
import { createOpenShellGitDenial } from "../helpers/openshell-git-denial.mjs";

const selected = process.env.OCC_TEST_OPENSHELL_K3D_REAL === "1";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "openshell";
process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "kubernetes";

interface RuntimePod {
  metadata: {
    uid: string;
    namespace: string;
    ownerReferences: { kind: string; name: string; uid: string }[];
  };
  status: {
    conditions: { type: string; status: string }[];
    containerStatuses: {
      name: string;
      containerID: string;
      imageID: string;
      restartCount: number;
      state: { running?: { startedAt: string } };
    }[];
  };
}

interface OriginToken {
  uses: number;
  revoked: boolean;
}

async function observeUntil<T>(
  label: string,
  signal: AbortSignal,
  observe: () => Promise<T | undefined>,
  timeout = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await observe();
    if (result !== undefined) {
      return result;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type GitInstallation = Awaited<ReturnType<typeof createOpenShellGitInstallation>>;

async function deployFiniteAgent(t: TestContext, fixture: GitInstallation) {
  const {
    request,
    namespace,
    modelSource,
    repositoryRef,
    workspace,
    gatewayClient,
    checkpoint: evidence,
  } = fixture;
  const base = `/namespaces/${namespace.id}`;
  const suffix = randomUUID();
  const model = process.env.OCC_TEST_OPENAI_MODEL;
  assert.ok(model, "Select the real CI model before provisioning the Agent");
  const configuration = await request("POST", `${base}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration("codex", model),
  });
  const agent = await request("POST", `${base}/agents`, {
    name: `git-retention-${suffix}`,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSource.id },
    credentialSources: [{ sourceId: modelSource.id }],
    repositoryBindings: [{ repositoryRef, profile: "github-repository" }],
  });
  const path = `${base}/agents/${agent.id}`;
  const role = await request("POST", `${base}/iam/roles`, {
    name: `git-retention-model-${suffix}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  await request("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: modelSource.id,
  });
  const transport = await request("POST", `${path}/runtime-credentials`, {});
  assert.equal(transport.transportConfigured, true);

  // The selected-repository profile grants finite access. Use its actual
  // admission deadline; neither the application clock nor queue is patched.
  const admissionStartedAt = Date.now();
  const revision = await request("POST", `${path}/deploy`);
  const admissionReturnedAt = Date.now();
  assert.equal(revision.harness.id, "codex");
  assert.equal(revision.harnessAuth.method, "credential_source");
  assert.equal(revision.harnessAuth.sourceId, modelSource.id);
  const deadlineWallMs = revision.repositoryCredentials?.deadlineWallMs;
  assert.ok(Number.isSafeInteger(deadlineWallMs));
  assert.ok(deadlineWallMs >= admissionStartedAt + 600_000);
  assert.ok(deadlineWallMs <= admissionReturnedAt + 600_000);
  await evidence("finite-git-grant", { revisionId: revision.id, deadlineWallMs });
  await observeUntil(
    "real Agent startup",
    t.signal,
    async () => {
      const [current, deployment] = await Promise.all([
        request("GET", path),
        request("GET", `${path}/deployments/${revision.id}`),
      ]);
      assert.notEqual(deployment.status, "failed", "the original deployment failed");
      return current.activeRevisionId === revision.id && deployment.status === "succeeded"
        ? current
        : undefined;
    },
    10 * 60_000,
  );

  const selector = `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`;
  const readExecution = async () => {
    const current = await request("GET", path);
    assert.equal(current.activeRevisionId, revision.id, "Agent revision changed");
    const pods = JSON.parse(
      await fixture.kube(["get", "pods", "-A", "-l", selector, "-o", "json"]),
    ) as { items: RuntimePod[] };
    assert.equal(pods.items.length, 1, "expected the single original Harness Pod");
    const pod = pods.items[0];
    assert.ok(pod);
    assert.ok(
      pod.status.conditions.some(({ type, status }) => type === "Ready" && status === "True"),
      "the original Harness Pod must remain ready",
    );
    const owner = pod.metadata.ownerReferences.find(({ kind }) => kind === "Sandbox");
    assert.ok(owner?.name && owner.uid, "the stock supplier must own the Harness Pod");
    const resource = JSON.parse(
      await fixture.kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        owner.name,
        "-n",
        pod.metadata.namespace,
        "-o",
        "json",
      ]),
    );
    assert.equal(resource.metadata.uid, owner.uid);
    const sandbox = await gatewayClient.getSandbox({ workspace, name: owner.name }, t.signal);
    assert.ok(sandbox?.id && sandbox.mainProcessInstanceId);
    assert.equal(sandbox.annotations["openclaw.dev/revision-id"], revision.id);
    const containers = pod.status.containerStatuses.map((container) => {
      assert.ok(container.containerID && container.imageID && container.state.running?.startedAt);
      assert.match(container.imageID, /sha256:[a-f0-9]{64}/);
      return {
        name: container.name,
        id: container.containerID,
        imageId: container.imageID,
        startedAt: container.state.running.startedAt,
        restartCount: container.restartCount,
      };
    });
    return {
      sandbox,
      identity: {
        revisionId: current.activeRevisionId,
        sandboxId: sandbox.id,
        sandboxName: sandbox.name,
        sandboxUid: owner.uid,
        podUid: pod.metadata.uid,
        containers,
        mainProcessInstanceId: sandbox.mainProcessInstanceId,
        mainProcessStartedAt: sandbox.mainProcessStartedAt,
      },
    };
  };
  const original = await readExecution();
  await evidence("initial-runtime", original.identity);
  const target = {
    sandboxName: original.sandbox.name,
    sandboxId: original.sandbox.id,
  };
  const supervisor = await fixture.verifySupervisorImage(target);
  assert.equal(supervisor.workloadPodUid, original.identity.podUid);
  assert.equal(supervisor.sandboxId, original.identity.sandboxId);
  await evidence("installed-supervisor", supervisor);
  return {
    agent,
    revision,
    suffix,
    deadlineWallMs,
    readExecution,
    original,
    target,
    supervisor,
  };
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
