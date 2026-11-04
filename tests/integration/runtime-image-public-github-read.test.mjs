import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { pluginRuntimeConfigMapData } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { PUBLIC_GITHUB_READ_SKILL } from "../../apps/controller/src/drivers/repo/github/public-read/codex.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { readPublicReadReceipts } from "../helpers/public-github-read-fixture.mjs";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";
import {
  image,
  imageTestOptions,
  reviewedCodexSeccompSecurityOptions,
  runDocker,
  waitForDockerLog,
} from "../helpers/runtime-image-startup.mjs";

// Exercise the exact setup inserted by the admitted production launcher, including
// its embedded helper bytes. No fixture-created helper path or permission grant.
const insertion = 'const pluginRuntime = readPluginRuntime("codex");';
const setupOffset = AGENT_RUNTIME_ENTRYPOINT.indexOf(insertion) + insertion.length;
const materialSetup = PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT.slice(
  setupOffset,
  PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT.length - (AGENT_RUNTIME_ENTRYPOINT.length - setupOffset),
);
assert.equal(
  AGENT_RUNTIME_ENTRYPOINT.slice(0, setupOffset) +
    materialSetup +
    AGENT_RUNTIME_ENTRYPOINT.slice(setupOffset),
  PUBLIC_GITHUB_READ_AGENT_ENTRYPOINT,
);

// Runs in the reader container. Only GitHub's address and trust root are substituted;
// the real reader constructs the request and verifies the provider's TLS identity.
async function readerWithPrivateProvider() {
  const assert = (await import("node:assert/strict")).default;
  const { writeFile } = await import("node:fs/promises");
  const { startPublicGithubProvider, publicProviderGit } =
    await import("/tmp/test-helpers/public-github-provider.mjs");
  const gitProvider = await startPublicGithubProvider({ after() {} }, { directory: "/tmp" });
  const source = await gitProvider.createRepository("example/public-project", {
    "readme.txt": process.argv[1] + "-first\n",
  });
  const https = (await import("node:https")).default;
  const { createHash } = await import("node:crypto");
  const { networkInterfaces } = await import("node:os");
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry.family === "IPv4" && !entry.internal).address;
  const name = "api.github.com";
  const { publicReaderTls, publicReadReceipts } =
    await import("/tmp/test-helpers/public-github-read-fixture.mjs");
  const observe = publicReadReceipts((line) => console.log(line));
  observe(gitProvider.provider, "git-provider");
  const { ca, cert, key } = await publicReaderTls(address, name);
  await writeFile("/tmp/provider.pem", ca);
  const provider = https.createServer({ key, cert }, async (req, res) => {
    assert.equal(req.socket.servername, name);
    assert.equal(req.headers.authorization ?? req.headers.cookie, undefined);
    assert.equal(req.url, "/repos/example/public-project/pulls/27");
    // The API read occurs between native clone and fetch and advances the real
    // upstream repository, so fetch must transfer a new object.
    await writeFile(source + "/readme.txt", process.argv[1] + "-second\n");
    await publicProviderGit(source, "commit", "-am", "Second object");
    await publicProviderGit(
      source,
      "push",
      gitProvider.root + "/example/public-project.git",
      "main",
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ title: process.argv[1] }));
  });
  observe(provider, "api-provider");
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const { createConnection } = https.Agent.prototype;
  https.Agent.prototype.createConnection = function (options, callback) {
    assert.ok([name, "github.com"].includes(options.host));
    assert.equal(options.port, 443);
    return createConnection.call(
      this,
      {
        ...options,
        host: "127.0.0.1",
        port: options.host === name ? provider.address().port : gitProvider.port,
        servername: options.host,
        ca: options.host === name ? ca : gitProvider.cert,
      },
      callback,
    );
  };
  const { createPublicGithubReadServer } = await import("/tmp/public-read/server.ts");
  const capability = process.env.OCE_TEST_PUBLIC_CAPABILITY;
  const revisionId = capability.split(".")[0];
  const policy = { mode: "repositories", repositories: ["example/public-project"] };
  const reader = createPublicGithubReadServer({
    tls: { cert, key },
    policy,
    loadAuthorizations: () => ({
      [revisionId]: {
        installationId: "ins_fixture",
        namespaceId: "ns_fixture",
        agentId: "agt_fixture",
        revisionId,
        tokenSha256: createHash("sha256").update(capability).digest("hex"),
        policy,
        validUntil: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
  });
  observe(reader, "reader");
  reader.listen(8080, () => console.log("public-reader-ready"));
}

// Runs as the stock runtime user with the reviewed seccomp profile. Resolve the real
// OpenClaw permission profile, then give it to Codex command/exec without a model turn.
async function readWithStockCodex() {
  const assert = (await import("node:assert/strict")).default;
  const { accessSync, constants, mkdirSync, readdirSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { pluginConfig, skillPath, materialSetup, manifest } = JSON.parse(process.argv[1]);
  new Function("require", "spawnSync", "pluginRuntime", materialSetup)(
    createRequire(import.meta.url),
    spawnSync,
    { manifest },
  );
  const publicEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key.startsWith("OCE_PUBLIC_GITHUB_") ||
        key === "CODEX_CA_CERTIFICATE" ||
        key === "GIT_EXEC_PATH" ||
        key === "PATH",
    ),
  );
  // Separate outer mount/access failures from the native sandbox checks below.
  // Catch filesystem errors so diagnostics contain fixed labels, never paths.
  for (const [label, path, mode] of [
    ["ca-readable", publicEnvironment.OCE_PUBLIC_GITHUB_READ_CA_FILE, constants.R_OK],
    ["config-readable", publicEnvironment.OCE_PUBLIC_GITHUB_READ_CONFIG, constants.R_OK],
    [
      "helper-executable",
      publicEnvironment.GIT_EXEC_PATH + "/git-remote-https",
      constants.R_OK | constants.X_OK,
    ],
    ["helper-source-readable", publicEnvironment.GIT_EXEC_PATH + "/transport.mjs", constants.R_OK],
  ]) {
    let accessible = false;
    try {
      accessSync(path, mode);
      accessible = true;
    } catch {
      // The fixed assertion below identifies the failed check without its error payload.
    }
    assert.ok(accessible, "public-git-outer-failed:" + label);
  }
  const { resolveProviderIdForAuth } = await import("openclaw/plugin-sdk/provider-auth-aliases");
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
  assert.equal(filesystem["/home/node/.oce-public-git"], "read");
  for (const key of [
    "OCE_PUBLIC_GITHUB_READ_CA_FILE",
    "OCE_PUBLIC_GITHUB_READ_CONFIG",
    "GIT_EXEC_PATH",
  ]) {
    assert.ok(publicEnvironment[key].startsWith("/home/node/.oce-public-git/"), key);
  }
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
      env: { HOME: "/home/node", CODEX_HOME: "/tmp/public-codex", ...publicEnvironment },
      clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
    },
  });
  try {
    // Discover the managed API operation in the projected skill, as an Agent can.
    // The random title is present only at the provider, never in this command or its environment.
    // Fixed stage names locate silent test/set -u exits without logging values,
    // paths, headers or commands. Some shells report status 0 to EXIT on set -u;
    // keep that premature exit a failure and remove the trap only after success.
    const shell = [
      "stage=proxy-active",
      `trap 'status=$?; printf "public-git-stage-failed:%s\\n" "$stage" >&2; if [ "$status" -eq 0 ]; then status=1; fi; exit "$status"' EXIT`,
      'test "$CODEX_NETWORK_PROXY_ACTIVE" = 1',
      "stage=local-binding",
      'test "$CODEX_NETWORK_ALLOW_LOCAL_BINDING" = 0',
      "stage=ca-readable",
      'test -r "$OCE_PUBLIC_GITHUB_READ_CA_FILE"',
      "stage=config-readable",
      'test -r "$OCE_PUBLIC_GITHUB_READ_CONFIG"',
      "stage=helper-path",
      'test "$GIT_EXEC_PATH" = "$2"',
      'test "$GIT_EXEC_PATH" = "${OCE_PUBLIC_GITHUB_READ_CONFIG%/*}"',
      "stage=helper-executable",
      'test -x "$GIT_EXEC_PATH/git-remote-https"',
      "stage=helper-source-readable",
      'test -r "$GIT_EXEC_PATH/transport.mjs"',
      "stage=clone",
      "git clone --depth=1 https://github.com/Example/Public-Project.git clone",
      "stage=managed-skill",
      'grep -q -- "--api-get" "$1"',
      "stage=api-read",
      'node "$GIT_EXEC_PATH/transport.mjs" --api-get "/repos/example/public-project/pulls/27"',
      "printf '\\n'",
      "stage=fetch",
      "git -C clone fetch origin",
      "stage=clone-object",
      "git -C clone show HEAD:readme.txt",
      "stage=fetched-object",
      "git -C clone show origin/main:readme.txt",
      "stage=remote-url",
      "git -C clone remote get-url origin",
      "trap - EXIT",
    ].join("\n");
    const result = await client.request("command/exec", {
      permissionProfile: profileName,
      cwd: workspace,
      command: [
        "/bin/sh",
        "-eu",
        "-c",
        shell,
        "public-read",
        skillPath,
        publicEnvironment.GIT_EXEC_PATH,
      ],
    });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const [pull, first, second, remote] = result.stdout.trim().split("\n");
    console.log(JSON.stringify({ ...JSON.parse(pull), first, second, remote }));
  } finally {
    client.close();
  }
}

test(
  "stock Codex reads public API and clones/fetches ordinary Git URLs through projected material",
  imageTestOptions,
  async (t) => {
    const security = await reviewedCodexSeccompSecurityOptions();
    const directory = await mkdtemp(join(tmpdir(), "oce-stock-public-read-"));
    const owner = "oce-public-read-" + randomUUID();
    const reader = owner + "-reader";
    const server = fileURLToPath(
      new URL("../../apps/controller/src/drivers/repo/github/public-read/", import.meta.url),
    );
    const pullTitle = "public-pull-" + randomUUID();
    const capability = "rev_fixture." + randomBytes(32).toString("base64url");
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
        // Collect passive receipts before teardown, including on the original
        // command failure. Diagnostic collection must not replace that failure.
        let receipts = readPublicReadReceipts(undefined);
        try {
          const logs = await runDocker(["logs", "--tail", "70", reader], { maxBuffer: 64 * 1024 });
          receipts = readPublicReadReceipts(logs.stdout);
        } catch {
          // No raw container/engine error enters the fixed receipt.
        }
        t.diagnostic("public-read-causal " + JSON.stringify(receipts));
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
      server + ":/tmp/public-read:ro",
      "-v",
      fileURLToPath(new URL("../helpers/", import.meta.url)) + ":/tmp/test-helpers:ro",
      "--env",
      "OCE_TEST_PUBLIC_CAPABILITY=" + capability,
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
    const caBundle = (await runDocker(["exec", reader, "cat", "/tmp/provider.pem"])).stdout;
    const publicGithubRead = {
      address,
      endpoint: "https://" + address + ":8080",
      caBundle,
      skillPath: "/home/node/.openclaw/skills/public-github-read/SKILL.md",
      authenticatedRepositories: [],
    };
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
    const material = join(directory, "public-material.json");
    await writeFile(material, projection["public-github-read.json"]);
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
      // Product material lives on disk-backed runtime storage. Permit execution
      // only in this private subtree; HOME and /tmp retain their noexec defaults.
      "--tmpfs",
      "/home/node/.oce-public-git:size=16m,uid=1000,gid=1000,mode=700,exec",
      "--tmpfs",
      "/tmp",
      "-v",
      skill + ":" + skillPath + ":ro",
      "-v",
      material + ":/tmp/public-material.json:ro",
      "--env",
      "OCE_PUBLIC_GITHUB_READ_MATERIAL_FILE=/tmp/public-material.json",
      "--env",
      "OCE_PUBLIC_GITHUB_READ_CAPABILITY=" + capability,
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      program(readWithStockCodex),
      JSON.stringify({
        pluginConfig,
        skillPath,
        materialSetup,
        manifest: JSON.parse(projection["runtime.json"]),
      }),
    ]);
    assert.deepEqual(JSON.parse(proof.stdout), {
      title: pullTitle,
      first: pullTitle + "-first",
      second: pullTitle + "-second",
      remote: "https://github.com/Example/Public-Project.git",
    });
  },
);
