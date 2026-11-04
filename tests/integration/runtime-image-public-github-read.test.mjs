import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { pluginRuntimeConfigMapData } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import {
  codexPublicGithubRead,
  PUBLIC_GITHUB_READ_SKILL,
} from "../../apps/controller/src/drivers/repo/github/public-read/codex.ts";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import {
  image,
  imageTestOptions,
  reviewedCodexSeccompSecurityOptions,
  runDocker,
  waitForDockerLog,
} from "../helpers/runtime-image-startup.mjs";

// Runs in the reader container. Only GitHub's address and trust root are substituted;
// the real reader constructs the request and verifies the provider's TLS identity.
async function readerWithPrivateProvider() {
  const assert = (await import("node:assert/strict")).default;
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const https = (await import("node:https")).default;
  const name = "api.github.com";
  const keyFile = "/tmp/provider.key";
  const certFile = "/tmp/provider.pem";
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=" + name,
      "-addext",
      "subjectAltName=DNS:" + name,
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certFile);
  const provider = https.createServer({ key: readFileSync(keyFile), cert }, (req, res) => {
    assert.equal(req.socket.servername, name);
    assert.equal(req.headers.authorization ?? req.headers.cookie, undefined);
    assert.equal(req.url, "/repos/example/public-project/pulls/27");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ title: process.argv[1] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { createConnection } = https.Agent.prototype;
  https.Agent.prototype.createConnection = function (options, callback) {
    assert.equal(options.host, name);
    assert.equal(options.port, 443);
    return createConnection.call(
      this,
      { ...options, host: "127.0.0.1", port: provider.address().port, servername: name, ca: cert },
      callback,
    );
  };
  const { createPublicGithubReadServer } = await import("/tmp/public-read.ts");
  createPublicGithubReadServer().listen(8080, () => console.log("public-reader-ready"));
}

// Runs as the stock runtime user with the reviewed seccomp profile. Resolve the real
// OpenClaw permission profile, then give it to Codex command/exec without a model turn.
async function readWithStockCodex() {
  const assert = (await import("node:assert/strict")).default;
  const { mkdirSync, readdirSync } = await import("node:fs");
  const { resolveProviderIdForAuth } = await import("openclaw/plugin-sdk/provider-auth-aliases");
  const { pluginConfig, skillPath } = JSON.parse(process.argv[1]);
  const workspace = "/home/node/workspace";
  mkdirSync(workspace, { recursive: true });
  const dist = "/app/node_modules/openclaw/dist/";
  async function bundledFunction(chunk, name) {
    const file = readdirSync(dist).find((file) => file.startsWith(chunk + "-"));
    const exports = await import(dist + file);
    return Object.values(exports).find(
      (value) => typeof value === "function" && value.name === name,
    );
  }
  const appServerConfig = await bundledFunction("config-options", "createCodexAppServerConfig");
  const { resolveCodexAppServerRuntimeOptions } = appServerConfig({ resolveProviderIdForAuth });
  const {
    start,
    networkProxy: { profileName, configPatch },
  } = resolveCodexAppServerRuntimeOptions({
    pluginConfig,
    env: {
      OPENCLAW_CODEX_APP_SERVER_BIN: "codex",
      OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server --listen stdio://",
    },
  });
  const { filesystem, network } = configPatch.permissions[profileName];
  assert.equal(filesystem[skillPath], "read");
  assert.equal(network.mode, "limited");
  assert.equal(network.allow_local_binding, false);
  function toml(value) {
    return value !== null && typeof value === "object"
      ? "{ " +
          Object.entries(value)
            .map(([key, child]) => JSON.stringify(key) + " = " + toml(child))
            .join(", ") +
          " }"
      : JSON.stringify(value);
  }
  const overrides = Object.entries(configPatch).flatMap(([key, value]) => [
    "-c",
    key + "=" + toml(value),
  ]);
  const createClient = await bundledFunction("shared-client", "createIsolatedCodexAppServerClient");
  const client = await createClient({
    agentDir: "/tmp/public-agent",
    authProfileId: null,
    startOptions: {
      ...start,
      args: [...start.args, ...overrides],
      env: { HOME: "/home/node", CODEX_HOME: "/tmp/public-codex" },
      clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
    },
  });
  try {
    // Read the endpoint from the projected managed skill, exactly as an Agent can.
    // The random title is present only at the provider, never in this command or its environment.
    const shell = [
      'test "$CODEX_NETWORK_PROXY_ACTIVE" = 1',
      'test "$CODEX_NETWORK_ALLOW_LOCAL_BINDING" = 0',
      'origin=$(grep -Eo "http://[0-9.]+:8080" "$1")',
      'curl -q --proxy "$HTTP_PROXY" --noproxy "" --fail-with-body -sS --max-time 15 "$origin/repos/example/public-project/pulls/27"',
    ].join("\n");
    const result = await client.request("command/exec", {
      permissionProfile: profileName,
      cwd: workspace,
      command: ["/bin/sh", "-eu", "-c", shell, "public-read", skillPath],
    });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    console.log(JSON.stringify(JSON.parse(result.stdout)));
  } finally {
    client.close();
  }
}

test(
  "stock Codex reads the projected public GitHub skill and returns a provider-only pull title",
  imageTestOptions,
  async (t) => {
    const security = await reviewedCodexSeccompSecurityOptions();
    const directory = await mkdtemp(join(tmpdir(), "oce-stock-public-read-"));
    const owner = "oce-public-read-" + randomUUID();
    const reader = owner + "-reader";
    const server = fileURLToPath(
      new URL(
        "../../apps/controller/src/drivers/repo/github/public-read/server.ts",
        import.meta.url,
      ),
    );
    const pullTitle = "public-pull-" + randomUUID();
    const isolated = [
      "--network",
      owner,
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
    ];
    await runDocker(["network", "create", "--internal", owner]);
    t.after(async () => {
      try {
        await runDocker(["rm", "-f", "-v", reader]);
      } finally {
        await runDocker(["network", "rm", owner]);
        await rm(directory, { recursive: true, force: true });
      }
    });
    const program = (fn) => "(" + fn.toString() + ")()";
    await runDocker([
      "run",
      "-d",
      "--name",
      reader,
      ...isolated,
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp",
      "-v",
      server + ":/tmp/public-read.ts:ro",
      "--entrypoint",
      "node",
      image,
      "-e",
      program(readerWithPrivateProvider),
      pullTitle,
    ]);
    await waitForDockerLog(reader, /public-reader-ready/);
    const { stdout } = await runDocker([
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      reader,
    ]);
    const address = stdout.trim();

    // Use the revision's actual ConfigMap producer and Gateway startup translator.
    // No repository binding, broker policy, GitHub credential or model credential is supplied.
    const proxy = {
      enabled: true,
      mode: "limited",
      allowLocalBinding: false,
      domains: { [address]: "allow" },
    };
    const publicGithubRead = codexPublicGithubRead(address, proxy);
    const projection = pluginRuntimeConfigMapData({
      kind: "codex",
      selections: {},
      publicGithubRead,
    });
    const { files } = runOpenClawRuntimeHelper(
      { manifest: JSON.parse(projection["runtime.json"]) },
      [],
      {
        baseConfig: {
          plugins: { entries: { codex: { config: { appServer: { networkProxy: proxy } } } } },
        },
      },
    );
    const { config: pluginConfig } = JSON.parse(files.get("/home/node/.openclaw/openclaw.json"))
      .plugins.entries.codex;
    const skill = join(directory, "SKILL.md");
    const { skillPath } = publicGithubRead;
    await writeFile(skill, projection[PUBLIC_GITHUB_READ_SKILL]);
    const proof = await runDocker([
      "run",
      "--rm",
      ...isolated,
      ...security,
      "--tmpfs",
      "/home/node:size=128m,uid=1000,gid=1000,mode=700",
      // Compute's private-home initializer owns this parent before the skill is mounted.
      "--tmpfs",
      "/home/node/.openclaw:size=64m,uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/tmp",
      "-v",
      skill + ":" + skillPath + ":ro",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      program(readWithStockCodex),
      JSON.stringify({ pluginConfig, skillPath }),
    ]);
    assert.deepEqual(JSON.parse(proof.stdout), { title: pullTitle });
  },
);
