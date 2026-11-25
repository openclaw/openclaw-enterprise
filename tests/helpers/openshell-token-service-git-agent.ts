import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
import {
  openShellProviderName,
  SOURCE_ID_LABEL,
} from "../../apps/controller/src/backends/openshell.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { openShellProjectedCredentialProviderName } from "../../apps/controller/src/drivers/sandbox/openshell-credential-policy.ts";
import {
  type OpenShellSandboxLogLine,
  GrpcOpenShellGatewayClient,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  AgentRevisionWire,
  CredentialSourceWire,
} from "../../packages/contracts/src/api/resources.ts";
import { startNativeTcpProbe } from "./openshell-token-service-raw-tcp.ts";
import { verifyNativeGitPush } from "./openshell-token-service-git-push.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { waitUntil } from "./wait-for.ts";

const selection = "OCC_TEST_OPENSHELL_TOKEN_SERVICE_GIT_AGENT";
const management = "OCC_TEST_OPENSHELL_TOKEN_SERVICE";
const poll = { intervalMs: 1_000, timeoutMs: 8 * 60_000 };
const repositoryName = /^(?:[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Missing required real Git Agent test input ${name}.`);
  return value;
}

function loopback(name: string, protocol: string): URL {
  let url: URL;
  try {
    url = new URL(required(name));
  } catch {
    throw new Error(`Set ${name} to a disposable loopback origin.`);
  }
  assert.ok(
    url.protocol === protocol &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
      url.href === `${url.origin}/`,
    `Set ${name} to a disposable loopback origin.`,
  );
  return url;
}

async function serviceKey(): Promise<string> {
  try {
    const file = await readFile(required("OCC_SERVICE_KEY_FILE"), "utf8");
    const key: unknown = JSON.parse(file).data?.key;
    assert.ok(typeof key === "string" && /^\S+$/.test(key));
    return key;
  } catch {
    throw new Error("Could not read the prepared Installation service key file.");
  }
}

type Agent = { id: string; activeRevisionId?: string };
type RepositoryOption = {
  repositoryRef: string;
  githubAccess?: { repository: string; access: string };
};

/** Exercise the selected Harness through OCC admission, Worker deployment and its native Agent turn. */
export async function verifyNativeGitAgent(t: TestContext, harness: "openclaw" | "codex") {
  const openClaw = harness === "openclaw";
  const origin = loopback("OCC_URL", "http:");
  const endpoint = loopback(`${management}_GATEWAY_ENDPOINT`, "https:");
  const key = await serviceKey();
  const namespaceId = required(`${selection}_NAMESPACE_ID`);
  const modelSourceId = required(`${selection}_MODEL_SOURCE_ID`);
  const model = required(`${selection}_MODEL`);
  const binary = openClaw ? "/usr/local/bin/node" : required(`${selection}_MODEL_BINARY`);
  const host = openClaw ? "api.openai.com" : required(`${selection}_MODEL_HOST`);
  const runtimeImage = required(`${selection}_RUNTIME_IMAGE`);
  const clientId = required(`${selection}_GITHUB_APP_CLIENT_ID`);
  const allowedRef = required(`${selection}_ALLOWED_REPOSITORY_REF`);
  const sharedSourceId = openClaw ? required(`${selection}_SHARED_GIT_SOURCE_ID`) : undefined;
  const writableRepository = openClaw
    ? undefined
    : required(`${selection}_DISPOSABLE_WRITE_REPOSITORY`);
  const deniedRef = required(`${selection}_DENIED_REPOSITORY_REF`);
  assert.ok(/^ns_[a-f0-9-]{36}$/.test(namespaceId) && /^cs_[a-f0-9-]{36}$/.test(modelSourceId));
  assert.ok(/^ccr_[a-f0-9-]{36}$/.test(clientId));
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model));
  if (openClaw) {
    assert.match(sharedSourceId ?? "", /^cs_[a-f0-9-]{36}$/);
  } else {
    assert.ok(OPEN_SHELL_CODEX_BINARIES.some((approved) => approved === binary));
    assert.ok(host === "chatgpt.com");
  }
  assert.ok(/^\S+@sha256:[a-f0-9]{64}$/.test(runtimeImage));
  assert.ok(allowedRef !== deniedRef, "Select distinct approved and denied repository references.");

  const base = `/namespaces/${namespaceId}`;
  const workspace = kubernetesNamespaceName(namespaceId);
  const gateway = new GrpcOpenShellGatewayClient({
    endpoint: endpoint.origin,
    rootCertificatePath: required(`${management}_CA_FILE`),
    requestTimeoutMs: 20_000,
    auth: {
      mode: "mutualTls",
      certificatePath: required(`${management}_MANAGEMENT_CERT_FILE`),
      privateKeyPath: required(`${management}_MANAGEMENT_KEY_FILE`),
    },
  });
  const rpc = () => AbortSignal.timeout(20_000);
  async function request(
    method: string,
    path: string,
    expected: number | readonly number[],
    body?: unknown,
    timeout = 45_000,
  ) {
    const url = new URL(path, origin);
    assert.equal(
      url.origin,
      origin.origin,
      "Service-key requests must use the prepared OCC origin.",
    );
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "x-api-key": key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const accepted = typeof expected === "number" ? [expected] : expected;
    if (!accepted.includes(response.status)) {
      await response.body?.cancel();
      assert.fail(
        `OCC ${method} returned HTTP ${response.status}; expected ${accepted.join("/")}.`,
      );
    }
    return response;
  }
  async function data<T>(
    method: string,
    path: string,
    expected: number,
    body?: unknown,
  ): Promise<T> {
    return ((await (await request(method, path, expected, body)).json()) as { data: T }).data;
  }

  t.after(() => gateway.close());

  const namespace = await data<{ status: string }>("GET", base, 200);
  assert.ok(namespace.status === "ready", "Use a ready disposable Namespace.");
  const modelSource = await data<CredentialSourceWire>(
    "GET",
    `${base}/credential-sources/${modelSourceId}`,
    200,
  );
  assert.ok(
    modelSource.state === "ready" &&
      (openClaw
        ? modelSource.type === "static" && modelSource.config?.provider_preset === "openai"
        : modelSource.type === "oauth2-refresh-token" &&
          modelSource.consent.kind === "builtin_codex"),
    "Use the ready model Source for the selected Harness.",
  );
  const clients = await data<{ id: string; kind: string }[]>("GET", "/credential-clients", 200);
  assert.ok(
    clients.some((client) => client.id === clientId && client.kind === "github-app"),
    "Use a registered GitHub App Client.",
  );
  const options = await data<RepositoryOption[]>("GET", `${base}/agents/repository-options`, 200);
  const allowed = options.find(({ repositoryRef }) => repositoryRef === allowedRef)?.githubAccess;
  const denied = options.find(({ repositoryRef }) => repositoryRef === deniedRef)?.githubAccess;
  assert.ok(
    allowed &&
      denied &&
      repositoryName.test(allowed.repository) &&
      repositoryName.test(denied.repository),
    "Both repository references must be in the finite Namespace registry.",
  );
  const tcpControl = openClaw
    ? undefined
    : {
        host: required(`${selection}_TCP_CONTROL_HOST`),
        address: required(`${selection}_TCP_CONTROL_ADDRESS`),
        port: Number(required(`${selection}_TCP_CONTROL_PORT`)),
      };
  const tcpProbe = tcpControl && (await startNativeTcpProbe(t, tcpControl));
  const previous = new Set(
    (await data<CredentialSourceWire[]>("GET", `${base}/credential-sources`, 200)).map(
      ({ id }) => id,
    ),
  );

  const configuration = await data<{ id: string }>("POST", `${base}/configurations`, 201, {
    kind: "agent",
    values: {
      ...createHarnessConfiguration(harness, model),
      // This test asks the OpenClaw worker to invoke exec directly.
      ...(openClaw ? { tools: { allow: ["exec"], codeMode: false, toolSearch: false } } : {}),
    },
  });
  const newGitSources = new Set<string>();
  const agentIds: string[] = [];
  t.after(async () => {
    for (const id of agentIds) {
      const path = `${base}/agents/${id}`;
      await (await request("DELETE", path, 202)).body?.cancel();
      await waitUntil(
        "test Agent deletion",
        async () => {
          const response = await request("GET", path, [200, 404]);
          await response.body?.cancel();
          return response.status === 404;
        },
        poll,
      );
    }
    for (const sourceId of newGitSources) {
      await (await request("DELETE", `${base}/credential-sources/${sourceId}`, 204)).body?.cancel();
    }
    await (
      await request("DELETE", `${base}/configurations/${configuration.id}`, 204)
    ).body?.cancel();
  });
  async function deploy(access: "read" | "write") {
    const agent = await data<Agent>("POST", `${base}/agents`, 201, {
      name: `native-git-${access}-${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      credentialSources: [{ sourceId: modelSourceId }],
      harnessAuth: { method: "credential_source", sourceId: modelSourceId },
      repositoryAccess: {
        githubAppClientId: clientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: allowedRef, access }],
      },
    });
    const agentId = agent.id;
    agentIds.push(agentId);
    const agentPath = `${base}/agents/${agentId}`;
    if (access === "read" && tcpControl) {
      const path = `${agentPath}/sandbox-policy/networking`;
      await data("PATCH", `${path}/editing`, 200, { enabled: true });
      const current = await data<{ policy: { version: number } }>("GET", path, 200);
      await data("PUT", path, 200, {
        expectedVersion: current.policy.version,
        additions: [
          {
            id: "tcp-control",
            binary: "/usr/bin/curl",
            host: tcpControl.host,
            ports: [{ from: tcpControl.port, to: tcpControl.port }],
          },
        ],
      });
    }
    const deployed = await data<AgentRevisionWire>("POST", `${agentPath}/deploy`, 202);
    const submittedSourceIds = deployed.credentialSources?.map(({ sourceId }) => sourceId) ?? [];
    const gitSourceId = submittedSourceIds.find((id) => id !== modelSourceId);
    if (gitSourceId && !previous.has(gitSourceId)) {
      newGitSources.add(gitSourceId);
    }
    await waitUntil(
      "native Git Agent deployment",
      async () => {
        const result = await data<{ status: string; error?: { code: string } }>(
          "GET",
          `${agentPath}/deployments/${deployed.id}`,
          200,
        );
        assert.ok(
          result.status !== "failed",
          `Deployment failed (${result.error?.code ?? "unknown"}).`,
        );
        return result.status === "succeeded";
      },
      poll,
    );
    assert.ok((await data<Agent>("GET", agentPath, 200)).activeRevisionId === deployed.id);
    const revision = await data<AgentRevisionWire>(
      "GET",
      `${agentPath}/revisions/${deployed.id}`,
      200,
    );
    // Service-managed Sandboxes retain their Agent identity across revisions. Find the
    // actual deployment by OCC's ownership annotations in its OpenShell Workspace.
    const matches = (await gateway.listSandboxes(workspace, rpc())).filter(
      ({ annotations }) =>
        annotations["openclaw.dev/namespace-id"] === namespaceId &&
        annotations["openclaw.dev/agent-id"] === agentId &&
        annotations["openclaw.dev/revision-id"] === deployed.id,
    );
    assert.equal(matches.length, 1, "The active revision must own exactly one Sandbox.");
    const sandboxName = matches[0]!.name;
    const sandbox = await gateway.getSandbox({ workspace, name: sandboxName }, rpc());
    assert.ok(
      sandbox?.id &&
        sandbox.id === matches[0]!.id &&
        sandbox.mainProcessInstanceId &&
        asRecord(sandbox.spec?.template)?.image === runtimeImage,
      "The inspected digest-pinned Harness runtime must be running.",
    );
    const workspacePath = asRecord(sandbox.spec?.environment)?.OPENCLAW_WORKSPACE_DIR;
    assert.ok(
      typeof workspacePath === "string" && /^\/sandbox\/[A-Za-z0-9_./-]+$/.test(workspacePath),
      "The inspected Sandbox must declare its approved Harness workspace mount.",
    );
    return { agentId, agentPath, revision, sandbox, sandboxName, workspacePath, gitSourceId };
  }
  const reader = await deploy("read");
  const { agentPath, revision, sandbox, sandboxName, gitSourceId } = reader;
  const sourceIds = revision.credentialSources?.map(({ sourceId }) => sourceId) ?? [];
  assert.ok(
    sourceIds.includes(modelSourceId) &&
      sourceIds.length === 2 &&
      gitSourceId !== undefined &&
      sourceIds.includes(gitSourceId),
    "The active revision must bind the model and one derived Git Source.",
  );
  const gitSource = await data<CredentialSourceWire>(
    "GET",
    `${base}/credential-sources/${gitSourceId}`,
    200,
  );
  assert.ok(
    gitSource.type === "github-app-installation" &&
      gitSource.clientId === clientId &&
      (openClaw
        ? gitSource.id === sharedSourceId
        : gitSource.scope.permissions.contents === "write"),
    "Deployment must derive the finite Git Source from the selected Client.",
  );
  const allowedName = gitSource.scope.repositories.find(
    ({ repository }) =>
      repository === allowed.repository || repository.split("/")[1] === allowed.repository,
  )?.repository;
  assert.ok(
    allowedName && repositoryName.test(allowedName) && allowedName.includes("/"),
    "The issued repository must match the saved reference.",
  );
  const owner = allowedName.split("/")[0]!;
  const deniedName = denied.repository.includes("/")
    ? denied.repository
    : `${owner}/${denied.repository}`;
  assert.ok(
    repositoryName.test(deniedName) &&
      deniedName !== allowedName &&
      deniedName.split("/")[0] === owner,
    "Use distinct repositories in the same approved installation.",
  );
  assert.ok(
    revision.repositoryCredentials?.bindings.length === 1 &&
      revision.repositoryCredentials.bindings[0]?.repositoryRef === allowedRef,
    "Only the selected Repository may enter the active revision.",
  );

  if (openClaw) {
    assert.ok(
      previous.has(gitSourceId) &&
        gitSource.scope.repositories.some(({ repository }) => repository === deniedName),
      "The existing shared Git Source must authorize both the selected and the omitted private repository.",
    );
  }

  const gitProvider = openShellProjectedCredentialProviderName(gitSourceId, "GITHUB_TOKEN");
  assert.ok(
    Array.isArray(sandbox.spec?.providers) && sandbox.spec.providers.includes(gitProvider),
    "The running Sandbox must attach its native Git Provider.",
  );
  const loaded = await gateway.getPolicyStatus({ workspace, sandbox: sandboxName }, rpc());
  assert.ok(
    loaded.state === "POLICY_STATUS_LOADED" && loaded.activeVersion === loaded.version,
    "The native policy must be loaded.",
  );
  const policies = asRecord(loaded.policy.network_policies);
  const nodeEndpoints = asRecord(policies?.["workspace-node-enrollment"])?.endpoints;
  assert.ok(
    policies &&
      Array.isArray(nodeEndpoints) &&
      nodeEndpoints.some(
        (entry) =>
          asRecord(entry)?.path === `/namespaces/${namespaceId}/agents/${reader.agentId}/node`,
      ),
    "The policy must admit the exact managed Workspace node route.",
  );
  const modelProvider = openShellProviderName(modelSourceId);
  assert.ok(
    Object.values(policies).some((entry) => {
      const rule = asRecord(entry);
      const binaries = rule?.binaries;
      const endpoints = rule?.endpoints;
      return (
        Array.isArray(binaries) &&
        binaries.some((item) => asRecord(item)?.path === binary) &&
        Array.isArray(endpoints) &&
        endpoints.some(
          (item) =>
            asRecord(item)?.host === host &&
            asRecord(asRecord(item)?.credential_binding)?.provider === modelProvider,
        )
      );
    }),
    "The model preset must admit its exact stock executable and model destination automatically.",
  );
  const credentialed = Object.values(policies).flatMap((entry) => {
    const endpoints = asRecord(entry)?.endpoints;
    return Array.isArray(endpoints)
      ? endpoints.filter(
          (endpoint) => asRecord(asRecord(endpoint)?.credential_binding)?.provider === gitProvider,
        )
      : [];
  });
  assert.ok(
    credentialed.length > 0 &&
      credentialed.every((entry) => asRecord(entry)?.host === "github.com"),
    "Only the GitHub destination may use the Git Provider.",
  );
  const policyText = JSON.stringify(credentialed);
  assert.ok(
    policyText.includes(`/${allowedName}.git/`) && !policyText.includes(`/${deniedName}.git/`),
    "The loaded credential policy must admit only the selected repository.",
  );

  async function chat(agentId: string, message: string): Promise<string> {
    const response = await request(
      "POST",
      `/agents/${agentId}/chat`,
      200,
      { messages: [{ role: "user", content: message }], stream: false },
      8 * 60_000,
    );
    const result = (await response.json()) as {
      choices?: { message?: { role?: string; content?: string } }[];
    };
    assert.ok(result.choices?.[0]?.message?.role === "assistant");
    return result.choices[0].message.content?.trim() ?? "";
  }

  // Run Git with the Harness's startup environment and native shell. Management
  // exec stages the script and checks its exit marker without supplying a token.
  async function runInHarness(runtime: typeof reader, script: string) {
    const file = `${runtime.workspacePath}/.occ-git-${randomUUID()}`;
    const nonce = randomUUID();
    const exec = (command: string[], stdin = "") =>
      gateway.execSandbox(
        {
          workspace,
          sandbox: runtime.sandboxName,
          command,
          environment: {},
          stdin,
          timeoutSeconds: 20,
        },
        rpc(),
      );
    const marker = openClaw
      ? `printf '%s %s %s %s' '${nonce}' "$(command -v git)" "$(readlink -f "$(git --exec-path)/git-remote-https")" "$(git --version)" > "${file}.ok"\ncat "${file}.ok"`
      : `printf '%s' '${nonce}' > "${file}.ok"`;
    const input = `set -eu\n(\n${script}\n)\n${marker}\n`;
    assert.equal(await exec(["sh", "-ceu", 'cat > "$1" && chmod 0444 "$1"', "sh", file], input), 0);
    try {
      const reply = await chat(
        runtime.agentId,
        openClaw
          ? `Use your native exec tool to run sh ${file} exactly once. Reply with only its final output line.`
          : `Use your native shell tool to run sh ${file} exactly once. Reply when the command finishes.`,
      );
      // Compare the bounded version and paths in the reply with the exec output in the
      // revision Sandbox before recording them. Raw model or command output stays private.
      const evidence = openClaw
        ? /^([a-f0-9-]{36}) (\/usr\/bin\/git) (\/usr\/(?:lib|libexec)\/git-core\/git-remote-https?) git version ([0-9]+(?:\.[0-9]+){1,3})$/.exec(
            reply,
          )
        : undefined;
      if (openClaw) {
        assert.ok(
          evidence && evidence[1] === nonce,
          "Expected the worker's Git result from the native Agent turn.",
        );
      }
      assert.equal(
        await exec([
          "sh",
          "-ceu",
          'test "$(cat "$1.ok")" = "$2"',
          "sh",
          file,
          evidence ? evidence[0] : nonce,
        ]),
        0,
        "The Harness command must complete successfully.",
      );
      if (evidence) {
        t.diagnostic(
          `Worker image ${runtimeImage.split("@")[1]}, Git ${evidence[4]} at ${evidence[2]}, HTTPS helper ${evidence[3]}.`,
        );
      }
    } finally {
      await exec(["sh", "-ceu", 'rm -f "$1" "$1.ok"', "sh", file]);
    }
  }
  async function expectNativeDecisions(
    matches: readonly ((line: OpenShellSandboxLogLine) => boolean)[],
    run: () => Promise<void>,
  ) {
    const latest = async () => {
      const logs = await gateway.getSandboxLogs(
        { workspace, sandbox: sandboxName, lines: 2000 },
        rpc(),
      );
      const decisions = logs.lines.filter(
        (line) =>
          line.sandboxId === sandbox.id &&
          line.source === "sandbox" &&
          line.target === "ocsf" &&
          line.level.toUpperCase() === "OCSF",
      );
      return matches.map((match) => decisions.findLast(match)?.time);
    };
    const before = await latest();
    await run();
    await waitUntil(
      "the revision Sandbox reports fresh matching network decisions",
      async () => (await latest()).every((time, index) => time && time !== before[index]),
      { timeoutMs: 30_000, intervalMs: 500 },
    );
  }
  // OpenShell can redact the service query in the denial event. The stock push
  // and fetch choose different services on the same discovery path.
  function discoveryDenied(
    line: OpenShellSandboxLogLine,
    service: "git-receive-pack" | "git-upload-pack",
    repository = allowedName,
  ) {
    const path = `L7_REQUEST deny GET github.com:443/${repository}.git/info/refs`;
    return (
      line.message.startsWith("HTTP:GET [MED] DENIED ") &&
      (line.message.includes(`${path} reason=`) ||
        line.message.includes(`${path}?service=${service} reason=`))
    );
  }
  const url = `https://github.com/${allowedName}.git`;
  const read = `git ls-remote --exit-code ${url} HEAD`;
  if (openClaw) {
    assert.equal(revision.harness.id, "openclaw");
    assert.equal(revision.harness.mode, "dedicated");
    const workerPath = `/namespaces/${namespaceId}/agents/${reader.agentId}/node/__openclaw__/worker`;
    assert.ok(nodeEndpoints.some((entry) => asRecord(entry)?.path === workerPath));
    for (const [name, sourceId] of [
      [modelProvider, modelSourceId],
      [gitProvider, gitSourceId],
    ] as const) {
      assert.ok(Array.isArray(sandbox.spec?.providers) && sandbox.spec.providers.includes(name));
      const provider = await gateway.getProvider(workspace, name, rpc());
      assert.ok(
        provider?.labels[SOURCE_ID_LABEL] === sourceId &&
          provider.config.oce_source_version &&
          provider.labels["openclaw.dev/credential-proxy-delivery"] === "static",
        "The attached Provider must be the selected Proxy's versioned copy of this Source.",
      );
    }
    // Only the Agent's exec runs Git. Its script and completion marker are checked in
    // the revision Sandbox, and the Supervisor must deny this specific omitted path.
    await expectNativeDecisions(
      [
        (line) =>
          line.message.startsWith("HTTP:POST [INFO] ALLOWED ") &&
          line.message.includes("POST https://api.openai.com/v1/responses "),
        (line) =>
          line.message.startsWith("HTTP:GET [INFO] ALLOWED ") &&
          line.message.includes(`GET https://github.com/${allowedName}.git/info/refs`),
        (line) => discoveryDenied(line, "git-upload-pack", deniedName),
      ],
      () =>
        runInHarness(
          reader,
          [
            'test -x "$(git --exec-path)/git-remote-https"',
            `${read} >/dev/null`,
            `code=0; git ls-remote --exit-code https://github.com/${deniedName}.git HEAD >/dev/null 2>&1 || code=$?; test "$code" -eq 128`,
          ].join("\n"),
        ),
    );
    const current = await gateway.getSandbox({ workspace, name: sandboxName }, rpc());
    assert.equal(current?.mainProcessInstanceId, sandbox.mainProcessInstanceId);
    assert.equal((await data<Agent>("GET", agentPath, 200)).activeRevisionId, revision.id);
    await (await request("POST", `${agentPath}/stop`, 202)).body?.cancel();
    await waitUntil(
      "managed Sandbox stopped and its model and Git Providers detached",
      async () => {
        const stopped = await gateway.getSandbox({ workspace, name: sandboxName }, rpc());
        const providers = stopped?.spec?.providers;
        return (
          stopped !== undefined &&
          stopped.id === sandbox.id &&
          (stopped.phase === "SANDBOX_PHASE_STOPPED" || stopped.phase === 7) &&
          Array.isArray(providers) &&
          !providers.includes(modelProvider) &&
          !providers.includes(gitProvider)
        );
      },
      poll,
    );
    return;
  }
  assert.ok(tcpProbe);
  await runInHarness(
    reader,
    `${read} >/dev/null && ! git ls-remote --exit-code https://github.com/${deniedName}.git HEAD >/dev/null 2>&1 || exit 1`,
  );
  await tcpProbe.verify((script) => runInHarness(reader, script));
  // Write only to the disposable repository explicitly named for this run.
  assert.ok(
    allowedName === writableRepository,
    "The installed repository must match the disposable write target.",
  );
  const contributor = await deploy("write");
  assert.equal(contributor.gitSourceId, gitSourceId);
  assert.ok(
    Array.isArray(contributor.sandbox.spec?.providers) &&
      contributor.sandbox.spec.providers.includes(gitProvider),
  );
  const version = (await gateway.getProvider(workspace, gitProvider, rpc()))?.config
    .oce_source_version;
  assert.ok(version);
  await verifyNativeGitPush({
    repository: allowedName,
    runReader: (script) =>
      expectNativeDecisions([(line) => discoveryDenied(line, "git-receive-pack")], () =>
        runInHarness(reader, script),
      ),
    runContributor: (script) => runInHarness(contributor, script),
  });
  assert.equal(
    (await gateway.getProvider(workspace, gitProvider, rpc()))?.config.oce_source_version,
    version,
    "Both pushes must use the same write-capable credential version.",
  );

  await data("PATCH", agentPath, 200, {
    configurationId: configuration.id,
    repositoryAccess: { defaultProfile: "github-repository", repositories: [] },
  });
  await waitUntil(
    "Worker withdraws Git from the running reader",
    async () => {
      const running = await gateway.getSandbox({ workspace, name: sandboxName }, rpc());
      assert.equal(running?.id, sandbox.id);
      assert.equal(running?.mainProcessInstanceId, sandbox.mainProcessInstanceId);
      const providers = running?.spec?.providers;
      return (
        Array.isArray(providers) &&
        providers.includes(modelProvider) &&
        !providers.includes(gitProvider)
      );
    },
    poll,
  );
  const reduced = await gateway.getPolicyStatus({ workspace, sandbox: sandboxName }, rpc());
  const effective = await gateway.getSandboxConfig(workspace, sandboxName, rpc());
  assert.equal(reduced.state, "POLICY_STATUS_LOADED");
  assert.equal(reduced.activeVersion, reduced.version);
  assert.notEqual(reduced.version, loaded.version);
  assert.equal(effective.configuration_admitted, true);
  assert.equal(effective.version, reduced.version);
  for (const policy of [reduced.policy, effective.policy]) {
    const networks = asRecord(asRecord(policy)?.network_policies);
    assert.ok(networks);
    const endpoints = Object.values(networks).flatMap((rule) => {
      const items = asRecord(rule)?.endpoints;
      return Array.isArray(items) ? items.map(asRecord) : [];
    });
    assert.ok(!endpoints.some((entry) => entry?.host === "github.com"));
    assert.ok(
      endpoints.some(
        (entry) =>
          entry?.host === host && asRecord(entry.credential_binding)?.provider === modelProvider,
      ),
    );
  }
  await expectNativeDecisions(
    [
      (line) =>
        /^NET:OPEN \[MED\] DENIED \/usr\/(?:lib|libexec)\/git-core\/git-remote-https?\(\d+\) -> github\.com:443 \[reason:transparent_tcp_policy_denied\]$/.test(
          line.message,
        ) || discoveryDenied(line, "git-upload-pack"),
    ],
    () => runInHarness(reader, `code=0; ${read} >/dev/null 2>&1 || code=$?; test "$code" -eq 128`),
  );
  await runInHarness(contributor, `${read} >/dev/null`);
  const modelNonce = `MODEL-${randomUUID()}`;
  assert.equal(
    await chat(reader.agentId, `Reply with exactly this text and no other words: ${modelNonce}`),
    modelNonce,
  );
  assert.equal((await data<Agent>("GET", agentPath, 200)).activeRevisionId, revision.id);
}
