import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { selectFirstAgentModel, verifyFirstAgentModel } from "../../scripts/first-agent-model.mjs";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  assertNativeWorkerProofInController,
  nativeFirstAgentProofTimeout,
} from "../helpers/local-first-agent-native.mjs";
import { localFirstAgentStack } from "../helpers/local-first-agent-stack.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const firstAgentScript = fileURLToPath(new URL("../../scripts/first-agent.mjs", import.meta.url));
const selected = process.env.OCC_TEST_LOCAL_FIRST_AGENT_REAL === "1";
const selectedHarness = process.env.OCC_TEST_LOCAL_FIRST_AGENT_HARNESS ?? "openclaw";
assert.match(selectedHarness, /^(?:openclaw|codex)$/);
const selectedSandboxDriver = process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER ?? "none";
assert.match(selectedSandboxDriver, /^(?:none|openshell)$/);
if (selectedSandboxDriver === "openshell") {
  assert.equal(selectedHarness, "codex", "OpenShell first-Agent proof requires dedicated Codex.");
}
const execFileAsync = promisify(execFile);
const maxOutputLength = 32_768;
const commandTimeout = 30 * 60_000;
const refusalTimeout = 2 * 60_000;
const stackLifecycleTimeout = 25 * 60_000;
const sensitiveValues = new Set([process.env.OPENAI_API_KEY].filter(Boolean));

function redact(output) {
  for (const value of sensitiveValues) {
    output = output.replaceAll(value, "[redacted]");
  }
  return output;
}

function runFirstAgent({
  name,
  prompt,
  replaceKey = false,
  allowFailure = false,
  forbiddenOutput,
  env,
  signal,
  timeout = commandTimeout,
  harness = selectedHarness,
}) {
  const args = [firstAgentScript, name, "--harness", harness];
  if (prompt !== undefined) {
    args.push("--prompt", prompt);
  }
  if (replaceKey) {
    args.push("--replace-key");
  }
  const captureLength =
    maxOutputLength + Math.max(0, ...[...sensitiveValues].map((value) => value.length));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let containedForbiddenOutput = false;
    let forceKill;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (forbiddenOutput && stdout.includes(forbiddenOutput)) {
        containedForbiddenOutput = true;
      }
      stdout = stdout.slice(-captureLength);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (forbiddenOutput && stderr.includes(forbiddenOutput)) {
        containedForbiddenOutput = true;
      }
      stderr = stderr.slice(-captureLength);
    });

    const abort = () => child.kill("SIGKILL");
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }

    const commandTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKill.unref();
    }, timeout);
    commandTimer.unref();

    function finish() {
      clearTimeout(commandTimer);
      clearTimeout(forceKill);
      signal.removeEventListener("abort", abort);
    }

    child.once("error", (error) => {
      finish();
      reject(new Error(`Could not start the first-Agent command: ${redact(error.message)}`));
    });
    child.once("close", (code, childSignal) => {
      finish();
      const output = {
        stdout: redact(stdout).slice(-maxOutputLength),
        stderr: redact(stderr).slice(-maxOutputLength),
        exitCode: code,
        containedForbiddenOutput,
      };
      if (timedOut || code === null || (!allowFailure && code !== 0)) {
        const cause = timedOut ? "timed out" : `exited ${code ?? childSignal}`;
        reject(new Error(`First-Agent command ${cause}.\n${output.stdout}\n${output.stderr}`));
        return;
      }
      resolve(output);
    });
  });
}

function readResult({ stdout, stderr }, expectedReply) {
  const diagnostic = `First-Agent command output:\n${stdout}\n${stderr}`;
  const agent = /^Agent ID: (agt_[A-Za-z0-9_-]+)\r?$/m.exec(stdout);
  const revision = /^Revision: (rev_[A-Za-z0-9_-]+)\r?$/m.exec(stdout);
  const harness = /^Harness: (openclaw|codex)\r?$/m.exec(stdout);
  const model = /^Model: ((?:openai|codex)\/[A-Za-z0-9._-]+)\r?$/m.exec(stdout);
  const proof = /^Model response verified: (FIRST_AGENT_[A-Fa-f0-9-]+)\r?$/m.exec(stdout);
  const consoleLine = /^Console: ([^\r\n]+)\r?$/m.exec(stdout);
  const replyHeading = /(?:^|\n)Agent response:\r?\n/.exec(stdout);

  assert.ok(agent, `Missing Agent ID.\n${diagnostic}`);
  assert.equal(harness?.[1], selectedHarness, `Unexpected Harness.\n${diagnostic}`);
  assert.ok(revision, `Missing revision.\n${diagnostic}`);
  assert.ok(model, `Missing selected model.\n${diagnostic}`);
  assert.ok(proof, `Missing generated model verification nonce.\n${diagnostic}`);
  assert.ok(consoleLine, `Missing Console URL.\n${diagnostic}`);
  assert.ok(replyHeading, `Missing custom model reply.\n${diagnostic}`);
  const reply = stdout.slice(replyHeading.index + replyHeading[0].length).replace(/\r?\n$/, "");
  assert.equal(reply, expectedReply, diagnostic);

  let consoleUrl;
  try {
    consoleUrl = new URL(consoleLine[1]);
  } catch {
    throw new Error("First-Agent command returned an invalid Console URL.");
  }
  assert.ok(
    consoleUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(consoleUrl.hostname) &&
      !consoleUrl.username &&
      !consoleUrl.password &&
      !consoleUrl.hash,
    "The Console URL must be an unauthenticated local HTTP origin",
  );
  assert.ok(
    consoleUrl.pathname === `/console/agents/${agent[1]}`,
    "The Console URL must identify the returned Agent",
  );
  const namespaces = consoleUrl.searchParams.getAll("namespace");
  assert.ok(
    namespaces.length === 1 && /^ns_[A-Za-z0-9_-]+$/.test(namespaces[0]),
    "The Console URL must identify one Namespace",
  );
  return {
    identity: { agentId: agent[1], revisionId: revision[1] },
    proofNonce: proof[1],
    model: model[1],
    origin: consoleUrl.origin,
    namespaceId: namespaces[0],
  };
}

async function readPrivateJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read ${label}.`);
  }
}

async function readKubernetesJson({ stateDirectory, cluster, env }, args, label) {
  const environment = { ...env };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_API_KEY_FILE;
  try {
    const { stdout } = await execFileAsync(
      "kubectl",
      [
        "--kubeconfig",
        join(stateDirectory, "kubeconfig"),
        "--context",
        `k3d-${cluster}`,
        ...args,
        "--output",
        "json",
      ],
      { env: environment, timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not read ${label} in the local Kubernetes context.`);
  }
}

async function readSecretResourceVersion({ stateDirectory, cluster, env, namespaceId, secretId }) {
  const environment = { ...env };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_API_KEY_FILE;
  const common = [
    "--kubeconfig",
    join(stateDirectory, "kubeconfig"),
    "--context",
    `k3d-${cluster}`,
  ];
  async function readOne(kind, selector, field, pattern) {
    let output;
    try {
      const { stdout } = await execFileAsync(
        "kubectl",
        [
          ...common,
          "get",
          kind,
          "--all-namespaces",
          "--selector",
          selector,
          "--output",
          `jsonpath={.items[*].metadata.${field}}`,
        ],
        { env: environment, timeout: 20_000, maxBuffer: 4_096 },
      );
      output = stdout.trim();
    } catch {
      throw new Error(`Could not read ${kind} metadata in the local Kubernetes context.`);
    }
    const matches = output === "" ? [] : output.split(/\s+/);
    assert.ok(
      matches.length === 1 && pattern.test(matches[0]),
      `Expected exactly one matching Kubernetes ${kind} metadata value`,
    );
    return matches[0];
  }

  // Single-cluster Compute materializes each consumer and its Secret in the canonical tenant
  // namespace. The Namespace label identifies that placement independently of Harness topology.
  return readOne(
    "secrets",
    `openclaw.dev/namespace=${namespaceId},openclaw.dev/secret=${secretId}`,
    "resourceVersion",
    /^[A-Za-z0-9._:-]+$/,
  );
}

async function requestLocalApi(origin, serviceKey, method, path, body) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "x-api-key": serviceKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`The local controller did not answer ${method} ${path}.`);
  }
  assert.ok(
    response.ok,
    `The local controller returned HTTP ${response.status} for ${method} ${path}.`,
  );
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error("The local controller returned invalid JSON.");
  }
  assert.ok(envelope?.data, "The local controller response is missing its data field");
  return envelope.data;
}

test("the first-Agent command advertises its default and preserves explicit or recorded model selections", async () => {
  const { stdout } = await execFileAsync(process.execPath, [firstAgentScript, "--help"], {
    cwd: repoRoot,
  });
  assert.match(stdout, /OPENCLAW_FIRST_AGENT_MODEL defaults to gpt-6-astra for a new Agent/);
  assert.equal(selectFirstAgentModel(undefined, undefined), "gpt-6-astra");
  assert.equal(selectFirstAgentModel("gpt-4.1", undefined), "gpt-4.1");
  assert.equal(selectFirstAgentModel(undefined, { model: "gpt-5.1" }), "gpt-5.1");
  assert.equal(selectFirstAgentModel("gpt-4.1", { model: "gpt-4.1" }), "gpt-4.1");
  assert.throws(
    () => selectFirstAgentModel("gpt-6-astra", { model: "gpt-4.1" }),
    /recorded Namespace or model differs/,
  );
  assert.throws(
    () => selectFirstAgentModel("openai/gpt-6-astra", undefined),
    /plain OpenAI model ID/,
  );
});

test("the first-Agent model check discovers the gateway in the tenant namespace", async () => {
  const namespaceId = "ns_first_agent_placement";
  const agentId = "agt_first_agent_placement";
  const revisionId = "rev_first_agent_placement";
  const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const revisionConfigMap = `gateway-${digest(agentId)}-rev-${digest(revisionId)}`;

  const calls = [];
  const kubectl = async (...args) => {
    calls.push(args);
    if (args[0] === "get" && args[1] === "namespaces") {
      return JSON.stringify({ items: [{ metadata: { name: "tenant-runtime" } }] });
    }
    if (args[0] === "get" && args[1] === "pods") {
      return JSON.stringify({
        items: [
          {
            metadata: { name: "gateway-pod" },
            spec: { volumes: [{ configMap: { name: revisionConfigMap } }] },
            status: {
              phase: "Running",
              conditions: [{ type: "Ready", status: "True" }],
            },
          },
        ],
      });
    }
    if (args[0] === "exec") {
      const input = args.at(-1)?.input ?? "";
      const nonce = /FIRST_AGENT_[0-9a-f-]+/u.exec(input)?.[0];
      assert.ok(nonce, "the gateway probe must include its verification nonce");
      return JSON.stringify({ nonce });
    }
    throw new Error(`Unexpected kubectl invocation: ${args.join(" ")}`);
  };

  await verifyFirstAgentModel(kubectl, {
    namespaceId,
    agentId,
    revisionId,
    expectProviderKey: false,
  });

  const namespaceCall = calls.find((args) => args[0] === "get" && args[1] === "namespaces");
  assert.equal(
    namespaceCall?.[namespaceCall.indexOf("-l") + 1],
    `openclaw.dev/namespace=${namespaceId}`,
  );
  const execCall = calls.find((args) => args[0] === "exec");
  assert.equal(execCall?.[execCall.indexOf("--namespace") + 1], "tenant-runtime");
});

test(
  "a local Kubernetes installer can deploy and reuse an Agent but cannot replace its key after external changes",
  {
    skip: selected
      ? false
      : "set OCC_TEST_LOCAL_FIRST_AGENT_REAL=1 to run against a disposable local Kubernetes installation",
    timeout:
      2 * commandTimeout +
      refusalTimeout +
      stackLifecycleTimeout +
      2 * nativeFirstAgentProofTimeout +
      17 * 60_000,
  },
  async (context) => {
    assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for the first invocation");
    const stack = await localFirstAgentStack(context);
    const stateDirectory = stack.directory;
    assert.ok(
      stateDirectory && isAbsolute(stateDirectory),
      "The selected or provisioned local Kubernetes installation must have an absolute state directory",
    );
    const state = await stat(stateDirectory);
    assert.ok(state.isDirectory(), "The local Kubernetes installation state must be a directory");
    const recorded = await readPrivateJson(
      join(stateDirectory, "state.json"),
      "the Local Setup state",
    );
    assert.ok(
      typeof recorded?.keyPath === "string" && isAbsolute(recorded.keyPath),
      "The Local Setup state must record an absolute administrator key path",
    );
    assert.ok(
      /^occ-dev-[a-z0-9][a-z0-9-]*$/.test(recorded.cluster ?? ""),
      "The Local Setup state must identify a disposable Kubernetes context",
    );
    const keyFile = await stat(recorded.keyPath);
    assert.ok(
      keyFile.isFile() && (keyFile.mode & 0o077) === 0,
      "The recorded Local Setup administrator key must be private",
    );
    const serviceKey = (
      await readPrivateJson(recorded.keyPath, "the Local Setup administrator key")
    )?.data?.key;
    assert.ok(
      typeof serviceKey === "string" && serviceKey.length > 0,
      "The recorded administrator service key is missing",
    );
    sensitiveValues.add(serviceKey);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const name = `first-agent-${suffix}`;
    const firstReply = `FIRST_AGENT_${suffix.toUpperCase()}_ONE`;
    const secondReply = `FIRST_AGENT_${suffix.toUpperCase()}_TWO`;
    const env = { ...stack.environment, OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes" };
    delete env.OPENAI_API_KEY_FILE;
    const promptFor = (reply) => `Reply with exactly ${reply} and no other text.`;

    // The unique Agent remains until the fixture or the owner destroys the selected disposable stack.
    const first = readResult(
      await runFirstAgent({ name, prompt: promptFor(firstReply), env, signal: context.signal }),
      firstReply,
    );

    const expectedModel = env.OPENCLAW_FIRST_AGENT_MODEL || "gpt-6-astra";
    assert.equal(
      first.model,
      `${selectedHarness === "codex" ? "codex" : "openai"}/${expectedModel}`,
    );
    if (selectedSandboxDriver === "openshell") {
      const kube = { stateDirectory, cluster: recorded.cluster, env };
      const deployments = await readKubernetesJson(
        kube,
        [
          "get",
          "deployments",
          "--all-namespaces",
          "--selector",
          `openclaw.dev/agent=${first.identity.agentId}`,
        ],
        "the Agent Gateway",
      );
      // Compute labels only the Pod template with its workload role, not the Deployment.
      const gateways = deployments.items.filter(
        (deployment) =>
          deployment.spec.template.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
      );
      assert.equal(gateways.length, 1);
      const gateway = gateways[0];
      const appServerUrl = gateway.spec.template.spec.containers[0].env.find(
        ({ name: variable }) => variable === "APP_SERVER_URL",
      )?.value;
      assert.match(
        appServerUrl ?? "",
        /^ws:\/\/[a-z0-9-]+--[a-z0-9-]+\.openshell\.localhost:8080\/$/,
      );
      const openShellNamespace =
        recorded.deploymentMode === "k3d" ? recorded.platformNamespace : "openshell-system";
      const openShellGateway = await readKubernetesJson(
        kube,
        ["get", "service", "openshell-gateway", "--namespace", openShellNamespace],
        "the OpenShell Gateway Service",
      );
      assert.deepEqual(gateway.spec.template.spec.hostAliases, [
        {
          ip: openShellGateway.spec.clusterIP,
          hostnames: [new URL(appServerUrl).hostname],
        },
      ]);
      const namespaces = await readKubernetesJson(
        kube,
        ["get", "namespaces", "--selector", `openclaw.dev/namespace=${first.namespaceId}`],
        "the Agent Namespace",
      );
      assert.equal(namespaces.items.length, 1);
      assert.equal(
        gateway.metadata.namespace,
        namespaces.items[0].metadata.name,
        "the dedicated Gateway must share the single-cluster tenant namespace",
      );
      const services = await readKubernetesJson(
        kube,
        [
          "get",
          "services",
          "--namespace",
          namespaces.items[0].metadata.name,
          "--selector",
          `openclaw.dev/agent=${first.identity.agentId}`,
        ],
        "the Agent Service",
      );
      // Both Services share the canonical tenant namespace. The Gateway serves
      // traffic, while OpenShell's advertised endpoint keeps the direct Harness
      // Service parked so it cannot bypass the provider's authenticated route.
      assert.equal(services.items.length, 2);
      const gatewayService = services.items.find(
        (service) => service.spec.selector["openclaw.dev/workload-role"] === "gateway",
      );
      const harnessService = services.items.find(
        (service) => service.spec.selector["openclaw.dev/workload-role"] === "agent",
      );
      assert.ok(gatewayService, "the Agent must retain its serving Gateway Service");
      assert.ok(harnessService, "the direct Harness Service must remain parked");
      assert.deepEqual(gatewayService.spec.selector, {
        "openclaw.dev/namespace": first.namespaceId,
        "openclaw.dev/agent": first.identity.agentId,
        "openclaw.dev/workload-role": "gateway",
        "app.kubernetes.io/name": gateway.spec.template.metadata.labels["app.kubernetes.io/name"],
      });
      assert.equal(harnessService.spec.selector["openclaw.dev/namespace"], first.namespaceId);
      assert.equal(harnessService.spec.selector["openclaw.dev/agent"], first.identity.agentId);
      assert.equal(
        harnessService.spec.selector["openclaw.dev/revision"],
        first.identity.revisionId,
      );
      assert.match(harnessService.spec.selector["app.kubernetes.io/name"], /-inactive$/);
    }
    const reuseEnv = { ...env };
    delete reuseEnv.OPENCLAW_FIRST_AGENT_MODEL;
    delete reuseEnv.OPENAI_API_KEY;
    delete reuseEnv.OPENAI_API_KEY_FILE;
    const second = readResult(
      await runFirstAgent({
        name,
        prompt: promptFor(secondReply),
        env: reuseEnv,
        signal: context.signal,
      }),
      secondReply,
    );

    assert.deepEqual(
      second.identity,
      first.identity,
      "Reusing the name must preserve the Agent ID and active revision",
    );
    assert.equal(
      second.model,
      first.model,
      "A repeat without an override must reuse the recorded model",
    );
    const refusedModel = await runFirstAgent({
      name,
      env: { ...reuseEnv, OPENCLAW_FIRST_AGENT_MODEL: "gpt-test-conflicting-selection" },
      allowFailure: true,
      signal: context.signal,
      timeout: refusalTimeout,
    });
    assert.notEqual(refusedModel.exitCode, 0);
    assert.match(
      `${refusedModel.stdout}\n${refusedModel.stderr}`,
      /recorded Namespace or model differs/,
    );
    assert.notEqual(
      second.proofNonce,
      first.proofNonce,
      "Each invocation must verify a fresh model response",
    );
    assert.ok(
      first.origin === second.origin && first.namespaceId === second.namespaceId,
      "Both invocations must use the same local controller and Namespace",
    );

    const base = `/namespaces/${first.namespaceId}`;
    const agentPath = `${base}/agents/${first.identity.agentId}`;
    const agent = await requestLocalApi(first.origin, serviceKey, "GET", agentPath);
    assert.ok(
      /^cfg_[A-Za-z0-9_-]+$/.test(agent.configurationId ?? ""),
      "The public Agent must expose its Configuration",
    );
    let secretId;
    if (selectedSandboxDriver === "openshell") {
      assert.match(agent.harnessAuth?.sourceId ?? "", /^cs_[A-Za-z0-9_-]+$/);
      assert.equal(agent.harnessAuth?.method, "credential_source");
      const source = await requestLocalApi(
        first.origin,
        serviceKey,
        "GET",
        `${base}/credential-sources/${agent.harnessAuth.sourceId}`,
      );
      assert.equal(source.type, "openai");
      assert.equal(source.state, "ready");
      assert.equal(source.secrets.api_key?.kind, "secret");
      assert.equal(source.secrets.api_key?.namespaceId, first.namespaceId);
      secretId = source.secrets.api_key?.id;

      await context.test(
        "guided native OpenClaw redeployment resumes the same session with retained files and required-worker execution",
        { timeout: 16 * 60_000 + 2 * nativeFirstAgentProofTimeout + 30_000 },
        async (nativeContext) => {
          const request = (method, path, body) =>
            requestLocalApi(first.origin, serviceKey, method, path, body);
          const configuration = createHarnessConfiguration("openclaw", expectedModel);
          const installation = await request("GET", "/installation");
          assert.equal(installation.capabilities?.nativeWorkers?.support, "pinned-runtime");
          assert.ok(
            installation.capabilities?.credentialSources?.types.some(
              ({ type }) => type === source.type,
            ),
          );
          // Use the same ready model Source, then let the regular Console API
          // create its Configuration, Agent, grants, transport and first revision.
          const submitted = await request("POST", `${base}/agents/provision`, {
            requestId: `req_${randomUUID()}`,
            name: `first-agent-native-${suffix}`,
            executionMode: "dedicated",
            harnessAuth: { method: "credential_source", sourceId: source.id },
            configuration: {
              kind: "agent",
              values: {
                ...configuration,
                tools: { allow: ["exec"] },
              },
            },
            initialWorkspaceFiles: { ...WORKSPACE_DEFAULTS },
            workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
          });
          const deadline = Date.now() + 8 * 60_000;
          let provisioned;
          let deployment;
          let nativeAgent;
          while (Date.now() < deadline) {
            nativeContext.signal.throwIfAborted();
            provisioned = await request("GET", submitted.provisioning.url);
            assert.notEqual(
              provisioned.status,
              "failed",
              "Guided native provisioning must succeed",
            );
            if (provisioned.status === "succeeded") {
              assert.ok(provisioned.agentId && provisioned.revisionId);
              const nativePath = `${base}/agents/${provisioned.agentId}`;
              deployment = await request(
                "GET",
                `${nativePath}/deployments/${provisioned.revisionId}`,
              );
              assert.notEqual(
                deployment.status,
                "failed",
                "The admitted native revision must become ready",
              );
              nativeAgent = await request("GET", nativePath);
              if (
                deployment.status === "succeeded" &&
                nativeAgent.activeRevisionId === provisioned.revisionId
              ) {
                break;
              }
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))),
            );
          }
          assert.equal(provisioned?.status, "succeeded");
          assert.equal(deployment?.status, "succeeded");
          assert.equal(nativeAgent?.activeRevisionId, provisioned.revisionId);
          assert.equal(nativeAgent.executionMode, "dedicated");
          assert.deepEqual(nativeAgent.harnessAuth, {
            method: "credential_source",
            sourceId: source.id,
          });
          assert.deepEqual(nativeAgent.credentialSources, [{ sourceId: source.id }]);
          const nativePath = `${base}/agents/${nativeAgent.id}`;
          const revision = await request(
            "GET",
            `${nativePath}/revisions/${provisioned.revisionId}`,
          );
          assert.equal(revision.harness.id, "openclaw");
          assert.equal(revision.harness.mode, "dedicated");
          const access = await request("GET", `${base}/iam/access-bindings`);
          assert.ok(
            access.some(
              (binding) =>
                binding.subjectId === nativeAgent.servicePrincipalId &&
                binding.resourceKind === "credential_source" &&
                binding.resourceId === source.id,
            ),
          );
          assert.equal(
            access.some(
              (binding) =>
                binding.subjectId === nativeAgent.servicePrincipalId &&
                binding.resourceKind === "secret",
            ),
            false,
            "The native Agent must not gain underlying Secret access",
          );
          // Reading through the real Console workspace route proves private setup
          // bytes are usable by the enrolled worker, not merely accepted at admission.
          for (const [filename, content] of Object.entries(WORKSPACE_DEFAULTS)) {
            const file = await request("GET", `${nativePath}/workspace/files/${filename}`);
            assert.equal(file.name, filename);
            assert.equal(file.content, content);
          }
          // Change owner-maintained bytes after setup: a replacement must reuse
          // the workspace rather than silently restoring the initial templates.
          const retainedMarker = `NATIVE_RETAINED_WORKSPACE_${randomUUID()}`;
          const retainedFiles = {
            ...WORKSPACE_DEFAULTS,
            "USER.md": `${WORKSPACE_DEFAULTS["USER.md"]}\n<!-- ${retainedMarker} -->\n`,
          };
          await request("PUT", `${nativePath}/workspace/files/USER.md`, {
            content: retainedFiles["USER.md"],
          });
          const workspaceRoot = revision.configuration.agents.defaults.workspace;
          assert.ok(workspaceRoot?.startsWith("/"));
          const workspaceFile = {
            path: join(workspaceRoot, "USER.md"),
            content: retainedFiles["USER.md"],
          };
          const proofOptions = {
            stateDirectory,
            state: recorded,
            environment: env,
            namespaceId: first.namespaceId,
            agentId: nativeAgent.id,
            workspaceFile,
          };
          const kube = { stateDirectory, cluster: recorded.cluster, env };
          const readProviderRevision = async (revisionId) => {
            const pods = await readKubernetesJson(
              kube,
              [
                "get",
                "pods",
                "--all-namespaces",
                "--selector",
                `openclaw.dev/agent=${nativeAgent.id},openclaw.dev/revision=${revisionId},openclaw.dev/workload-role=agent`,
              ],
              "the native OpenShell Harness",
            );
            assert.equal(pods.items.length, 1);
            const pod = pods.items[0];
            assert.ok(pod.metadata.uid);
            assert.ok(
              pod.status.conditions.some(
                ({ type, status }) => type === "Ready" && status === "True",
              ),
            );
            assert.equal(pod.metadata.labels["openclaw.dev/network-profile"], "provider-fenced-v1");
            const owner = pod.metadata.ownerReferences.find(({ kind }) => kind === "Sandbox");
            assert.ok(owner?.name && owner.uid, "OpenShell must own the native Harness Pod");
            const sandbox = await readKubernetesJson(
              kube,
              [
                "get",
                "sandboxes.agents.x-k8s.io",
                owner.name,
                "--namespace",
                pod.metadata.namespace,
              ],
              "the native Harness's provider-owned Sandbox",
            );
            assert.equal(sandbox.metadata.uid, owner.uid);
            const container = pod.spec.containers.find(({ name }) => name === "agent");
            assert.ok(container, "The Sandbox must contain its native Harness");
            const mount = container.volumeMounts.find(
              ({ mountPath }) => mountPath === workspaceRoot,
            );
            assert.ok(
              mount?.subPath,
              "The native workspace must use an exact Agent storage subpath",
            );
            assert.notEqual(mount.readOnly, true);
            const volume = pod.spec.volumes.find(({ name }) => name === mount.name);
            assert.ok(volume?.persistentVolumeClaim?.claimName);
            const workspaceStorage = {
              claimName: volume.persistentVolumeClaim.claimName,
              subPath: mount.subPath,
            };
            return { pod, sandbox, workspaceStorage };
          };
          const initialProvider = await readProviderRevision(provisioned.revisionId);
          const firstNativeProof = await assertNativeWorkerProofInController(
            nativeContext,
            proofOptions,
          );
          assert.equal(
            firstNativeProof.hostname,
            initialProvider.pod.spec.hostname ?? initialProvider.pod.metadata.name,
            "The initial native model turn and exec must run in the first revision's Harness Pod",
          );

          // A new revision replaces the provider-owned workload while retaining
          // Agent storage.
          const replacement = await request("POST", `${nativePath}/deploy`);
          assert.notEqual(replacement.id, provisioned.revisionId);
          assert.equal(replacement.harness.id, "openclaw");
          assert.equal(replacement.harness.mode, "dedicated");
          const replacementDeadline = Date.now() + 8 * 60_000;
          let replacementDeployment;
          let replacementAgent;
          while (Date.now() < replacementDeadline) {
            nativeContext.signal.throwIfAborted();
            replacementDeployment = await request(
              "GET",
              `${nativePath}/deployments/${replacement.id}`,
            );
            assert.notEqual(
              replacementDeployment.status,
              "failed",
              "Redeployment with the retained native workspace must succeed",
            );
            replacementAgent = await request("GET", nativePath);
            if (
              replacementDeployment.status === "succeeded" &&
              replacementAgent.activeRevisionId === replacement.id
            ) {
              break;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(2_000, Math.max(1, replacementDeadline - Date.now()))),
            );
          }
          assert.equal(replacementDeployment?.status, "succeeded");
          assert.equal(replacementAgent?.activeRevisionId, replacement.id);
          const replacementProvider = await readProviderRevision(replacement.id);
          assert.notEqual(replacementProvider.pod.metadata.uid, initialProvider.pod.metadata.uid);
          assert.notEqual(
            replacementProvider.sandbox.metadata.uid,
            initialProvider.sandbox.metadata.uid,
          );
          assert.deepEqual(replacementProvider.workspaceStorage, initialProvider.workspaceStorage);
          for (const [filename, content] of Object.entries(retainedFiles)) {
            const file = await request("GET", `${nativePath}/workspace/files/${filename}`);
            assert.equal(file.name, filename);
            assert.equal(file.content, content, `Redeployment must preserve ${filename}`);
          }
          const replacementNativeProof = await assertNativeWorkerProofInController(nativeContext, {
            ...proofOptions,
            session: firstNativeProof.session,
            sessionFile: firstNativeProof.sessionFile,
          });
          assert.equal(
            replacementNativeProof.hostname,
            replacementProvider.pod.spec.hostname ?? replacementProvider.pod.metadata.name,
            "The replacement native model turn and exec must run in the new revision's Harness Pod",
          );
          assert.equal(replacementNativeProof.profileId, firstNativeProof.profileId);
          assert.equal(replacementNativeProof.providerId, firstNativeProof.providerId);
          assert.deepEqual(
            replacementNativeProof.session,
            firstNativeProof.session,
            "The replacement must resume the exact native session created before redeployment",
          );
          assert.deepEqual(
            replacementNativeProof.sessionFile,
            firstNativeProof.sessionFile,
            "The resumed exec must read the relative file written before redeployment",
          );
        },
      );
      const bindings = await requestLocalApi(
        first.origin,
        serviceKey,
        "GET",
        `${base}/iam/access-bindings`,
      );
      assert.ok(
        bindings.some(
          (binding) =>
            binding.subjectId === agent.servicePrincipalId &&
            binding.resourceKind === "credential_source" &&
            binding.resourceId === source.id,
        ),
        "The Agent must receive exact CredentialSource access.",
      );
      assert.equal(
        bindings.some(
          (binding) =>
            binding.subjectId === agent.servicePrincipalId && binding.resourceKind === "secret",
        ),
        false,
        "The OpenShell Agent must not receive Secret access.",
      );
    } else {
      secretId = agent.harnessAuth?.source?.id;
      assert.ok(
        agent.harnessAuth?.method === "api_key" &&
          agent.harnessAuth.source?.kind === "secret" &&
          agent.harnessAuth.source?.namespaceId === first.namespaceId,
        "The public Agent must reference an exact Secret in its Namespace",
      );
    }
    assert.match(secretId ?? "", /^sec_[A-Za-z0-9_-]+$/);
    const secretLookup = {
      stateDirectory,
      cluster: recorded.cluster,
      env: stack.environment,
      namespaceId: first.namespaceId,
      secretId,
    };
    const originalSecretVersion = await readSecretResourceVersion(secretLookup);
    const configurationPath = `${base}/configurations/${agent.configurationId}`;
    const original = await requestLocalApi(first.origin, serviceKey, "GET", configurationPath);
    assert.equal(original.values.agents.defaults.model, first.model);
    assert.deepEqual(
      original.values.models.providers[selectedHarness === "codex" ? "codex" : "openai"].models,
      [{ id: expectedModel, name: expectedModel }],
    );
    assert.ok(
      Number.isInteger(original.generation),
      "The public Configuration must expose its generation",
    );
    assert.ok(
      original.values?.tools?.deny?.includes("*"),
      "The native Configuration must deny tools before the regression check",
    );
    try {
      const changed = await requestLocalApi(first.origin, serviceKey, "PATCH", configurationPath, {
        values: {
          ...original.values,
          tools: { allow: ["*"] },
        },
      });
      assert.equal(changed.id, original.id, "The edit must preserve the Configuration ID");
      assert.equal(
        changed.generation,
        original.generation + 1,
        "The public edit must advance the Configuration generation",
      );

      const replacementKey = "first-agent-replacement-should-not-be-written";
      sensitiveValues.add(replacementKey);
      const refused = await runFirstAgent({
        name,
        replaceKey: true,
        allowFailure: true,
        forbiddenOutput: replacementKey,
        env: { ...reuseEnv, OPENAI_API_KEY: replacementKey },
        signal: context.signal,
        timeout: refusalTimeout,
      });
      const refusedSecretVersion = await readSecretResourceVersion(secretLookup);
      assert.equal(
        refusedSecretVersion,
        originalSecretVersion,
        "A refused key replacement must not mutate the exact Kubernetes Secret",
      );
      assert.notEqual(
        refused.exitCode,
        0,
        "An externally changed Configuration must block key replacement",
      );
      assert.match(
        `${refused.stdout}\n${refused.stderr}`,
        /Configuration was changed outside this helper/,
      );
      assert.equal(
        refused.containedForbiddenOutput,
        false,
        "The replacement value must not be printed",
      );
      const unchanged = await requestLocalApi(first.origin, serviceKey, "GET", agentPath);
      assert.equal(
        unchanged.activeRevisionId,
        first.identity.revisionId,
        "A refused key replacement must leave the active revision unchanged",
      );
    } finally {
      await requestLocalApi(first.origin, serviceKey, "PATCH", configurationPath, {
        values: original.values,
      });
    }
  },
);
