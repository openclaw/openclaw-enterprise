import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { redactFailure } from "../../scripts/ci/failure-redaction.mjs";
import { selectFirstAgentModel, verifyFirstAgentModel } from "../../scripts/first-agent-model.mjs";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  assertNativeWorkNotFailed,
  assertNativeWorkerProofInController,
  failNativeProvisioningDeadline,
  nativeFirstAgentProofTimeout,
  nativeProvisioningPath,
  runtimeLogSources,
  waitForNativeRedeploy,
} from "../helpers/local-first-agent-native.mjs";
import { localFirstAgentStack } from "../helpers/local-first-agent-stack.mjs";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { availablePort } from "../helpers/available-port.mjs";
import { stopProcess } from "../helpers/stop-process.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const firstAgentScript = fileURLToPath(new URL("../../scripts/first-agent.mjs", import.meta.url));
const selected = process.env.OCC_TEST_LOCAL_FIRST_AGENT_REAL === "1";
const selectedHarness = process.env.OCC_TEST_LOCAL_FIRST_AGENT_HARNESS ?? "openclaw";
assert.match(selectedHarness, /^(?:openclaw|codex)$/);
const selectedSandboxDriver = process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER ?? "none";
assert.match(selectedSandboxDriver, /^(?:none|openshell)$/);
const selectedControlUi = process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_UI === "1";
if (selectedSandboxDriver === "openshell") {
  assert.equal(selectedHarness, "codex", "OpenShell first-Agent proof requires dedicated Codex.");
}
if (selectedControlUi) {
  assert.equal(selectedSandboxDriver, "openshell");
  assert.equal(process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE, "compose");
}
const execFileAsync = promisify(execFile);
const maxOutputLength = 32_768;
const commandTimeout = 30 * 60_000;
const refusalTimeout = 2 * 60_000;
const stackLifecycleTimeout = 25 * 60_000;
const credentialVariable =
  selectedSandboxDriver === "openshell" ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY";
const sensitiveValues = new Set(
  [process.env.OPENAI_API_KEY, process.env.CODEX_ACCESS_TOKEN].filter(Boolean),
);

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
  controlUi = selectedControlUi,
}) {
  const args = [firstAgentScript, name, "--harness", harness];
  if (controlUi) {
    args.push("--control-ui");
  }
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

function readResult({ stdout, stderr }, expectedReply, { apiOrigin, browserOrigin }) {
  const diagnostic = `First-Agent command output:\n${stdout}\n${stderr}`;
  const agent = /^Agent ID: (agt_[A-Za-z0-9_-]+)\r?$/m.exec(stdout);
  const revision = /^Revision: (rev_[A-Za-z0-9_-]+)\r?$/m.exec(stdout);
  const harness = /^Harness: (openclaw|codex)\r?$/m.exec(stdout);
  const model = /^Model: ((?:openai|codex)\/[A-Za-z0-9._-]+)\r?$/m.exec(stdout);
  const proof = /^Model response verified: (FIRST_AGENT_[A-Fa-f0-9-]+)\r?$/m.exec(stdout);
  const consoleLine = /^Console: ([^\r\n]+)\r?$/m.exec(stdout);
  const controlUiLine = /^Control UI: ([^\r\n]+)\r?$/m.exec(stdout);
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
  assert.equal(consoleUrl.origin, browserOrigin ?? apiOrigin);
  assert.equal(consoleUrl.protocol, browserOrigin === undefined ? "http:" : "https:");
  assert.ok(!consoleUrl.username && !consoleUrl.password && !consoleUrl.hash);
  assert.ok(
    consoleUrl.pathname === `/console/agents/${agent[1]}`,
    "The Console URL must identify the returned Agent",
  );
  const namespaces = consoleUrl.searchParams.getAll("namespace");
  assert.ok(
    namespaces.length === 1 && /^ns_[A-Za-z0-9_-]+$/.test(namespaces[0]),
    "The Console URL must identify one Namespace",
  );
  let controlUiOrigin;
  if (selectedControlUi) {
    assert.ok(controlUiLine, `Missing Control UI URL.\n${diagnostic}`);
    controlUiOrigin = new URL(controlUiLine[1]).origin;
    assert.equal(new URL(controlUiLine[1]).pathname, "/");
    assert.equal(new URL(controlUiOrigin).protocol, "https:");
  } else {
    assert.equal(controlUiLine, null, `Unexpected Control UI URL.\n${diagnostic}`);
  }
  return {
    identity: { agentId: agent[1], revisionId: revision[1] },
    proofNonce: proof[1],
    model: model[1],
    origin: apiOrigin,
    controlUiOrigin,
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

async function readKubernetes({ stateDirectory, cluster, env }, args, label, output, signal) {
  const environment = { ...env };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_API_KEY_FILE;
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.CODEX_ACCESS_TOKEN_FILE;
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
        output,
      ],
      { env: environment, timeout: 20_000, signal, maxBuffer: 1024 * 1024 },
    );
    return output === "json" ? JSON.parse(stdout) : stdout;
  } catch {
    throw new Error(`Could not read ${label} in the local Kubernetes context.`);
  }
}

function readKubernetesJson(kube, args, label) {
  return readKubernetes(kube, args, label, "json");
}

function nativeAgentPodSelector(agentId, revisionId) {
  return `openclaw.dev/agent=${agentId},openclaw.dev/revision=${revisionId},openclaw.dev/workload-role=agent`;
}

// Project only the fields needed to join the agent imageID to the model probe's log stream.
function readNativeProbePod(kube, { namespaceId, agentId, revisionId }, signal) {
  const selector = `${nativeAgentPodSelector(agentId, revisionId)},openclaw.dev/namespace=${namespaceId}`;
  return readKubernetes(
    kube,
    ["get", "pods", "--all-namespaces", "--selector", selector],
    "the native model probe's Harness Pod",
    'jsonpath={range .items[*]}{.metadata.name} {.metadata.uid} {range .status.containerStatuses[?(@.name=="agent")]}{.restartCount} {.imageID}{end}{"\\n"}{end}',
    signal,
  );
}

async function readSecretResourceVersion({ stateDirectory, cluster, env, namespaceId, secretId }) {
  const environment = { ...env };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_API_KEY_FILE;
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.CODEX_ACCESS_TOKEN_FILE;
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

async function requestLocalApi(
  origin,
  serviceKey,
  method,
  path,
  body,
  signal = AbortSignal.timeout(20_000),
) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal,
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

test("native terminal failures report only fixed failure codes", async (t) => {
  const namespaceId = `ns_${randomUUID()}`;
  const agentId = `agt_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  const provisioningPath = `/namespaces/${namespaceId}/agents/provision/work`;
  const deploymentPath = `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`;
  const logPath = `${deploymentPath}/runtime/logs?source=agent&tailLines=1000`;
  const expectation = "Guided native provisioning must succeed";
  const failure = (code) => ({ code, message: "private-sentinel" });
  const handoff = {
    workId: "work",
    url: provisioningPath,
    phase: "handoff",
    status: "failed",
    attemptCount: 1,
    agentId,
    configurationId: "private-sentinel",
    revisionId,
    error: failure("RUNTIME_AUTHENTICATION_FAILED"),
  };
  const deployment = {
    namespaceId,
    agentId,
    deploymentId: revisionId,
    status: "failed",
    progress: null,
    error: failure("RUNTIME_AUTHENTICATION_FAILED"),
  };
  const probeStream = {
    source: "agent",
    container: "agent",
    pod: "native-agent",
    podUid: randomUUID(),
    restartCount: 0,
  };
  const probeLog = (fields) =>
    sanitizeRuntimeLogChunk({
      stream: probeStream,
      lines: [
        { raw: JSON.stringify({ event: "openclaw.model_probe", elapsedMs: 5, ...fields }) },
        { raw: "private-sentinel" },
      ],
      truncated: false,
    }).records;
  const page = (records) => ({ revisionId, source: "agent", stream: probeStream, records });

  function reportedFailure(message) {
    assert.doesNotMatch(message, /sentinel|ns_|agt_|rev_/i);
    const [, category, json] = message.match(/: (\S+) (\{.*\})$/) ?? [];
    assert.ok(json, message);
    const observation = JSON.parse(json);
    // The CI result can clip the assertion even after the runtime log was sanitized.
    if (typeof observation.modelProbe === "object") {
      const { message: retained } = redactFailure({ message }, [], repoRoot);
      assert.ok(retained.includes(category), retained);
      for (const [key, value] of Object.entries(observation.modelProbe)) {
        assert.ok(retained.includes(`"${key}":${JSON.stringify(value)}`), retained);
      }
      if (typeof observation.probePodImage === "object") {
        assert.ok(retained.includes(JSON.stringify(observation.probePodImage)), retained);
      }
      if (observation.modelProbe.providerStatus === 401) {
        assert.match(retained, /"credentialAttachment":"not observed"/);
      }
    }
    return { category, ...observation };
  }

  async function observe(response, provisioned, responses, expectedPaths, readProbePod) {
    const calls = [];
    const request = async (method, path, body, signal) => {
      calls.push({ method, path, body, signal });
      return responses[calls.length - 1];
    };
    let message;
    const signal = AbortSignal.timeout(30_000);
    await assert.rejects(
      assertNativeWorkNotFailed(response, expectation, {
        request,
        namespaceId,
        provisioningPath,
        provisioned,
        readProbePod,
        signal,
      }),
      (error) => {
        assert.equal(error.name, "AssertionError");
        message = error.message;
        return true;
      },
    );
    assert.deepEqual(
      calls.map(({ path }) => path),
      expectedPaths,
    );
    for (const call of calls) {
      assert.ok(call.signal instanceof AbortSignal && call.signal !== signal);
      assert.equal(call.signal, calls[0].signal, "all reads must share one diagnostic budget");
      assert.equal(call.method, "GET");
      assert.equal(call.body, undefined);
    }
    return reportedFailure(message);
  }

  await t.test("name the held failure and its provider response", async () => {
    const provider = {
      providerStatus: 401,
      providerCode: "invalid_api_key",
      responseHeaderMarker: "provider-like",
      bodyShape: "json-error-code",
      providerErrorCode: "invalid_api_key",
      providerErrorType: "invalid_request_error",
    };
    const records = probeLog({ code: "AUTHENTICATION_FAILED", ...provider });
    // The provider fields reach the assertion's input through the production sanitizer.
    for (const [name, value] of Object.entries(provider)) {
      assert.equal(records[0]?.fields?.[name], value, name);
    }
    const observed = await observe(
      handoff,
      handoff,
      [deployment, page(records)],
      [deploymentPath, logPath],
    );
    assert.deepEqual(observed, {
      category: "RUNTIME_AUTHENTICATION_FAILED",
      provisioning: {
        status: "failed",
        phase: "handoff",
        attemptCount: 1,
        agentIdPresent: true,
        configurationIdPresent: true,
        revisionIdPresent: true,
        errorCode: "RUNTIME_AUTHENTICATION_FAILED",
      },
      deployment: {
        status: "failed",
        errorCode: "RUNTIME_AUTHENTICATION_FAILED",
        lastAttemptCode: "none",
      },
      modelProbe: { probes: 1, code: "AUTHENTICATION_FAILED", ...provider },
      credentialAttachment: "not observed",
    });

    const { pod, podUid } = records[0].stream;
    const digest = `sha256:${"a".repeat(64)}`;
    const row = `${pod} ${podUid} 0 private-sentinel@${digest}`;
    const imageFor = async (result, lines = records) => {
      const failure = await observe(
        handoff,
        handoff,
        [deployment, page(lines)],
        [deploymentPath, logPath],
        async () => {
          if (result === undefined) {
            throw new Error("private-sentinel");
          }
          return result;
        },
      );
      assert.equal(failure.modelProbe.providerStatus, 401);
      return failure.probePodImage;
    };
    assert.deepEqual(await imageFor(row), { digest, podUid });
    for (const other of [
      row.replace(podUid, randomUUID()),
      row.replace(" 0 ", " 1 "),
      `${row}\n${row}`,
      row.slice(0, -1),
      undefined,
    ]) {
      assert.equal(await imageFor(other), "unavailable");
    }
    const gap = { type: "gap", reason: "stream_replaced", stream: probeStream };
    assert.equal(await imageFor(row, [gap, ...records]), "unavailable");

    // A later READY keeps the observed 401, and the image can belong only to that 401.
    const ready = probeLog({ code: "READY" });
    const recovered = await observe(
      handoff,
      handoff,
      [deployment, page([...records, ...ready])],
      [deploymentPath, logPath],
      async () => row,
    );
    assert.deepEqual(recovered.modelProbe, {
      probes: 2,
      code: "AUTHENTICATION_FAILED",
      ...provider,
    });
    assert.deepEqual(recovered.probePodImage, { digest, podUid });

    // A success-only, ambiguous, mismatched or mixed-stream page reads no Pod.
    // The diagnostic catch would swallow a throw here, so count reads instead.
    let podReads = 0;
    const noPodRead = async () => {
      podReads += 1;
      return row;
    };
    const otherStream = { ...probeStream, podUid: randomUUID() };
    const mixed = [...records, ...ready.map((record) => ({ ...record, stream: otherStream }))];
    const unattributed = [
      [deployment, ready],
      [deployment, [...records, ...records]],
      [deployment, mixed],
      [
        { ...deployment, error: failure("RUNTIME_MODEL_PROBE_FAILED") },
        probeLog({ code: "AUTHENTICATION_FAILED", ...provider }),
      ],
    ];
    for (const [current, lines] of unattributed) {
      const { probePodImage } = await observe(
        handoff,
        handoff,
        [current, page(lines)],
        [deploymentPath, logPath],
        noPodRead,
      );
      assert.equal(probePodImage, "unavailable");
    }
    assert.equal(podReads, 0);
  });

  await t.test("print other for values outside the fixed vocabularies", async () => {
    const records = probeLog({
      code: "PRIVATE_SENTINEL",
      providerStatus: 200,
      providerCode: "private-sentinel",
      responseHeaderMarker: "private-sentinel-source",
      bodyShape: "private-sentinel-shape",
      providerErrorCode: "private-sentinel-code",
      providerErrorType: "private-sentinel-type",
    });
    assert.equal(records[0]?.fields?.providerCode, "private-sentinel");
    assert.equal(records[0]?.fields?.responseHeaderMarker, "private-sentinel-source");
    assert.equal(records[0]?.fields?.bodyShape, "private-sentinel-shape");
    assert.equal(records[0]?.fields?.providerErrorCode, "private-sentinel-code");
    assert.equal(records[0]?.fields?.providerErrorType, "private-sentinel-type");
    const failed = { ...deployment, error: failure("RUNTIME_MODEL_PROBE_FAILED") };
    const observed = await observe(
      failed,
      { ...handoff, status: "succeeded", error: undefined },
      [failed, page([...records, ...probeLog({ providerStatus: "401 private-sentinel" })])],
      [deploymentPath, logPath],
    );
    assert.equal(observed.category, "RUNTIME_MODEL_PROBE_FAILED");
    assert.equal(observed.provisioning.errorCode, "none");
    assert.deepEqual(observed.modelProbe, {
      probes: 2,
      code: "none",
      providerStatus: "other",
      providerCode: "none",
      responseHeaderMarker: "absent",
      bodyShape: "absent",
      providerErrorCode: "absent",
      providerErrorType: "absent",
    });
    const single = await observe(
      failed,
      handoff,
      [failed, page(records)],
      [deploymentPath, logPath],
    );
    assert.deepEqual(single.modelProbe, {
      probes: 1,
      code: "other",
      providerStatus: "other",
      providerCode: "other",
      responseHeaderMarker: "other",
      bodyShape: "other",
      providerErrorCode: "other",
      providerErrorType: "other",
    });
    for (const providerStatus of [399, 401.5, 600]) {
      const statusPage = page(probeLog({ providerStatus }));
      const { modelProbe } = await observe(
        failed,
        handoff,
        [failed, statusPage],
        [deploymentPath, logPath],
      );
      assert.equal(modelProbe.providerStatus, "other");
    }
  });

  await t.test("read no provider response without a held model-check failure", async () => {
    const unknown = { ...handoff, error: failure("RUNTIME_PRIVATE_SENTINEL") };
    const pending = {
      ...deployment,
      status: "running",
      error: null,
      progress: { lastAttempt: { code: "PRIVATE_SENTINEL", message: "private-sentinel" } },
    };
    const observed = await observe(unknown, unknown, [pending], [deploymentPath]);
    assert.equal(observed.category, "unrecognized");
    assert.equal(observed.provisioning.errorCode, "unrecognized");
    assert.deepEqual(observed.deployment, {
      status: "running",
      errorCode: "none",
      lastAttemptCode: "unknown",
    });
    assert.equal(observed.modelProbe, undefined);
    const starved = { ...deployment, error: failure("RUNTIME_CPU_STARVED") };
    const running = { ...deployment, status: "running" };
    for (const current of [starved, running]) {
      assert.equal(
        (await observe(handoff, handoff, [current], [deploymentPath])).modelProbe,
        undefined,
      );
    }
  });

  await t.test("bind every read to the exact revision", async () => {
    const wrongPage = { ...page(probeLog({ providerStatus: 401 })), revisionId: "another" };
    assert.equal(
      (await observe(handoff, handoff, [deployment, wrongPage], [deploymentPath, logPath]))
        .modelProbe,
      "unavailable",
    );
    const gatewayPage = { ...page(probeLog({ providerStatus: 401 })), source: "gateway" };
    assert.equal(
      (await observe(handoff, handoff, [deployment, gatewayPage], [deploymentPath, logPath]))
        .modelProbe,
      "unavailable",
    );
    // Runtime output that merely names the event is not the wrapper's model check.
    const echoed = { type: "line", kind: "openclaw", message: "openclaw.model_probe" };
    const unechoed = await observe(
      handoff,
      handoff,
      [deployment, page([{ ...echoed, fields: { providerStatus: 401 } }])],
      [deploymentPath, logPath],
    );
    assert.deepEqual(unechoed.modelProbe, {
      probes: 0,
      code: "none",
      providerStatus: "none",
      providerCode: "none",
      responseHeaderMarker: "absent",
      bodyShape: "absent",
      providerErrorCode: "absent",
      providerErrorType: "absent",
    });
    for (const other of [
      { ...deployment, deploymentId: "another-revision" },
      { ...deployment, agentId: `agt_${randomUUID()}` },
      { ...deployment, namespaceId: `ns_${randomUUID()}` },
    ]) {
      assert.equal(
        (await observe(handoff, handoff, [other], [deploymentPath])).deployment,
        "unavailable",
      );
    }
    const early = { ...handoff, phase: "configuration", agentId: undefined, revisionId: undefined };
    const observed = await observe(early, early, [], []);
    assert.equal(observed.deployment, undefined);
    assert.equal(observed.provisioning.phase, "configuration");
    const unbound = { ...handoff, revisionId: "private-sentinel" };
    assert.equal((await observe(unbound, unbound, [], [])).deployment, "unavailable");
  });

  await t.test("pass work that has not failed", async () => {
    for (const status of ["queued", "running", "succeeded"]) {
      await assertNativeWorkNotFailed({ status }, expectation);
    }
    await assert.rejects(assertNativeWorkNotFailed({ status: "failed" }, expectation), {
      name: "AssertionError",
      message: /^Guided native provisioning must succeed: unrecognized \{"provisioning":/,
    });
  });

  await t.test("name a failed redeploy's code and model check without peer text", async () => {
    const replacementId = `rev_${randomUUID()}`;
    const agentPath = `/namespaces/${namespaceId}/agents/${agentId}`;
    const replacementPath = `${agentPath}/deployments/${replacementId}`;
    const replacementLogPath = `${replacementPath}/runtime/logs?source=agent&tailLines=1000`;
    const failed = { ...deployment, deploymentId: replacementId };
    const replacementPage = (records) => ({ ...page(records), revisionId: replacementId });
    async function redeploy(responses, expectedPaths) {
      const calls = [];
      const request = async (method, path, body, signal) => {
        calls.push({ method, path, body, signal });
        return responses[calls.length - 1];
      };
      const signal = AbortSignal.timeout(30_000);
      const wait = waitForNativeRedeploy({
        request,
        namespaceId,
        agentId,
        revisionId: replacementId,
        signal,
      });
      let message;
      await assert.rejects(wait, (error) => {
        assert.equal(error.name, "AssertionError");
        message = error.message;
        return true;
      });
      assert.deepEqual(
        calls.map(({ path }) => path),
        expectedPaths,
      );
      for (const call of calls.slice(1)) {
        assert.ok(call.signal instanceof AbortSignal && call.signal !== signal);
      }
      return reportedFailure(message);
    }

    const provider = { providerStatus: 429, providerCode: "rate_limit_exceeded" };
    const records = probeLog({ code: "MODEL_PROBE_FAILED", ...provider });
    const probeFailed = { ...failed, error: failure("RUNTIME_MODEL_PROBE_FAILED") };
    assert.deepEqual(
      await redeploy(
        [probeFailed, replacementPage(records)],
        [replacementPath, replacementLogPath],
      ),
      {
        category: "RUNTIME_MODEL_PROBE_FAILED",
        deployment: {
          status: "failed",
          errorCode: "RUNTIME_MODEL_PROBE_FAILED",
          lastAttemptCode: "none",
        },
        // The full probe's provider summary names no responder.
        modelProbe: {
          probes: 1,
          code: "MODEL_PROBE_FAILED",
          ...provider,
          responseHeaderMarker: "absent",
          bodyShape: "absent",
          providerErrorCode: "absent",
          providerErrorType: "absent",
        },
      },
    );
    // Codes outside the closed vocabulary print as unrecognized, with no log read.
    const unknown = {
      ...failed,
      error: failure("RUNTIME_PRIVATE_SENTINEL"),
      progress: { lastAttempt: { code: "PRIVATE_SENTINEL", message: "private-sentinel" } },
    };
    assert.deepEqual(await redeploy([unknown], [replacementPath]), {
      category: "unrecognized",
      deployment: { status: "failed", errorCode: "unrecognized", lastAttemptCode: "unknown" },
    });
    // A different binding is rejected before status, diagnostics or an agent read.
    const otherBinding = {
      namespaceId: `ns_${randomUUID()}`,
      agentId: `agt_${randomUUID()}`,
      deploymentId: revisionId,
    };
    for (const [field, otherId] of Object.entries(otherBinding)) {
      for (const status of ["failed", "succeeded", "queued", "running"]) {
        const mismatched = {
          ...failed,
          [field]: otherId,
          status,
          error: status === "failed" ? failed.error : null,
        };
        const calls = [];
        await assert.rejects(
          waitForNativeRedeploy({
            request: async (method, path) => {
              calls.push(path);
              // Even an active replacement cannot legitimize the mismatched record.
              return calls.length === 1 ? mismatched : { activeRevisionId: replacementId };
            },
            namespaceId,
            agentId,
            revisionId: replacementId,
            signal: AbortSignal.timeout(30_000),
            timeoutMs: 100,
            pollMs: 1,
          }),
          {
            name: "AssertionError",
            message: "The native redeploy returned a mismatched deployment binding",
          },
          `${field} mismatch in a ${status} deployment must stop the poll`,
        );
        assert.deepEqual(calls, [replacementPath]);
      }
    }
    // Only the replacement revision's own log page is reported.
    const firstPage = page(probeLog({ providerStatus: 401 }));
    const stale = await redeploy([failed, firstPage], [replacementPath, replacementLogPath]);
    assert.equal(stale.modelProbe, "unavailable");

    // A redeploy returns once it succeeded and is active, without diagnostic reads.
    const ready = { ...failed, status: "succeeded", error: null };
    const calls = [];
    const responses = [
      { ...ready, status: "running" },
      { activeRevisionId: revisionId },
      ready,
      { activeRevisionId: revisionId },
      ready,
      { activeRevisionId: replacementId },
    ];
    const active = await waitForNativeRedeploy({
      request: async (method, path) => {
        calls.push(path);
        return responses[calls.length - 1];
      },
      namespaceId,
      agentId,
      revisionId: replacementId,
      signal: AbortSignal.timeout(30_000),
      pollMs: 1,
    });
    assert.deepEqual(active, { deployment: ready, agent: { activeRevisionId: replacementId } });
    assert.deepEqual(calls, [
      replacementPath,
      agentPath,
      replacementPath,
      agentPath,
      replacementPath,
      agentPath,
    ]);
  });
});

test("the missed native handoff deadline reports only Pod readiness and fixed runtime output for its exact revision", async (t) => {
  const namespaceId = `ns_${randomUUID()}`;
  const agentId = `agt_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  const provisioningPath = `/namespaces/${namespaceId}/agents/provision/work`;
  const deploymentPath = `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`;
  const provisioned = {
    workId: "work",
    url: provisioningPath,
    phase: "handoff",
    status: "queued",
    agentId,
    revisionId,
  };
  const deployment = {
    namespaceId,
    agentId,
    deploymentId: revisionId,
    status: "running",
    progress: { lastAttempt: { code: "REVISION_INCOMPLETE" } },
  };

  async function observe(responses, expectedPaths) {
    const calls = [];
    const request = async (method, path, body, signal) => {
      calls.push({ method, path, body, signal });
      return responses[calls.length - 1];
    };
    let observation;
    await assert.rejects(
      failNativeProvisioningDeadline({
        request,
        provisioned,
        namespaceId,
        provisioningPath,
        signal: AbortSignal.timeout(30_000),
      }),
      (error) => {
        const message = error.message;
        assert.doesNotMatch(message, /private-sentinel|ns_|agt_|rev_/);
        const [, json] = message.match(/did not become ready before the deadline: (.*)$/) ?? [];
        assert.ok(json);
        observation = JSON.parse(json);
        return true;
      },
    );
    const signal = calls[0]?.signal;
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(
      calls.map(({ path }) => path),
      expectedPaths,
    );
    for (const call of calls) {
      assert.equal(call.signal, signal, "all reads must share the original diagnostic budget");
      assert.equal(call.method, "GET");
      assert.equal(call.body, undefined);
    }
    return observation;
  }

  const gateway = { role: "gateway", phase: "Running", ready: false, name: "private-sentinel" };
  const agent = {
    role: "agent",
    phase: "Running",
    ready: true,
    events: [{ message: "private-sentinel" }],
  };
  const logPaths = runtimeLogSources.map(
    (source) => `${deploymentPath}/runtime/logs?source=${source}&tailLines=1000`,
  );
  const runtimePaths = [deploymentPath, `${deploymentPath}/runtime`];
  const readyPods = [{ ...gateway, ready: true }, agent];
  const readyRuntime = { revisionId, pods: readyPods };
  const pendingPaths = [...runtimePaths, ...logPaths];

  await t.test("count known events without publishing values retained by the log API", async () => {
    const phase = "private-sentinel-phase";
    const event = "runtime.startup_phase";
    const raw = JSON.stringify({ event, phase, code: "SYNTHETIC_SENTINEL", ms: 987654 });
    const { records } = sanitizeRuntimeLogChunk({
      stream: { source: "agent", container: "agent" },
      lines: [{ raw, time: "2026-01-02T03:04:05Z" }],
      truncated: false,
    });
    // Prove that the marker reaches the assertion's input through the production sanitizer.
    assert.equal(records[0]?.fields?.phase, phase);
    const sandbox = ["DENIED", "ALLOWED", "SENTINEL"].map((action) => ({
      type: "line",
      kind: "sandbox",
      message: "private-sentinel",
      fields: { action, rule_type: "private-sentinel" },
    }));
    const logged = await observe(
      [
        deployment,
        readyRuntime,
        { revisionId, source: "agent", records },
        { revisionId, source: "sandbox", records: sandbox },
        { revisionId: "another-revision", source: "gateway", records },
      ],
      pendingPaths,
    );
    assert.deepEqual(logged.runtimeOutput, {
      agent: { records: 1, events: { [event]: 1 }, decisions: {} },
      sandbox: { records: 3, events: {}, decisions: { DENIED: 1, ALLOWED: 1, other: 1 } },
      gateway: "unavailable",
    });
  });

  await t.test("request no log pages without exactly one ready Pod per role", async () => {
    for (const pods of [
      undefined,
      [],
      [gateway],
      [gateway, agent],
      [readyPods[0], { ...agent, role: "private-sentinel" }],
      [{ ...gateway, phase: "private-sentinel" }, agent],
      [readyPods[0], { ...agent, ready: false }],
      [readyPods[0], readyPods[0], agent],
      [...readyPods, agent],
    ]) {
      const observed = await observe([deployment, { revisionId, pods }], runtimePaths);
      assert.equal(observed.runtimeOutput, undefined);
      if (pods?.length === 1) {
        assert.deepEqual(observed.runtimeAfterDeadline, {
          gateway: { count: "one", phase: "Running", ready: false },
          agent: { count: "zero" },
        });
      }
    }
    const observed = await observe(
      [deployment, { ...readyRuntime, revisionId: "another-revision" }],
      runtimePaths,
    );
    assert.equal(observed.runtimeAfterDeadline, "unavailable");
    assert.equal(observed.runtimeOutput, undefined);
  });

  await t.test(
    "keep workspace-node pending and exclude a log page with the wrong source",
    async () => {
      const lastAttempt = { code: "WORKSPACE_NODE_PENDING" };
      const observed = await observe(
        [
          { ...deployment, progress: { lastAttempt } },
          readyRuntime,
          { revisionId, source: "gateway", records: [] },
        ],
        pendingPaths,
      );
      const ready = { count: "one", phase: "Running", ready: true };
      assert.deepEqual(observed.runtimeAfterDeadline, { gateway: ready, agent: ready });
      assert.equal(observed.deployment.lastAttemptCode, lastAttempt.code);
      assert.deepEqual(observed.runtimeOutput, {
        agent: "unavailable",
        sandbox: "unavailable",
        gateway: "unavailable",
      });
    },
  );

  await observe([{ ...deployment, deploymentId: "another-revision" }], [deploymentPath]);
  const late = { ...provisioned, status: "succeeded" };
  const observation = await observe(
    [{ ...deployment, status: "succeeded" }, late],
    [deploymentPath, provisioningPath],
  );
  assert.equal(observation.provisioningAfterDeployment.status, "succeeded");
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
    assert.ok(
      process.env[credentialVariable],
      `${credentialVariable} is required for the first invocation`,
    );
    if (selectedSandboxDriver === "openshell") {
      assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for native OpenClaw");
    }
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
    delete env.CODEX_ACCESS_TOKEN_FILE;
    if (credentialVariable === "CODEX_ACCESS_TOKEN") {
      delete env.OPENAI_API_KEY;
    } else {
      delete env.CODEX_ACCESS_TOKEN;
    }
    const promptFor = (reply) => `Reply with exactly ${reply} and no other text.`;
    const resultOrigins = {
      apiOrigin: env.OCC_URL,
      browserOrigin: recorded.browserOrigin,
    };

    // The unique Agent remains until the fixture or the owner destroys the selected disposable stack.
    const first = readResult(
      await runFirstAgent({
        name,
        prompt: promptFor(firstReply),
        env,
        signal: context.signal,
      }),
      firstReply,
      resultOrigins,
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
      if (recorded.sandboxNetworkPolicies?.some(({ name: rule }) => rule === "python-web")) {
        // Read the actual provider-created Sandbox after normal Agent deployment:
        // a rendered Installation alone would not prove delivery to OpenShell.
        const port = await availablePort();
        const safeEnvironment = { ...env };
        delete safeEnvironment.OPENAI_API_KEY;
        delete safeEnvironment.OPENAI_API_KEY_FILE;
        const forward = spawn(
          "kubectl",
          [
            "--kubeconfig",
            join(stateDirectory, "kubeconfig"),
            "--context",
            `k3d-${recorded.cluster}`,
            "port-forward",
            "--namespace",
            openShellNamespace,
            "service/openshell-gateway",
            `${port}:8080`,
          ],
          { env: safeEnvironment, stdio: "ignore" },
        );
        context.after(() => stopProcess(forward));
        const client = new GrpcOpenShellGatewayClient({
          endpoint: `http://127.0.0.1:${port}`,
          auth: { mode: "unauthenticated" },
        });
        try {
          const sandboxName = new URL(appServerUrl).hostname.split("--")[1].split(".")[0];
          const deadline = Date.now() + 30_000;
          let sandbox;
          while (Date.now() < deadline && sandbox === undefined) {
            try {
              sandbox = await client.getSandbox(
                { name: sandboxName, workspace: namespaces.items[0].metadata.name },
                AbortSignal.timeout(2_000),
              );
            } catch {
              // The owned port-forward may still be opening its listener.
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          const rule = sandbox?.spec?.policy?.network_policies?.["python-web"];
          assert.ok(rule, "the startup rule must reach the deployed Agent's actual Sandbox");
          assert.deepEqual(
            rule.binaries.map(({ path }) => path),
            ["/usr/bin/python3.11"],
          );
          assert.deepEqual(
            rule.endpoints.map(({ host, ports }) => ({ host, ports })),
            [{ host: "example.com", ports: [443] }],
          );
          assert.ok(sandbox.spec.policy.network_policies["source-control"]);
          assert.ok(sandbox.spec.policy.network_policies["workspace-node-enrollment"]);
        } finally {
          client.close();
          await stopProcess(forward);
        }
      } else {
        context.diagnostic(
          "Existing stack has no python-web startup rule; override delivery was not exercised.",
        );
      }
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
    delete reuseEnv.CODEX_ACCESS_TOKEN;
    delete reuseEnv.CODEX_ACCESS_TOKEN_FILE;
    const second = readResult(
      await runFirstAgent({
        name,
        prompt: promptFor(secondReply),
        env: reuseEnv,
        signal: context.signal,
      }),
      secondReply,
      resultOrigins,
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
      assert.equal(source.type, "codex-pat");
      assert.equal(source.state, "ready");
      assert.equal(source.secrets.access_token?.kind, "secret");
      assert.equal(source.secrets.access_token?.namespaceId, first.namespaceId);
      secretId = source.secrets.access_token?.id;

      await context.test(
        "guided native OpenClaw redeployment resumes the same session with retained files and required-worker execution",
        { timeout: 16 * 60_000 + 2 * nativeFirstAgentProofTimeout + 30_000 },
        async (nativeContext) => {
          const request = (method, path, body, signal) =>
            requestLocalApi(first.origin, serviceKey, method, path, body, signal);
          const configuration = createHarnessConfiguration("openclaw", expectedModel);
          const providerFile = process.env.OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE;
          if (providerFile) {
            const provider = await readPrivateJson(
              providerFile,
              "the native model provider catalog",
            );
            const model = provider.models?.[0]?.id;
            assert.ok(typeof model === "string" && model.length > 0);
            configuration.models.providers.openai = {
              baseUrl: provider.baseUrl,
              api: provider.api,
              models: provider.models,
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            };
            configuration.agents.defaults.model = `openai/${model}`;
            configuration.agents.defaults.models = {
              [`openai/${model}`]: { agentRuntime: { id: "openclaw" } },
            };
          }
          const installation = await request("GET", "/installation");
          assert.equal(installation.capabilities?.nativeWorkers?.support, "pinned-runtime");
          assert.ok(
            installation.capabilities?.credentialSources?.types.some(
              ({ type }) => type === "openai",
            ),
          );
          // Native OpenClaw uses an OpenAI API key; the first Codex Agent's PAT
          // Source is valid only for its Codex runtime. Keep both exact bindings.
          const nativeSecret = await request("POST", `${base}/secrets`, {
            name: `first-agent-native-${suffix}`,
            value: process.env.OPENAI_API_KEY,
          });
          assert.equal(nativeSecret.ref.kind, "secret");
          assert.equal(nativeSecret.ref.namespaceId, first.namespaceId);
          const nativeSource = await request("POST", `${base}/credential-sources`, {
            name: `first-agent-native-${suffix}`,
            type: "openai",
            config: { base_url: configuration.models.providers.openai.baseUrl },
            secrets: { api_key: nativeSecret.ref },
          });
          assert.equal(nativeSource.type, "openai");
          assert.equal(nativeSource.state, "ready");
          assert.equal(
            nativeSource.config.base_url,
            new URL(configuration.models.providers.openai.baseUrl).href.replace(/\/$/u, ""),
          );
          assert.deepEqual(nativeSource.secrets.api_key, nativeSecret.ref);
          // The regular Console API creates the Configuration, Agent, source
          // grant, transport and revision; the Agent receives no Secret grant.
          const submitted = await request("POST", `${base}/agents/provision`, {
            requestId: `req_${randomUUID()}`,
            name: `first-agent-native-${suffix}`,
            executionMode: "dedicated",
            harnessAuth: { method: "credential_source", sourceId: nativeSource.id },
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
          const provisioningPath = nativeProvisioningPath(
            first.namespaceId,
            submitted.provisioning,
          );
          const kube = { stateDirectory, cluster: recorded.cluster, env };
          let provisioned;
          let deployment;
          let nativeAgent;
          while (Date.now() < deadline) {
            nativeContext.signal.throwIfAborted();
            provisioned = await request("GET", provisioningPath);
            const failureDiagnostics = {
              request,
              namespaceId: first.namespaceId,
              provisioningPath,
              provisioned,
              signal: nativeContext.signal,
              readProbePod: (revision, signal) => readNativeProbePod(kube, revision, signal),
            };
            await assertNativeWorkNotFailed(
              provisioned,
              "Guided native provisioning must succeed",
              failureDiagnostics,
            );
            if (provisioned.status === "succeeded") {
              assert.ok(provisioned.agentId && provisioned.revisionId);
              const nativePath = `${base}/agents/${provisioned.agentId}`;
              deployment = await request(
                "GET",
                `${nativePath}/deployments/${provisioned.revisionId}`,
              );
              await assertNativeWorkNotFailed(
                deployment,
                "The admitted native revision must become ready",
                failureDiagnostics,
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
          if (Date.now() >= deadline && provisioned?.status !== "succeeded") {
            await failNativeProvisioningDeadline({
              request,
              provisioningPath,
              provisioned,
              namespaceId: first.namespaceId,
              signal: nativeContext.signal,
            });
          }
          assert.equal(provisioned?.status, "succeeded");
          assert.equal(deployment?.status, "succeeded");
          assert.equal(nativeAgent?.activeRevisionId, provisioned.revisionId);
          assert.equal(nativeAgent.executionMode, "dedicated");
          assert.deepEqual(nativeAgent.harnessAuth, {
            method: "credential_source",
            sourceId: nativeSource.id,
          });
          assert.deepEqual(nativeAgent.credentialSources, [{ sourceId: nativeSource.id }]);
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
                binding.resourceId === nativeSource.id,
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
          const readProviderRevision = async (revisionId) => {
            const pods = await readKubernetesJson(
              kube,
              [
                "get",
                "pods",
                "--all-namespaces",
                "--selector",
                nativeAgentPodSelector(nativeAgent.id, revisionId),
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
            // Match RPC node observations to this revision's configured workspace node.
            // Kubernetes supplies the public identity; do not read node enrollment Secrets.
            const gatewayPods = await readKubernetesJson(
              kube,
              [
                "get",
                "pods",
                "--all-namespaces",
                "--selector",
                `openclaw.dev/agent=${nativeAgent.id},openclaw.dev/revision=${revisionId},openclaw.dev/workload-role=gateway,openclaw.dev/namespace=${first.namespaceId}`,
              ],
              "the native Gateway's workspace-node identity",
            );
            const gateways = gatewayPods.items.filter((item) => !item.metadata.deletionTimestamp);
            assert.equal(gateways.length, 1);
            const nodeIds = gateways[0].spec.containers.flatMap((item) =>
              (item.env ?? [])
                .filter(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID")
                .map(({ value }) => value),
            );
            assert.equal(nodeIds.length, 1);
            assert.ok(
              typeof nodeIds[0] === "string" && /^[a-f0-9]{64}$/.test(nodeIds[0]),
              "The native Gateway must name its exact workspace node",
            );
            return { pod, sandbox, workspaceStorage, expectedNodeId: nodeIds[0] };
          };
          const initialProvider = await readProviderRevision(provisioned.revisionId);
          const firstNativeProof = await assertNativeWorkerProofInController(nativeContext, {
            ...proofOptions,
            expectedNodeId: initialProvider.expectedNodeId,
          });
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
          const { deployment: replacementDeployment, agent: replacementAgent } =
            await waitForNativeRedeploy({
              request,
              namespaceId: first.namespaceId,
              agentId: nativeAgent.id,
              revisionId: replacement.id,
              signal: nativeContext.signal,
            });
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
            expectedNodeId: replacementProvider.expectedNodeId,
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
    if (selectedSandboxDriver === "openshell") {
      // Admission pins the Harness workspace to Local Setup's selected Sandbox data mount.
      const admitted = await requestLocalApi(
        first.origin,
        serviceKey,
        "GET",
        `${agentPath}/revisions/${first.identity.revisionId}`,
      );
      assert.equal(admitted.configuration.agents.defaults.workspace, "/sandbox/enterprise");
    }
    if (selectedControlUi) {
      assert.equal(original.generation, 2);
      assert.equal(original.values.gateway.publicOrigin, first.controlUiOrigin);
      assert.deepEqual(original.values.gateway.controlUi, {
        enabled: true,
        allowedOrigins: [first.controlUiOrigin],
      });
      assert.equal(original.values.gateway.auth.mode, "trusted-proxy");
      assert.deepEqual(original.values.gateway.auth.identityScopes, {
        "occ-workspace-files": ["operator.admin"],
      });
    }
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
        env: { ...reuseEnv, [credentialVariable]: replacementKey },
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
      // Control UI pins generation 2 and refuses drift before the content comparison.
      assert.match(
        `${refused.stdout}\n${refused.stderr}`,
        selectedControlUi
          ? /Configuration generation changed outside this helper/
          : /Configuration was changed outside this helper/,
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
