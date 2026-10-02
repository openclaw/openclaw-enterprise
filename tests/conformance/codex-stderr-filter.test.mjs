import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

import {
  AGENT_RUNTIME_ENTRYPOINT,
  CODEX_STDERR_FILTER_HELPER,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// Lines in the shape Codex 0.158 `app-server` prints with LOG_FORMAT=json (FmtSpan::FULL).
const record = (level, target, fields, span) =>
  JSON.stringify({
    timestamp: "2026-10-01T07:49:44.100970Z",
    level,
    fields,
    target,
    ...(span === undefined ? {} : { span, spans: [] }),
  });
// Codex 0.158's project-trust startup message, naming each untrusted folder.
const untrusted = (folders) =>
  "Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.\n" +
  folders
    .map(
      (folder, index) =>
        `    ${index + 1}. ${folder}\n       To load project-local config, hooks, and exec policies, add ${folder.replace(/\/\.codex$/, "")} as a trusted project in /home/node/.codex/config.toml.\n`,
    )
    .join("");
const turn = { name: "turn", model: "gpt-5.6-luna", "turn.id": "turn-1" };
const lines = {
  turnNew: record("INFO", "codex_core::tasks", { message: "new" }, turn),
  turnEnter: record("INFO", "codex_core::tasks", { message: "enter" }, turn),
  turnExit: record("INFO", "codex_core::tasks", { message: "exit" }, turn),
  turnClose: record("INFO", "codex_core::tasks", { message: "close", "time.busy": "2.1s" }, turn),
  // Every other span's lifecycle, including a span named "turn" from another target.
  fsNew: record(
    "INFO",
    "codex_exec_server::local_file_system",
    { message: "new" },
    {
      name: "fs.read_file",
    },
  ),
  fsClose: record(
    "INFO",
    "codex_exec_server::local_file_system",
    { message: "close", "time.busy": "1ms" },
    { name: "fs.read_file" },
  ),
  otherTurnNew: record("INFO", "codex_core::session", { message: "new" }, turn),
  // A plain event whose message is a lifecycle word is not a span record.
  plainNew: record("INFO", "codex_core::client", { message: "new" }),
  tool: record("INFO", "codex_core::tools::parallel", {
    message: "tool call completed",
    tool_name: "shell",
  }),
  modelRetry: record("WARN", "codex_core::client", { message: "retrying model request" }),
  // A plain event whose message is a lifecycle word is not a span record.
  plainExit: record("INFO", "codex_core::client", { message: "exit" }),
  probe: record("INFO", "codex_app_server_transport::transport::websocket", {
    message: "websocket client connected",
    peer_addr: "127.0.0.1:41822",
  }),
  probeV6: record("INFO", "codex_app_server_transport::transport::websocket", {
    message: "websocket client connected",
    peer_addr: "[::1]:41822",
  }),
  gatewayClient: record("INFO", "codex_app_server_transport::transport::websocket", {
    message: "websocket client connected",
    peer_addr: "10.42.0.17:51234",
  }),
  remoteControlWait: record(
    "INFO",
    "codex_app_server_transport::transport::remote_control::websocket",
    {
      message: "waiting to resolve remote control preference until authentication is available",
      error: "remote control requires ChatGPT authentication",
    },
  ),
  // Codex 0.158 prints this once per start; the image runs Codex's bundled bubblewrap.
  missingBwrap: record("ERROR", "codex_app_server", {
    message:
      "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.",
  }),
  // Other bubblewrap errors still pass.
  bwrapNamespaces: record("ERROR", "codex_app_server", {
    message: "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
  }),
  // Codex prints this at each start once the workspace has a .codex folder; an
  // empty one appears when any session runs, and the workspace is not trusted.
  untrustedWorkspace: record("ERROR", "codex_app_server", {
    message: untrusted(["/home/node/workspace/.codex"]),
  }),
  // Any other folder, or more than one, still passes.
  untrustedOtherFolder: record("ERROR", "codex_app_server", {
    message: untrusted(["/home/node/workspace/repo/.codex"]),
  }),
  untrustedTwoFolders: record("ERROR", "codex_app_server", {
    message: untrusted(["/home/node/workspace/.codex", "/home/node/workspace/repo/.codex"]),
  }),
  // Codex 0.158 prints this at each session's network-proxy start on Linux,
  // whatever the Unix-socket policy says.
  unixSocketsPlatform: record(
    "WARN",
    "codex_network_proxy::proxy",
    {
      message:
        "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform",
    },
    { name: "session_init.network_proxy" },
  ),
  // The same text from another target is not the platform warning.
  unixSocketsOtherTarget: record("WARN", "codex_core::client", {
    message:
      "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform",
  }),
  text: "codex app-server (WebSockets)",
  malformed: '{"fields":{"message":"enter"',
};

function filter(rustLog = "info,codex_otel=off") {
  const writes = [];
  const context = {
    process: { env: { RUST_LOG: rustLog }, stderr: { write: (text) => writes.push(text) } },
    Date,
    Promise,
  };
  vm.runInNewContext(
    `${CODEX_STDERR_FILTER_HELPER}\nthis.kept = codexStderrLineKept; this.forward = forwardCodexStderr;`,
    context,
  );
  return { kept: context.kept, forward: context.forward, writes };
}

test("the Codex stderr filter drops span lifecycle records except the turn's start and end, and idle noise, below debug", () => {
  const { kept } = filter();
  const at = Date.parse("2026-10-01T07:00:00Z");
  const decisions = Object.fromEntries(
    Object.entries(lines).map(([name, line]) => [name, kept(line, at)]),
  );
  assert.deepEqual(decisions, {
    turnNew: true,
    turnEnter: false,
    turnExit: false,
    turnClose: true,
    fsNew: false,
    fsClose: false,
    otherTurnNew: false,
    plainNew: true,
    tool: true,
    modelRetry: true,
    plainExit: true,
    probe: false,
    probeV6: false,
    gatewayClient: true,
    // The first retry line is kept, so the reason stays visible.
    remoteControlWait: true,
    missingBwrap: false,
    bwrapNamespaces: true,
    untrustedWorkspace: false,
    untrustedOtherFolder: true,
    untrustedTwoFolders: true,
    // The first platform warning per app-server is kept.
    unixSocketsPlatform: true,
    unixSocketsOtherTarget: true,
    text: true,
    malformed: true,
  });
  // The remote-control retry repeats every second: kept once per 10 minutes.
  assert.equal(kept(lines.remoteControlWait, at + 1_000), false);
  assert.equal(kept(lines.remoteControlWait, at + 599_000), false);
  assert.equal(kept(lines.remoteControlWait, at + 600_000), true);
  // Later sessions repeat the platform warning: dropped for the process lifetime.
  assert.equal(kept(lines.unixSocketsPlatform, at + 1_000), false);
  assert.equal(kept(lines.unixSocketsPlatform, at + 86_400_000), false);
  assert.equal(kept(lines.unixSocketsOtherTarget, at + 1_000), true);
});

test("the Codex stderr filter forwards everything when RUST_LOG starts at debug or trace", () => {
  for (const level of ["debug,codex_otel=off", "trace", "DEBUG"]) {
    const { kept } = filter(level);
    for (const line of Object.values(lines)) {
      assert.equal(kept(line), true, `${level}: ${line}`);
    }
  }
  const { kept } = filter("warn,codex_otel=off");
  assert.equal(kept(lines.turnEnter), false);
  assert.equal(kept(lines.fsClose), false);
});

test("the Codex stderr forwarder splits chunks into lines and flushes the last partial line", async () => {
  const { forward, writes } = filter();
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const done = forward(stream);
  const input = [
    lines.turnNew,
    lines.fsNew,
    lines.turnEnter,
    lines.tool,
    lines.fsClose,
    lines.turnExit,
    lines.probe,
  ].join("\n");
  // Chunk boundaries fall inside lines.
  for (let index = 0; index < input.length; index += 37) {
    stream.write(input.slice(index, index + 37));
  }
  stream.write("\n");
  stream.end(lines.turnClose);
  await done;
  assert.deepEqual(writes, [`${lines.turnNew}\n`, `${lines.tool}\n`, lines.turnClose]);
});

test("the Codex stderr forwarder passes an oversized line through without buffering it", async () => {
  const { forward, writes } = filter();
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const done = forward(stream);
  const long = `{"fields":{"message":"enter"},"span":{"name":"x"},"pad":"${"a".repeat(70_000)}"}`;
  stream.write(long.slice(0, 66_000));
  stream.write(`${long.slice(66_000)}\n${lines.turnEnter}\n${lines.tool}\n`);
  stream.end();
  await done;
  assert.equal(writes.join(""), `${long}\n${lines.tool}\n`);
});

test("the Codex wrapper pipes only app-server stderr through the filter and keeps protocol stdout", () => {
  // The real wrapper program, end to end: a child prints protocol output on
  // stdout and tracing on stderr; the wrapper's helper forwards stderr.
  const child =
    `process.stdout.write(${JSON.stringify(`{"jsonrpc":"2.0","id":1,"result":{}}\n`)});` +
    `process.stderr.write(${JSON.stringify([lines.turnNew, lines.turnEnter, lines.probe, lines.tool, ""].join("\n"))});`;
  const program = `${CODEX_STDERR_FILTER_HELPER}
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: ["inherit", "inherit", "pipe"] });
const done = forwardCodexStderr(child.stderr);
child.on("exit", (code) => done.then(() => process.exit(code ?? 1)));`;
  const result = spawnSync(process.execPath, ["-e", program], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUST_LOG: "info,codex_otel=off" },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `{"jsonrpc":"2.0","id":1,"result":{}}\n`);
  assert.equal(result.stderr, `${lines.turnNew}\n${lines.tool}\n`);
  // The production wrapper uses the same helper and stdio split.
  assert.ok(AGENT_RUNTIME_ENTRYPOINT.includes(CODEX_STDERR_FILTER_HELPER));
  assert.match(AGENT_RUNTIME_ENTRYPOINT, /stdio: \["inherit", "inherit", "pipe"\]/);
  assert.match(AGENT_RUNTIME_ENTRYPOINT, /forwardCodexStderr\(child\.stderr\)/);
});
