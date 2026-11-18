import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { commandResult, codexRpc, parseJson, record, text } from "./wire.ts";

export async function probeDedicatedCommand(
  tokenHash: string,
  historicalCodex: boolean,
  createRpc: typeof codexRpc,
  parse: typeof parseJson,
  read: typeof record,
  asText: typeof text,
  observeCommand: typeof commandResult,
) {
  const assert: typeof import("node:assert/strict") =
    process.getBuiltinModule("node:assert/strict");
  const cp = process.getBuiltinModule("node:child_process");
  const vm = process.getBuiltinModule("node:vm");
  const fs = process.getBuiltinModule("node:fs");
  const { createInterface } = process.getBuiltinModule("node:readline");
  const requireModule: (name: string) => unknown = process
    .getBuiltinModule("node:module")
    .createRequire(process.cwd() + "/[eval]");
  const environment: NodeJS.ProcessEnv = {
    PATH: "/opt/oce/repository-credentials/bin:" + process.env.PATH,
    HOME: "/home/node",
    CODEX_HOME: "/home/node/.codex",
    CODEX_LOGIN_MODE: "api_key",
    OPENAI_API_KEY: "synthetic-offline-key",
    OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
    APP_TOKEN_SHA: tokenHash,
    APP_SERVER_PORT: "4500",
    // The workspace node supervisor points hooks at a CA copy the sandbox cannot read.
    NODE_EXTRA_CA_CERTS: "/home/node/.oce-native-hooks/gateway-ca.pem",
    OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS: "/run/oce/repository-credentials/ca-bundle.pem",
  };
  const launched: { native?: ChildProcessWithoutNullStreams } = {};
  // The entrypoint arrives on stdin: inlined, it can exceed the per-argument limit.
  vm.runInNewContext(fs.readFileSync(0, "utf8"), {
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
          const appServerEnvironment = options.env ?? environment;
          assert.equal(Object.hasOwn(appServerEnvironment, "APP_SERVER_TOKEN"), false);
          assert.equal(Object.hasOwn(appServerEnvironment, "APP_TOKEN_SHA"), false);
          assert.equal(
            Object.hasOwn(appServerEnvironment, "OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS"),
            false,
          );
          assert.equal(appServerEnvironment.NODE_EXTRA_CA_CERTS, environment.NODE_EXTRA_CA_CERTS);
          launched.native = cp.spawn(
            command,
            [...args.slice(0, appServer + 1), "--listen", "stdio://"],
            {
              ...options,
              env: appServerEnvironment,
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
  native.stderr.resume();
  const timeout = setTimeout(() => {
    native.kill("SIGKILL");
    process.exitCode = 1;
  }, 20000);
  try {
    await rpc("initialize", {
      clientInfo: { name: "repository-runtime-smoke", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const config = read(read(await rpc("config/read", {})).config);
    const shellEnvironment = read(read(config.shell_environment_policy).set);
    // Native metrics have a separate upstream exporter default from logs.
    if (!historicalCodex) {
      assert.equal(read(config.otel).metrics_exporter, "none");
    }
    assert.equal(config.allow_login_shell, false);
    assert.equal(shellEnvironment.PATH, environment.PATH);
    assert.equal(
      shellEnvironment.NODE_EXTRA_CA_CERTS,
      environment.OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS,
    );
    const result = observeCommand(
      await rpc("command/exec", {
        command: [
          "/bin/bash",
          "-c",
          'test -z "$APP_SERVER_TOKEN" || exit 1; test -z "$APP_TOKEN_SHA" || exit 1; command -v gh; command -v git; git config --system --get-all include.path; echo "$NODE_EXTRA_CA_CERTS"',
        ],
        sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
        timeoutMs: 5000,
      }),
      read,
      asText,
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "/opt/oce/repository-credentials/bin/gh",
      "/usr/bin/git",
      "/run/oce/repository-credentials/gitconfig",
      environment.OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS,
    ]);
    fs.accessSync(
      "/opt/oce/repository-credentials/dist/drivers/repo/github/access/client/router.js",
    );
    process.stdout.write("native-repository-shell-ready\n");
    // The proof is complete. The Codex binary, a grandchild that holds this
    // probe's pipes, takes about 5 s to exit after SIGTERM or EOF. This node is
    // the container's PID 1, so its exit stops Codex at once.
    process.exit();
  } finally {
    clearTimeout(timeout);
    lines.close();
    native.kill("SIGTERM");
  }
}
