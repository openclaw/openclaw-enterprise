import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CODEX_PLUGIN_STDIO_HELPER } from "../../apps/controller/src/drivers/compute/kubernetes/codex-plugin-stdio.ts";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  cleanEnvironment,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

test("stdio retains only fixed native install classifications after draining stderr", async (t) => {
  const directory = await temporaryDirectory(t, "oce-stdio-classification-");
  const fixture = join(directory, "classified-peer.cjs");
  const unsafeText = syntheticCredentialUrl({
    username: "fixture-user",
    password: "fixture-secret",
    host: "example.invalid",
    port: undefined,
    pathname: "/private-bundle",
    search: "?signed=do-not-export",
  });
  // This peer tests the real pipes and diagnostic boundary, not a remote install.
  // A warning can arrive after its RPC error; drain it without retaining its text.
  await writeFile(
    fixture,
    String.raw`
const { createInterface } = require("node:readline");
process.once("SIGTERM", () => {
  process.stderr.write("x".repeat(70 * 1024) + "\n");
  const record = {
    level: "WARN", target: "codex_app_server::request_processors::plugins",
    fields: {
      message: "remote plugin install failed", error_type: "remote_bundle_download_status",
      sub_error_type: "http_403", error: process.env.UNSAFE_DIAGNOSTIC_TEXT,
      remote_plugin_id: "do-not-export-native-id", marketplace_name: "do-not-export-marketplace",
    },
  };
  const line = JSON.stringify(record) + "\n";
  process.stderr.write(line.slice(0, 17));
  process.stderr.write(line.slice(17));
  process.stderr.write(JSON.stringify({ ...record, fields: { ...record.fields, remote_plugin_id: "another-plugin", error_type: "remote_catalog_auth_token" } }) + "\n");
  process.stderr.write(JSON.stringify({ ...record, fields: { ...record.fields, error_type: "do-not-export-unknown-type" } }) + "\n");
  process.stderr.write(JSON.stringify({ ...record, fields: { ...record.fields, message: "unrelated warning", error_type: "remote_catalog_auth_token" } }) + "\n");
  if (process.argv[2] === "unknown-subtype") process.stderr.write(JSON.stringify({ ...record, fields: { ...record.fields, sub_error_type: process.env.UNSAFE_DIAGNOSTIC_TEXT } }) + "\n");
  setTimeout(() => process.exit(0), 20);
});
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") process.stdout.write(JSON.stringify({ id, result: {} }) + "\n");
  else if (method === "plugin/install") process.stdout.write(JSON.stringify({ id, error: {
    code: -32603, message: process.env.UNSAFE_DIAGNOSTIC_TEXT,
    data: { private: "do-not-export-native-data" },
  } }) + "\n");
});
`,
  );
  const prepare = new Function(
    "require",
    `${PLUGIN_RUNTIME_HELPERS}\n${CODEX_PLUGIN_STDIO_HELPER}\nreturn withCodexPluginStdio;`,
  )(createRequire(import.meta.url));
  for (const unknownSubtype of [false, true]) {
    await assert.rejects(
      prepare(
        process.execPath,
        [fixture, ...(unknownSubtype ? ["unknown-subtype"] : [])],
        { cwd: directory, env: { ...cleanEnvironment(), UNSAFE_DIAGNOSTIC_TEXT: unsafeText } },
        (request: (method: string, params: unknown) => Promise<unknown>) =>
          request("plugin/install", {
            remoteMarketplaceName: "do-not-export-marketplace",
            pluginName: "do-not-export-native-id",
          }),
      ),
      (error) => {
        assert.ok(error instanceof Error && "preparation" in error);
        const diagnostic = error.preparation as Record<string, unknown>;
        assert.equal(diagnostic.method, "plugin/install");
        assert.equal(diagnostic.rpcCode, -32603);
        assert.equal(diagnostic.nativeErrorType, "remote_bundle_download_status");
        assert.equal(diagnostic.nativeSubErrorType, unknownSubtype ? undefined : "http_403");
        assert.equal(diagnostic.exitCode, 0);
        assert.doesNotMatch(
          JSON.stringify(diagnostic),
          /fixture-secret|signed=|do-not-export|example[.]invalid/,
        );
        return true;
      },
    );
  }
});

test("stdio failure diagnostics count reply IDs without exporting native payloads", async (t) => {
  const directory = await temporaryDirectory(t, "oce-stdio-observations-");
  const fixture = join(directory, "protocol-fixture.cjs");
  // This process is a malformed-peer protocol fixture, not native catalog proof.
  // Valid but unmatched IDs must remain visible by type without retaining values.
  await writeFile(
    fixture,
    String.raw`
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") {
    process.stdout.write(JSON.stringify({ id, result: {} }) + "\n");
  } else if (method === "plugin/search") {
    for (const unmatched of [String(id), null, true, id + 100]) {
      process.stdout.write(JSON.stringify({ id: unmatched, result: "do-not-export-native-payload" }) + "\n");
    }
    if (process.argv[2] !== "pending") {
      process.stderr.write("do-not-export-native-stderr\n");
      process.stdout.write(JSON.stringify({ id, error: { code: -32000, message: "do-not-export-native-error" } }) + "\n");
    }
  } else if (method === "account/read") {
    process.stdout.write(JSON.stringify({ id, result: { account: null } }) + "\n");
  }
});
`,
  );
  const prepare = new Function(
    "require",
    `${PLUGIN_RUNTIME_HELPERS}\n${CODEX_PLUGIN_STDIO_HELPER}\nreturn withCodexPluginStdio;`,
  )(createRequire(import.meta.url));
  await assert.rejects(
    prepare(
      process.execPath,
      [fixture],
      { cwd: directory, env: cleanEnvironment() },
      (request: (method: string, params: unknown) => Promise<unknown>) =>
        request("plugin/search", { searchTerm: "fixture", scope: "global", limit: 100 }),
    ),
    (error) => {
      assert.ok(error instanceof Error && "preparation" in error);
      const diagnostic = error.preparation as Record<string, unknown>;
      assert.deepEqual(diagnostic, {
        reason: "rpc",
        method: "plugin/search",
        rpcCode: -32000,
        catalogQueued: true,
        catalogWriteComplete: true,
        catalogReplyMatched: true,
        stdoutMessages: 6,
        matchedReplyEnvelopes: 2,
        unmatchedNumberIds: 1,
        unmatchedStringIds: 1,
        unmatchedNullIds: 1,
        unmatchedOtherIds: 1,
        catalogPending: false,
        exitCode: undefined,
        signal: "SIGTERM",
      });
      assert.doesNotMatch(JSON.stringify(diagnostic), /do-not-export-native/);
      return true;
    },
  );
  // A later matched read drains the earlier fixture messages without answering
  // the catalog request. Cancellation must retain that pending distinction.
  await assert.rejects(
    prepare(
      process.execPath,
      [fixture, "pending"],
      { cwd: directory, env: cleanEnvironment() },
      async (request: (method: string, params: unknown) => Promise<unknown>) => {
        const catalog = request("plugin/search", {
          searchTerm: "fixture",
          scope: "global",
          limit: 100,
        });
        await request("account/read", { refreshToken: false });
        process.emit("SIGTERM");
        return catalog;
      },
    ),
    (error) => {
      assert.ok(error instanceof Error && "preparation" in error);
      const diagnostic = error.preparation as Record<string, unknown>;
      assert.equal(diagnostic.reason, "cancelled");
      assert.equal(diagnostic.catalogQueued, true);
      assert.equal(diagnostic.catalogWriteComplete, true);
      assert.equal(diagnostic.catalogReplyMatched, false);
      assert.equal(diagnostic.catalogPending, true);
      assert.equal(diagnostic.stdoutMessages, 6);
      assert.equal(diagnostic.matchedReplyEnvelopes, 2);
      assert.doesNotMatch(JSON.stringify(diagnostic), /do-not-export-native/);
      return true;
    },
  );
});

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
  // This offline native failure occurs before HTTP: its fresh home has no login.
  // It verifies the real binary's JSON warning format, not remote installation.
  await assert.rejects(withCodexPluginStdio("codex", ["app-server"], options, async request => {
    const account = await request("account/read", { refreshToken: false });
    assert.equal(account.account, null);
    return request("plugin/install", { remoteMarketplaceName: "openai-curated-remote", pluginName: "unauthed-diagnostic" });
  }), error => {
    assert.equal(error.preparation.nativeErrorType, "remote_catalog_auth_required");
    assert.equal(error.preparation.nativeSubErrorType, undefined);
    assert.doesNotMatch(JSON.stringify(error.preparation), /stdio-home|unauthed-diagnostic/);
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
