// Runtime image workspace node and native worker smoke tests, split from
// runtime-image-startup-probe.test.mjs and runtime-image-startup.test.mjs so CI
// can run them beside runtime-image-startup.test.mjs: workspace node enrollment
// and reconnect, ephemeral native worker reconnect from an expired replayed
// setup code, and descendant reaping across workspace node and Codex restarts.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  image,
  imageTestOptions,
  runDocker,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

test(
  "runtime image enrolls the restricted workspace node and reconnects with saved credentials",
  imageTestOptions,
  async (t) => {
    // The Kubernetes entrypoint admits the workspace command grant before pairing.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-workspace-node.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 240_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterRestart, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.commands.length, 7);
  },
);

test(
  "runtime image reconnects an ephemeral native worker from an expired replayed setup code",
  imageTestOptions,
  async (t) => {
    // Pod restarts replay the enrollment Secret's setup code after its expiry.
    const configurationPath = await temporaryGatewayConfiguration(t, "codex");
    const { containerName } = await runGatewaySmoke(t, "codex", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    });
    const source = await readFile(
      new URL("../fixtures/runtime-native-worker-restart.mjs", import.meta.url),
      "utf8",
    );
    const { stdout } = await runDocker(
      ["exec", containerName, "node", "--input-type=module", "-e", source],
      { timeout: 300_000 * imageSmokeTimeoutMultiplier },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.sameIdentityAfterExpiredReplay, true);
    assert.equal(result.singleBootstrapCompletion, true);
    assert.equal(result.unpairedExpiredRejected, true);
  },
);

test(
  "runtime image reaps descendants during workspace node and Codex restarts",
  imageTestOptions,
  async (t) => {
    const containerName = `oce-runtime-image-supervisor-${randomBytes(6).toString("hex")}`;
    t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
    // Run the same process proof inside the image, using the production init
    // command. Copy source over argv so this also works with a remote Docker engine.
    const paths = [
      "tests/conformance/workspace-node-supervisor.test.mjs",
      "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
      "apps/controller/src/drivers/compute/node-program.ts",
      "apps/controller/src/drivers/plugin/runtime-translator.ts",
    ];
    const files = await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
      ]),
    );
    const launch = String.raw`
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
for (const [relative, content] of JSON.parse(readFileSync(0, "utf8"))) {
  const target = join("/tmp/proof", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const child = spawnSync(process.execPath, ["--test", "/tmp/proof/tests/conformance/workspace-node-supervisor.test.mjs"], { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
    const { stdout } = await runDocker(
      [
        "run",
        "-i",
        "--rm",
        "--name",
        containerName,
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--entrypoint",
        "/usr/bin/tini",
        image,
        "-s",
        "--",
        "node",
        "-e",
        launch,
      ],
      {},
      JSON.stringify(files),
    );
    // All supervisor proofs: environment and file-delivered node setup, a
    // failed saved-identity probe that is retried, and a stop with no child.
    assert.match(stdout, /\bpass 4\b/);
    assert.match(stdout, /\bfail 0\b/);
    assert.match(stdout, /skipped 0/);
  },
);
