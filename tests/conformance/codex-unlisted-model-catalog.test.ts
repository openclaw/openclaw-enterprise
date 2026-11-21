import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  AGENT_RUNTIME_ENTRYPOINT,
  COMPUTE_AGENT_RUNTIME_ENTRYPOINT,
  COMPUTE_PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
  PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// The shape `codex debug models --bundled` prints (Codex 0.164): a code-mode-only model
// and the gpt-5.5 entry the generated catalog copies.
const bundled = {
  models: [
    {
      slug: "gpt-6-luna",
      display_name: "gpt-6-luna",
      tool_mode: "code_mode_only",
      apply_patch_tool_type: "freeform",
      supports_search_tool: true,
      input_modalities: ["text", "image"],
      context_window: 400000,
    },
    {
      slug: "gpt-5.5",
      display_name: "gpt-5.5",
      apply_patch_tool_type: "freeform",
      supports_search_tool: true,
      input_modalities: ["text", "image"],
      context_window: 272000,
    },
  ],
};

const helperSource = (() => {
  const start = AGENT_RUNTIME_ENTRYPOINT.indexOf("function unlistedModelCatalogArguments(");
  const end = AGENT_RUNTIME_ENTRYPOINT.indexOf("const nativeArguments = [", start);
  assert.ok(start >= 0 && end > start, "the entrypoint defines the catalog helper");
  return AGENT_RUNTIME_ENTRYPOINT.slice(start, end);
})();

type CodexResult = { status: number | null; stdout: string };

function catalogArguments(
  modelId: string,
  codexHome: string | undefined,
  codex: CodexResult = { status: 0, stdout: JSON.stringify(bundled) },
) {
  const calls: { command: string; args: string[] }[] = [];
  const context = {
    process: { env: codexHome === undefined ? {} : { CODEX_HOME: codexHome } },
    codexExecutable: () => "/usr/local/bin/codex",
    codexChildEnvironment: () => ({}),
    spawnSync: (command: string, args: string[]) => {
      calls.push({ command, args });
      return codex;
    },
    mkdirSync,
    require: (id: string) => {
      assert.equal(id, "node:fs");
      return { writeFileSync };
    },
    JSON,
    result: undefined as unknown,
  };
  vm.runInNewContext(
    `${helperSource}\nresult = unlistedModelCatalogArguments(${JSON.stringify(modelId)});`,
    context,
  );
  // Values built inside the context carry its Array prototype; compare plain copies.
  return {
    args: JSON.parse(JSON.stringify(context.result)) as string[],
    calls: JSON.parse(JSON.stringify(calls)) as typeof calls,
  };
}

function withHome(run: (home: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "codex-unlisted-catalog-"));
  try {
    run(join(root, ".codex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an unlisted model gets a direct-tools catalog entry", () => {
  withHome((home) => {
    const { args, calls } = catalogArguments("rits/zai-org/glm-5-3", home);
    const target = join(home, "unlisted-model-catalog.json");
    assert.deepEqual(args, ["-c", "model_catalog_json=" + JSON.stringify(target)]);
    assert.deepEqual(calls, [
      { command: "/usr/local/bin/codex", args: ["debug", "models", "--bundled"] },
    ]);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    const catalog = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(
      catalog.models.slice(0, 2),
      bundled.models,
      "bundled entries are kept unchanged",
    );
    assert.deepEqual(catalog.models[2], {
      ...bundled.models[1],
      slug: "rits/zai-org/glm-5-3",
      display_name: "rits/zai-org/glm-5-3",
      apply_patch_tool_type: null,
      tool_mode: "direct",
      supports_search_tool: false,
      input_modalities: ["text"],
    });
  });
});

test("a model the bundled catalog lists keeps the native defaults", () => {
  withHome((home) => {
    for (const model of ["gpt-5.5", "gpt-6-luna"]) {
      assert.deepEqual(catalogArguments(model, home).args, []);
    }
    assert.throws(() => statSync(join(home, "unlisted-model-catalog.json")), { code: "ENOENT" });
  });
});

test("without CODEX_HOME nothing runs and nothing is written", () => {
  const { args, calls } = catalogArguments("rits/zai-org/glm-5-3", undefined);
  assert.deepEqual(args, []);
  assert.deepEqual(calls, []);
});

test("a failing or unreadable catalog dump keeps the native defaults", () => {
  withHome((home) => {
    for (const codex of [
      { status: 1, stdout: JSON.stringify(bundled) },
      { status: null, stdout: "" },
      { status: 0, stdout: "not json" },
      { status: 0, stdout: JSON.stringify({ models: "none" }) },
      { status: 0, stdout: JSON.stringify({ models: [bundled.models[0]] }) },
    ]) {
      assert.deepEqual(catalogArguments("rits/zai-org/glm-5-3", home, codex).args, []);
    }
    assert.throws(() => statSync(join(home, "unlisted-model-catalog.json")), { code: "ENOENT" });
  });
});

test("a catalog that cannot be written keeps the native defaults", () => {
  withHome((home) => {
    mkdirSync(join(home, "unlisted-model-catalog.json"), { recursive: true });
    assert.deepEqual(catalogArguments("rits/zai-org/glm-5-3", home).args, []);
  });
});

test("every Codex app-server entrypoint passes the catalog arguments", () => {
  for (const entrypoint of [
    AGENT_RUNTIME_ENTRYPOINT,
    PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
    COMPUTE_AGENT_RUNTIME_ENTRYPOINT,
    COMPUTE_PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
  ]) {
    const start = entrypoint.indexOf("const nativeArguments = [");
    const arguments_ = entrypoint.slice(start, entrypoint.indexOf("];", start));
    assert.match(
      arguments_,
      /\.\.\.unlistedModelCatalogArguments\(process\.env\.OPENCLAW_HARNESS_MODEL\.slice\(/,
    );
  }
});
