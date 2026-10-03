import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { localFirstAgentStack } from "../helpers/local-first-agent-stack.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const firstAgentScript = fileURLToPath(new URL("../../scripts/first-agent.mjs", import.meta.url));
const selected = process.env.OCC_TEST_LOCAL_FIRST_AGENT_REAL === "1";
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
}) {
  const args = [firstAgentScript, name];
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
  const model = /^Model: (openai\/[A-Za-z0-9._-]+)\r?$/m.exec(stdout);
  const proof = /^Model response verified: (FIRST_AGENT_[A-Fa-f0-9-]+)\r?$/m.exec(stdout);
  const consoleLine = /^Console: ([^\r\n]+)\r?$/m.exec(stdout);
  const replyHeading = /(?:^|\n)Agent response:\r?\n/.exec(stdout);

  assert.ok(agent, `Missing Agent ID.\n${diagnostic}`);
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
  async function readOne(kind, selector, field, pattern, namespace) {
    let output;
    try {
      const { stdout } = await execFileAsync(
        "kubectl",
        [
          ...common,
          ...(namespace === undefined ? [] : ["--namespace", namespace]),
          "get",
          kind,
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

  const namespace = await readOne(
    "namespaces",
    `openclaw.dev/namespace=${namespaceId}`,
    "name",
    /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/,
  );
  return readOne(
    "secrets",
    `openclaw.dev/namespace=${namespaceId},openclaw.dev/secret=${secretId}`,
    "resourceVersion",
    /^[A-Za-z0-9._:-]+$/,
    namespace,
  );
}

async function requestLocalApi(origin, serviceKey, method, path, values) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "x-api-key": serviceKey,
        ...(values === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(values === undefined ? {} : { body: JSON.stringify({ values }) }),
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

test(
  "a local Kubernetes installer can deploy and reuse an Agent but cannot replace its key after external changes",
  {
    skip: selected
      ? false
      : "set OCC_TEST_LOCAL_FIRST_AGENT_REAL=1 to run against a disposable local Kubernetes installation",
    timeout: 2 * commandTimeout + refusalTimeout + stackLifecycleTimeout + 60_000,
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
    assert.equal(first.model, `openai/${expectedModel}`);
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
    const secretId = agent.harnessAuth?.source?.id;
    assert.ok(
      agent.harnessAuth?.method === "api_key" &&
        agent.harnessAuth.source?.kind === "secret" &&
        agent.harnessAuth.source?.namespaceId === first.namespaceId &&
        /^sec_[A-Za-z0-9_-]+$/.test(secretId ?? ""),
      "The public Agent must reference an exact Secret in its Namespace",
    );
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
    assert.deepEqual(original.values.models.providers.openai.models, [
      { id: expectedModel, name: expectedModel },
    ]);
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
        ...original.values,
        tools: { allow: ["*"] },
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
      await requestLocalApi(first.origin, serviceKey, "PATCH", configurationPath, original.values);
    }
  },
);
