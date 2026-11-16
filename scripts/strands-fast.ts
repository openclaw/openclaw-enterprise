#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
type LaneResult = {
  version: number;
  command: string;
  lane: string;
  scope: string;
  status: string;
  exitCode: number;
  sourceSha: string;
  counts: Counts;
  issues: unknown[];
  files: { path: string; status: string; cleanup: { status: string } }[];
};
type Selection = { name: string; lane: string; file?: string };
const selections: Selection[] = [
  { name: "native", lane: "strands-sender" },
  { name: "sender", lane: "checks-baseline-1", file: "tests/conformance/strands-box-git.test.ts" },
];

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
    return;
  }
  const start = performance.now();
  const config = options(process.argv.slice(2));
  assert(process.platform === "linux", "the native rehearsal requires Linux process identity");
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer is required");
  const codex = await realpath(resolve(config.codex!));
  assert((await stat(codex)).isFile(), "Codex must be a regular executable file");
  await access(codex, constants.X_OK);
  // Fingerprint the selected runtime once; the benchmark never builds or downloads it.
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(codex)) {
    digest.update(chunk);
  }
  const output = config.output ?? (await mkdtemp(join(tmpdir(), "strands-fast-")));
  if (config.output) {
    await mkdir(output, { mode: 0o700 });
  }
  console.log(`Strands fast results: ${output}`);
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
  const runs = [];
  const runSelection = async (selection: Selection, directory: string) => {
    assert(!interrupted, "run interrupted");
    const selectedAt = performance.now();
    const resultPath = join(directory, selection.name + ".json");
    const log = await open(join(directory, selection.name + ".log"), "wx", 0o600);
    const args = [
      "scripts/ci/run-tests.ts",
      "run",
      selection.lane,
      "--state",
      join(directory, selection.name + "-state.json"),
      "--results",
      resultPath,
    ];
    if (selection.file) {
      args.push("--file", selection.file);
    }
    let exit: number | null;
    try {
      // Each existing runner owns its test processes, state file and teardown.
      // Separate state files prevent preparation/cleanup locks from interfering.
      const child = spawn(process.execPath, args, {
        cwd: root,
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
    const result = JSON.parse(await readFile(resultPath, "utf8")) as LaneResult;
    assert(
      result.version === 1 && result.command === "run" && result.lane === selection.lane,
      "unexpected runner receipt",
    );
    const passed =
      exit === 0 &&
      result.exitCode === 0 &&
      result.status === "passed" &&
      result.issues.length === 0 &&
      result.counts.total > 0 &&
      result.counts.passed === result.counts.total &&
      result.counts.failed === 0 &&
      result.counts.skipped === 0 &&
      result.counts.todo === 0 &&
      result.files.length > 0 &&
      result.files.every((file) => file.status === "passed" && file.cleanup.status === "passed");
    const elapsedMs = Math.round(performance.now() - selectedAt);
    console.log(
      `${selection.name}: ${passed ? "PASS" : "FAIL"}, ${result.counts.passed}/${result.counts.total} tests, ${elapsedMs} ms`,
    );
    return {
      name: selection.name,
      passed,
      elapsedMs,
      resultPath,
      sourceSha: result.sourceSha,
      counts: result.counts,
    };
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
        // allSettled joins both original runners even if one receipt is missing.
        const settled = await Promise.allSettled(
          selections.map((selection) => runSelection(selection, directory)),
        );
        for (const result of settled) {
          if (result.status === "rejected") {
            throw result.reason;
          }
          results.push(result.value);
        }
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
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  const times = runs.map((run) => run.elapsedMs).sort((a, b) => a - b);
  const passed = !interrupted && runs.length === config.repeat && runs.every((run) => run.passed);
  const summary = {
    schema: "strands-fast-v1",
    passed,
    interrupted,
    mode: config.serial ? "serial" : "parallel",
    executable: { path: codex, sha256: digest.digest("hex") },
    totalElapsedMs: Math.round(performance.now() - start),
    samples: runs.length,
    medianMs: times.length
      ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2
      : null,
    p90Ms: times[Math.ceil(times.length * 0.9) - 1] ?? null,
    runs,
    proof:
      "Real sender, Git, mutual TLS and native Codex conversation; controlled material authority and origins. No Box or installed-cluster qualification.",
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
