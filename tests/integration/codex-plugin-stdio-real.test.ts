import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import { CODEX_PLUGIN_STDIO_HELPER } from "../../apps/controller/src/drivers/compute/kubernetes/codex-plugin-stdio.ts";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

test(
  "native stdio plugin preparation survives WebSocket replacement and drains failed installation",
  { skip: !process.env.OCC_TEST_RUNTIME_IMAGE, timeout: 120_000 },
  async (t) => {
    // CI supplies an owned local tag. Resolve it once and run the immutable image ID.
    const { stdout } = await promisify(execFile)(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", "--", process.env.OCC_TEST_RUNTIME_IMAGE!],
      { encoding: "utf8", timeout: 15_000 },
    );
    const image = stdout.trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const name = `oce-stdio-plugin-${randomUUID()}`;
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--entrypoint",
        "node",
        image,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(async () => {
      const cleanup = spawn("docker", ["rm", "--force", name], { stdio: "ignore" });
      await once(cleanup, "exit");
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    // Exercise the production stdio session with an actual native local package.
    // The remote catalog and protected-proxy path have separate OpenShell QA proof.
    child.stdin.end(String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createHash, randomBytes } = require("node:crypto");
process.env.CODEX_HOME = "/tmp/stdio-home";
process.env.OPENCLAW_WORKSPACE_DIR = "/tmp/workspace";
process.env.APP_SERVER_PORT = "4500";
process.env.APP_SERVER_TOKEN = randomBytes(32).toString("hex");
for (const path of [process.env.CODEX_HOME, "/tmp/workspace/.git", "/tmp/workspace/.agents/plugins", "/tmp/workspace/sample/.codex-plugin"]) fs.mkdirSync(path, { recursive: true });
fs.writeFileSync(process.env.CODEX_HOME + "/config.toml", "[features]\nplugins = true\napps = true\n");
fs.writeFileSync("/tmp/workspace/sample/.codex-plugin/plugin.json", JSON.stringify({ name: "sample" }));
fs.writeFileSync("/tmp/workspace/sample/.app.json", JSON.stringify({ apps: {} }));
fs.writeFileSync("/tmp/workspace/.agents/plugins/marketplace.json", JSON.stringify({
  name: "stdio-proof", plugins: [{ name: "sample", source: { source: "local", path: "./sample" } }],
}));
const params = { marketplacePath: "/tmp/workspace/.agents/plugins/marketplace.json", pluginName: "sample" };
const env = { PATH: process.env.PATH, HOME: "/tmp", CODEX_HOME: process.env.CODEX_HOME };
const options = { env, cwd: "/tmp/workspace" };
${PLUGIN_RUNTIME_HELPERS}
${CODEX_PLUGIN_STDIO_HELPER}
(async () => {
  await withCodexPluginStdio("codex", ["app-server"], options, async (request) => {
    // These shared installer helpers must use stdio before any WebSocket exists.
    const configuration = {
      features: { apps: true, plugins: true, remote_plugin: true },
      apps: { _default: { enabled: false } },
      plugins: { _default: { enabled: false }, "sample@stdio-proof": { enabled: true } },
    };
    await writeCodexPluginConfiguration(configuration, request);
    verifyCodexPluginConfiguration(configuration, await readCodexPluginConfiguration(request));
    const read = await request("plugin/read", params);
    assert.equal(read.plugin.summary.installed, false);
    await request("plugin/install", params);
  });
  assert.equal(spawnSync("pgrep", ["-f", "codex.*app-server"]).status, 1, "temporary native process must exit");
  const digest = createHash("sha256").update(process.env.APP_SERVER_TOKEN).digest("hex");
  const final = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:4500", "--ws-auth", "capability-token", "--ws-token-sha256", digest], {
    ...options, env: { ...env, APP_TOKEN_SHA: digest }, stdio: "ignore",
  });
  try {
    let detail;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { detail = await codexAppServerRequest("plugin/read", params); break; }
      catch { await pluginRuntimeDelay(100); }
    }
    assert.equal(detail?.plugin?.summary?.installed, true, "replacement discovers the installed package without reinstalling");
    assert.equal(detail.plugin.summary.enabled, true);
    const installed = await codexAppServerRequest("plugin/installed", { cwds: ["/tmp/workspace"] });
    assert.ok(installed.marketplaces.some(market => market.plugins.some(plugin => plugin.id === "sample@stdio-proof")));
  } finally {
    const exited = once(final, "exit");
    final.kill("SIGTERM");
    await exited;
  }
  // A real native install error must close the temporary process, not leave it
  // writing into a home that a replacement process could use.
  await assert.rejects(withCodexPluginStdio("codex", ["app-server"], options, request =>
    request("plugin/install", { ...params, pluginName: "missing" })), error => {
      assert.equal(error.preparation.method, "plugin/install");
      assert.equal(Number.isSafeInteger(error.preparation.rpcCode), true);
      return true;
    });
  assert.equal(spawnSync("pgrep", ["-f", "codex.*app-server"]).status, 1);
  // Deliver the launcher's termination event with a real native request pending.
  // This checks process cleanup on cancellation, not loss of a controller lease.
  await assert.rejects(withCodexPluginStdio("codex", ["app-server"], options, request => {
    const pending = request("plugin/read", params);
    process.emit("SIGTERM");
    return pending;
  }), error => error.preparation.reason === "cancelled");
  assert.equal(spawnSync("pgrep", ["-f", "codex.*app-server"]).status, 1);
  console.log(JSON.stringify({ installed: true, replacementDiscovery: true, failedInstallDrained: true, cancellationDrained: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output.trim()), {
      installed: true,
      replacementDiscovery: true,
      failedInstallDrained: true,
      cancellationDrained: true,
    });
  },
);
