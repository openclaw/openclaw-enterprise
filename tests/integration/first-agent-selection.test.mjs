import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  firstAgentConfiguration,
  selectFirstAgentModel,
  verifyFirstAgentModel,
} from "../../scripts/first-agent-model.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const firstAgentScript = fileURLToPath(new URL("../../scripts/first-agent.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const openaiDefault = "https://api.openai.com/v1";

function recorded(selection) {
  return {
    version: 2,
    name: "first-agent-selection",
    namespaceId: "ns_first_agent_selection",
    ...selection,
    secretName: "first-agent-selection-secret",
  };
}

test("the first-Agent command advertises its default and preserves explicit or recorded model selections", async () => {
  const { stdout } = await execFileAsync(process.execPath, [firstAgentScript, "--help"], {
    cwd: repoRoot,
  });
  assert.match(stdout, /OPENCLAW_FIRST_AGENT_MODEL defaults to gpt-6-astra for a new Agent/);
  const openai = (model) => ({ provider: "openai", baseUrl: openaiDefault, model });
  assert.deepEqual(selectFirstAgentModel({}, undefined), openai("gpt-6-astra"));
  assert.deepEqual(selectFirstAgentModel({ model: "gpt-4.1" }, undefined), openai("gpt-4.1"));
  assert.deepEqual(selectFirstAgentModel({}, recorded(openai("gpt-5.1"))), openai("gpt-5.1"));
  assert.deepEqual(
    selectFirstAgentModel({ model: "gpt-4.1" }, recorded(openai("gpt-4.1"))),
    openai("gpt-4.1"),
  );
  assert.throws(
    () => selectFirstAgentModel({ model: "gpt-6-astra" }, recorded(openai("gpt-4.1"))),
    /recorded Namespace or model differs/,
  );

  // A model gateway may serve IDs with path segments; the helper must not block them.
  assert.deepEqual(
    selectFirstAgentModel({ model: "vendor/family/model-1.5" }, undefined),
    openai("vendor/family/model-1.5"),
  );
  for (const model of [
    "openai/gpt-6-astra",
    "/model",
    "model/",
    "vendor//model",
    "vendor/-model",
    "model id",
    `m${"/m".repeat(50)}`,
  ]) {
    assert.throws(
      () => selectFirstAgentModel({ model }, undefined),
      /served model ID without the openai\/ prefix/,
      model,
    );
  }
});

test("the first-Agent command selects a provider and endpoint and keeps them for a recorded Agent", () => {
  const gateway = "https://models.example.test/anthropic";
  const anthropic = { provider: "anthropic", baseUrl: gateway, model: "vendor/family/model-1" };
  assert.deepEqual(selectFirstAgentModel(anthropic, undefined), anthropic);
  assert.deepEqual(
    selectFirstAgentModel({ provider: "anthropic", model: "claude-test" }, undefined),
    { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-test" },
  );
  assert.throws(
    () => selectFirstAgentModel({ provider: "anthropic" }, undefined),
    /Set OPENCLAW_FIRST_AGENT_MODEL to the served model ID for the anthropic provider/,
  );
  assert.throws(
    () => selectFirstAgentModel({ provider: "gemini", model: "m" }, undefined),
    /OPENCLAW_FIRST_AGENT_PROVIDER must be "openai" or "anthropic"/,
  );
  for (const baseUrl of [
    "http://models.example.test/v1",
    "https://user:pass@models.example.test/v1",
    "https://models.example.test/v1?key=value",
    "not a url",
  ]) {
    assert.throws(
      () => selectFirstAgentModel({ baseUrl }, undefined),
      /OPENCLAW_FIRST_AGENT_BASE_URL must be an https URL/,
      baseUrl,
    );
  }

  // A repeat without overrides reuses the recorded selection; a different one is refused.
  const record = recorded(anthropic);
  assert.deepEqual(selectFirstAgentModel({}, record), anthropic);
  for (const configured of [
    { provider: "openai" },
    { baseUrl: "https://other.example.test/anthropic" },
  ]) {
    assert.throws(
      () => selectFirstAgentModel(configured, record),
      /recorded model provider or base URL differs/,
    );
  }
});

test("the first-Agent command refuses a record without its provider selection", () => {
  // A record from an older helper cannot prove which endpoint its Agent uses,
  // so the helper must refuse it instead of guessing before any platform change.
  const older = {
    version: 1,
    name: "first-agent-selection",
    namespaceId: "ns_first_agent_selection",
    model: "gpt-5.1",
    secretName: "first-agent-selection-secret",
  };
  const current = recorded({ provider: "openai", baseUrl: openaiDefault, model: "gpt-5.1" });
  for (const record of [
    older,
    { ...older, version: 2 },
    { ...current, provider: "gemini" },
    { ...current, baseUrl: undefined },
  ]) {
    assert.throws(
      () => selectFirstAgentModel({}, record),
      /local record was written by an older first-agent helper or is invalid\. Choose a new Agent name/,
    );
  }
});

test("the first-Agent Configuration delivers the selected provider's credential and endpoint", () => {
  const configuration = (provider, keyEnvironment, baseUrl, api, model) => ({
    kind: "agent",
    values: {
      gateway: {
        mode: "local",
        bind: "lan",
        controlUi: { enabled: false },
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
        http: { endpoints: { chatCompletions: { enabled: true } } },
      },
      agents: {
        defaults: {
          model: `${provider}/${model}`,
          skipBootstrap: true,
          models: { [`${provider}/${model}`]: { agentRuntime: { id: "openclaw" } } },
        },
      },
      tools: { deny: ["*"] },
      secrets: { providers: { model: { source: "env", allowlist: [keyEnvironment] } } },
      models: {
        providers: {
          [provider]: {
            baseUrl,
            api,
            apiKey: { source: "env", provider: "model", id: keyEnvironment },
            models: [{ id: model, name: model }],
          },
        },
      },
    },
  });

  assert.deepEqual(
    firstAgentConfiguration(selectFirstAgentModel({}, undefined)),
    configuration("openai", "OPENAI_API_KEY", openaiDefault, "openai-responses", "gpt-6-astra"),
  );
  assert.deepEqual(
    firstAgentConfiguration({
      provider: "anthropic",
      baseUrl: "https://models.example.test/anthropic",
      model: "vendor/family/model-1",
    }),
    configuration(
      "anthropic",
      "ANTHROPIC_API_KEY",
      "https://models.example.test/anthropic",
      "anthropic-messages",
      "vendor/family/model-1",
    ),
  );
});

test("the first-Agent model check reads the selected provider's credential in the gateway", async () => {
  const namespaceId = "ns_first_agent_probe";
  const agentId = "agt_first_agent_probe";
  const revisionId = "rev_first_agent_probe";
  const hash = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);
  const pod = {
    metadata: { name: "gateway-0" },
    spec: {
      volumes: [{ configMap: { name: `gateway-${hash(agentId)}-rev-${hash(revisionId)}` } }],
    },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  };
  // Discovery is faked; the serialized probe itself runs in a real Node process
  // with only the environment the gateway container would expose.
  const kubectlWith = (gatewayEnvironment) =>
    async function kubectl(...args) {
      const options = typeof args.at(-1) === "object" ? args.pop() : {};
      if (args[0] === "get" && args[1] === "namespaces") {
        return JSON.stringify({ items: [{ metadata: { name: "tenant" } }] });
      }
      if (args[0] === "get" && args[1] === "pods") {
        return JSON.stringify({ items: [pod] });
      }
      assert.equal(args[0], "exec");
      const { stdout } = await new Promise((resolve, reject) => {
        const child = execFile(
          process.execPath,
          ["--input-type=module", "-"],
          { env: { PATH: process.env.PATH, ...gatewayEnvironment }, timeout: 30_000 },
          (error, out) => (error ? reject(error) : resolve({ stdout: out })),
        );
        child.stdin.end(options.input);
      });
      return stdout;
    };
  const target = { namespaceId, agentId, revisionId };
  const anthropicKey = `anthropic-test-${randomUUID()}`;

  // The probe refuses a prompt containing the provider key before any request,
  // so this outcome proves it read ANTHROPIC_API_KEY without needing a gateway.
  await assert.rejects(
    verifyFirstAgentModel(
      kubectlWith({ OPENCLAW_GATEWAY_PASSWORD: "password", ANTHROPIC_API_KEY: anthropicKey }),
      { ...target, provider: "anthropic", prompt: `Repeat ${anthropicKey}` },
    ),
    /model prompt contained a credential/,
  );
  await assert.rejects(
    verifyFirstAgentModel(
      kubectlWith({ OPENCLAW_GATEWAY_PASSWORD: "password", OPENAI_API_KEY: anthropicKey }),
      { ...target, provider: "anthropic", prompt: `Repeat ${anthropicKey}` },
    ),
    /gateway container has no Anthropic provider key/,
  );
  await assert.rejects(
    verifyFirstAgentModel(
      kubectlWith({ OPENCLAW_GATEWAY_PASSWORD: "password", ANTHROPIC_API_KEY: anthropicKey }),
      { ...target, provider: "openai", prompt: `Repeat ${anthropicKey}` },
    ),
    /gateway container has no OpenAI provider key/,
  );
});
