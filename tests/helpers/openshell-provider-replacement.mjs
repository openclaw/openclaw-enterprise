import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { sandboxNetworkGrantsWithinCeiling } from "../../packages/contracts/src/index.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { validateExplicitK3dLoopbackContext } from "./kubernetes-real.mjs";
import { createOpenShellKubernetesFixture } from "./openshell-kubernetes-real.mjs";

/** Real API/worker workflow with run-owned resources in a selected managed installation. */
export async function verifyOpenShellProviderReplacement(context, { gitReplacement = false } = {}) {
  const path = process.env.OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE;
  assert.ok(path, "Select the prepared managed installation input file");
  const input = JSON.parse(await readFile(path, "utf8"));
  if (gitReplacement) {
    assert.ok(input.git?.repositoryRef, "Select an enrolled repository reference");
    for (const address of [input.git.url, input.git.deniedUrl]) {
      const url = new URL(address);
      assert.equal(url.origin, "https://github.com");
      assert.equal(url.username + url.password + url.search + url.hash, "");
      assert.match(url.pathname, /^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\.git$/);
    }
    assert.notEqual(input.git.url, input.git.deniedUrl);
  }
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  const fixture = createOpenShellKubernetesFixture(selection);
  if (input.existingCluster) {
    // Existing-cluster runs require operator approval and pin both the endpoint
    // and cluster identity before creating any API resources.
    assert.ok(selection.kubeconfigPath, "Select an explicit kubeconfig");
    assert.ok(input.existingCluster.context);
    assert.equal(selection.kubernetesContext, input.existingCluster.context);
    assert.equal(new URL(input.existingCluster.server).protocol, "https:");
    assert.ok(input.existingCluster.kubeSystemUid);
    const config = JSON.parse(await fixture.kubectl("config", "view", "--minify", "-o", "json"));
    assert.equal(config.contexts?.length, 1);
    assert.equal(config.contexts[0].name, input.existingCluster.context);
    assert.equal(config.clusters?.length, 1);
    assert.equal(config.clusters[0].cluster.server, input.existingCluster.server);
    const system = JSON.parse(
      await fixture.kubectl("get", "namespace", "kube-system", "-o", "json"),
    );
    assert.equal(system.metadata.uid, input.existingCluster.kubeSystemUid);
  } else {
    assert.equal(input.disposable, true, "Explicitly select a disposable installation");
    await validateExplicitK3dLoopbackContext(selection);
  }
  const serviceKey = (await readFile(input.serviceKeyFile, "utf8")).trim();
  const apiUrl = new URL(input.apiUrl);
  assert.ok(
    apiUrl.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname),
  );
  const api = async (method, path, body, allowMissing = false) => {
    const response = await fetch(new URL(path, apiUrl), {
      method,
      headers: {
        "x-api-key": serviceKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (allowMissing && response.status === 404) {
      return undefined;
    }
    // Do not put credential source bodies or server diagnostics into failure output.
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : (await response.json()).data;
  };
  const base = `/namespaces/${input.namespaceId}`;
  const namespace = await api("GET", base);
  assert.equal(namespace.status, "ready");
  // Compute passes the mapped Kubernetes Namespace name to the OpenShell Drivers.
  const workspace = openShellWorkspaceName({ ...namespace, name: input.gatewayNamespace });
  const gateway = new GrpcOpenShellGatewayClient(input.gatewayClient);
  context.after(() => gateway.close());
  const signal = () => AbortSignal.timeout(30_000);
  const wait = async (label, observe) => {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const result = await observe();
      if (result) {
        return result;
      }
      await delay(1000);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const agents = [];
  const sources = [];
  const createdSources = [];
  const bindings = [];
  let role;
  context.after(async () => {
    // Delete only resources created by this run. Wait for Agent cleanup before
    // deleting its credential sources; the prepared source and Namespace survive.
    for (const agent of agents) {
      await api("DELETE", `${base}/agents/${agent.id}`, undefined, true);
      await wait("Agent deletion", async () => {
        const remaining = await api("GET", `${base}/agents`);
        return !remaining.some((entry) => entry.id === agent.id);
      });
    }
    const remainingBindings = await api("GET", `${base}/iam/access-bindings`);
    for (const binding of bindings) {
      if (remainingBindings.some((entry) => entry.id === binding.id)) {
        await api("DELETE", `${base}/iam/access-bindings/${binding.id}`);
      }
    }
    if (role) {
      await api("DELETE", `${base}/iam/roles/${role.id}`, undefined, true);
    }
    for (const source of createdSources) {
      await api("DELETE", `${base}/credential-sources/${source.id}`, undefined, true);
    }
  });
  const seed = await api("GET", `${base}/credential-sources/${input.modelSourceId}`);
  assert.ok(["openai", "codex-pat"].includes(seed.type));
  if (gitReplacement) {
    // The Git-only Proxy refuses new model source registration. Reuse the
    // prepared Gateway source without acquiring ownership of it for cleanup.
    assert.equal(seed.state, "ready", "The prepared model source must be ready");
    assert.equal(seed.ownerCapability, "credential_gateway");
    assert.equal(
      seed.egress,
      undefined,
      "Use a model source registered before enabling the Git Proxy",
    );
    sources.push(seed);
  } else {
    // Clone references to an authorized existing Secret, never its value. Distinct
    // source identities produce different Providers with the same credential key.
    for (const suffix of ["a", "b"]) {
      const source = await api("POST", `${base}/credential-sources`, {
        name: `replacement-${suffix}-${randomUUID()}`,
        type: seed.type,
        config: seed.config,
        secrets: seed.secrets,
      });
      createdSources.push(source);
      sources.push(source);
    }
  }
  role = await api("POST", `${base}/iam/roles`, {
    name: `Replacement sources ${randomUUID()}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const deploy = async (agent) => {
    const revision = await api("POST", `${base}/agents/${agent.id}/deploy`);
    await wait("revision activation", async () => {
      const status = await api("GET", `${base}/agents/${agent.id}/deployments/${revision.id}`);
      assert.ok(!["failed", "cancelled"].includes(status.status), `Deployment ${status.status}`);
      return status.status === "succeeded";
    });
    return revision;
  };
  const sandbox = (agent) =>
    gateway.getSandbox(
      {
        workspace,
        name: `oc-${createHash("sha256").update(agent.id).digest("hex").slice(0, 16)}`,
      },
      signal(),
    );
  const turn = async (agent, revision) => {
    const pods = await fixture.resources("pods", input.gatewayNamespace);
    const pod = pods.find(
      (entry) =>
        !entry.metadata.deletionTimestamp &&
        entry.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
        entry.metadata.labels?.["openclaw.dev/revision"] === revision.id &&
        entry.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
    );
    assert.ok(pod, "The active revision must have a Gateway Pod");
    const nonce = `replacement-${randomUUID()}`;
    const result = await fixture.requestCodexTurnFromGatewayPod({
      namespace: input.gatewayNamespace,
      gatewayPod: pod.metadata.name,
      providerModel: input.model,
      prompt: `Reply with exactly ${nonce}.`,
    });
    assert.ok(result.assistant.includes(nonce), "The real model turn must return its nonce");
  };
  for (let index = 0; index < 2; index++) {
    const agent = await api("POST", `${base}/agents`, {
      name: `provider-replacement-${randomUUID()}`,
      configurationId: input.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: sources[0].id },
      credentialSources: [{ sourceId: sources[0].id }],
      ...(gitReplacement
        ? {
            repositoryBindings: [
              {
                repositoryRef: input.git.repositoryRef,
                profile: input.git.profile ?? "github-repository",
              },
            ],
          }
        : {}),
    });
    agents.push(agent);
    await api("POST", `${base}/agents/${agent.id}/runtime-credentials`, {});
    for (const source of sources) {
      bindings.push(
        await api("POST", `${base}/iam/access-bindings`, {
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.id,
          resourceKind: "credential_source",
          resourceId: source.id,
        }),
      );
    }
  }
  if (gitReplacement) {
    // Read-only Git against explicitly selected repositories. Exercise the regular
    // API/worker revision lifecycle; no token is read or installed by the test.
    const first = await deploy(agents[0]);
    const peer = await deploy(agents[1]);
    const before = await sandbox(agents[0]);
    assert.ok(before?.id);
    const path = `/sandbox/oce/workspace/git-replacement-${randomUUID()}`;
    const nonce = randomUUID();
    const execute = async (agent, command) =>
      gateway.execSandbox(
        {
          workspace,
          sandbox: (await sandbox(agent)).name,
          command,
          environment: { GIT_TERMINAL_PROMPT: "0" },
          stdin: "",
          timeoutSeconds: 25,
        },
        signal(),
      );
    const fetch = (initial) =>
      execute(agents[0], [
        "/bin/sh",
        "-ec",
        initial
          ? 'mkdir "$1"; git -C "$1" init -q; git -C "$1" remote add origin "$2"; git -C "$1" fetch -q --depth=1 origin HEAD; printf %s "$3" > "$1/retained"'
          : 'test "$(cat "$1/retained")" = "$3"; git -C "$1" fetch -q --depth=1 origin HEAD',
        "git-replacement",
        path,
        input.git.url,
        nonce,
      ]);
    const denied = () => execute(agents[0], ["/usr/bin/git", "ls-remote", input.git.deniedUrl]);
    assert.equal(await fetch(true), 0, "Initial revision must fetch the admitted repository");
    assert.notEqual(await denied(), 0, "Unselected repository must be denied");
    await turn(agents[0], first);
    await turn(agents[1], peer);
    const oldPolicy = await gateway.getPolicyStatus({ workspace, sandbox: before.name }, signal());
    const oldProviders = [];
    for (const name of before.spec.providers) {
      const provider = await gateway.getProvider(workspace, name, signal());
      if (provider?.labels["openclaw.dev/git-revision-id"] === first.id) {
        oldProviders.push(provider);
      }
    }
    assert.equal(oldProviders.length, 1);
    const successor = await deploy(agents[0]);
    const after = await sandbox(agents[0]);
    assert.equal(after.id, before.id, "Git replacement retains the Sandbox and workspace");
    const policy = await gateway.getPolicyStatus({ workspace, sandbox: after.name }, signal());
    assert.equal(policy.state, "POLICY_STATUS_LOADED");
    assert.equal(policy.activeVersion, policy.version);
    assert.notDeepEqual(
      policy.policy.network_middlewares["oce-prepared-git"],
      oldPolicy.policy.network_middlewares["oce-prepared-git"],
    );
    for (const provider of oldProviders) {
      assert.equal(after.spec.providers.includes(provider.name), false);
      assert.equal(await gateway.getProvider(workspace, provider.name, signal()), undefined);
      assert.equal(await gateway.getProviderProfile(workspace, provider.type, signal()), undefined);
    }
    assert.equal(
      await fetch(false),
      0,
      "New revision must retain files and fetch with its new Git authorization",
    );
    assert.notEqual(await denied(), 0);
    assert.equal(
      await execute(agents[1], ["/usr/bin/git", "ls-remote", input.git.url]),
      0,
      "Peer Git access must survive replacement",
    );
    await turn(agents[0], successor);
    await turn(agents[1], peer);
    return {
      outcome:
        "unchanged Git redeployment, retained Sandbox/workspace, fetch before/after, denied unselected repository, retired Provider/profile and peer isolation",
      limitation: "A successful public repository fetch does not prove credential delivery.",
    };
  }
  const policyPath = `${base}/agents/${agents[0].id}/sandbox-policy/networking`;
  const networkGrant = {
    id: "replacement-probe",
    binary: "/usr/bin/curl",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
  const policySetup = await api("GET", policyPath);
  assert.ok(
    sandboxNetworkGrantsWithinCeiling([networkGrant], policySetup.ceiling),
    "The Installation sandboxNetworkPolicyCeiling must delegate /usr/bin/curl to example.org:443",
  );
  const first = await deploy(agents[0]);
  const peer = await deploy(agents[1]);
  const before = await sandbox(agents[0]);
  assert.ok(before?.id, "The installation must use a stable managed Sandbox per Agent");
  await turn(agents[0], first);
  await turn(agents[1], peer);
  const providerA = openShellProviderName(sources[0].id);
  const providerB = openShellProviderName(sources[1].id);
  await api("PATCH", `${base}/agents/${agents[0].id}`, {
    configurationId: input.configurationId,
    harnessAuth: { method: "credential_source", sourceId: sources[1].id },
    credentialSources: [{ sourceId: sources[1].id }],
  });
  const successor = await deploy(agents[0]);
  const after = await sandbox(agents[0]);
  assert.equal(after.id, before.id, "Source replacement must retain the Sandbox");
  assert.equal(after.spec.providers.includes(providerA), false);
  assert.equal(after.spec.providers.includes(providerB), true);
  await turn(agents[0], successor);
  // The old source belongs to the Namespace, not the replacing Agent. Its
  // Provider and the peer's attachment must remain usable after detachment.
  assert.ok(await gateway.getProvider(workspace, providerA, signal()));
  assert.ok((await sandbox(agents[1])).spec.providers.includes(providerA));
  await turn(agents[1], peer);
  const unchanged = await deploy(agents[0]);
  assert.equal((await sandbox(agents[0])).id, before.id);
  await turn(agents[0], unchanged);
  // Save through the Agent policy API, then deploy. Do not use live apply:
  // the worker must update the retained Sandbox's policy during replacement.
  await api("PATCH", `${policyPath}/editing`, { enabled: true });
  const probe = async (agent) => {
    const current = await sandbox(agent);
    return gateway.execSandbox(
      {
        workspace,
        sandbox: current.name,
        command: [
          "/usr/bin/curl",
          "--silent",
          "--fail",
          "--max-time",
          "15",
          "--output",
          "/dev/null",
          "https://example.org/",
        ],
        environment: {},
        stdin: "",
        timeoutSeconds: 20,
      },
      signal(),
    );
  };
  const assertPolicy = async (present, provider = providerB) => {
    const current = await sandbox(agents[0]);
    assert.equal(current.id, before.id);
    assert.deepEqual(
      [...current.spec.providers].sort(),
      [...after.spec.providers.filter((name) => name !== providerB), provider].sort(),
    );
    const status = await gateway.getPolicyStatus({ workspace, sandbox: current.name }, signal());
    assert.equal(status.state, "POLICY_STATUS_LOADED");
    assert.equal(status.activeVersion, status.version);
    assert.equal(
      Object.hasOwn(status.policy.network_policies, "oce-agent-replacement-probe"),
      present,
    );
  };
  assert.notEqual(await probe(agents[0]), 0, "The probe route must initially be denied");
  const policy = (await api("GET", policyPath)).policy;
  assert.deepEqual(policy.additions, []);
  const granted = await api("PUT", policyPath, {
    expectedVersion: policy.version,
    additions: [networkGrant],
  });
  const allowed = await deploy(agents[0]);
  await assertPolicy(true);
  assert.equal(await probe(agents[0]), 0, "The new revision must permit the granted route");
  assert.notEqual(await probe(agents[1]), 0, "The peer must not inherit the grant");
  await turn(agents[0], allowed);
  await api("PUT", policyPath, { expectedVersion: granted.version, additions: [] });
  const removed = await deploy(agents[0]);
  await assertPolicy(false);
  assert.notEqual(await probe(agents[0]), 0, "The later revision must deny the removed route");
  await turn(agents[0], removed);
  // Change both inputs before deployment so the regular worker must reconcile
  // policy and Provider membership together on the same retained Sandbox.
  for (const [source, present] of [
    [sources[0], true],
    [sources[1], false],
  ]) {
    await api("PATCH", `${base}/agents/${agents[0].id}`, {
      configurationId: input.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    });
    const current = (await api("GET", policyPath)).policy;
    await api("PUT", policyPath, {
      expectedVersion: current.version,
      additions: present ? [networkGrant] : [],
    });
    const combined = await deploy(agents[0]);
    await assertPolicy(present, openShellProviderName(source.id));
    assert.equal((await probe(agents[0])) === 0, present);
    await turn(agents[0], combined);
  }
  assert.notEqual(await probe(agents[1]), 0, "Combined replacement must not alter the peer policy");
  assert.ok((await sandbox(agents[1])).spec.providers.includes(providerA));
  await turn(agents[1], peer);
  return {
    outcome:
      "separate and combined model source and network grant replacement, stable Sandbox, unchanged redeploy and shared-source isolation",
  };
}
