import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("image lanes reuse compatible skopeo when package installation is unavailable", async (t) => {
  const bin = await temporaryDirectory(t, "ci-registry-transport-");
  await writeCommand(bin, "timeout", 'shift 2\nexec "$@"');
  await writeCommand(bin, "skopeo", '[ "$1" = --version ] && echo "skopeo version $VERSION"');
  await writeCommand(bin, "sudo", "exit 42");

  for (const [lane, version, status] of [
    ["images-packaging", "1.13.3", 0],
    ["images-packaging", "1.20.0", 42],
    ["images-runtime-startup", "1.20.0", 0],
  ] as const) {
    const result = spawnSync("/bin/bash", ["scripts/ci/setup-registry-transport.sh", lane], {
      cwd: new URL("../../", import.meta.url),
      env: { PATH: bin, VERSION: version },
      encoding: "utf8",
    });
    assert.equal(result.status, status, `${lane} with skopeo ${version}: ${result.stderr}`);
  }
});

test(
  "registry setup stops before installation when the package update times out",
  {
    skip: process.platform === "linux" ? false : "APT setup runs on Linux",
  },
  async (t) => {
    const bin = await temporaryDirectory(t, "ci-registry-timeout-");
    const calls = join(bin, "package-calls");
    await writeCommand(bin, "skopeo", "exit 1");
    await writeCommand(bin, "sudo", 'shift\nexec "$@"');
    // Shorten the production deadlines, retaining GNU timeout's real termination
    // and exit status. Package commands are disposable; no system packages change.
    await writeCommand(bin, "timeout", 'shift 2\nexec /usr/bin/timeout --kill-after=1s 1s "$@"');
    await writeCommand(bin, "apt-get", "/bin/sleep 2", { log: calls });

    const result = spawnSync(
      "/bin/bash",
      ["scripts/ci/setup-registry-transport.sh", "images-packaging"],
      {
        cwd: new URL("../../", import.meta.url),
        env: { PATH: bin },
        encoding: "utf8",
        timeout: 8_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 124, result.stderr);
    const packageCalls = await commandCalls(calls);
    assert.equal(packageCalls.length, 1, "A timed-out update must prevent installation");
    assert.match(packageCalls.join("\n"), / update$/);
  },
);
