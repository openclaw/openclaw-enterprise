const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");

(async () => {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const state = "/home/node/.openclaw";
  const marker = state + "/state/.oce-maintenance-pending";
  mkdirSync(state + "/state", { recursive: true, mode: 0o700 });
  writeFileSync(marker, "", { mode: 0o600 });
  writeFileSync("/tmp/automation-wrapper.cjs", input.wrapper, { mode: 0o600 });
  const config = {
    agents: { entries: { main: { identity: { name: "Test Agent" } } } },
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
        },
      },
    },
    plugins: { allow: ["openai", "memory-core"] },
    meta: { lastTouchedVersion: "2026.11.5" },
  };
  writeFileSync("/etc/openclaw/openclaw.json", JSON.stringify(config), { mode: 0o600 });
  const environment = {
    ...process.env,
    HOME: "/home/node",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
    OPENCLAW_CONFIG_READONLY: "1",
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_GATEWAY_PASSWORD: "synthetic",
    OPENCLAW_RUNTIME_STATUS_PORT: "47732",
    OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
    OPENCLAW_AGENT_REVISION_ID: "00000000-0000-4000-8000-000000000001",
    OPENCLAW_POD_UID: "00000000-0000-4000-8000-000000000002",
  };
  const statusUrl = "http://127.0.0.1:47732";
  const observations = {
    doctor: false,
    native: false,
    nativePid: undefined,
    proxyRefused: false,
    originRefused: false,
    migrationFailed: false,
    migrationStarted: false,
    configInvalid: false,
  };
  let wrapper;
  let stderr = "";
  const errorKind = () => {
    for (const [kind, text] of [
      ["persisted-discovery", "Automation persisted discovery"],
      ["reviewed-image", "Automation reviewed image"],
      ["proxy-configuration", "Automation MCP proxy configuration is invalid"],
      ["proxy-unavailable", "Automation MCP proxy is unavailable"],
      ["origin", "Automation plugin origin guard"],
      ["reference", "ReferenceError"],
      ["type", "TypeError"],
      ["syntax", "SyntaxError"],
      ["migration", "state migration failed"],
      ["configuration", "Invalid config"],
    ]) {
      if (stderr.includes(text)) {
        return kind;
      }
    }
    return "unclassified";
  };
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
        if (args.includes("/app/openclaw.mjs") && args.includes(" doctor ")) {
          observations.doctor = true;
        }
        if (args.includes("/app/openclaw.mjs") && args.includes(" gateway ")) {
          observations.native = true;
          observations.nativePid = Number(child);
        }
        visit(child);
      }
    };
    visit(wrapper.pid);
  };
  const interval = setInterval(sample, 20);
  interval.unref();
  const launch = () => {
    stderr = "";
    wrapper = spawn(process.execPath, ["/tmp/automation-wrapper.cjs"], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    wrapper.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr = (stderr + text).slice(-65536);
      if (text.includes("Automation MCP proxy refused")) {
        observations.proxyRefused = true;
      }
      if (text.includes("Automation plugin origin guard refused")) {
        observations.originRefused = true;
      }
      if (text.includes("state migration failed")) {
        observations.migrationFailed = true;
      }
      if (text.includes("Migrating ") && text.includes("openclaw doctor")) {
        observations.migrationStarted = true;
      }
      if (text.includes("configuration is invalid") || text.includes("Invalid config")) {
        observations.configInvalid = true;
      }
    });
    return wrapper;
  };
  const waitFor = async (check, budget = 75_000) => {
    const until = Date.now() + budget;
    while (Date.now() < until) {
      if (await check()) {
        return;
      }
      if (wrapper?.exitCode !== null) {
        throw new Error(
          "Gateway wrapper exited before expected state: " +
            JSON.stringify({
              exitCode: wrapper.exitCode,
              doctor: observations.doctor,
              native: observations.native,
              marker: existsSync(marker),
              originRefused: observations.originRefused,
              migrationFailed: observations.migrationFailed,
              migrationStarted: observations.migrationStarted,
              configInvalid: observations.configInvalid,
              errorKind: errorKind(),
              guardLine: Number(
                stderr.match(/at assertCleanAutomationOrigins \(.*?:(\d+):\d+\)/)?.[1] || 0,
              ),
            }),
        );
      }
      await delay(100);
    }
    throw new Error("Gateway wrapper did not reach expected state.");
  };
  const status = async () =>
    fetch(statusUrl + "/openclaw/runtime/status", { signal: AbortSignal.timeout(1000) })
      .then((response) => response.json())
      .catch(() => undefined);
  const ready = async () =>
    fetch(statusUrl + "/readyz", { signal: AbortSignal.timeout(1000) })
      .then((response) => response.status)
      .catch(() => undefined);
  const holder = createServer();
  holder.listen(47731, "127.0.0.1");
  await once(holder, "listening");
  launch();
  await waitFor(async () => (await status())?.runtimeFailure?.check === "gateway-config", 20_000);
  await delay(300);
  const held = {
    ready: await ready(),
    doctor: observations.doctor,
    native: observations.native,
    marker: existsSync(marker),
    proxyRefused: observations.proxyRefused,
  };
  assert.equal(held.ready, 503);
  assert.equal(held.doctor, false);
  assert.equal(held.native, false);
  assert.equal(held.marker, true);
  assert.equal(held.proxyRefused, true);
  wrapper.kill("SIGTERM");
  await once(wrapper, "exit");
  await new Promise((resolve) => holder.close(resolve));
  observations.doctor = false;
  observations.native = false;
  launch();
  await waitFor(async () => (await ready()) === 200);
  sample();
  const recovered = {
    doctor: observations.doctor,
    native: observations.native,
    marker: existsSync(marker),
  };
  assert.equal(recovered.doctor, true);
  assert.equal(recovered.native, true);
  assert.equal(recovered.marker, false);
  const probe = await fetch("http://127.0.0.1:47731" + input.path, { method: "GET" });
  assert.equal(probe.status, 502);
  const nativePid = observations.nativePid;
  assert.ok(Number.isSafeInteger(nativePid));
  process.kill(nativePid, "SIGTERM");
  await once(wrapper, "exit");
  observations.native = false;
  observations.nativePid = undefined;
  launch();
  await waitFor(async () => (await ready()) === 200);
  sample();
  const restarted = {
    native: observations.native,
    marker: existsSync(marker),
    proxyStatus: (await fetch("http://127.0.0.1:47731" + input.path, { method: "GET" })).status,
  };
  assert.equal(restarted.native, true);
  assert.equal(restarted.marker, false);
  assert.equal(restarted.proxyStatus, 502);
  wrapper.kill("SIGTERM");
  await once(wrapper, "exit");
  clearInterval(interval);
  console.log(JSON.stringify({ held, recovered, restarted }));
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
