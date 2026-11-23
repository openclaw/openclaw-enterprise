const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

(async () => {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const state = "/home/node/.openclaw";
  const admittedPath = "/etc/openclaw/openclaw.json";
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync("/tmp/automation-wrapper.cjs", input.wrapper, { mode: 0o600 });
  const config = {
    agents: {
      entries: {
        main: {
          identity: { name: "Test Agent" },
          workspace: "/home/node/workspace",
          tools: { allow: ["approved__parity_probe"] },
        },
      },
    },
    tools: {
      profile: "full",
      gatewayPolicy: { allow: ["approved__parity_probe"] },
      codeMode: false,
      toolSearch: false,
    },
    gateway: { mode: "local", nodes: { pluginTools: { enabled: false }, allowSkills: false } },
    mcp: {
      servers: {
        approved: {
          transport: "streamable-http",
          url: "http://127.0.0.1:47731" + input.path,
          toolFilter: { include: ["parity_probe"] },
          codex: { defaultToolsApprovalMode: "approve" },
        },
      },
    },
    plugins: {
      allow: ["codex", "memory-core"],
      entries: {
        codex: {
          enabled: true,
          config: { appServer: structuredClone(input.appServer) },
        },
      },
    },
  };
  const save = () => writeFileSync(admittedPath, JSON.stringify(config), { mode: 0o600 });
  save();
  const env = {
    ...process.env,
    HOME: "/home/node",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: admittedPath,
    OPENCLAW_CONFIG_READONLY: "1",
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_GATEWAY_PASSWORD: "synthetic",
    OPENCLAW_RUNTIME_STATUS_PORT: "47732",
    OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
    OPENCLAW_AGENT_REVISION_ID: "00000000-0000-4000-8000-000000000001",
    OPENCLAW_POD_UID: "00000000-0000-4000-8000-000000000002",
    APP_SERVER_URL: "ws://127.0.0.1:9",
    APP_SERVER_TOKEN: "synthetic",
    OPENCLAW_WORKSPACE_NODE_ID: "enrolled-node",
    OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest: { kind: "codex", selections: {} } }),
  };
  let wrapper;
  let nativePid;
  let nativeObserved = false;
  let originRefused = false;
  let stderr = "";
  const sample = () => {
    if (!wrapper?.pid) {
      return;
    }
    const visit = (pid) => {
      let children;
      try {
        children = readFileSync("/proc/" + pid + "/task/" + pid + "/children", "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      } catch {
        return;
      }
      for (const child of children) {
        let args;
        try {
          args = readFileSync("/proc/" + child + "/cmdline", "utf8").replaceAll("\0", " ");
        } catch {
          continue;
        }
        if (args.includes("/app/openclaw.mjs") && args.includes(" gateway ")) {
          nativeObserved = true;
          nativePid = Number(child);
        }
        visit(child);
      }
    };
    visit(wrapper.pid);
  };
  const timer = setInterval(sample, 20);
  timer.unref();
  const launch = () => {
    nativePid = undefined;
    nativeObserved = false;
    originRefused = false;
    stderr = "";
    wrapper = spawn(process.execPath, ["/tmp/automation-wrapper.cjs"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    wrapper.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-65536);
      if (stderr.includes("Automation plugin origin guard refused")) {
        originRefused = true;
      }
    });
  };
  const ready = () =>
    fetch("http://127.0.0.1:47732/readyz", { signal: AbortSignal.timeout(1000) })
      .then((r) => r.status)
      .catch(() => undefined);
  const wait = async (check, budget = 60_000) => {
    const end = Date.now() + budget;
    while (Date.now() < end) {
      sample();
      if (await check()) {
        return;
      }
      if (wrapper.exitCode !== null) {
        throw new Error(
          "dedicated wrapper exited: " +
            JSON.stringify({
              exit: wrapper.exitCode,
              native: nativeObserved,
              originRefused,
              guardLine: Number(
                stderr.match(/at assertCleanAutomationOrigins \(.*?:(\d+):\d+\)/)?.[1] || 0,
              ),
              configInvalid:
                stderr.includes("Invalid config") || stderr.includes("configuration is invalid"),
              reference: stderr.includes("ReferenceError"),
            }),
        );
      }
      await delay(100);
    }
    throw new Error("dedicated wrapper timed out");
  };
  const stop = async () => {
    if (wrapper?.exitCode === null) {
      wrapper.kill("SIGTERM");
      await once(wrapper, "exit");
    }
  };
  launch();
  await wait(async () => (await ready()) === 200);
  assert.equal(nativeObserved, true);
  const childEnvironment = readFileSync("/proc/" + nativePid + "/environ", "utf8").split("\0");
  const currentPath = childEnvironment
    .find((entry) => entry.startsWith("OPENCLAW_CONFIG_PATH="))
    ?.slice("OPENCLAW_CONFIG_PATH=".length);
  assert.ok(currentPath);
  const current = JSON.parse(readFileSync(currentPath, "utf8"));
  const paths = current.plugins.entries.codex.config.appServer.networkProxy.readOnlyPaths;
  assert.deepEqual(paths, ["/app/node_modules/openclaw", "/home/node/.codex/skills/.system"]);
  const positive = { ready: await ready(), native: nativeObserved, paths };
  await stop();
  config.plugins.entries.codex.config.appServer.networkProxy.readOnlyPaths = ["/tmp"];
  save();
  launch();
  await wait(() => originRefused, 20_000);
  await delay(200);
  const negative = { native: nativeObserved, originRefused };
  assert.deepEqual(negative, { native: false, originRefused: true });
  await stop();
  delete config.plugins.entries.codex.config.appServer.networkProxy.readOnlyPaths;
  save();
  const guardCall =
    "assertCleanAutomationOrigins(childEnvironment, gatewayToolPolicyInput, initialConfigPath);";
  assert.equal(input.wrapper.split(guardCall).length, 2);
  const mutations = {
    missing: "delete proxy.readOnlyPaths;",
    extra: 'proxy.readOnlyPaths.push("/tmp");',
    reordered: "proxy.readOnlyPaths.reverse();",
    altered: 'proxy.readOnlyPaths[0] = "/tmp";',
  };
  const generated = [];
  for (const [mode, mutation] of Object.entries(mutations)) {
    // Inject a filesystem fault immediately before the actual guard. The
    // production guard and native spawn path remain unchanged.
    const fault = `
      const proofFs = require("node:fs");
      const proofPath = childEnvironment.OPENCLAW_CONFIG_PATH;
      const proofConfig = JSON.parse(proofFs.readFileSync(proofPath, "utf8"));
      const proxy = proofConfig.plugins.entries.codex.config.appServer.networkProxy;
      ${mutation}
      proofFs.writeFileSync(proofPath, JSON.stringify(proofConfig), { mode: 0o600 });
      ${guardCall}`;
    const mutated = input.wrapper.replace(guardCall, fault);
    writeFileSync("/tmp/automation-wrapper.cjs", mutated, { mode: 0o600 });
    launch();
    await wait(() => originRefused, 20_000);
    await delay(100);
    assert.equal(nativeObserved, false, mode);
    generated.push({ mode, native: nativeObserved, originRefused });
    await stop();
  }
  clearInterval(timer);
  console.log(JSON.stringify({ positive, negative, generated }));
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
