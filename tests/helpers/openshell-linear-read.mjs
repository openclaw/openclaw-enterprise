import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderPresetTemplate } from "../../packages/contracts/src/index.ts";
import { createQaInstallation } from "./qa-installation.mjs";
import { createNativePluginAssertions } from "./plugin-driver-real.mjs";
import { protectedText, redactQaError } from "./qa-secrets.mjs";
import { waitFor } from "./qa-utils.mjs";
import { nativeProvisioningPath } from "./local-first-agent-native.mjs";

const nativeReadScript = String.raw`
(async () => {
if (process.env.OPENCLAW_CODEX_PLUGINS_PREPARED !== "true") {
  throw new Error("OpenShell must prepare the selected plugins.");
}
const method = process.argv[1];
if (!["plugin/installed", "mcpServerStatus/list", "config/read"].includes(method)) throw new Error("Unsupported observation.");
const params = JSON.parse(process.argv[2] ?? "{}");
const token = process.env.APP_SERVER_TOKEN;
if (typeof token !== "string" || !token) throw new Error("Gateway transport token is required.");
const WebSocket = require("node:module").createRequire("/app/package.json")("ws");
const socket = new WebSocket(process.env.APP_SERVER_URL, {
  headers: { authorization: "Bearer " + token },
});
let settled = false;
const timeout = setTimeout(() => finish(), 15000);
function finish(result) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  socket.terminate();
  if (result === undefined) {
    process.stderr.write("Native installed-plugin observation failed.\n");
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify(result));
}
socket.on("error", () => finish());
socket.on("close", () => { if (!settled) finish(); });
socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "initialize", params: {
  clientInfo: { name: "oce-linear-proof", version: "1" }, capabilities: { experimentalApi: true },
} })));
socket.on("message", (data) => {
  try {
    const message = JSON.parse(data.toString());
    if (message.error) { finish(); return; }
    if (message.id === 1) {
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      socket.send(JSON.stringify({ id: 2, method, params }));
    } else if (message.id === 2) {
      if (method === "mcpServerStatus/list") { finish(message.result); return; }
      if (method === "config/read") {
        const config = message.result.config;
        finish({ features: config?.features, apps: config?.apps, plugins: config?.plugins });
        return;
      }
      const plugin = message.result.marketplaces.flatMap(market => market.plugins)
        .find(plugin => plugin.id === "linear@openai-curated-remote");
      finish({ installed: plugin?.installed === true, enabled: plugin?.enabled === true });
    }
  } catch { finish(); }
});
})().catch(() => {
  process.stderr.write("Native installed-plugin authentication failed.\n");
  process.exitCode = 1;
});
`;

// Use the shipped controller's existing route key, cluster DNS and CA. This
// client sends a normal Agent request through OCE routing without extracting a
// Gateway password or changing any running workload.
async function sendLinearRead({ namespaceId, agentId, sessionKey, prompt }) {
  const assert = (await import("node:assert/strict")).default;
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { randomUUID } = await import("node:crypto");
  const require = createRequire(resolve("apps/controller/package.json"));
  const { GatewayClient } = await import(
    pathToFileURL(require.resolve("@openclaw/gateway-client"))
  );
  const { loadYaml } = await import(pathToFileURL(require.resolve("@kubernetes/client-node")));
  let stage = "configuration";
  let client;
  let timer;
  try {
    const startup = loadYaml(await readFile(process.env.OCC_CONFIG_PATH, "utf8"));
    const routing = startup.drivers.compute.configuration.gatewayRouting;
    assert.ok(routing.hostname && !routing.hostname.includes("*"));
    const authority =
      routing.hostname +
      (routing.endpointPort && routing.endpointPort !== 443 ? ":" + routing.endpointPort : "");
    const key = await readFile(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8");
    const connected = Promise.withResolvers();
    const signal = AbortSignal.timeout(600_000);
    client = new GatewayClient({
      url: `wss://${authority}/namespaces/${namespaceId}/agents/${agentId}`,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: [],
      deviceIdentity: null,
      minProtocol: 4,
      maxProtocol: 4,
      edgeAuthHeaders: { "x-api-key": key },
      onHelloOk: connected.resolve,
      onConnectError: connected.reject,
    });
    stage = "connect";
    timer = setTimeout(() => connected.reject(new Error("Gateway hello timeout")), 15_000);
    client.start();
    const hello = await connected.promise;
    clearTimeout(timer);
    assert.equal(hello.auth.role, "operator");
    assert.ok(hello.auth.scopes.includes("operator.admin"));
    const call = (method, params) => client.request(method, params, { signal, timeoutMs: 30_000 });
    stage = "send";
    const sent = await call("chat.send", {
      sessionKey,
      message: prompt,
      idempotencyKey: randomUUID(),
    });
    assert.ok(sent.runId);
    stage = "completion";
    let result;
    do {
      result = await call("agent.wait", { runId: sent.runId, timeoutMs: 3_000 });
    } while (
      !signal.aborted &&
      !["ok", "error"].includes(result.status) &&
      result.endedAt === undefined
    );
    signal.throwIfAborted();
    assert.equal(result.status, "ok");
    process.stdout.write(
      "OCE_LINEAR_READ " + JSON.stringify({ ok: true, runId: sent.runId }) + "\n",
    );
  } catch {
    process.stdout.write("OCE_LINEAR_READ " + JSON.stringify({ ok: false, stage }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

export async function verifyOpenShellLinearRead(context, artifacts) {
  const token = await protectedText(process.env.OCC_TEST_QA_CODEX_TOKEN_FILE, "Codex credential");
  const model = process.env.OCC_TEST_QA_CODEX_MODEL;
  const prompt = process.env.OCC_TEST_CODEX_LINEAR_PROMPT;
  const toolName = process.env.OCC_TEST_CODEX_LINEAR_TOOL_NAME;
  const resultPattern = process.env.OCC_TEST_CODEX_LINEAR_RESULT_EXPECT;
  assert.ok(model?.trim(), "Select an authorized Codex model with OCC_TEST_QA_CODEX_MODEL");
  assert.ok(prompt?.trim(), "OCC_TEST_CODEX_LINEAR_PROMPT must request a harmless Linear read");
  assert.ok(toolName?.trim(), "OCC_TEST_CODEX_LINEAR_TOOL_NAME must identify the real read tool");
  assert.ok(
    resultPattern?.trim(),
    "OCC_TEST_CODEX_LINEAR_RESULT_EXPECT must identify known Linear data",
  );

  // Ordinary operator configuration at startup, never a patch to a running Sandbox.
  // These are the pinned runtime's native executables and observed package origins.
  const policyFile = join(artifacts, `linear-package-policy-${randomUUID()}.json`);
  await writeFile(
    policyFile,
    JSON.stringify({
      networkPolicies: [
        {
          name: "codex-plugin-artifacts",
          binaries: [
            "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
            "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
          ].map((path) => ({ path })),
          endpoints: [
            "sdmntprsouthcentralus.oaiusercontent.com",
            "sdmntprwestcentralus.oaiusercontent.com",
            "sdmntprcentralus.oaiusercontent.com",
            "sdmntprwestus.oaiusercontent.com",
            "sdmntprbrazilsouth.oaiusercontent.com",
            "sdmntprwestus2.oaiusercontent.com",
          ].map((host) => ({
            host,
            ports: [443],
            protocol: "rest",
            enforcement: "enforce",
            access: "read_only",
          })),
        },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );

  const f = await createQaInstallation(context, "kubernetes", artifacts, {
    repositoryInputs: false,
    sandboxDriver: "openshell",
    sandboxNetworkPolicyFile: policyFile,
  });
  const native = createNativePluginAssertions({
    execGateway: (target, args) => f.execRole(target, "gateway", args),
    execCodex: (target, args) => f.execRole(target, "agent", args),
    waitFor,
    proofMode: "codex",
  });
  let deployedAgent;
  let sessionKey;
  try {
    assert.equal(f.configuration.drivers.plugin.id, "codex-plugin");
    const base = `/namespaces/${f.namespace.id}`;
    const preset = JSON.parse(
      await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
    );
    const name = `linear-read-${f.suffix}`;
    const rendered = renderPresetTemplate(preset.template, {
      name,
      model,
      modelSecret: "provided-through-secret-api",
    });
    rendered.configuration.values.agents.defaults.skipBootstrap = true;

    // The real Secret, Credential Source and provisioning APIs own all Agent mutation.
    // No imported ServiceAccount Driver, hand-written adapter or workload mutation is used.
    const secret = await f.api("POST", `${base}/secrets`, {
      name: `${name}-credential`,
      value: token,
    });
    const source = await f.api("POST", `${base}/credential-sources`, {
      name: `${name}-source`,
      type: "codex-pat",
      config: {},
      secrets: { access_token: secret.ref },
    });
    assert.equal(source.state, "ready");
    const pluginId = "codex-plugin:linear@openai-curated-remote";
    const submitted = await f.api("POST", `${base}/agents/provision`, {
      requestId: `req_${randomUUID()}`,
      name,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      configuration: { kind: "agent", values: rendered.configuration.values },
      plugins: {
        [pluginId]: {
          enabled: true,
          toolDefaults: { approval: "provider_default", reviewer: "auto" },
        },
      },
    });
    const provisioningPath = nativeProvisioningPath(f.namespace.id, submitted.provisioning);
    const provisioned = await waitFor("OpenShell Linear provisioning", async () => {
      const work = await f.api("GET", provisioningPath);
      assert.notEqual(
        work.status,
        "failed",
        `Agent provisioning failed: ${work.failureCode ?? "unspecified"}`,
      );
      return work.status === "succeeded" && work;
    });
    const agent = await f.api("GET", `${base}/agents/${provisioned.agentId}`);
    agent.revision = await f.api(
      "GET",
      `${base}/agents/${agent.id}/revisions/${provisioned.revisionId}`,
    );
    f.agents.push(agent);
    deployedAgent = agent;
    const deployment = await waitFor("OpenShell Linear deployment", async () => {
      const status = await f.api(
        "GET",
        `${base}/agents/${agent.id}/deployments/${agent.revision.id}`,
      );
      assert.notEqual(status.status, "failed", "Linear deployment must succeed without repair");
      return status.status === "succeeded" && status;
    });
    assert.deepEqual(
      deployment.warnings ?? [],
      [],
      "Linear must be installed without an authentication warning",
    );
    assert.equal(agent.revision.plugins.plugins[pluginId].enabled, true);

    // Kubernetes access below observes the deployed runtime and forwards its API;
    // it does not change configuration, credentials, Pods, or native state.
    const harness = await f.pod(agent, "agent");
    assert.equal(harness.metadata.labels["openclaw.dev/network-profile"], "provider-fenced-v1");
    const owner = harness.metadata.ownerReferences?.find(({ kind }) => kind === "Sandbox");
    assert.ok(owner?.name && owner.uid, "OpenShell must own the actual Codex Harness Pod");
    const sandbox = await f.resource(
      "sandboxes.agents.x-k8s.io",
      owner.name,
      harness.metadata.namespace,
    );
    assert.equal(sandbox.metadata.uid, owner.uid);

    // Query installed state from the Gateway's existing authorized connection
    // inputs. Its reusable transport token never leaves the Gateway container.
    const installed = await f.execRole(agent, "gateway", [
      "node",
      "-e",
      nativeReadScript,
      "plugin/installed",
    ]);
    assert.deepEqual(JSON.parse(installed.stdout), { installed: true, enabled: true });
    sessionKey = `agent:main:linear-read-${randomUUID()}`;
    const turnMarker = `LINEAR_READ_${randomUUID()}`;
    const routed = await f.run(
      "kubectl",
      [
        "--kubeconfig",
        join(f.stateDirectory, "kubeconfig"),
        "--context",
        `k3d-${f.cluster}`,
        "exec",
        "-i",
        "--namespace",
        f.state.platformNamespace,
        "deployment/openclaw-enterprise-api",
        "-c",
        "api",
        "--",
        "node",
        "--input-type=module",
        "-",
      ],
      {
        input: `await (${sendLinearRead.toString()})(${JSON.stringify({
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          sessionKey,
          prompt: `${prompt}\nUse only the installed Linear plugin for a fresh read. Do not make changes, run shell commands, or use unrelated tools. If Linear is unavailable, report that directly. Include this marker in your final response: ${turnMarker}`,
        })});`,
        timeout: 660_000,
        allowExitCodes: [0, 1],
        privateFailureOutput: true,
      },
    );
    const receipt = routed.split("\n").find((line) => line.startsWith("OCE_LINEAR_READ "));
    assert.ok(receipt, "OCE Gateway route must return a turn receipt");
    const turn = JSON.parse(receipt.slice("OCE_LINEAR_READ ".length));
    assert.equal(turn.ok, true, `OCE Gateway turn failed at ${turn.stage}`);
    // A model claim is insufficient: require the exact native call linked to a
    // successful result matching known Linear data in this marked Agent turn.
    const toolEvidence = await native.assertSessionToolCallEvidence(agent, {
      sessionKey,
      turnMarker,
      toolName,
      resultPattern,
    });
    const evidence = await f.record("linear-read", {
      agentId: agent.id,
      revisionId: agent.revision.id,
      pluginId,
      toolName,
      installedAndUsed: true,
      nativeToolResultVerified: true,
      gatewayRunId: turn.runId,
      sessionId: toolEvidence.sessionId,
      toolCallId: toolEvidence.toolCallId,
      setup: "shipped Kubernetes/OpenShell installation and public OCE provisioning APIs",
    });
    return {
      evidence,
      outcome: "Linear read through the installed plugin in a real OpenShell Agent turn",
    };
  } catch (error) {
    // Preserve private, bounded failure evidence before normal API cleanup. Raw
    // runtime logs are not public QA artifacts and never replace the failed assertion.
    if (deployedAgent !== undefined) {
      const base = `/namespaces/${deployedAgent.namespaceId}/agents/${deployedAgent.id}/deployments/${deployedAgent.revision.id}`;
      for (const source of ["agent", "gateway"]) {
        try {
          const logs = await f.api("GET", `${base}/runtime/logs?source=${source}&tailLines=200`);
          await writeFile(
            join(f.directory, `linear-failure-${source}.json`),
            JSON.stringify(logs),
            { mode: 0o600 },
          );
        } catch {
          /* Keep the original failure if logs are unavailable. */
        }
      }
      let binding;
      if (sessionKey !== undefined) {
        try {
          binding = await native.readCodexSessionBinding(deployedAgent, { sessionKey });
        } catch {
          /* A turn can fail before it creates a native binding. */
        }
      }
      for (const [method, params, name] of [
        ["mcpServerStatus/list", { threadId: binding?.threadId, serverName: "codex_apps" }, "mcp"],
        ["config/read", { includeLayers: false }, "plugin-config"],
      ]) {
        try {
          const status = await f.execRole(deployedAgent, "gateway", [
            "node",
            "-e",
            nativeReadScript,
            method,
            JSON.stringify(params),
          ]);
          await writeFile(join(f.directory, `linear-failure-${name}.json`), status.stdout, {
            mode: 0o600,
          });
        } catch {
          /* Keep the original failure if native observation is unavailable. */
        }
      }
      await f.record("linear-failure", {
        agentId: deployedAgent.id,
        revisionId: deployedAgent.revision.id,
        privateDiagnostics: f.directory,
      });
    }
    throw redactQaError(error);
  }
}
