import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeCommand } from "../helpers/fake-commands.ts";
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
