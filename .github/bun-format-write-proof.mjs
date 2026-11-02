import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

process.chdir(path.join(process.env.GITHUB_WORKSPACE, "source"));
const originalManifest = fs.readFileSync("package.json", "utf8");
const manifest = JSON.parse(originalManifest);
const baselineSha = "7bb67ab81e65bfcea35aeddf2a9f02c4f258b138";
const candidateSha = "7f8678844a8cf0be94aacda849e26b2e2c051df4";
const results = [];
function run(label, executable, args) {
  const started = performance.now();
  const child = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const result = {
    label,
    milliseconds: performance.now() - started,
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    stdout: child.stdout,
    stderr: child.stderr,
  };
  const summary = {
    ...result,
    stdout: result.stdout?.slice(-5000),
    stderr: result.stderr?.slice(-5000),
    stdoutTruncated: result.stdout?.length > 5000,
    stderrTruncated: result.stderr?.length > 5000,
  };
  results.push(summary);
  console.log(JSON.stringify(summary));
  return result;
}
const head = run("source-head", "git", ["rev-parse", "HEAD"]).stdout.trim();
if (head !== candidateSha) throw new Error("candidate source head mismatch");
const baselineRead = run("baseline-manifest", "git", ["show", `${baselineSha}:package.json`]);
if (baselineRead.status !== 0) throw new Error("baseline manifest lookup failed");
const baselineManifest = JSON.parse(baselineRead.stdout);
const baselineWrite = baselineManifest.scripts["format:fix"];
const globs = [...manifest.scripts["format:check"].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const prettier = path.join(process.env.RUNNER_TEMP, "formatter-tools/node_modules/.bin/prettier");
const cache = path.join(process.env.RUNNER_TEMP, "formatter-content-cache");
const cacheWasPresent = fs.existsSync(cache);
if (process.env.PROOF_MODE === "cold" && cacheWasPresent)
  throw new Error("cold content cache was not empty");
if (process.env.PROOF_MODE === "restored" && !cacheWasPresent)
  throw new Error("restored content cache missing");
run("node-version", "node", ["--version"]);
run("pnpm-version", "pnpm", ["--version"]);
run("prettier-version", prettier, ["--version"]);
run("bun-version", "bun", ["--revision"]);

function write(tool, label) {
  try {
    if (tool === "baseline")
      fs.writeFileSync(
        "package.json",
        `${JSON.stringify(
          { ...manifest, scripts: { ...manifest.scripts, "format:fix": baselineWrite } },
          null,
          2,
        )}\n`,
      );
    return run(label, "pnpm", ["run", "format:fix"]);
  } finally {
    fs.writeFileSync("package.json", originalManifest);
  }
}
for (let repetition = 0; repetition < 3; repetition += 1) {
  for (const tool of repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    write(tool, `write-${tool}-${repetition + 1}`);
    if (run(`status-${tool}-${repetition + 1}`, "git", ["status", "--porcelain"]).stdout.trim())
      throw new Error("formatter changed the already-formatted corpus");
  }
}

const trackedRead = run("tracked-files", "git", ["ls-files", "-z"]);
if (trackedRead.status !== 0) throw new Error("tracked corpus lookup failed");
const tracked = trackedRead.stdout.split("\0").filter(Boolean);
const filename = tracked.find(
  (filename) =>
    filename.startsWith("packages/") && filename.endsWith(".ts") && !filename.endsWith(".d.ts"),
);
if (!filename) throw new Error("included source specimen missing");
const original = fs.readFileSync(filename);
let baselineOutput;
let candidateOutput;
try {
  for (const tool of ["baseline", "candidate"]) {
    fs.writeFileSync(
      filename,
      Buffer.concat([original, Buffer.from("\nexport const bunFormatControl={number:1}\n")]),
    );
    write(tool, `repair-${tool}`);
    if (tool === "baseline") baselineOutput = fs.readFileSync(filename, "utf8");
    else candidateOutput = fs.readFileSync(filename, "utf8");
  }
  for (const tool of ["baseline", "candidate"]) {
    fs.writeFileSync(filename, Buffer.concat([original, Buffer.from("\nexport const =\n")]));
    write(tool, `negative-syntax-${tool}`);
  }
} finally {
  fs.writeFileSync(filename, original);
  fs.writeFileSync("package.json", originalManifest);
}

run("cache-check-baseline-seed", prettier, [
  "--check",
  ...globs,
  "--cache",
  "--cache-strategy",
  "content",
  "--cache-location",
  cache,
]);
for (let repetition = 0; repetition < 3; repetition += 1) {
  for (const tool of repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    run(
      `cache-check-${tool}-${repetition + 1}`,
      tool === "baseline" ? prettier : "bun",
      tool === "baseline"
        ? ["--check", ...globs, "--cache", "--cache-strategy", "content", "--cache-location", cache]
        : ["fmt", "--no-script", "--check", ...globs],
    );
  }
}
const finalStatus = run("final-status", "git", ["status", "--porcelain"]).stdout.trim();
const report = {
  head,
  baseline: baselineSha,
  mode: process.env.PROOF_MODE,
  runner: {
    platform: process.platform,
    architecture: process.arch,
    cpus: os.cpus().length,
    cpu: os.cpus()[0].model,
  },
  cacheWasPresent,
  cacheBytes: fs.statSync(cache).size,
  results,
  repairEqual: baselineOutput === candidateOutput,
  finalStatus,
  caveats: [
    "actual pnpm format:fix entrypoint on both sides; temporary baseline script restored after every call",
    "full corpus stays byte-identical after every clean write; source control is restored after repair/syntax negatives",
    "Prettier cached checking is reference context, not a proposed checking migration; CI content-cache behavior remains unchanged",
    "standalone exact formatter dependency; no platform service, project runtime, emitter or package-manager migration",
  ],
};
console.log(`BUN_FORMAT_WRITE_JSON=${JSON.stringify(report)}`);
const failed =
  results.some((result) => result.label.startsWith("write-") && result.status !== 0) ||
  results.some((result) => result.label.startsWith("repair-") && result.status !== 0) ||
  results.some((result) => result.label.startsWith("negative-syntax-") && result.status === 0) ||
  results.some((result) => result.label.startsWith("cache-check-") && result.status !== 0) ||
  !report.repairEqual ||
  finalStatus;
if (failed) process.exitCode = 1;
