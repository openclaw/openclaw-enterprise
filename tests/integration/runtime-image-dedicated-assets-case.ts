import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  includeRepositoryRestSkill,
  repositoryRestSkillConfiguration,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-native-configuration.ts";
import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import { list, parseJson, record } from "../fixtures/runtime-image-startup/wire.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { gatewayLogsThroughReady } from "../helpers/runtime-image-gateway-observations.ts";
import {
  image,
  runGatewaySmoke,
  runtimeImageModel,
  temporaryGatewayConfiguration,
} from "../helpers/runtime-image-startup.ts";

type GatewayAssetAssertions = {
  entrypoint: string;
  stopTimeoutMs: number;
  assertGatewayReadyLog: (entries: unknown[]) => void;
  assertGatewayModelLog: (entries: unknown[], modelReference: string) => void;
  assertNoPackagingFailure: (logs: string) => void;
};

async function listRepositorySkills(t: TestContext, configuration: OpenClawConfigurationDocument) {
  const path = await temporaryGatewayConfiguration(t, "openclaw", configuration);
  // The CLI queries a running Gateway first. An isolated container makes it load this config.
  const { stdout } = await runDocker([
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--user=1000:1000",
    "--tmpfs=/tmp:uid=1000,gid=1000,mode=1777",
    "--env=HOME=/tmp",
    "--env=OPENCLAW_STATE_DIR=/tmp/state",
    "--env=OPENCLAW_CONFIG_PATH=/etc/openclaw/openclaw.json",
    "--volume",
    `${path}:/etc/openclaw/openclaw.json:ro`,
    "--entrypoint=node",
    image,
    "/app/openclaw.mjs",
    "skills",
    "list",
    "--agent",
    "main",
    "--json",
  ]);
  return list(record(parseJson(stdout)).skills).map(record);
}

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
  const { containerName } = await runGatewaySmoke(t, "codex", {
    configurationPath: "/etc/openclaw/openclaw.json",
    entrypoint,
    extraEnvironment: ["OPENCLAW_WORKSPACE_DIR=/home/node/workspace", "OPENCLAW_LOG_LEVEL=error"],
    tmpfs: [
      "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
      "/home/node/workspace:size=1024m,uid=1000,gid=1000,mode=700",
    ],
    volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
  });

  const { logs, entries } = await gatewayLogsThroughReady(containerName);
  assertGatewayReadyLog(entries);
  assertGatewayModelLog(entries, `codex/${runtimeImageModel}`);
  await assertGatewayRuntimeAssets(containerName);
  // Staging verifies a previously published image. The current image must show the REST
  // publication instructions to an Agent that inherited a selection of the bundled GitHub skill.
  if (process.env.OCC_TEST_STAGING_CODEX_VERSION === undefined) {
    const configuration = { agents: { defaults: { skills: ["github"] } } };
    const before = await listRepositorySkills(t, configuration);
    assert.equal(before.find((skill) => skill.name === "github")?.modelVisible, true);
    const after = await listRepositorySkills(
      t,
      repositoryRestSkillConfiguration(configuration, true),
    );
    const generic = after.find((skill) => skill.name === "github");
    assert.equal(generic?.disabled, true);
    assert.equal(generic.modelVisible, false);
    const publicationSkills = after.filter((skill) => skill.name === "github-repository-rest");
    assert.equal(publicationSkills.length, 1, "The Gateway should offer one publication skill.");
    const [publication] = publicationSkills;
    assert.equal(publication?.source, "openclaw-extra");
    assert.equal(publication.modelVisible, true);
    const gitOnly = await listRepositorySkills(
      t,
      repositoryRestSkillConfiguration(configuration, false),
    );
    assert.equal(
      gitOnly.some((skill) => skill.name === "github-repository-rest" && skill.modelVisible),
      false,
    );
    // A protected Codex Agent that selected GitHub can still discover the managed skill.
    const protectedSkills = await listRepositorySkills(
      t,
      includeRepositoryRestSkill(configuration),
    );
    const visiblePublication = protectedSkills.filter(
      (skill) => skill.name === "github-repository-rest" && skill.modelVisible,
    );
    assert.equal(visiblePublication.length, 1);
  }
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
