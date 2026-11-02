import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const candidate = process.env.PROOF_CANDIDATE_SHA;
const baseline = process.env.PROOF_BASELINE_SHA;
const mode = process.env.PROOF_MODE;
if (![candidate, baseline].every((value) => /^[a-f0-9]{40}$/.test(value ?? "")))
  throw new Error("exact source and baseline SHAs are required");
if (!["cold", "restored"].includes(mode)) throw new Error("invalid proof mode");
process.chdir(path.join(process.env.GITHUB_WORKSPACE, "source"));
const results = [];
function run(label, executable, args) {
  const started = performance.now();
  const child = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
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

const head = run("head", "git", ["rev-parse", "HEAD"]).stdout.trim();
if (head !== candidate) throw new Error("candidate checkout changed");
if (run("initial-status", "git", ["status", "--porcelain"]).stdout.trim())
  throw new Error("proof requires a clean source checkout");
const originalManifest = fs.readFileSync("package.json", "utf8");
const manifest = JSON.parse(originalManifest);
const baselineRead = run("baseline-manifest", "git", ["show", `${baseline}:package.json`]);
if (baselineRead.status !== 0) throw new Error("baseline manifest lookup failed");
const baselineManifest = JSON.parse(baselineRead.stdout);
const baselineCheck = baselineManifest.scripts["format:check"];
const candidateCheck = manifest.scripts["format:check"];
if (candidateCheck !== baselineCheck.replace(/^prettier --check/, "bun fmt --no-script --check"))
  throw new Error("checker globs or scope changed");
const baselineBytes = originalManifest.replace(
  JSON.stringify(candidateCheck),
  JSON.stringify(baselineCheck),
);
if (baselineBytes === originalManifest) throw new Error("baseline script substitution failed");
const contentCache = path.join(process.env.RUNNER_TEMP, "checker-content-cache");
const cacheWasPresent = fs.existsSync(contentCache);
if (cacheWasPresent !== (mode === "restored")) throw new Error("content cache state mismatch");
const cacheBefore = cacheWasPresent
  ? createHash("sha256").update(fs.readFileSync(contentCache)).digest("hex")
  : null;
const bunCacheHit = process.env.PROOF_BUN_CACHE_HIT;
if (mode === "cold" && bunCacheHit === "true") throw new Error("cold Bun setup restored a cache");
if (mode === "restored" && bunCacheHit !== "true") throw new Error("Bun cache was not restored");
run("node-version", "node", ["--version"]);
run("pnpm-version", "pnpm", ["--version"]);
const prettierVersion = run("prettier-version", path.resolve("node_modules/.bin/prettier"), [
  "--version",
]);
const bunVersion = run("bun-version", "bun", ["--revision"]);
if (prettierVersion.stdout.trim() !== "3.9.10" || bunVersion.stdout.trim() !== "1.4.4+38afee6c8")
  throw new Error("formatter version drift");

function check(tool, label, cached = false) {
  try {
    if (tool === "baseline") fs.writeFileSync("package.json", baselineBytes);
    const args = ["run", "format:check"];
    if (cached) {
      if (tool !== "baseline") throw new Error("Bun cache flags are unsupported no-ops");
      args.push("--cache", "--cache-strategy", "content", "--cache-location", contentCache);
    }
    return run(label, "pnpm", args);
  } finally {
    fs.writeFileSync("package.json", originalManifest);
  }
}
for (let repetition = 0; repetition < 3; repetition += 1) {
  for (const tool of repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    check(tool, `format-${tool}-package-${repetition + 1}`);
    if (run(`status-${tool}-${repetition + 1}`, "git", ["status", "--porcelain"]).stdout.trim())
      throw new Error("readonly formatting check modified source");
  }
}
check("baseline", "cache-check-baseline-seed", true);
for (let repetition = 0; repetition < 3; repetition += 1) {
  for (const tool of repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"])
    check(tool, `cache-check-${tool}-${repetition + 1}`, tool === "baseline");
}

const specimens = [
  ["packages/audit/src/index.ts", "\nexport const bunFormatCheckControl={number:1}\n"],
  ["CONTRIBUTING.md", "\n```typescript\nexport const bunFormatCheckControl={number:1}\n```\n"],
];
for (const [filename, addition] of specimens) {
  const original = fs.readFileSync(filename);
  try {
    fs.appendFileSync(filename, addition);
    for (const tool of ["baseline", "candidate"])
      check(tool, `negative-format-${path.extname(filename)}-${tool}`);
    if (filename.endsWith(".ts")) check("baseline", "negative-cache-baseline", true);
  } finally {
    fs.writeFileSync(filename, original);
  }
}
const included = "packages/audit/src/index.ts";
const originalIncluded = fs.readFileSync(included);
try {
  fs.appendFileSync(included, "\nexport const =\n");
  for (const tool of ["baseline", "candidate"]) check(tool, `negative-syntax-${tool}`);
} finally {
  fs.writeFileSync(included, originalIncluded);
}
const excluded = "docs/reference/api.md";
const originalExcluded = fs.readFileSync(excluded);
try {
  fs.writeFileSync(excluded, "```typescript\nexport const =\n```\n");
  for (const tool of ["baseline", "candidate"]) check(tool, `excluded-source-${tool}`);
} finally {
  fs.writeFileSync(excluded, originalExcluded);
  fs.writeFileSync("package.json", originalManifest);
}
const finalStatus = run("final-status", "git", ["status", "--porcelain"]).stdout.trim();
const report = {
  head,
  baseline,
  mode,
  runner: {
    platform: process.platform,
    architecture: process.arch,
    cpus: os.cpus().length,
    cpu: os.cpus()[0].model,
  },
  scripts: { baseline: baselineCheck, candidate: candidateCheck },
  lockfile: createHash("sha256").update(fs.readFileSync("pnpm-lock.yaml")).digest("hex"),
  cacheWasPresent,
  cacheBefore,
  cacheBytes: fs.statSync(contentCache).size,
  bunCacheHit,
  results,
  finalStatus,
  caveats: [
    "actual pnpm format:check entrypoint on identical source; baseline script prefix alone is temporarily restored",
    "three interleaved uncached and cached-reference repeats; OS caches warm naturally, no OS-cache-cold claim",
    "frozen dependency installation and Bun provisioning/cache timings are separate workflow steps",
    "Prettier cache is task-owned reference context; candidate never passes unsupported Bun cache flags",
    "writer output/config parity is separately retained; this proof checks exact-head readonly coverage and negative controls",
  ],
};
console.log(`BUN_FORMAT_CHECK_JSON=${JSON.stringify(report)}`);
const failed = results.some((result) => {
  if (result.label.startsWith("negative-format-") || result.label === "negative-cache-baseline")
    return result.status !== 1;
  if (result.label.startsWith("negative-syntax-")) return result.status !== 2;
  return result.status !== 0;
});
if (failed || finalStatus) process.exitCode = 1;
