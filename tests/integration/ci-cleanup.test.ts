import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { withStateLock } from "../../scripts/ci/state-lock.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import {
  cleanupPath,
  createK3dClusterResource,
  fixture,
  repositoryRoot,
  runCleanup,
  writeState,
} from "./ci-cleanup-fixture.ts";
import { registerImageCustodyCases } from "./ci-cleanup-image-cases.ts";
import {
  registerBoundK3dCases,
  registerK3dDirectoryCase,
  registerK3dRemovalCases,
} from "./ci-cleanup-k3d-cases.ts";
import {
  registerChildJournalCases,
  registerPostgresAdminCases,
  registerPostgresResourceCases,
  registerRoutingResetCase,
} from "./ci-cleanup-postgres-cases.ts";
import {
  registerCommandOwnershipCases,
  registerInheritedOutputCases,
  registerInheritedPipeCases,
} from "./ci-cleanup-process-cases.ts";

const processCaseInputs = { repositoryRoot, cleanupPath, fixture, writeState, runCleanup };

registerRoutingResetCase();
registerK3dRemovalCases();
registerPostgresResourceCases();
registerInheritedOutputCases(processCaseInputs);
registerPostgresAdminCases();
registerInheritedPipeCases(processCaseInputs);
registerK3dDirectoryCase();

const observabilitySha = "a".repeat(40);
const observabilityNotice =
  "::notice title=Production Observability timing::" +
  `lane=k3d-observability run_id=12345 run_attempt=2 source_sha=${observabilitySha} phase=lane-cleanup`;
const observabilityStart = `${observabilityNotice} event=start`;

async function observabilityCleanupFixture(t: TestContext) {
  const root = await fixture(t);
  await mkdir(join(root, "state"));
  await mkdir(join(root, "results"));
  const statePath = join(root, "state", "k3d-observability.json");
  const resultsPath = join(root, "results", "k3d-observability.json");
  return {
    statePath,
    resultsPath,
    args: [cleanupPath, "--state", statePath, "--results", resultsPath],
    env: {
      ...process.env,
      RUNNER_TEMP: root,
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SHA: observabilitySha,
    },
  };
}

function cleanupNotices(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("::notice title=Production Observability timing::"));
}

test("Production Observability cleanup notices follow journal processing and result finalization", async (t) => {
  const laneResult = { version: 1, command: "run", lane: "k3d-observability" };
  const cases = [
    { name: "journal processed", journal: { version: 1 }, outcome: "success" },
    { name: "no journal", outcome: "skipped" },
    {
      name: "no journal or result",
      result: null,
      outcome: "skipped",
    },
    {
      name: "invalid journal",
      journal: { version: 2 },
      outcome: "failure",
      error: /Unsupported cleanup state version/,
      cleanup: "failed",
    },
    {
      name: "invalid result without journal",
      result: { ...laneResult, version: 2 },
      outcome: "failure",
      error: /Cannot record cleanup on an invalid lane result/,
    },
    {
      name: "failed cleanup result without journal",
      result: { ...laneResult, cleanup: { status: "failed" } },
      outcome: "failure",
      error: /Cannot verify failed cleanup without resource state/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const { args, env, statePath, resultsPath } = await observabilityCleanupFixture(t);
      if (scenario.journal) {
        await writeState(statePath, {
          repositoryRoot,
          prefix: "openclaw-ci-local-abcdef1234567890",
          resources: [],
          ...scenario.journal,
        });
      }
      const initialResult = scenario.result === undefined ? laneResult : scenario.result;
      if (initialResult) {
        await writeState(resultsPath, initialResult);
      }

      const result = spawnSync(process.execPath, args, {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, scenario.error ? 1 : 0, result.stderr);
      assert.equal(result.stdout, "");
      if (scenario.error) {
        assert.match(result.stderr, scenario.error);
      }
      const notices = cleanupNotices(result.stderr);
      assert.equal(notices.length, 2, result.stderr);
      assert.equal(notices[0], observabilityStart);
      if (scenario.outcome === "skipped") {
        assert.equal(notices[1], `${observabilityNotice} event=finish outcome=skipped`);
      } else {
        assert.match(
          notices[1] ?? "",
          new RegExp(
            `^${observabilityNotice} event=finish outcome=${scenario.outcome} elapsed_ms=[0-9]+$`,
          ),
        );
      }
      if (scenario.journal && !scenario.error) {
        await assert.rejects(stat(statePath), { code: "ENOENT" });
      }
      if (initialResult) {
        const expected =
          scenario.error && !scenario.cleanup
            ? initialResult
            : { ...initialResult, cleanup: { status: scenario.cleanup ?? "passed" } };
        assert.deepEqual(JSON.parse(await readFile(resultsPath, "utf8")), expected);
      } else {
        await assert.rejects(stat(resultsPath), { code: "ENOENT" });
      }
    });
  }
});

test("Production Observability cleanup notices require ordinary lane paths", async (t) => {
  const { args, env, statePath } = await observabilityCleanupFixture(t);
  for (const otherArgs of [
    [...args, "--cleanup-owner", "synthetic-owner", "--lane", "k3d-observability"],
    [...args.slice(0, -1), join(env.RUNNER_TEMP, "results", "k3d-model.json")],
  ]) {
    const result = spawnSync(process.execPath, otherArgs, {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(cleanupNotices(result.stderr), []);
  }
  await assert.rejects(stat(statePath), { code: "ENOENT" });
});

test("interrupted Production Observability cleanup emits only a start", async (t) => {
  const { args, env, statePath } = await observabilityCleanupFixture(t);
  const journal = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [],
  };
  await writeState(statePath, journal);
  await withStateLock(statePath, async () => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10_000,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes(`${observabilityStart}\n`)) {
        child.kill("SIGKILL");
      }
    });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (_code, signal) => resolve(signal));
    });
    assert.equal(signal, "SIGKILL", stderr);
    assert.deepEqual(cleanupNotices(stderr), [observabilityStart]);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), journal);
  });
});

test("cleanup rejects ownerless resources before invoking cleanup commands", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-ownerless-cluster-abcdef123456";
  const clusterDirectory = join(root, `${clusterName}-state`);
  const k3dLog = join(root, "k3d.log");
  const cluster = await createK3dClusterResource({ name: clusterName }, clusterDirectory);
  await writeCommand(join(root, "bin"), "k3d", "exit 0\n", { log: k3dLog });

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [cluster],
  };
  await writeState(statePath, state);

  const result = runCleanup(statePath, {
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another prefix: undefined/);
  const retainedState: unknown = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(retainedState, state);
  await assert.rejects(() => stat(k3dLog), { code: "ENOENT" });
  assert.equal((await stat(clusterDirectory)).isDirectory(), true);
});

registerCommandOwnershipCases(processCaseInputs);
registerImageCustodyCases();
registerBoundK3dCases();
registerChildJournalCases();
