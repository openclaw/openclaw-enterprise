import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { assertShippedPods, selectShippedRuntime } from "./select-shipped-runtime.ts";

test(
  "network proxy QA qualifies canonical Codex PAT and shipped runtime before any Slack post",
  { timeout: 1_800_000 },
  async (context) => {
    for (const name of [
      "OPENAI_API_KEY",
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "OCC_TEST_SLACK_SENDER_BOT_TOKEN",
    ]) {
      assert.equal(process.env[name], undefined);
    }
    assert.ok(process.env.TMPDIR && process.env.OCC_TEST_QA_CODEX_TOKEN_FILE);
    const artifacts = join(process.env.TMPDIR, "qa-preflight-evidence");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const { createQaInstallation, prepareQaPluginCatalogs, createQaAgent } = await import(
      pathToFileURL(join(process.cwd(), "tests/helpers/qa-installation.mjs"))
    );
    const { stopQaAgent } = await import(
      pathToFileURL(join(process.cwd(), "tests/helpers/qa-repository.ts"))
    );
    const { createQaBrowser } = await import(
      pathToFileURL(join(process.cwd(), "tests/helpers/qa-browser.mjs"))
    );
    const fixture = await createQaInstallation(context, "kubernetes", artifacts, {
      repositoryInputs: false,
    });
    await selectShippedRuntime(fixture);
    await prepareQaPluginCatalogs(fixture);
    const browser = await createQaBrowser(fixture, { themed: false });
    const agent = await createQaAgent(
      fixture,
      "Codex",
      browser.nativeOrigin,
      "-network-proxy-auth-preflight",
    );
    assert.equal(agent.harnessAuth.method, "codex_pat");
    await assertShippedPods(fixture, agent);
    const marker = `QA_CODEX_PAT_${randomUUID()}`;
    await agent.native.normalGatewayTurn({
      agent,
      sessionKey: `agent:main:qa-network-proxy-auth-${randomUUID()}`,
      prompt: `Reply with exactly ${marker}. Do not use tools.`,
      expectedPatterns: [marker],
      secrets: [],
    });
    await stopQaAgent(fixture, agent);
  },
);
