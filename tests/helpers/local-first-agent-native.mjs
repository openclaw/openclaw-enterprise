import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const proofPrefix = "OCE_NATIVE_FIRST_AGENT_PROOF ";
export const nativeFirstAgentProofTimeout = 10 * 60_000;

// Run in the existing trusted controller: it already has the private route key,
// cluster DNS and CA. Native admin sign-in is neither enabled nor required.
async function nativeWorkerProof({ namespaceId, agentId, timeout }) {
  const assert = (await import("node:assert/strict")).default;
  const { randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(resolve("apps/controller/package.json"));
  const { GatewayClient } = await import(
    pathToFileURL(require.resolve("@openclaw/gateway-client"))
  );
  const { loadYaml } = await import(pathToFileURL(require.resolve("@kubernetes/client-node")));
  let stage = "startup";
  let client;
  let helloTimer;
  const emit = (data) =>
    process.stdout.write("OCE_NATIVE_FIRST_AGENT_PROOF " + JSON.stringify(data) + "\n");
  try {
    const startup = loadYaml(await readFile(process.env.OCC_CONFIG_PATH, "utf8"));
    assert.equal(startup.runtime?.nativeWorkerSupport, undefined);
    assert.equal(startup.occ?.runtime?.nativeWorkerSupport, undefined);
    const routing = startup.drivers.compute.configuration.gatewayRouting;
    assert.ok(routing.hostname, "The selected OpenShell route must advertise its hostname");
    assert.ok(!routing.hostname.includes("*"), "Local Setup must provide one literal Gateway host");
    const authority =
      routing.endpointPort && routing.endpointPort !== 443
        ? `${routing.hostname}:${routing.endpointPort}`
        : routing.hostname;
    const apiKey = await readFile(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8");
    assert.ok(apiKey && /^[\x21-\x7e]+$/.test(apiKey));
    const connected = Promise.withResolvers();
    const signal = AbortSignal.timeout(timeout);
    client = new GatewayClient({
      url: `wss://${authority}/namespaces/${namespaceId}/agents/${agentId}`,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: [],
      deviceIdentity: null,
      minProtocol: 4,
      maxProtocol: 4,
      edgeAuthHeaders: { "x-api-key": apiKey },
      onHelloOk: connected.resolve,
      onConnectError: connected.reject,
    });
    const call = (method, params) => client.request(method, params, { signal, timeoutMs: 30_000 });
    helloTimer = setTimeout(() => connected.reject(new Error("Gateway hello timeout")), 15_000);
    stage = "connect";
    client.start();
    const hello = await connected.promise;
    clearTimeout(helloTimer);
    assert.equal(hello.auth.role, "operator");
    assert.ok(hello.auth.scopes.includes("operator.admin"));
    assert.equal(hello.auth.deviceToken, undefined);
    const agents = await call("agents.list", { includeSessionPlacement: true });
    const required = agents.sessionPlacement?.requiredProfile;
    assert.ok(required?.id && required.providerId);
    assert.equal(required.inference, "worker");
    assert.ok(required.executionModes.includes("worker-turn"));
    const key = `agent:main:first-agent-native-${randomUUID()}`;
    stage = "create";
    const session = await call("sessions.create", {
      key,
      agentId: "main",
      message: "",
      displayName: "First Agent native worker proof",
      worktree: true,
      worktreeSource: "empty",
    });
    assert.equal(session.key, key);
    stage = "required-placement";
    let placement;
    while (!signal.aborted) {
      const described = await call("sessions.describe", { key, agentId: "main" });
      placement = described.session?.placement;
      if (placement?.state === "active") {
        break;
      }
      assert.ok(!["failed", "reclaimed", "local"].includes(placement?.state));
      await delay(500, undefined, { signal });
    }
    signal.throwIfAborted();
    assert.equal(placement.profileId, required.id);
    assert.ok(placement.environmentId && placement.remoteWorkspaceDir);
    const marker = `FIRST_AGENT_NATIVE_${randomUUID()}`;
    const toolPrefix = "FIRST_AGENT_NATIVE_TOOL ";
    const command = `node -e '${[
      `process.stdout.write(${JSON.stringify(toolPrefix)} + JSON.stringify({`,
      'cwd:process.cwd(),modelCredentialPresent:Object.hasOwn(process.env,"OPENAI_API_KEY")',
      '}) + "\\n")',
    ].join("")}'`;
    stage = "send";
    const sent = await call("sessions.send", {
      key,
      agentId: "main",
      idempotencyKey: randomUUID(),
      message: `Use exec to run exactly this command: ${command}. After exec succeeds, reply with exactly ${marker}. Do not print environment values or credentials.`,
    });
    assert.ok(sent.runId);
    assert.ok(!["error", "timeout"].includes(sent.status));
    stage = "model-and-exec";
    const text = (content) =>
      typeof content === "string"
        ? content
        : (content ?? [])
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n");
    while (!signal.aborted) {
      const history = await call("chat.history", { sessionKey: key, limit: 30 });
      const messages = history.messages ?? [];
      const tool = messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "exec" &&
          message.isError === false &&
          text(message.content).includes(toolPrefix),
      );
      const final = messages.find(
        (message) =>
          message.role === "assistant" &&
          text(message.content).trim() === marker &&
          !["toolUse", "error"].includes(message.stopReason) &&
          !(
            Array.isArray(message.content) &&
            message.content.some((part) => part?.type === "toolCall")
          ),
      );
      if (tool && final) {
        const line = text(tool.content)
          .split(/\r?\n/)
          .find((line) => line.startsWith(toolPrefix));
        assert.ok(line);
        const proof = JSON.parse(line.slice(toolPrefix.length));
        assert.equal(proof.cwd, placement.remoteWorkspaceDir);
        assert.equal(proof.modelCredentialPresent, false);
        emit({ verified: true, profileId: required.id, environmentId: placement.environmentId });
        return;
      }
      assert.ok(
        !messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
      );
      await delay(500, undefined, { signal });
    }
    signal.throwIfAborted();
  } catch {
    // Dependency/RPC errors can include private headers. Preserve the failing
    // stage, never raw exceptions, keys, transcripts or controller output.
    emit({ verified: false, stage });
    process.exitCode = 1;
  } finally {
    clearTimeout(helloTimer);
    client?.stop();
    await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

export async function assertNativeWorkerProofInController(
  context,
  { stateDirectory, state, environment, namespaceId, agentId },
) {
  context.signal.throwIfAborted();
  const safeEnvironment = {
    ...environment,
    COMPOSE_DISABLE_ENV_FILE: "1",
    DOCKER_HOST: state.dockerHost,
  };
  delete safeEnvironment.OPENAI_API_KEY;
  delete safeEnvironment.OPENAI_API_KEY_FILE;
  const input = `await (${nativeWorkerProof.toString()})(${JSON.stringify({ namespaceId, agentId, timeout: nativeFirstAgentProofTimeout })});`;
  const command = state.deploymentMode === "k3d" ? "kubectl" : state.containerEngine;
  const args =
    state.deploymentMode === "k3d"
      ? [
          "--kubeconfig",
          join(stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${state.cluster}`,
          "exec",
          "-i",
          "--namespace",
          state.platformNamespace,
          "deployment/openclaw-enterprise-api",
          "-c",
          "api",
          "--",
          "node",
          "--input-type=module",
          "-",
        ]
      : [
          "compose",
          "--project-directory",
          state.repository,
          "--project-name",
          state.composeProject,
          "-f",
          join(stateDirectory, "compose.yaml"),
          "exec",
          "-T",
          "controller",
          "node",
          "--input-type=module",
          "-",
        ];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: safeEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-16_384);
    });
    child.stderr.resume();
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, nativeFirstAgentProofTimeout + 30_000);
    context.signal.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.once("error", () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", stop);
      reject(new Error("Could not start the native first-Agent proof in the selected controller"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", stop);
      const line = output.split(/\r?\n/).find((line) => line.startsWith(proofPrefix));
      try {
        resolve({ code, proof: line ? JSON.parse(line.slice(proofPrefix.length)) : undefined });
      } catch {
        reject(new Error("The native first-Agent proof returned invalid evidence"));
      }
    });
  });
  assert.equal(
    result.code,
    0,
    `Native first-Agent proof failed during ${result.proof?.stage ?? "controller startup"}; raw output withheld`,
  );
  assert.equal(result.proof?.verified, true);
  assert.ok(result.proof.profileId && result.proof.environmentId);
}
