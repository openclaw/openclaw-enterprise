import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/test-files.mjs");
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

function fixture(t) {
  mkdirSync(join(root, ".build"), { recursive: true });
  const dir = mkdtempSync(join(root, ".build/test-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    put(name, code) {
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, code);
      return file;
    },
  };
}

function invoke(args, cwd = root) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
}

const passing = "import test from 'node:test'; test('passes', () => {});\n";

// The escape target must sit outside this checkout, but TMPDIR may be inside it.
// HOME is consulted only when TMPDIR is unusable; a missing or unwritable base is skipped.
function outsideRepository() {
  const checkout = realpathSync(root);
  for (const candidate of [tmpdir, homedir]) {
    let base;
    try {
      base = realpathSync(candidate());
      accessSync(base, constants.W_OK);
    } catch {
      continue;
    }
    if (!statSync(base).isDirectory()) {
      continue;
    }
    const path = relative(checkout, base);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      return base;
    }
  }
  throw new Error("Neither TMPDIR nor HOME is a writable directory outside this repository");
}

test("runs actual passing, skipped and todo tests without converting expected failure to failure", (t) => {
  const f = fixture(t);
  const file = f.put(
    "outcomes.test.mjs",
    `${passing}
    test('skipped', { skip: 'explicit infrastructure omission' }, () => { throw Error('must not execute'); });
    test('todo', { todo: 'unfinished behavior' }, () => { throw Error('expected todo failure'); });`,
  );
  const result = invoke(["--", file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Selected 1 test file/);
  assert.match(result.stdout, /# pass 1/);
  assert.match(result.stdout, /# skipped 1/);
  assert.match(result.stdout, /# todo 1/);
});

test("preserves assertion and process-exit failures", (t) => {
  const f = fixture(t);
  for (const [name, code] of [
    [
      "assertion",
      "import test from 'node:test'; test('fails', () => { throw Error('real assertion failure'); });",
    ],
    ["exit", "process.exitCode = 7;"],
  ]) {
    const result = invoke(["--", f.put(`${name}.test.mjs`, code)]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /not ok/);
  }
});

test("validates every path and option before starting any selected file", (t) => {
  const f = fixture(t);
  const marker = join(f.dir, "executed");
  const valid = f.put(
    "valid.test.mjs",
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`,
  );
  const outside = mkdtempSync(join(outsideRepository(), "oce-outside-tests-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const escaped = join(outside, "escape.test.mjs");
  writeFileSync(escaped, passing);
  symlinkSync(escaped, join(f.dir, "escape.test.mjs"));
  mkdirSync(join(f.dir, "directory.test.mjs"));
  for (const args of [
    ["--", valid, join(f.dir, "missing.test.mjs")],
    ["--", valid, join(f.dir, "*.test.mjs")],
    ["--", valid, join(f.dir, "escape.test.mjs")],
    ["--", valid, escaped],
    ["--", valid, join(f.dir, "directory.test.mjs")],
    ["--", valid, valid],
    ["--", valid, "--test-reporter=tap"],
    ["--test-concurrency=0", "--", valid],
    ["--test-concurrency=2", "--test-concurrency=1", "--", valid],
    ["--test-name-pattern=[", "--", valid],
    ["--test-reporter=missing", "--", valid],
    ["--test-force-exit", "--", valid],
    ["--test-concurency=2", "--", valid],
    ["--help", "--", valid],
    [valid],
    ["--"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1, JSON.stringify({ args, result }));
    assert.equal(existsSync(marker), false, JSON.stringify(args));
    assert.doesNotMatch(result.stderr, /Selected /);
  }
});

test("runs literal unusual paths, relative paths and internal symlinks without glob expansion", (t) => {
  const f = fixture(t);
  const literal = f.put("spaces [abc] ? star*/-literal.test.mjs", passing);
  const decoy = f.put(
    "spaces a x starZ/-literal.test.mjs",
    "throw Error('glob decoy must not execute');",
  );
  assert.ok(existsSync(decoy));
  const result = invoke(["--", relative(f.dir, literal)], f.dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1/);
  const alias = join(f.dir, "alias.test.mjs");
  symlinkSync(literal, alias);
  const linked = invoke(["--", alias]);
  assert.equal(linked.status, 0, linked.stdout + linked.stderr);
  assert.equal(invoke(["--", literal, alias]).status, 1);
});

test("forwards filters and built-in reporters with fresh process isolation", (t) => {
  const f = fixture(t);
  const files = ["one", "two"].map((name) =>
    f.put(
      `${name}.test.mjs`,
      `
    import test from 'node:test'; import assert from 'node:assert/strict';
    test('selected', () => { assert.equal(globalThis.fixtureValue, undefined); globalThis.fixtureValue = 1; });
    test('excluded', () => { throw Error('filter must omit this'); });`,
    ),
  );
  for (const reporter of ["tap", "spec", "dot"]) {
    const result = invoke([
      "--test-concurrency=2",
      "--test-name-pattern=^selected$",
      `--test-reporter=${reporter}`,
      "--",
      ...files,
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Selected 2 test file/);
    assert.ok(result.stdout.length > 0);
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(
    `forwards ${signal} cancellation and retains leaked-handle lifecycle evidence`,
    { timeout: 15000 },
    async (t) => {
      const f = fixture(t);
      // A passing assertion with a live handle must remain live until explicitly cancelled.
      const file = f.put(
        "live.test.mjs",
        `import test, { after } from 'node:test';
      test('assertion passes', () => {});
      after(() => {
        setInterval(() => console.log('test-child-pid:', process.pid), 10);
      });`,
      );
      const child = spawn(process.execPath, [runner, "--", file], {
        cwd: root,
        env,
        stdio: "pipe",
      });
      const output = createInterface({ input: child.stdout });
      child.stderr.resume();
      const closed = once(child, "close");
      let testPid;
      t.after(() => {
        output.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        if (testPid) {
          try {
            process.kill(testPid, "SIGKILL");
          } catch {}
        }
      });
      // Wait for the passing result and output from the leaked interval itself.
      // Hook output alone can race natural shutdown without a live handle.
      // Complete PID lines also avoid reading an empty, newly created PID file.
      let passed = false;
      for await (const line of output) {
        const match = /^# test-child-pid: ([1-9]\d*)$/.exec(line);
        if (match) {
          testPid = Number(match[1]);
        }
        if (line === "ok 1 - assertion passes") {
          passed = true;
        }
        if (testPid && passed) {
          break;
        }
      }
      child.stdout.resume();
      assert.ok(testPid, "real test child remains live through its leaked interval");
      assert.ok(passed, "the passing assertion was reported before cancellation");
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      child.kill(signal);
      const [code, observedSignal] = await closed;
      assert.equal(code, null);
      assert.equal(observedSignal, signal);
      assert.throws(() => process.kill(testPid, 0), { code: "ESRCH" });
      testPid = undefined;
    },
  );
}
