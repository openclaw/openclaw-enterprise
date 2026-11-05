import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type {
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { verifyFirstAgentModel } from "../../scripts/first-agent-model.mjs";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createOpenShellGitInstallation } from "../helpers/openshell-git-installation.mjs";

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

interface StandingApproval {
  id: string;
  generation: number;
  status: string;
}

interface OriginToken {
  uses: number;
  revoked: boolean;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

test(
  "OpenShell retains its runtime after Git withdrawal and worker restart",
  { skip: !selected, timeout: 35 * 60_000 },
  async (t) => {
    // This owns a real Helm installation, PostgreSQL and authenticated stock Gateway.
    // The only controlled upstream is a private Git server and its App token issuer.
    const fixture = await createOpenShellGitInstallation(t);
    const evidence = async (event: string, data: Record<string, unknown>) => {
      await fixture.checkpoint(event, data);
    };
    const { request, namespace, modelSource, repositoryRef, origin, gatewayClient, workspace } =
      fixture;
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

    // Standing withdrawal is the supported operation that removes Git while the
    // independent model permission keeps this execution alive before its deadline.
    const scopes = await request("GET", `${path}/repository-approval-scopes`);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].binding.repositoryRef, repositoryRef);
    assert.ok(scopes[0].scopeFingerprint);
    const approvalId = randomUUID();
    await request("PATCH", path, {
      configurationId: configuration.id,
      repositoryStandingApproval: {
        repositoryRef,
        approvalId,
        approved: true,
        duration: "until-removed",
        expectedScopeFingerprint: scopes[0].scopeFingerprint,
      },
    });
    const revision = await request("POST", `${path}/deploy`);
    assert.equal(revision.harness.id, "codex");
    assert.equal(revision.harnessAuth.method, "credential_source");
    assert.equal(revision.harnessAuth.loginMode, "api_key");
    await observeUntil(
      "real Agent startup",
      t.signal,
      async () => {
        const current = await request("GET", path);
        return current.activeRevisionId === revision.id ? current : undefined;
      },
      10 * 60_000,
    );

    const selector = `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`;
    const readExecution = async () => {
      const current = await request("GET", path);
      assert.equal(current.activeRevisionId, revision.id, "withdrawal replaced the revision");
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
    const target = {
      sandboxName: original.sandbox.name,
      sandboxId: original.sandbox.id,
    };
    assert.match(origin.repository, /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
    const gitUrl = `https://github.com/${origin.repository}.git`;
    const directory = `/sandbox/enterprise/git-retention-${suffix}`;
    const git = `LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c protocol.version=2 ls-remote '${gitUrl}' refs/heads/main`;
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
    assert.ok(afterGit.connections > beforeGit.connections);
    assert.ok(afterGit.requests > beforeGit.requests);
    assert.ok(afterGit.tokens.some((token: OriginToken) => token.uses > 0 && !token.revoked));
    await evidence("initial-git-succeeded", {
      revisionId: revision.id,
      sha: origin.initialSha,
      connections: afterGit.connections,
      requests: afterGit.requests,
    });
    await verifyModelTurn("before-withdrawal");

    const approvals = (await request("GET", `${path}/repository-approvals`)) as StandingApproval[];
    const approval = approvals.find(({ id }) => id === approvalId);
    assert.ok(approval && Number.isSafeInteger(approval.generation));
    await request("POST", `${path}/repository-approvals/${approvalId}/remove`, {
      expectedGeneration: approval.generation,
    });
    const removed = (
      (await request("GET", `${path}/repository-approvals`)) as StandingApproval[]
    ).find(({ id }) => id === approvalId);
    assert.ok(removed);
    assert.equal(removed.status, "removed");
    assert.equal(removed.generation, approval.generation + 1);
    await fixture.waitForWithdrawal({ agentId: agent.id, revisionId: revision.id });
    // Wait for acknowledged retirement and observable supplier subtraction, so a
    // background token DELETE cannot be mistaken for a denied Git connection.
    await observeUntil("Git withdrawal and token retirement", t.signal, async () => {
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

    const verifyRetainedExecution = async (stage: string) => {
      const before = origin.snapshot();
      const { sandbox, identity } = await readExecution();
      assert.deepEqual(identity, original.identity, `${stage}: runtime identity changed`);
      const attached = sandbox.spec?.providers;
      assert.ok(Array.isArray(attached));
      assert.deepEqual([...attached].sort(), retainedNames);
      for (const saved of retained) {
        const provider = await gatewayClient.getProvider(workspace, saved.name, t.signal);
        assert.ok(provider);
        // Provider configuration may include private runtime material. Compare
        // digests so an assertion failure cannot print it into the CI log.
        assert.equal(
          fingerprint(provider),
          fingerprint(saved.provider),
          `${stage}: independent provider changed`,
        );
        const profile = await gatewayClient.getProviderProfile(
          provider.profileWorkspace || null,
          provider.type,
          t.signal,
        );
        assert.equal(
          fingerprint(profile),
          fingerprint(saved.profile),
          `${stage}: independent profile changed`,
        );
      }
      await verifyModelTurn(stage);
      const result = await execute(target, [
        "sh",
        "-ceu",
        [
          `test "$(cat '${directory}/identity')" = '${suffix}'`,
          `printf '%s' '${stage}' > '${directory}/non-git'`,
          `test "$(cat '${directory}/non-git')" = '${stage}'`,
          "git --version >/dev/null",
          `set +e; ${git} >'${directory}/git.out' 2>'${directory}/git.err'; status=$?; set -e`,
          'test "$status" -ne 0; test "$status" -ne 126; test "$status" -ne 127',
          `test ! -s '${directory}/git.out'`,
          // Stock's explicit proxy policy refusal is HTTP 403. DNS, TLS and
          // executable failures cannot satisfy this assertion.
          `grep -Eq '(^|[^0-9])403([^0-9]|$)' '${directory}/git.err'`,
          "printf '%s' 'non-git-succeeded;fresh-git-denied'",
        ].join("; "),
      ]);
      assert.equal(result.stdout.toString("utf8"), "non-git-succeeded;fresh-git-denied");
      assert.deepEqual(origin.snapshot(), before, `${stage}: denied Git reached the origin`);
      assert.deepEqual((await readExecution()).identity, original.identity);
      await evidence(stage, {
        ...identity,
        nonGit: "succeeded",
        freshGit: "http-403",
        connections: before.connections,
        requests: before.requests,
      });
    };
    await verifyRetainedExecution("after-withdrawal");
    // An actual Deployment restart discards all worker and Driver memory. Its
    // PostgreSQL route and custody Secret must still identify this same execution.
    const restart = await fixture.restartWorker({ agentId: agent.id, revisionId: revision.id });
    await evidence("worker-restarted", restart);
    await verifyRetainedExecution("after-worker-restart");
  },
);
