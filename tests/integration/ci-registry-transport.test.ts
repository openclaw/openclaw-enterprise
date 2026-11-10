import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, type TestContext } from "node:test";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const script = fileURLToPath(
  new URL("../../scripts/ci/setup-registry-transport.sh", import.meta.url),
);

async function fixture(t: TestContext, installed?: string) {
  const root = await temporaryDirectory(t, "ci-registry-transport-");
  const calls = join(root, "apt-calls");
  // Restrict PATH so a host installation cannot turn the missing-tool case into a hit.
  await symlink("/usr/bin/timeout", join(root, "timeout"));
  await writeCommand(root, "sudo", '[ "$1" = -n ] && shift; exec "$@"');
  await writeCommand(root, "candidate", 'printf "skopeo version %s\\n" "$INSTALLED_VERSION"');
  if (installed) {
    await writeCommand(root, "skopeo", installed);
  }
  await writeCommand(
    root,
    "apt-get",
    `
for arg do
  case "$arg" in update|install) operation="$arg";; esac
done
echo "APT $operation diagnostic" >&2
if [ "$operation" = "$FAIL_AT" ]; then exit 42; fi
if [ "$operation" = "$STALL_AT" ]; then
  if [ "$IGNORE_TERM" = 1 ]; then trap '' TERM; fi
  exec /bin/sleep 600
fi
if [ "$operation" = install ]; then /bin/cp "$FIXTURE_ROOT/candidate" "$FIXTURE_ROOT/skopeo"; fi
`,
    { log: calls },
  );
  return {
    calls,
    root,
    run(lane = "images-packaging", overrides: Record<string, string> = {}) {
      return new Promise<{ code: number | string | null; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            "/bin/bash",
            [script, lane],
            {
              env: {
                PATH: root,
                FIXTURE_ROOT: root,
                INSTALLED_VERSION: "1.13.3",
                ...overrides,
              },
              timeout: 145_000,
            },
            (error, stdout, stderr) =>
              resolve({ code: error ? (error.code ?? error.signal ?? null) : 0, stdout, stderr }),
          );
        },
      );
    },
  };
}

describe("registry transport setup", { concurrency: true }, () => {
  test("reuses the qualified packaging tool without APT", async (t) => {
    const f = await fixture(t, 'echo "skopeo version 1.13.3"');
    const result = await f.run("images-packaging", { FAIL_AT: "update" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skopeo version 1\.13\.3/);
    assert.deepEqual(await commandCalls(f.calls), []);
  });

  test("artifact consumers reuse a working version without the packaging pin", async (t) => {
    const f = await fixture(t, 'echo "skopeo version 1.20.0"');
    assert.equal((await f.run("images-runtime-startup")).code, 0);
    assert.deepEqual(await commandCalls(f.calls), []);
  });

  for (const [name, installed] of [
    ["missing", undefined],
    ["wrong version", 'echo "skopeo version 1.12.0"'],
    ["broken", 'echo "broken executable" >&2; exit 9'],
  ] as const) {
    test(`installs and verifies a ${name} packaging tool`, async (t) => {
      const f = await fixture(t, installed);
      const result = await f.run();
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /skopeo version 1\.13\.3/);
      const calls = await commandCalls(f.calls);
      assert.equal(calls.length, 2);
      assert.ok(calls[0]);
      assert.ok(calls[1]);
      assert.match(calls[0], / update$/);
      assert.match(calls[1], / install --no-install-recommends -y skopeo$/);
      for (const call of calls) {
        assert.match(call, /Acquire::Retries=3/);
        assert.match(call, /Acquire::http::Timeout=20/);
        assert.match(call, /Acquire::https::Timeout=20/);
        assert.match(call, /APT::Update::Error-Mode=any/);
        assert.doesNotMatch(call, /allow-unauthenticated|AllowInsecure|sourcelist/);
      }
    });
  }

  test("rejects a wrong version after installation", async (t) => {
    const f = await fixture(t);
    const result = await f.run("images-packaging", { INSTALLED_VERSION: "1.12.0" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Expected skopeo version 1\.13\.3/);
  });

  test("preserves a failed version probe after installation", async (t) => {
    const f = await fixture(t);
    await writeCommand(f.root, "candidate", 'echo "version probe failed" >&2; exit 9');
    const result = await f.run();
    assert.equal(result.code, 9);
    assert.match(result.stderr, /version probe failed/);
  });

  test("bounds a stalled installed version probe before repairing it", async (t) => {
    const f = await fixture(t, "exec /bin/sleep 600");
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await commandCalls(f.calls)).length, 2);
  });

  for (const operation of ["update", "install"]) {
    test(`preserves ${operation} failure and its original diagnostic`, async (t) => {
      const f = await fixture(t);
      const result = await f.run("images-packaging", { FAIL_AT: operation });
      assert.equal(result.code, 42);
      assert.match(result.stderr, new RegExp(`APT ${operation} diagnostic`));
      assert.equal((await commandCalls(f.calls)).length, operation === "update" ? 1 : 2);
    });

    test(`terminates a stalled ${operation} with the real APT deadline`, async (t) => {
      const f = await fixture(t);
      // The update fixture ignores TERM to exercise the hard-kill deadline too.
      const result = await f.run("images-packaging", {
        STALL_AT: operation,
        IGNORE_TERM: operation === "update" ? "1" : "0",
      });
      assert.equal(result.code, operation === "update" ? 137 : 124, result.stderr);
      assert.match(result.stderr, new RegExp(`APT ${operation} diagnostic`));
      assert.equal((await commandCalls(f.calls)).length, operation === "update" ? 1 : 2);
    });
  }
});
