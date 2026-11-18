import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import {
  createRunnerFixture as fixture,
  laneArgs,
  runRunnerSync,
  writeJson,
  writeRunnerManifest,
} from "../helpers/ci-runner-fixture.ts";

interface AuditReceipt {
  issues: { code: string; message: string; file?: string }[];
}

interface SharedLaneReceipt {
  fileConcurrency: number;
  counts: { passed: number };
  files: {
    path: string;
    mode: string;
    status: string;
    startOffsetMs: number;
    wallDurationMs: number;
  }[];
  issues: { code: string }[];
}

async function auditManifest(root: string, manifest: Parameters<typeof writeRunnerManifest>[1]) {
  await writeRunnerManifest(root, manifest);
  return runRunnerSync(["audit", "--manifest", "manifest.json", "--root", root]);
}

test("audit fails when a referenced lane cannot be loaded", async (t) => {
  const root = await fixture(t);
  const missing = await auditManifest(root, { lanes: { missing: "./missing-lane.json" } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT.*missing-lane\.json/);
  assert.equal(missing.stdout, "");
});

test("audit rejects prototype keys instead of silently dropping file environment", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/env.test.mjs"), "import 'node:test';\n");
  const result = await auditManifest(root, {
    lanes: {
      baseline: {
        files: [
          {
            path: "tests/integration/env.test.mjs",
            env: JSON.parse('{"__proto__":"configured"}'),
          },
        ],
      },
    },
  });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout) as AuditReceipt;
  assert.deepEqual(
    summary.issues.map(({ code }) => code),
    ["invalid-manifest"],
  );
  const [issue] = summary.issues;
  assert.ok(issue);
  assert.match(issue.message, /files\.0\.env\.__proto__/);
});

test("audit rejects obsolete manifest selectors", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/pattern.test.mjs"), "import 'node:test';\n");
  const result = await auditManifest(root, {
    lanes: {
      obsolete: {
        files: [
          {
            path: "tests/integration/pattern.test.mjs",
            namePattern: "^selected case$",
            allowedSkips: ["skipped case"],
          },
        ],
      },
    },
  });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout) as AuditReceipt;
  assert.deepEqual(summary.issues.map((entry) => entry.message).sort(), [
    "lanes.obsolete.files.0.allowedSkips is no longer supported",
    "lanes.obsolete.files.0.namePattern is no longer supported",
  ]);
});

test("audit rejects invalid file concurrency marks", async (t) => {
  const root = await fixture(t);
  for (const name of ["one", "two"]) {
    await writeFile(join(root, `tests/integration/${name}.test.mjs`), "import 'node:test';\n");
  }
  const result = await auditManifest(root, {
    lanes: {
      marks: {
        fileConcurrency: 0,
        parallelFiles: [
          "tests/integration/one.test.mjs",
          "tests/integration/one.test.mjs",
          "tests/integration/two.test.mjs",
          "tests/integration/other.test.mjs",
        ],
        serialFiles: {
          "tests/integration/two.test.mjs": "shared port",
          "tests/integration/one.test.mjs": " ",
          "tests/integration/gone.test.mjs": "moved",
        },
        files: [
          { path: "tests/integration/one.test.mjs" },
          { path: "tests/integration/two.test.mjs" },
        ],
      },
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(
    (JSON.parse(result.stdout) as AuditReceipt).issues.map((entry) => entry.message).sort(),
    [
      "lanes.marks.fileConcurrency must be an integer from 1 to 32",
      "lanes.marks.parallelFiles lists tests/integration/one.test.mjs twice",
      "lanes.marks.parallelFiles tests/integration/one.test.mjs is also serial",
      "lanes.marks.parallelFiles tests/integration/other.test.mjs is not a lane file",
      "lanes.marks.parallelFiles tests/integration/two.test.mjs is also serial",
      "lanes.marks.serialFiles.tests/integration/gone.test.mjs is not a lane file",
      "lanes.marks.serialFiles.tests/integration/one.test.mjs must name a reason",
    ],
  );
});

// Each fixture file holds a marker in `running/` while it runs. A parallel file waits
// for its partner's marker, so it passes only if both share slots; a file that must
// run alone fails if any other marker exists. Neither depends on timing.
function concurrencyProbe(name: string, partner: string | null) {
  return [
    'import assert from "node:assert/strict";',
    'import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";',
    'import { setTimeout as sleep } from "node:timers/promises";',
    'import test from "node:test";',
    "const running = process.env.CI_RUNNER_PROBE_DIR;",
    `test(${JSON.stringify(`${name} probe`)}, async () => {`,
    `  writeFileSync(running + "/${name}", "");`,
    "  try {",
    partner
      ? [
          '    const deadline = Date.now() + Number(process.env.CI_RUNNER_PROBE_WAIT_MS ?? "20000");',
          `    while (!existsSync(running + "/${partner}")) {`,
          `      assert.ok(Date.now() < deadline, "${partner} never ran beside ${name}");`,
          "      await sleep(10);",
          "    }",
        ].join("\n")
      : `    assert.deepEqual(readdirSync(running), ["${name}"]);`,
    "    await sleep(50);",
    "  } finally {",
    `    rmSync(running + "/${name}", { force: true });`,
    "  }",
    "});",
    "",
  ].join("\n");
}

async function runSharedLaneFixture(
  root: string,
  name: string,
  exitCode: number,
  env: NodeJS.ProcessEnv,
  manifestPath?: string,
) {
  const resultsPath = `results/${name}.json`;
  const args = laneArgs(root, "shared", `state/${name}.jsonl`, resultsPath, manifestPath);
  const { status, stderr } = runRunnerSync(args, env);
  assert.equal(status, exitCode, stderr);
  const summary = JSON.parse(await readFile(join(root, resultsPath), "utf8")) as SharedLaneReceipt;
  return { summary, stderr };
}

test("run shares slots only between audited parallel files and runs the rest alone", async (t) => {
  const root = await fixture(t);
  const running = join(root, "running");
  await mkdir(running);
  const probes = {
    unmarked: null,
    left: "right",
    serial: null,
    right: "left",
  };
  for (const [name, partner] of Object.entries(probes)) {
    await writeFile(
      join(root, `tests/integration/${name}.test.mjs`),
      concurrencyProbe(name, partner),
    );
  }
  await writeRunnerManifest(root, {
    lanes: {
      shared: {
        fileConcurrency: 4,
        parallelFiles: ["tests/integration/right.test.mjs", "tests/integration/left.test.mjs"],
        serialFiles: { "tests/integration/serial.test.mjs": "writes a fixed path" },
        files: [
          { path: "tests/integration/unmarked.test.mjs" },
          { path: "tests/integration/left.test.mjs" },
          { path: "tests/integration/serial.test.mjs" },
          { path: "tests/integration/right.test.mjs" },
        ],
      },
    },
  });
  const env = { CI_RUNNER_PROBE_DIR: running, CI_RUNNER_FILE_CONCURRENCY: "2" };

  const { summary, stderr } = await runSharedLaneFixture(root, "shared", 0, env);
  assert.equal(summary.fileConcurrency, 2);
  assert.equal(summary.counts.passed, 4);
  // Results keep manifest order; serial files ran first, before the shared slots.
  assert.deepEqual(
    summary.files.map((file) => [file.path.split("/").at(-1), file.mode]),
    [
      ["unmarked.test.mjs", "serial"],
      ["left.test.mjs", "parallel"],
      ["serial.test.mjs", "serial"],
      ["right.test.mjs", "parallel"],
    ],
  );
  const [unmarked, left, serial, right] = summary.files;
  assert.ok(unmarked && left && serial && right);
  assert.ok(unmarked.startOffsetMs < serial.startOffsetMs);
  assert.ok(serial.startOffsetMs + serial.wallDurationMs <= left.startOffsetMs);
  assert.ok(serial.startOffsetMs + serial.wallDurationMs <= right.startOffsetMs);
  // Shared slots start in parallelFiles order.
  assert.ok(right.startOffsetMs <= left.startOffsetMs);
  assert.match(
    stderr,
    /^run-tests: passed tests\/integration\/left\.test\.mjs \d+\.\ds \(parallel\)$/m,
  );

  // One slot runs every file alone; the partners then cannot meet, and the
  // result says so instead of passing.
  const { summary: aloneSummary } = await runSharedLaneFixture(root, "alone", 1, {
    ...env,
    CI_RUNNER_FILE_CONCURRENCY: "1",
    CI_RUNNER_PROBE_WAIT_MS: "300",
  });
  assert.equal(aloneSummary.fileConcurrency, 1);
  assert.deepEqual(
    aloneSummary.files.map((file) => [file.mode, file.status]),
    [
      ["serial", "passed"],
      ["serial", "failed"],
      ["serial", "passed"],
      ["serial", "failed"],
    ],
  );

  const { summary: invalidSummary } = await runSharedLaneFixture(root, "invalid", 1, {
    ...env,
    CI_RUNNER_FILE_CONCURRENCY: "many",
  });
  assert.deepEqual(invalidSummary.files, []);
  assert.deepEqual(
    invalidSummary.issues.map((entry) => entry.code),
    ["invalid-env"],
  );
});

test("run starts shared files longest first from the measured table, unmeasured first", async (t) => {
  const root = await fixture(t);
  const files = ["short", "long", "new", "middle"].map(
    (name) => `tests/integration/${name}.test.mjs`,
  );
  for (const path of files) {
    await writeFile(join(root, path), 'import test from "node:test";\ntest("case", () => {});\n');
  }
  // Rows for files outside the lane are ignored.
  await writeJson(join(root, "durations.json"), {
    version: 1,
    files: {
      "tests/integration/short.test.mjs": 10,
      "tests/integration/long.test.mjs": 50_000,
      "tests/integration/middle.test.mjs": 20,
      "tests/integration/gone.test.mjs": 90_000,
    },
  });
  const lanes = {
    shared: { fileConcurrency: 2, parallelFiles: files, files: files.map((path) => ({ path })) },
  };
  const starts = async (name: string, fileDurations?: string) => {
    const manifestPath = `${name}.json`;
    await writeRunnerManifest(root, { lanes, fileDurations }, manifestPath);
    const env = { CI_RUNNER_FILE_CONCURRENCY: "2" };
    const { summary, stderr } = await runSharedLaneFixture(root, name, 0, env, manifestPath);
    const offsets = Object.fromEntries(
      summary.files.map((file) => [basename(file.path, ".test.mjs"), file.startOffsetMs]),
    );
    const { short, long, new: unmeasured, middle } = offsets;
    assert.ok(
      short !== undefined && long !== undefined && unmeasured !== undefined && middle !== undefined,
    );
    return { stderr, short, long, new: unmeasured, middle };
  };

  // Two slots: the unmeasured and the longest file start together; the next freed slot
  // takes the middle file, the last one the shortest.
  const measured = await starts("measured", "./durations.json");
  assert.ok(measured.new < measured.middle && measured.long < measured.middle);
  assert.ok(measured.middle <= measured.short);
  assert.match(measured.stderr, /longest first \(3 of 4 shared files measured\)/);

  // Without a table, shared files start in parallelFiles order.
  const listed = await starts("listed");
  assert.ok(listed.short < listed.new && listed.long < listed.new);
  assert.ok(listed.new <= listed.middle);
  assert.doesNotMatch(listed.stderr, /longest first/);
});

test("audit rejects an unusable file duration table", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/one.test.mjs"), "import 'node:test';\n");
  await writeJson(join(root, "durations.json"), {
    version: 1,
    files: { "tests/integration/one.test.mjs": -1, "tests/integration/two.test.mjs": 1.5 },
  });
  const audit = async (fileDurations: unknown) => {
    const result = await auditManifest(root, {
      fileDurations,
      lanes: { one: { files: [{ path: "tests/integration/one.test.mjs" }] } },
    });
    assert.equal(result.status, 1, result.stdout);
    return (JSON.parse(result.stdout) as AuditReceipt).issues.map((entry) => entry.message);
  };

  assert.deepEqual(await audit("./durations.json"), [
    "fileDurations tests/integration/one.test.mjs must be a whole number of milliseconds",
    "fileDurations tests/integration/two.test.mjs must be a whole number of milliseconds",
  ]);
  assert.deepEqual(await audit("./missing.json"), [
    "fileDurations ./missing.json is not readable JSON",
  ]);
  for (const reference of ["../durations.json", "./../durations.json", "durations.json", 5]) {
    assert.deepEqual(await audit(reference), ["fileDurations must be a ./relative .json path"]);
  }
  await writeJson(join(root, "durations.json"), { version: 2, files: {} });
  assert.deepEqual(await audit("./durations.json"), [
    "fileDurations ./durations.json must be version 1 with a files object",
  ]);
});

test("audit requires current discovered test files and rejects duplicate ownership", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "tests/integration/mapped.test.mjs"), "import 'node:test';\n");
  await writeFile(join(root, "tests/integration/unmapped.test.ts"), "import 'node:test';\n");
  await mkdir(join(root, "tests/docs"), { recursive: true });
  await writeFile(join(root, "tests/docs/unmapped.test.mjs"), "import 'node:test';\n");
  const result = await auditManifest(root, {
    lanes: {
      one: {
        files: [
          { path: "tests/integration/mapped.test.mjs", expectedTests: ["case a"] },
          { path: "tests/integration/missing.test.mjs" },
        ],
      },
      two: {
        files: [{ path: "tests/integration/mapped.test.mjs", expectedTests: ["case b"] }],
      },
      broad: {
        files: [{ path: "tests/integration/mapped.test.mjs", expectedTests: ["case c"] }],
      },
      empty: {
        files: [],
      },
    },
    groups: {
      ci: ["one", "two", "broad", "empty", "unknown"],
    },
  });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout) as AuditReceipt;
  assert.deepEqual(summary.issues.map((entry) => entry.code).sort(), [
    "duplicate-file",
    "missing-file",
    "missing-lane",
    "selected-zero",
    "unmapped-file",
    "unmapped-file",
  ]);
  assert.deepEqual(
    summary.issues
      .filter((entry) => entry.code === "unmapped-file")
      .map((entry) => entry.file)
      .sort(),
    ["tests/docs/unmapped.test.mjs", "tests/integration/unmapped.test.ts"],
  );
});
