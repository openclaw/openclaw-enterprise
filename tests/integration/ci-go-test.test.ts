import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// scripts/ci/go-test.ts gates the Go CLI tests in CI. These cases run it over a
// scratch module, one package directory at a time: the script tests "./...", so
// the working directory picks the packages.
const script = fileURLToPath(new URL("../../scripts/ci/go-test.ts", import.meta.url));
const execFileAsync = promisify(execFile);
const modulePath = "example.test/gotest";

const packages = {
  // A passing package with a nested package that has no test files.
  ok: {
    "ok_test.go": 'package ok\n\nimport "testing"\n\nfunc TestPasses(t *testing.T) {}\n',
    "notests/notests.go": "package notests\n\nconst Value = 1\n",
  },
  skip: {
    "skip_test.go": `package skip

import "testing"

func TestParent(t *testing.T) {
	t.Run("child", func(t *testing.T) { t.Skip("fixture skip reason") })
}
`,
  },
  // The panic ends the test binary before the test reports its own result.
  panic: {
    "panic_test.go":
      'package panic\n\nimport "testing"\n\nfunc TestPanics(t *testing.T) { panic("fixture panic text") }\n',
  },
  // The test ends the binary with os.Exit, so go test reports only the package as
  // failed: the test's log and TestMain's output arrive without a test result.
  exit: {
    "exit_test.go": `package exit

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	fmt.Println("fixture TestMain output")
	os.Exit(m.Run())
}

func TestExits(t *testing.T) {
	t.Log("fixture exit log")
	os.Exit(2)
}
`,
  },
  // A test still running at the -timeout deadline: the timeout panic also arrives
  // without a result for the test.
  timeout: {
    "timeout_test.go": `package timeout

import (
	"testing"
	"time"
)

func TestHangs(t *testing.T) {
	t.Log("fixture hang log")
	time.Sleep(time.Minute)
}
`,
  },
  build: {
    "build_test.go":
      'package build\n\nimport "testing"\n\nfunc TestBuild(t *testing.T) { _ = fixtureMissingIdentifier }\n',
  },
};

async function fixtureModule(t: TestContext) {
  const root = await temporaryDirectory(t, "ci-go-test-");
  await writeFile(join(root, "go.mod"), `module ${modulePath}\n\ngo 1.21\n`);
  for (const [name, files] of Object.entries(packages)) {
    for (const [file, source] of Object.entries(files)) {
      const path = join(root, name, file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, source);
    }
  }
  return root;
}

async function goTest(
  cwd: string,
  { env = {}, args = [] }: { env?: NodeJS.ProcessEnv; args?: string[] } = {},
) {
  const options: ExecFileOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      GOFLAGS: "",
      GOTOOLCHAIN: "local",
      GOWORK: "off",
      ...env,
    },
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [script, "-count=1", ...args],
      options,
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok("signal" in error && "code" in error && "stdout" in error && "stderr" in error);
    assert.ok(typeof error.stdout === "string" && typeof error.stderr === "string");
    assert.equal(error.signal, null, `go-test.ts was killed: ${error.stderr}`);
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("go-test handles malformed and nonstandard event records without dropping output", async (t) => {
  const root = await temporaryDirectory(t, "ci-go-events-");
  await writeCommand(
    root,
    "go",
    `printf '%s\n' 'not json' '{"Action":"output","Test":"T","Output":"buffered"}' '{"Action":["pass"],"Test":"T"}'
`,
  );
  const result = await goTest(root, { env: { PATH: commandPath(root) } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^not json\nbufferedgo-test: 1 passed, 0 failed, 0 skipped\n$/);
});

test("go-test fails on skips and package failures and passes clean packages", async (t) => {
  const root = await fixtureModule(t);

  await t.test(
    "an all-pass package exits 0 and does not count a package without tests",
    async () => {
      const result = await goTest(join(root, "ok"));
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^go-test: 1 passed, 0 failed, 0 skipped$/m);
      assert.match(result.stdout, /notests\s+\[no test files\]/);
      assert.doesNotMatch(result.stderr, /skipped test did not run/);
    },
  );

  await t.test("a skipped subtest exits 1 and is named", async () => {
    const result = await goTest(join(root, "skip"));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^go-test: 1 passed, 0 failed, 1 skipped$/m);
    assert.match(result.stdout, /fixture skip reason/);
    assert.match(
      result.stderr,
      new RegExp(`^go-test: skipped test did not run: ${modulePath}/skip\\.TestParent/child$`, "m"),
    );
  });

  await t.test("a panicking test exits 1 and its panic output reaches the log", async () => {
    const result = await goTest(join(root, "panic"));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /panic: fixture panic text/);
    assert.match(result.stdout, /^go-test: 0 passed, 1 failed, 0 skipped$/m);
  });

  await t.test(
    "a test binary that exits mid-test exits 1 and prints the package's output",
    async () => {
      const result = await goTest(join(root, "exit"));
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /fixture TestMain output/);
      assert.match(result.stdout, /fixture exit log/);
      assert.match(result.stdout, /^go-test: 0 passed, 1 failed, 0 skipped$/m);
    },
  );

  await t.test("a test timeout exits 1 and prints the running test's output", async () => {
    const result = await goTest(join(root, "timeout"), { args: ["-timeout=2s"] });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /fixture hang log/);
    assert.match(result.stdout, /panic: test timed out after 2s/);
    assert.match(result.stdout, /^go-test: 0 passed, 1 failed, 0 skipped$/m);
  });

  await t.test("a build failure exits 1 with the compiler error", async () => {
    const result = await goTest(join(root, "build"));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /undefined: fixtureMissingIdentifier/);
    assert.match(result.stdout, /^go-test: 0 passed, 0 failed, 0 skipped$/m);
  });

  await t.test("a go command killed by a signal exits 1", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeCommand(bin, "go", "kill -KILL $$\n");
    const result = await goTest(join(root, "ok"), { env: { PATH: commandPath(bin) } });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^go-test: 0 passed, 0 failed, 0 skipped$/m);
  });
});

const splitPackage = "github.com/openclaw/openclaw-enterprise/internal/occdev";
const splitTarget = "TestOpenShellArchiveBoundsAStalledAttempt";

test("split Go reporting preserves real package selection and failures", async (t) => {
  for (const scenario of [
    "pass",
    "target-fail",
    "target-skip",
    "remainder-fail",
    "remainder-skip",
    "missing",
    "build",
  ]) {
    await t.test(scenario, async (t) => {
      const root = await temporaryDirectory(t, "ci-go-split-");
      // A nested module keeps discovery independent of both the checkout and its
      // parent module. The sibling's identical test name must remain selected.
      await writeFile(join(root, "go.mod"), "module example.test/parent\n\ngo 1.21\n");
      const cwd = join(root, "nested");
      await mkdir(join(cwd, "internal", "occdev"), { recursive: true });
      await mkdir(join(cwd, "sibling"));
      await mkdir(join(cwd, "notests"));
      await writeFile(
        join(cwd, "go.mod"),
        "module github.com/openclaw/openclaw-enterprise\n\ngo 1.21\n",
      );
      await writeFile(join(cwd, "notests", "empty.go"), "package notests\n");
      await writeFile(
        join(cwd, "sibling", "sibling_test.go"),
        `package sibling
import "testing"
func ${splitTarget}(t *testing.T) {}
`,
      );
      await writeFile(
        join(cwd, "internal", "occdev", "archive_test.go"),
        `package occdev
import (
  "testing"
  "os"
)
func ${scenario === "missing" ? "TestDifferent" : splitTarget}(t *testing.T) {
  switch os.Getenv("SPLIT_SCENARIO") {
  case "target-fail": t.Fatal("target failure evidence")
  case "target-skip": t.Skip("target skip evidence")
  }
  t.Run("child", func(t *testing.T) {})
}
func TestRemainder(t *testing.T) {
  switch os.Getenv("SPLIT_SCENARIO") {
  case "remainder-fail": t.Fatal("remainder failure evidence")
  case "remainder-skip": t.Skip("remainder skip evidence")
  }
}
`,
      );
      if (scenario === "build") {
        await writeFile(
          join(cwd, "sibling", "broken.go"),
          "package sibling\nvar _ = missingBuildValue\n",
        );
      }
      const result = await goTest(cwd, {
        args: ["--split-stalled-archive"],
        env: { SPLIT_SCENARIO: scenario },
      });
      assert.equal(result.code, scenario === "pass" ? 0 : 1, result.stdout + result.stderr);
      if (scenario === "pass") {
        assert.match(result.stdout, /go-test: 4 passed, 0 failed, 0 skipped/);
        assert.match(result.stdout, /notests\s+\[no test files\]/);
      } else if (scenario.endsWith("fail")) {
        assert.match(result.stdout, /(?:target|remainder) failure evidence/);
      } else if (scenario.endsWith("skip")) {
        assert.match(result.stdout, /(?:target|remainder) skip evidence/);
        assert.match(result.stderr, /skipped test did not run/);
      } else if (scenario === "build") {
        assert.match(result.stdout + result.stderr, /undefined: missingBuildValue/);
      } else {
        assert.match(result.stderr, /Isolated target/);
      }
    });
  }
});

test("split Go reporting rejects invalid protocol evidence and observes child failures", async (t) => {
  for (const scenario of [
    "pass",
    "malformed",
    "malformed-terminal",
    "wrong",
    "wrong-package",
    "duplicate",
    "missing-terminal",
    "missing-package",
    "no-tests",
    "empty-remainder",
    "omit-sibling",
    "duplicate-sibling",
    "duplicate-remainder",
    "foreign-terminal",
    "foreign-sibling",
    "skip-remainder",
    "skip-sibling",
    "remainder-target",
    "package-fail",
    "signal",
    "cancel",
    "spawn",
  ]) {
    await t.test(scenario, async (t) => {
      const root = await temporaryDirectory(t, "ci-go-split-events-");
      // This simulates only the Go JSON/process boundary; real selection and
      // execution are covered by the nested module above.
      await writeCommand(
        root,
        "go",
        `
const fs = require("node:fs");
const args = process.argv.slice(2);
const pkg = ${JSON.stringify(splitPackage)};
const target = ${JSON.stringify(splitTarget)};
const scenario = ${JSON.stringify(scenario)};
if (args[0] === "list") {
  if (JSON.stringify(args) !== JSON.stringify(["list", "./..."])) process.exit(9);
  console.log(pkg + "\\nexample.test/other\\nexample.test/sibling");
  if (scenario === "spawn") fs.unlinkSync(__filename);
} else {
  const isolated = args.includes("-run");
  const remainder = args.includes("-skip");
  const packageName = isolated || remainder ? pkg : "example.test/other";
  const name = isolated || (remainder && scenario === "remainder-target") ? target : "TestOther";
  const emit = (event) => console.log(JSON.stringify({ Package: packageName, ...event }));
  // Wait for all three processes before producing records. A serialized runner
  // cannot complete this handshake. Each child acknowledges cleanup on errors.
  const role = isolated ? "isolated" : remainder ? "remainder" : "other";
  fs.writeFileSync(role, "started");
  process.on("SIGTERM", () => {
    console.error(role + " observed termination");
    process.exit(0);
  });
  const timer = setInterval(() => {
    if (!["isolated", "remainder", "other"].every((file) => fs.existsSync(file))) return;
    clearInterval(timer);
    console.error(role + " stderr evidence");
    if (scenario === "cancel") {
      if (isolated) process.kill(process.ppid, "SIGTERM");
      // Stay alive until the reporter forwards cancellation to every child.
      setInterval(() => {}, 1000);
      return;
    }
    if (remainder && scenario === "empty-remainder") return;
    if (!isolated && !remainder && scenario !== "omit-sibling") {
      const sibling = scenario === "duplicate-sibling" ? packageName : "example.test/sibling";
      emit({Action: scenario === "skip-sibling" ? "skip" : "pass", Package: sibling});
      if (scenario === "foreign-sibling") emit({Action: "pass", Package: pkg, Test: "TestForeign"});
    }
    if (remainder && scenario === "skip-remainder") { emit({Action: "skip"}); return; }
    if (remainder && scenario === "duplicate-remainder") emit({Action: "pass"});
    if (!isolated && !remainder && scenario === "foreign-terminal") emit({Action: "pass", Package: pkg});
    if (isolated && scenario === "signal") {
      process.kill(process.pid, "SIGKILL");
      return;
    }
    if (isolated && scenario === "malformed") { console.log("{broken"); return; }
    if (isolated && scenario === "malformed-terminal") { emit({Action: "pass", Test: null}); return; }
    if (isolated && scenario === "wrong-package") { emit({Action: "pass", Package: "wrong/package", Test: target}); return; }
    if (isolated && scenario === "no-tests") emit({Action: "output", Output: "warning: no tests to run\\n"});
    if (!(isolated && scenario === "missing-terminal")) {
      emit({Action: "pass", Test: isolated && scenario === "wrong" ? "TestWrong" : name});
    }
    if (isolated && scenario === "duplicate") emit({Action: "pass", Test: name});
    if (!(isolated && scenario === "missing-package")) {
      emit({Action: scenario === "package-fail" && !isolated ? "fail" : "pass"});
    }
  }, 10);
}
`,
        { interpreter: process.execPath },
      );
      const result = await goTest(root, {
        args: ["--split-stalled-archive"],
        env: { PATH: root },
      });
      assert.equal(result.code, scenario === "pass" ? 0 : 1, result.stdout + result.stderr);
      if (scenario === "spawn") {
        assert.equal(result.stderr.match(/Error: spawn go ENOENT/g)?.length, 3, result.stderr);
      } else {
        for (const role of ["isolated", "remainder", "other"]) {
          assert.match(result.stderr, new RegExp(`${role} (stderr evidence|observed termination)`));
        }
      }
      if (scenario === "pass") {
        assert.match(result.stdout, /go-test: 3 passed, 0 failed, 0 skipped/);
      }
    });
  }
  await t.test("missing go binary", async (t) => {
    const root = await temporaryDirectory(t, "ci-go-split-missing-");
    const result = await goTest(root, {
      args: ["--split-stalled-archive"],
      env: { PATH: root },
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ENOENT/);
  });
});
