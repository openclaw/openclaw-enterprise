#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isObject, sourceEvidence } from "./ci/runner-inputs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage: node scripts/strands-fast.ts [--codex <executable>] [--output <new-directory>] [--repeat <1..20>] [--serial]
Runs the existing native Strands rehearsal and sender controls with their CI assertions and cleanup.
The executable defaults to OCC_TEST_STANDING_GIT_CODEX. Output defaults to a fresh temporary directory.
No Box, cluster, public provider or account credentials are required. --serial measures the same selections sequentially.`;

function options(args: string[]) {
  const result = {
    codex: process.env.OCC_TEST_STANDING_GIT_CODEX,
    output: undefined as string | undefined,
    repeat: 1,
    serial: false,
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    assert(arg && !seen.has(arg), "duplicate option");
    seen.add(arg);
    if (arg === "--serial") {
      result.serial = true;
    } else if (arg === "--codex" || arg === "--output" || arg === "--repeat") {
      const value = args[++i];
      assert(value && !value.startsWith("--"), `${arg} requires a value`);
      if (arg === "--codex") {
        result.codex = value;
      } else if (arg === "--output") {
        result.output = resolve(value);
      } else {
        assert(/^(?:[1-9]|1[0-9]|20)$/.test(value), "--repeat must be 1..20");
        result.repeat = Number(value);
      }
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  assert(result.codex, "provide --codex or OCC_TEST_STANDING_GIT_CODEX");
  return result;
}

type Counts = { passed: number; failed: number; skipped: number; todo: number; total: number };
const countKeys = ["passed", "failed", "skipped", "todo", "total"] as const;

function readCounts(value: unknown): Counts {
  assert(isObject(value), "runner receipt has no test counts");
  const counts: Counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const key of countKeys) {
    const count: unknown = value[key];
    assert(typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
    counts[key] = count;
  }
  return counts;
}
type Selection = {
  name: string;
  lane: string;
  scope: "full" | "focused";
  file: string;
  count: number;
};
const selections: Selection[] = [
  {
    name: "native",
    lane: "strands-sender",
    scope: "full",
    file: "tests/integration/strands-sender-rehearsal.test.ts",
    count: 1,
  },
  {
    name: "sender",
    lane: "checks-baseline-1",
    scope: "focused",
    file: "tests/conformance/strands-box-git.test.ts",
    count: 5,
  },
];

async function nativeCodexVersion(codex: string) {
  const binary = await open(codex, "r");
  const header = Buffer.alloc(20);
  try {
    await binary.read(header, 0, header.length, 0);
  } finally {
    await binary.close();
  }
  const machine = process.arch === "x64" ? 62 : process.arch === "arm64" ? 183 : 0;
  assert(
    machine !== 0 &&
      header.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
      header.readUInt16LE(18) === machine,
    "provide the native Linux ELF Codex executable for this CPU",
  );
  const recipe = await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8");
  const version = /^ENV OPENAI_CODEX_VERSION=(\d+\.\d+\.\d+)$/m.exec(recipe)?.[1];
  assert(version, "the runtime recipe must pin a Codex version");
  const home = await mkdtemp(join(tmpdir(), "strands-fast-codex-version-"));
  try {
    const result = spawnSync(codex, ["--version"], {
      cwd: home,
      env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4096,
    });
    assert(
      result.status === 0 && result.stdout.trim() === `codex-cli ${version}`,
      `executable must identify as pinned Codex ${version}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return version;
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
    return;
  }
  const start = performance.now();
  const config = options(process.argv.slice(2));
  assert(process.platform === "linux", "the native rehearsal requires Linux process identity");
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer is required");
  if (config.output) {
    try {
      await lstat(config.output);
      throw new Error("EEXIST: --output must name a new directory");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const source = sourceEvidence(root, { requireCleanTracked: true });
  assert(
    source.sha && source.issues.length === 0,
    source.issues[0]?.message ?? "Missing source SHA",
  );
  const codex = await realpath(resolve(config.codex!));
  assert((await stat(codex)).isFile(), "Codex must be a regular executable file");
  await access(codex, constants.X_OK);
  const version = await nativeCodexVersion(codex);
  // Fingerprint the selected runtime once; the benchmark never builds or downloads it.
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(codex)) {
    digest.update(chunk);
  }
  const output = config.output ?? (await mkdtemp(join(tmpdir(), "strands-fast-")));
  if (config.output) {
    await mkdir(output, { mode: 0o700 });
  }
  let interrupted = false;
  const interrupt = () => {
    if (!interrupted) {
      console.error("Stopping after the current tests finish their owned cleanup.");
    }
    // Killing the outer CI runner would skip test after-hooks, including the
    // detached native child's cleanup. Drain this bounded selection instead.
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  console.log(`Strands fast results: ${output}`);
  const runs = [];
  const runSelection = async (selection: Selection, directory: string) => {
    const selectedAt = performance.now();
    const resultPath = join(directory, selection.name + ".json");
    const args = [
      "scripts/ci/run-tests.ts",
      "run",
      selection.lane,
      "--state",
      join(directory, selection.name + "-state.json"),
      "--results",
      resultPath,
    ];
    if (selection.scope === "focused") {
      args.push("--file", selection.file);
    }
    try {
      const log = await open(join(directory, selection.name + ".log"), "wx", 0o600);
      let exit: number | null;
      try {
        assert(!interrupted, "run interrupted before selection started");
        // Each runner owns its state and test cleanup. Isolate its process group
        // so terminal interrupts reach this parent, which waits for both runners.
        const child = spawn(process.execPath, args, {
          cwd: root,
          detached: true,
          env: { ...process.env, OCC_TEST_STANDING_GIT_CODEX: codex },
          stdio: ["ignore", log.fd, log.fd],
        });
        exit = await new Promise<number | null>((accept, reject) => {
          child.once("error", reject);
          child.once("close", accept);
        });
      } finally {
        await log.close();
      }
      const result: unknown = JSON.parse(await readFile(resultPath, "utf8"));
      assert(
        isObject(result) &&
          result.version === 1 &&
          result.command === "run" &&
          result.lane === selection.lane &&
          typeof result.sourceSha === "string" &&
          Array.isArray(result.issues) &&
          Array.isArray(result.files),
        "unexpected runner receipt",
      );
      const counts = readCounts(result.counts);
      const file: unknown = result.files[0];
      const passed =
        exit === 0 &&
        result.exitCode === 0 &&
        result.status === "passed" &&
        result.scope === selection.scope &&
        result.sourceSha === source.sha &&
        result.issues.length === 0 &&
        counts.total === selection.count &&
        counts.passed === selection.count &&
        counts.failed === 0 &&
        counts.skipped === 0 &&
        counts.todo === 0 &&
        result.files.length === 1 &&
        isObject(file) &&
        file.path === selection.file &&
        file.status === "passed" &&
        isObject(file.cleanup) &&
        file.cleanup.status === "passed";
      const elapsedMs = Math.round(performance.now() - selectedAt);
      console.log(
        `${selection.name}: ${passed ? "PASS" : "FAIL"}, ${counts.passed}/${counts.total} tests, ${elapsedMs} ms`,
      );
      return {
        name: selection.name,
        passed,
        elapsedMs,
        resultPath,
        sourceSha: result.sourceSha,
        counts,
      };
    } catch {
      console.log(`${selection.name}: FAIL, runner receipt unavailable`);
      return {
        name: selection.name,
        passed: false,
        elapsedMs: Math.round(performance.now() - selectedAt),
        resultPath,
        sourceSha: null,
        counts: null,
        problem: "runner receipt unavailable; cleanup unverified",
      };
    }
  };
  try {
    for (let i = 0; i < config.repeat && !interrupted; i++) {
      const directory = join(output, "run-" + (i + 1));
      await mkdir(directory, { mode: 0o700 });
      const at = performance.now();
      const results = [];
      if (config.serial) {
        for (const selection of selections) {
          if (interrupted) {
            break;
          }
          results.push(await runSelection(selection, directory));
        }
      } else {
        results.push(
          ...(await Promise.all(selections.map((selection) => runSelection(selection, directory)))),
        );
      }
      const passed =
        !interrupted &&
        results.length === selections.length &&
        results.every((result) => result.passed);
      runs.push({ passed, elapsedMs: Math.round(performance.now() - at), results });
      if (!passed) {
        break;
      }
    }
  } catch {
    console.error("The fast runner could not finish recording a sample.");
  }
  const times = runs
    .filter((run) => run.passed)
    .map((run) => run.elapsedMs)
    .sort((a, b) => a - b);
  const finishedSource = sourceEvidence(root, { requireCleanTracked: true });
  const sourceProblem =
    finishedSource.issues[0]?.message ??
    (finishedSource.sha === source.sha
      ? null
      : "the checked-out source SHA changed during the run");
  if (sourceProblem) console.error(sourceProblem);
  const passed =
    sourceProblem === null &&
    !interrupted &&
    runs.length === config.repeat &&
    runs.every((run) => run.passed);
  const summary = {
    schema: "strands-fast-v1",
    passed,
    interrupted,
    mode: config.serial ? "serial" : "parallel",
    sourceSha: source.sha,
    ...(sourceProblem ? { sourceProblem } : {}),
    executable: { path: codex, version, sha256: digest.digest("hex") },
    totalElapsedMs: Math.round(performance.now() - start),
    samples: runs.length,
    medianMs: times.length
      ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2
      : null,
    p90Ms: times[Math.ceil(times.length * 0.9) - 1] ?? null,
    runs,
    ...(passed
      ? {
          proof:
            "Real sender, Git, mutual TLS and native Codex conversation with controlled material authority and origins.",
        }
      : {}),
  };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `${passed ? "PASS" : "FAIL"}: ${runs.length} sample(s), median ${summary.medianMs} ms, p90 ${summary.p90Ms} ms`,
  );
  process.exitCode = passed ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
