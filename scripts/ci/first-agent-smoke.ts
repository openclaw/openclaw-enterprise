#!/usr/bin/env node
// Per-merge smoke of a real local installation, needing no secrets.
//
//   node scripts/ci/first-agent-smoke.ts images   build the checkout's images
//   node scripts/ci/first-agent-smoke.ts run      install, deploy, chat, stop, start
//   node scripts/ci/first-agent-smoke.ts release-selection <file>  record build selection
//
// `images` builds the controller and runtime images from this checkout (reading
// the hosted image caches when available), adds a private test CA to the
// runtime image's trust store, and publishes both to a local registry, reachable
// on loopback, so Local Setup can select them by digest. `run` starts the
// Kubernetes-only Local Setup with those images, answers api.openai.com from a
// stand-in Responses provider, runs scripts/first-agent.ts for an embedded
// OpenClaw Agent, deploys one dedicated Codex Agent through the API, reads both
// Agents' logs through `occ agent logs`, stops and starts each once, and checks
// that every reported status matches the cluster and a real model turn.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, realpath, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildImages, writeReleaseSelection } from "./first-agent-smoke/images.ts";
import { createStepRecorder, log, workDirectory } from "./first-agent-smoke/process.ts";
import {
  clusterName,
  routeModelProvider,
  startLocalSetup,
  type LocalSetup,
  type SmokeAgent,
  type SmokeStack,
} from "./first-agent-smoke/setup.ts";
import {
  chatTurn,
  createCodexAgent,
  deployAgent,
  readLogs,
  runFirstAgent,
  stopAgent,
} from "./first-agent-smoke/agents.ts";
import {
  diagnostics,
  enablePublicReader,
  proveRetirement,
  publicReadTurn,
} from "./first-agent-smoke/reader.ts";

export {
  STOP_PHASE_TIMEOUT_MS,
  agentStopDiagnostic,
  createStepRecorder,
  modelContainer,
  observeAgentStop,
  run,
  smokeSlotNames,
  waitFor,
  workDirectory,
} from "./first-agent-smoke/process.ts";
export {
  bakeReferences,
  providerImageDockerfile,
  providerImageTag,
  publishPostgresImage,
  registryManifest,
  smokeBakeDefinition,
  smokeImageEnvironment,
} from "./first-agent-smoke/images.ts";
export {
  createApi,
  kubectl,
  routeModelProvider,
  startLocalSetup,
  watchCluster,
} from "./first-agent-smoke/setup.ts";
export { assertChatReply, stoppedGatewaySummary } from "./first-agent-smoke/agents.ts";
export { clusterEventLines } from "./first-agent-smoke/reader.ts";

const { step, smokeStep, initialAdmissions, timings, writeTimingReport } = createStepRecorder();
const proofResults: string[] = [];

async function smoke() {
  if (!process.env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY) {
    try {
      const images: unknown = JSON.parse(
        await readFile(join(workDirectory, "images.json"), "utf8"),
      );
      Object.assign(process.env, images);
    } catch {
      throw new Error("Run `node scripts/ci/first-agent-smoke.ts images` first.");
    }
  }
  const modelDirectory = process.env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY;
  const environment: NodeJS.ProcessEnv & { OCC_DEVELOPMENT_STATE_DIRECTORY: string } = {
    ...process.env,
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
    OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    OCC_DEVELOPMENT_STATE_DIRECTORY: join(await realpath(workDirectory), "local-setup"),
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: clusterName,
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "900",
  };
  delete environment.OPENAI_API_KEY;
  const modelCredentials = {
    embedded: `sk-oce-smoke-${randomUUID()}`,
    codex: `sk-oce-smoke-${randomUUID()}`,
    "reader-control": `sk-oce-smoke-${randomUUID()}`,
  };
  const credentialDigests = Object.fromEntries(
    Object.entries(modelCredentials).map(([label, value]) => [
      label,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  let diagnosticStack: (LocalSetup & Partial<SmokeStack>) | undefined;
  try {
    const installed = await smokeStep("local-setup", () => startLocalSetup(environment));
    diagnosticStack = installed;
    const agents: SmokeAgent[] = [];
    const setup = Object.assign(installed, { agents });
    const namespaces = (await setup.api("GET", "/namespaces")) as { name: string; id: string }[];
    const namespaceId = namespaces.find(({ name }) => name === "default")?.id;
    const initialized = Object.assign(setup, { namespaceId });
    assert.ok(initialized.namespaceId, "Local Setup created no default Namespace");
    const stack = initialized as SmokeStack;
    const reader = await smokeStep("install-reader", () => enablePublicReader(stack));
    await smokeStep("route-model", () =>
      routeModelProvider(
        stack,
        modelDirectory,
        process.env.OCC_FIRST_AGENT_SMOKE_PROVIDER_IMAGE ||
          process.env.OCC_KUBERNETES_RUNTIME_IMAGE,
        { credentialDigests },
      ),
    );
    const [embedded, codex, control] = await initialAdmissions({
      embedded: () => runFirstAgent(stack, modelCredentials.embedded),
      codex: () => createCodexAgent(stack, reader, "codex", modelCredentials.codex),
      control: () =>
        createCodexAgent(stack, reader, "reader-control", modelCredentials["reader-control"]),
    });
    await smokeStep("codex-chat", () => chatTurn(stack, codex.agent, codex.revisionId));
    await smokeStep("public-read", () => publicReadTurn(stack, codex, reader));
    const retiredRevision = await smokeStep("reader-retirement", () =>
      proveRetirement(stack, codex, control, reader, proofResults),
    );
    await smokeStep("agent-logs", async () => {
      await readLogs(stack, embedded.agent, "gateway");
      await readLogs(stack, codex.agent, "gateway");
      await readLogs(stack, codex.agent, "agent");
    });
    await smokeStep("stop-agents", () =>
      Promise.all([stopAgent(stack, embedded.agent), stopAgent(stack, codex.agent)]),
    );
    const [embeddedRevision, codexRevision] = await smokeStep("start-agents", () =>
      Promise.all([deployAgent(stack, embedded.agent), deployAgent(stack, codex.agent)]),
    );
    assert.notEqual(embeddedRevision, embedded.revisionId, "start must admit a new revision");
    assert.notEqual(codexRevision, retiredRevision, "start must admit a new revision");
    await smokeStep("chat-after-start", () =>
      Promise.all([
        chatTurn(stack, embedded.agent, embeddedRevision),
        chatTurn(stack, codex.agent, codexRevision),
      ]),
    );
  } catch (error) {
    await diagnostics(diagnosticStack);
    throw error;
  }
}

async function summarize() {
  const lines = ["| Step | Seconds | Result |", "| --- | ---: | --- |"];
  for (const { name, seconds, status } of timings) {
    lines.push(`| ${name} | ${seconds} | ${status} |`);
  }
  for (const proof of proofResults) {
    lines.push("", `Public reader: ${proof}`);
  }
  try {
    const disk = await statfs("/");
    lines.push("", `Free disk: ${Math.round((disk.bavail * disk.bsize) / 1024 ** 3)} GiB`);
  } catch {
    // Informational only.
  }
  log(`\n${lines.join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### First Agent smoke\n\n${lines.join("\n")}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === "release-selection") {
      await writeReleaseSelection(process.argv[3]);
    } else if (command === "images" || command === "prepared-git-images") {
      await buildImages(step, { preparedGit: command === "prepared-git-images" });
    } else if (command === "run") {
      await smoke();
    } else {
      throw new Error(
        "Usage: node scripts/ci/first-agent-smoke.ts images|prepared-git-images|run|release-selection <file>",
      );
    }
  } catch (error) {
    const failure = error as Error;
    process.stderr.write(`first-agent-smoke: ${failure.stack ?? failure.message}\n`);
    process.exitCode = 1;
  } finally {
    try {
      if (command !== "release-selection") {
        await summarize();
      }
    } finally {
      if (command === "run" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_TEMP) {
        await writeTimingReport(process.env.RUNNER_TEMP);
      }
    }
  }
}
