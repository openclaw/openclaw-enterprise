import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { renderPresetTemplate } from "../../packages/contracts/src/preset-variables.mjs";
import {
  protectedText,
  qaCommandFailureDetail,
  redactQaError,
  registerQaSecret,
} from "./qa-secrets.mjs";

// Do not preserve raw causes, command output or assertion actual/expected fields.
export function devUpTestError(error, context) {
  const detail = qaCommandFailureDetail(error?.message ?? "Development proof failed", {});
  const result = new Error(detail || "Development proof failed");
  const code = error?.code;
  if (
    (["ENOENT", "EACCES", "ELOOP", "EINVAL", "ETIMEDOUT"].includes(code) ||
      (Number.isInteger(code) && code >= 0 && code <= 255)) &&
    redactQaError(new Error(String(code))).message === String(code)
  ) {
    result.code = code;
  }
  if (
    ["SIGTERM", "SIGKILL", "SIGINT"].includes(error?.signal) &&
    redactQaError(new Error(error.signal)).message === error.signal
  ) {
    result.signal = error.signal;
  }
  if (context === undefined) {
    return result;
  }
  // Build both parts at the redaction boundary, never attach the original error.
  const message = qaCommandFailureDetail(context, {});
  return new Error(message || "Development proof failed", { cause: result });
}

// The returned test callback reads nothing until node:test selects this case.
export function withDevUpModelKey(keyFile, body) {
  return async (t) => {
    try {
      assert.ok(
        typeof keyFile === "string" && isAbsolute(keyFile),
        "OCC_TEST_DEV_UP_MODEL_KEY_FILE must name an absolute private file",
      );
      t.signal?.throwIfAborted();
      const modelKey = await protectedText(keyFile, "Development model API key");
      registerQaSecret(JSON.stringify(modelKey).slice(1, -1));
      const hasControl = [...modelKey].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || code === 127;
      });
      assert.ok(
        !hasControl && !/\s/u.test(modelKey) && !/^[{["]/u.test(modelKey),
        "Development model API key must be a single token, not a credential bundle",
      );
      t.signal?.throwIfAborted();
      await body(t, modelKey);
    } catch (error) {
      throw devUpTestError(error);
    }
  };
}

export async function provisionDevUpSandboxAgent({
  post,
  namespaceId,
  preset,
  modelKey,
  model = "gpt-6-astra",
  thinkingDefault,
  requestId,
}) {
  assert.ok(
    typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model),
    "Development model ID must be a plain ID without a provider prefix",
  );
  assert.ok(
    thinkingDefault === undefined ||
      ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"].includes(
        thinkingDefault,
      ),
    "Development model thinking default must be a supported OpenClaw thinking level",
  );
  const secret = await post(
    `/namespaces/${namespaceId}/secrets`,
    { name: "Local sandbox proof", value: modelKey },
    201,
  );
  // Match the console's existing-Secret flow: the renderer never receives a key.
  const template = structuredClone(preset.template);
  template.agent.harnessAuth = { method: "api_key", source: secret.data.ref };
  const rendered = renderPresetTemplate(template, {
    name: "Local sandbox proof",
    model,
  });
  if (thinkingDefault !== undefined) {
    rendered.configuration.values.agents.defaults.thinkingDefault = thinkingDefault;
  }
  rendered.configuration.values.gateway.controlUi.enabled = false;
  return post(
    `/namespaces/${namespaceId}/agents/provision`,
    {
      requestId,
      ...rendered.agent,
      configuration: { kind: "agent", ...rendered.configuration },
    },
    202,
  );
}
