import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  jsonLogEntries,
  runDocker,
  runGatewaySmoke,
  runtimeImageModel,
  temporaryGatewayConfiguration,
} from "../helpers/runtime-image-startup.mjs";

type GatewayAssetAssertions = {
  entrypoint: string;
  stopTimeoutMs: number;
  assertGatewayReadyLog: (entries: unknown[]) => void;
  assertGatewayModelLog: (entries: unknown[], modelReference: string) => void;
  assertNoPackagingFailure: (logs: string) => void;
};

async function assertGatewayRuntimeAssets(containerName: string): Promise<void> {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    `
const { lstatSync, readFileSync, readdirSync } = require("node:fs");
const appSkills = lstatSync("/app/skills");
if (!appSkills.isDirectory() || appSkills.isSymbolicLink()) {
  throw new Error("/app/skills must be a real directory in the runtime image.");
}
const bundled = readdirSync("/home/node/openclaw-runtime-assets/bundled-skills");
if (bundled.length === 0) {
  throw new Error("Kubernetes gateway entrypoint did not publish bundled skills.");
}
const plugin = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills");
if (!plugin.isDirectory()) {
  throw new Error("Kubernetes gateway entrypoint did not publish plugin skills directory.");
}
const slack = lstatSync("/home/node/openclaw-runtime-assets/plugin-skills/slack/SKILL.md");
if (!slack.isFile()) {
  throw new Error("Kubernetes gateway entrypoint did not publish Slack plugin skills.");
}
if (!/name:\\s*slack/.test(readFileSync("/home/node/openclaw-runtime-assets/plugin-skills/slack/SKILL.md", "utf8"))) {
  throw new Error("Kubernetes gateway entrypoint cannot read Slack Skill.md from runtime assets.");
}
if (!/# Block Kit/.test(readFileSync("/home/node/openclaw-runtime-assets/plugin-skills/block-kit/references/official-block-kit.md", "utf8"))) {
  throw new Error("Kubernetes gateway entrypoint cannot read packaged relative plugin skill files.");
}
process.stdout.write(JSON.stringify({ bundledCount: bundled.length, slackSkill: true }));
`,
  ]);

  const assets: unknown = JSON.parse(stdout);
  assert.ok(typeof assets === "object" && assets !== null && "bundledCount" in assets);
  assert.ok(typeof assets.bundledCount === "number" && assets.bundledCount > 0);
}

export async function verifyDedicatedGatewayAssets(
  t: TestContext,
  {
    entrypoint,
    stopTimeoutMs,
    assertGatewayReadyLog,
    assertGatewayModelLog,
    assertNoPackagingFailure,
  }: GatewayAssetAssertions,
): Promise<void> {
  const configurationPath = await temporaryGatewayConfiguration(t, "codex");
  const { logs, containerName } = await runGatewaySmoke(t, "codex", {
    configurationPath: "/etc/openclaw/openclaw.json",
    entrypoint,
    extraEnvironment: ["OPENCLAW_WORKSPACE_DIR=/home/node/workspace", "OPENCLAW_LOG_LEVEL=error"],
    tmpfs: [
      "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
      "/home/node/workspace:size=1024m,uid=1000,gid=1000,mode=700",
    ],
    volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
  });

  assert.ok(typeof logs === "string");
  const entries: unknown[] = jsonLogEntries(logs);
  assertGatewayReadyLog(entries);
  assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
  await assertGatewayRuntimeAssets(containerName);
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "--input-type=module",
    "-e",
    'import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "/app/node_modules/openclaw/gateway-shutdown-budget.mjs"; console.log(GATEWAY_SERVICE_STOP_TIMEOUT_MS);',
  ]);
  const runtimeStopTimeoutMs = Number(stdout.trim());
  assert.ok(runtimeStopTimeoutMs > 0 && runtimeStopTimeoutMs <= stopTimeoutMs);
  assertNoPackagingFailure(logs);
}
