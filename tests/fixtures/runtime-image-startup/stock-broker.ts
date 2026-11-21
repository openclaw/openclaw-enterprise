import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { commandResult, codexRpc, list, parseJson, record, text } from "./wire.ts";

type ProbeInput = {
  descriptor: { manifest: { generation: string } };
  repositoryGitHelperPath: string;
  entrypoint: string;
  materialInit: string;
  nativeGitInit: string;
  pluginRuntime: {
    manifest: { kind: "codex"; selections: Record<string, never> };
    brokerCodexConfiguration: Record<string, unknown>;
  };
  configPatchProbe: string;
  proxyEnvironmentProbe: string;
  brokerDenialProbe: string;
  gitProofScript: string;
};

export async function probeStockBroker(
  input: ProbeInput,
  createRpc: typeof codexRpc,
  observeCommand: typeof commandResult,
  asList: typeof list,
  parse: typeof parseJson,
  read: typeof record,
  asText: typeof text,
) {
  const assert: typeof import("node:assert/strict") =
    process.getBuiltinModule("node:assert/strict");
  const cp = process.getBuiltinModule("node:child_process");
  const fs = process.getBuiltinModule("node:fs");
  const vm = process.getBuiltinModule("node:vm");
  const { createInterface } = process.getBuiltinModule("node:readline");
  const requireModule: (name: string) => unknown = process
    .getBuiltinModule("node:module")
    .createRequire(process.cwd() + "/[stdin]");
  function markStockBrokerStage(stage: string) {
    console.error("openclaw-ci-stock-broker-stage=" + stage);
  }
  markStockBrokerStage("material-init");
  const material = cp.spawnSync(
    process.execPath,
    ["-e", input.materialInit, JSON.stringify(input.descriptor)],
    { stdio: "inherit" },
  );
  assert.equal(material.status, 0, "repository material initialization failed");
  markStockBrokerStage("native-git-init");
  const repositoryRoot = "/run/oce/repository-credentials";
  const preparation = cp.spawnSync(process.execPath, ["-e", input.nativeGitInit, repositoryRoot], {
    stdio: "inherit",
  });
  assert.equal(preparation.status, 0, "repository native Git initialization failed");
  const expectedHelper = `!'/usr/local/bin/node' '${input.repositoryGitHelperPath}' manifest '${repositoryRoot}' '${input.descriptor.manifest.generation}'`;
  // Git's generated per-origin helper list resets earlier helpers and installs one command.
  const helpers = cp.spawnSync(
    "git",
    [
      "config",
      "--no-includes",
      "--file",
      repositoryRoot + "/gitconfig",
      "--null",
      "--get-all",
      "credential.https://git.oce.svc.helper",
    ],
    { encoding: "utf8" },
  );
  assert.ok(
    helpers.status === 0 && helpers.stdout === `\0${expectedHelper}\0`,
    "repository-native-git-helper-mismatch",
  );
  const brokerCaBundle = fs
    .readdirSync("/run/oce/repository-credentials/sessions")
    .map((name) => "/run/oce/repository-credentials/sessions/" + name + "/ca-bundle.pem")
    .find((filename) => fs.existsSync(filename));
  assert.ok(brokerCaBundle, "repository material initialization must project a broker CA bundle");
  assert.ok(fs.readFileSync(brokerCaBundle, "utf8").includes("BEGIN CERTIFICATE"));
  const environment: NodeJS.ProcessEnv = {
    PATH: "/opt/oce/repository-credentials/bin:" + process.env.PATH,
    HOME: "/home/node",
    CODEX_HOME: "/home/node/.codex",
    CODEX_LOGIN_MODE: "api_key",
    OPENAI_API_KEY: "synthetic-offline-key",
    OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
    APP_SERVER_TOKEN: "synthetic-transport-token",
    APP_SERVER_PORT: "4500",
    SSL_CERT_FILE: brokerCaBundle,
    GIT_SSL_CAINFO: brokerCaBundle,
    REQUESTS_CA_BUNDLE: brokerCaBundle,
    CURL_CA_BUNDLE: brokerCaBundle,
    NODE_EXTRA_CA_CERTS: brokerCaBundle,
  };
  markStockBrokerStage("config-patch");
  const configPatchResult = cp.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", input.configPatchProbe],
    {
      input: JSON.stringify(input.pluginRuntime),
      encoding: "utf8",
    },
  );
  assert.equal(configPatchResult.status, 0, configPatchResult.stderr);
  const allowPatch = read(read(parse(configPatchResult.stdout)).allowPatch);
  const brokerPermissionProfile = asText(allowPatch.default_permissions);
  const deniedPermissionProfile = brokerPermissionProfile + "-denied";
  const configPatch = structuredClone(allowPatch);
  const permissions = read(configPatch.permissions);
  const deniedProfile = read(structuredClone(permissions[brokerPermissionProfile]));
  permissions[deniedPermissionProfile] = deniedProfile;
  read(deniedProfile.network).domains = { "git.oce.svc": "deny" };
  function tomlValue(value: unknown): string {
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    if (Array.isArray(value)) {
      return "[" + asList(value).map(tomlValue).join(", ") + "]";
    }
    return JSON.stringify(value);
  }
  function isTomlTable(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function tomlPathKey(key: string) {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  }
  function tomlAssignmentKey(key: string, topLevel: boolean) {
    return topLevel && /^[A-Za-z0-9_.-]+$/.test(key) ? key : tomlPathKey(key);
  }
  function renderTomlTable(path: string[], value: Record<string, unknown>): string {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const scalarEntries = entries.filter(([, item]) => !isTomlTable(item));
    const tableEntries = entries.filter(([, item]) => isTomlTable(item));
    const lines: string[] = [];
    if (path.length > 0 && scalarEntries.length > 0) {
      lines.push("[" + path.map(tomlPathKey).join(".") + "]");
    }
    for (const [key, item] of scalarEntries) {
      lines.push(tomlAssignmentKey(key, path.length === 0) + " = " + tomlValue(item));
    }
    for (const [key, item] of tableEntries) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(renderTomlTable([...path, key], read(item)));
    }
    return lines.join("\n");
  }
  function codexConfigPatchToml(patch: Record<string, unknown>) {
    return renderTomlTable([], patch) + "\n";
  }
  environment.OPENCLAW_PLUGIN_RUNTIME_JSON = JSON.stringify({
    manifest: input.pluginRuntime.manifest,
    codexConfigurationToml: codexConfigPatchToml(configPatch),
  });
  const codexAuthFixturePath = "/home/node/.codex/auth.json";
  fs.mkdirSync("/home/node/.codex", { recursive: true });
  fs.mkdirSync("/home/node/workspace", { recursive: true });
  fs.writeFileSync(
    codexAuthFixturePath,
    JSON.stringify({ OPENAI_API_KEY: "synthetic-offline-key" }),
    { mode: 0o600 },
  );
  const homeControlSentinelPath = "/home/node/openclaw-stock-codex-control-sentinel.txt";
  const homeControlSentinel = "synthetic-openclaw-control-sentinel\n";
  fs.writeFileSync(homeControlSentinelPath, homeControlSentinel, { mode: 0o600 });
  assert.equal(fs.readFileSync(homeControlSentinelPath, "utf8"), homeControlSentinel);
  // As the workspace node supervisor does: hooks trust a private CA copy the sandbox cannot
  // read, and sandboxed commands keep the Pod's broker CA bundle (finding 2412).
  const hookCaPath = "/home/node/.oce-native-hooks/gateway-ca.pem";
  fs.mkdirSync("/home/node/.oce-native-hooks", { mode: 0o700 });
  fs.writeFileSync(hookCaPath, fs.readFileSync(brokerCaBundle, "utf8"), { mode: 0o600 });
  environment.OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS = brokerCaBundle;
  environment.NODE_EXTRA_CA_CERTS = hookCaPath;
  const launched: { native?: ChildProcessWithoutNullStreams } = {};
  vm.runInNewContext(input.entrypoint, {
    URL,
    console,
    setTimeout,
    setInterval,
    // The wrapper forwards filtered app-server stderr; the probe reads native.stderr itself.
    process: {
      env: environment,
      stderr: {
        write() {
          return true;
        },
      },
      on() {},
      exit() {},
    },
    require(name: string) {
      if (name !== "node:child_process") {
        return requireModule(name);
      }
      return {
        spawnSync(_command: string, args: string[]) {
          return args.includes("login")
            ? { status: 0 }
            : {
                status: 0,
                stdout: [
                  { type: "turn.started" },
                  { type: "item.completed", item: { type: "agent_message", text: "READY" } },
                  { type: "turn.completed" },
                ]
                  .map((message) => JSON.stringify(message))
                  .join("\n"),
              };
        },
        spawn(command: string, args: string[], options: SpawnOptions) {
          const appServer = args.indexOf("app-server");
          assert.ok(appServer > 0);
          launched.native = cp.spawn(
            command,
            [...args.slice(0, appServer + 1), "--listen", "stdio://"],
            {
              ...options,
              env: environment,
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          return launched.native;
        },
      };
    },
  });
  const { native } = launched;
  assert.ok(native);
  const lines = createInterface({ input: native.stdout });
  const rpc = createRpc(native, lines, parse, read).request;
  let stderr = "";
  native.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  async function execShell(
    script: string,
    permissionProfile = brokerPermissionProfile,
    timeoutMs = 30000,
  ) {
    try {
      return observeCommand(
        await rpc("command/exec", {
          command: ["/bin/bash", "-euo", "pipefail", "-c", script],
          permissionProfile,
          timeoutMs,
        }),
        read,
        asText,
      );
    } catch (error) {
      throw new Error(
        "subprobe " +
          permissionProfile +
          " failed for script: " +
          script.slice(0, 240) +
          "\n" +
          (error instanceof Error ? error.message : String(error)) +
          "\napp-server stderr:\n" +
          stderr.slice(-4000),
        { cause: error },
      );
    }
  }
  async function expectFailure(
    name: string,
    script: string,
    pattern: string,
    permissionProfile = brokerPermissionProfile,
  ) {
    const failureProbe = [
      "set +e",
      "output=$({",
      script,
      "} 2>&1)",
      "status=$?",
      "set -e",
      "printf '%s\n' \"$output\"",
      'if [ "$status" -eq 0 ]; then exit 42; fi',
      // An in-shell match: printf piped to grep -q can fail with EPIPE under pipefail.
      // Patterns are case-insensitive alternations of literals matched against the
      // whole output; they go into a double-quoted assignment, so keep $, backticks
      // and backslashes out of them.
      "shopt -s nocasematch",
      "pattern=" + JSON.stringify(pattern),
      "[[ $output =~ $pattern ]]",
    ].join("\n");
    const denied = await execShell(failureProbe, permissionProfile);
    assert.equal(
      denied.exitCode,
      0,
      name + " did not fail for the expected reason: " + denied.stdout + denied.stderr,
    );
  }
  const timeout = setTimeout(() => {
    console.error(stderr);
    native.kill("SIGKILL");
    process.exitCode = 1;
  }, 90000);
  try {
    // Resolve and reach the fixture outside Codex first, so the direct-bypass
    // assertion cannot pass merely because sandboxed DNS is unavailable.
    markStockBrokerStage("fixture-reachability");
    const unrelatedAddress = (
      await process.getBuiltinModule("node:dns/promises").lookup("unrelated.oce.svc", { family: 4 })
    ).address;
    assert.equal(process.getBuiltinModule("node:net").isIP(unrelatedAddress), 4);
    const directRoute = cp.spawnSync(
      "curl",
      [
        "--noproxy",
        "*",
        "-ksS",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "--resolve",
        "unrelated.oce.svc:443:" + unrelatedAddress,
        "https://unrelated.oce.svc/",
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      directRoute.status,
      0,
      "fixture must be reachable outside the sandbox: " + directRoute.stderr,
    );
    markStockBrokerStage("initialize");
    await rpc("initialize", {
      clientInfo: { name: "repository-broker-stock-codex-smoke", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");

    markStockBrokerStage("bundled-system-skill");
    const control = await execShell("cd /home/node/workspace && printf restricted-command-ok");
    assert.equal(control.exitCode, 0, "restricted command control failed: " + control.stderr);
    assert.equal(control.stdout, "restricted-command-ok");
    const catalog = read(
      await rpc("skills/list", { cwds: ["/home/node/workspace"], forceReload: true }),
    );
    const skill = asList(catalog.data)
      .flatMap((entry) => asList(read(entry).skills))
      .map(read)
      .find((entry) => entry.name === "skill-creator" && entry.enabled && entry.scope === "system");
    assert.ok(skill, "Codex must advertise an enabled system skill");
    const skillPath = asText(skill.path);
    assert.equal(skillPath, "/home/node/.codex/skills/.system/skill-creator/SKILL.md");
    const skillBefore = fs.readFileSync(skillPath, "utf8");
    assert.ok(skillBefore.length > 0, "Codex must install its bundled skill before the probe");
    const skillRead = await execShell("cat " + skillPath);
    assert.equal(skillRead.exitCode, 0, "bundled skill read failed: " + skillRead.stderr);
    assert.equal(skillRead.stdout, skillBefore);
    await expectFailure(
      "bundled-system-skill-write-denied",
      "printf modified >> " + skillPath,
      "Read-only file system|Permission denied|Operation not permitted|EROFS|EACCES",
    );
    assert.equal(
      fs.readFileSync(skillPath, "utf8"),
      skillBefore,
      "the real system skill must remain unchanged",
    );
    await expectFailure(
      "codex-credential-read-denied",
      "cat " + codexAuthFixturePath,
      "No such file|Permission denied|Operation not permitted|EACCES|ENOENT",
    );

    markStockBrokerStage("proxy-env");
    const proxyState = await execShell(input.proxyEnvironmentProbe);
    assert.equal(
      proxyState.exitCode,
      0,
      "proxy-env subprobe failed: " + proxyState.stderr + proxyState.stdout,
    );
    assert.match(proxyState.stdout, /proxy-env-ok/);

    markStockBrokerStage("broker-denial");
    const brokerDenials = await execShell(input.brokerDenialProbe);
    assert.equal(
      brokerDenials.exitCode,
      0,
      "broker denial code probe failed: " + brokerDenials.stderr,
    );
    assert.match(brokerDenials.stdout, /broker-denial-codes-confirmed/);

    markStockBrokerStage("outside-home-read");
    await expectFailure(
      "outside-workspace-home-read-denied",
      "cat " + homeControlSentinelPath,
      "No such file|Permission denied|Operation not permitted|EACCES|ENOENT",
    );
    await expectFailure(
      "hook-ca-read-denied",
      "cat " + hookCaPath,
      "No such file|Permission denied|Operation not permitted|EACCES|ENOENT",
    );
    // Node loads extra CAs lazily; reading them proves the sandboxed command can.
    const shellNodeCa = await execShell(
      "node -e " +
        JSON.stringify(
          'process.stdout.write(process.env.NODE_EXTRA_CA_CERTS + "|" + require("node:tls").getCACertificates("extra").length);',
        ),
    );
    assert.equal(shellNodeCa.exitCode, 0, shellNodeCa.stderr);
    assert.doesNotMatch(shellNodeCa.stderr, /Ignoring extra certs/);
    const [shellCaPath, shellCaCount] = shellNodeCa.stdout.split("|");
    assert.equal(shellCaPath, brokerCaBundle);
    assert.ok(Number(shellCaCount) > 0, "sandboxed node must trust the broker CA bundle");
    const sentinelBeforeSandboxWrite = fs.readFileSync(homeControlSentinelPath, "utf8");
    markStockBrokerStage("outside-home-shadow-write");
    const shadowWrite = await execShell(
      "printf shadowed > " + homeControlSentinelPath + " && printf sandbox-write-exit0",
      brokerPermissionProfile,
    );
    assert.equal(shadowWrite.exitCode, 0, shadowWrite.stderr + shadowWrite.stdout);
    assert.match(shadowWrite.stdout, /sandbox-write-exit0/);
    assert.equal(
      fs.readFileSync(homeControlSentinelPath, "utf8"),
      sentinelBeforeSandboxWrite,
      "sandbox writes must not modify the parent home sentinel",
    );
    markStockBrokerStage("outside-home-read-after-shadow-write");
    await expectFailure(
      "outside-workspace-home-read-still-denied-after-shadow-write",
      "cat " + homeControlSentinelPath,
      "No such file|Permission denied|Operation not permitted|EACCES|ENOENT",
    );

    markStockBrokerStage("git-proof");
    const gitProof = await execShell(input.gitProofScript, brokerPermissionProfile, 60000);
    assert.equal(gitProof.exitCode, 0, gitProof.stderr + "\n" + gitProof.stdout);
    const commit = gitProof.stdout.match(/commit=([a-f0-9]{40})/)?.[1];
    assert.ok(commit, gitProof.stdout);

    markStockBrokerStage("explicit-deny");
    await expectFailure(
      "explicit-deny-broker",
      "git ls-remote https://github.com/fixture/repository.git HEAD",
      "CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy after CONNECT",
      deniedPermissionProfile,
    );
    markStockBrokerStage("unrelated-private-host");
    await expectFailure(
      "proxy-unrelated-private-host",
      "curl -ksS --connect-timeout 5 --max-time 10 https://unrelated.oce.svc/",
      "CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy after CONNECT",
    );
    const directProbe =
      "node -e " +
      JSON.stringify(
        'const socket = require("node:net").connect(443, process.argv[1]); socket.on("connect", () => { console.error("UNEXPECTED_CONNECTION"); process.exit(42); }); socket.on("error", (error) => { console.error(error.code); process.exit(1); }); setTimeout(() => { console.error("TIMEOUT"); process.exit(43); }, 5000);',
      ) +
      " " +
      unrelatedAddress;
    markStockBrokerStage("direct-private-host");
    await expectFailure(
      "direct-unrelated-private-host",
      directProbe,
      "EPERM|EACCES|ENETUNREACH|EHOSTUNREACH",
    );
    process.stdout.write(
      "stock-codex-repository-broker-ready " + JSON.stringify({ commit }) + "\n",
    );
  } catch (error) {
    console.error(stderr);
    throw error;
  } finally {
    clearTimeout(timeout);
    lines.close();
    native.kill("SIGTERM");
  }
}
