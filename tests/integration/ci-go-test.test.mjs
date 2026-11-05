import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { commandPath, writeCommand } from "../helpers/fake-commands.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// scripts/ci/go-test.mjs gates the Go CLI tests in CI. These cases run it over a
// scratch module, one package directory at a time: the script tests "./...", so
// the working directory picks the packages.
const script = fileURLToPath(new URL("../../scripts/ci/go-test.mjs", import.meta.url));
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

async function fixtureModule(t) {
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

async function goTest(cwd, { env = {}, args = [] } = {}) {
  const options = {
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
    assert.equal(error.signal, null, `go-test.mjs was killed: ${error.stderr}`);
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

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
