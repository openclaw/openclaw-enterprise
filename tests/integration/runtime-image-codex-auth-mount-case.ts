import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { image, runDocker } from "../helpers/runtime-image-startup.mjs";

export async function verifyRuntimeCodexAuthMount(
  t: TestContext,
  syntheticCodexApiKey: string,
): Promise<void> {
  const containerName = `oce-runtime-image-codex-auth-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));

  const probe = String.raw`
set -eu
printf "%s\n" "$SYNTHETIC_CODEX_API_KEY" | timeout ${20 * imageSmokeTimeoutMultiplier}s codex login --with-api-key >/tmp/codex-login.stdout 2>/tmp/codex-login.stderr || {
  status=$?
  # 124: timeout stopped codex login. Its output may be empty, so name the status.
  echo "codex login exited $status" >&2
  sed -E "s/sk-[A-Za-z0-9_-]+/[REDACTED_SYNTHETIC_KEY]/g" /tmp/codex-login.stdout /tmp/codex-login.stderr >&2
  exit 1
}
node - <<'NODE'
const { accessSync, constants, statSync } = require("node:fs");
function entry(path) {
  const stat = statSync(path);
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: (stat.mode & 0o777).toString(8),
    directory: stat.isDirectory(),
    file: stat.isFile(),
  };
}
accessSync("/home/node/.codex", constants.W_OK);
accessSync("/home/node/.codex/generated_images", constants.W_OK);
process.stdout.write(JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  codexHome: entry("/home/node/.codex"),
  generatedImages: entry("/home/node/.codex/generated_images"),
  authJson: entry("/home/node/.codex/auth.json"),
}));
NODE
`;

  const { stdout } = await runDocker(
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/home/node/.codex/generated_images:size=64m,uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
      "--network",
      "none",
      "-e",
      "HOME=/home/node",
      "-e",
      "CODEX_HOME=/home/node/.codex",
      "-e",
      `SYNTHETIC_CODEX_API_KEY=${syntheticCodexApiKey}`,
      "--entrypoint",
      "sh",
      image,
      "-c",
      probe,
    ],
    { timeout: 30_000 * imageSmokeTimeoutMultiplier, redact: [syntheticCodexApiKey] },
  );

  const result: unknown = JSON.parse(stdout);
  assert.ok(
    result !== null &&
      typeof result === "object" &&
      "uid" in result &&
      "gid" in result &&
      "codexHome" in result &&
      "generatedImages" in result &&
      "authJson" in result,
  );
  assert.equal(result.uid, 1000);
  assert.equal(result.gid, 1000);
  assert.deepEqual(result.codexHome, {
    uid: 1000,
    gid: 1000,
    mode: "700",
    directory: true,
    file: false,
  });
  assert.deepEqual(result.generatedImages, {
    uid: 1000,
    gid: 1000,
    mode: "700",
    directory: true,
    file: false,
  });
  assert.deepEqual(result.authJson, {
    uid: 1000,
    gid: 1000,
    mode: "600",
    directory: false,
    file: true,
  });
}
