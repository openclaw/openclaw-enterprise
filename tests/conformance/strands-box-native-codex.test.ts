import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { Agent, MessageEvent, WebSocket } from "../../apps/controller/node_modules/undici/index.js";
import { hostConfig, smokeInput, start } from "../../deploy/examples/strands-box/host/launch.ts";
import {
  processIdentity,
  sameSocket,
  upgradeStatus,
} from "../../deploy/examples/strands-box/host/transport.ts";
import { initializeNativeVerifier } from "../../deploy/examples/strands-box/verify-native.ts";
import { listen } from "../helpers/listen.ts";
import { stopProcess } from "../helpers/stop-process.mjs";
import { strandsBoxReadinessProbe } from "../helpers/strands-box-driver-package.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md). These cases
// need host material CI does not have, so they run only when the lane selects
// them and then fail, never skip, on a missing prerequisite.
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

function assertOwnedLinux() {
  assert.equal(process.platform, "linux", "the Box host checks read Linux process identity");
  assert.notEqual(process.getuid?.(), 0, "run the Box host checks as an unprivileged user");
}

function temporary(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "oce-box-test-"));
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const realNative = process.env.OCC_TEST_STRANDS_NATIVE_CODEX;

function bridge(from: Duplex, to: Duplex) {
  from.on("error", () => to.destroy());
  to.on("error", () => from.destroy());
  from.once("close", () => to.destroy());
  to.once("close", () => from.destroy());
  from.pipe(to);
  to.pipe(from);
}

test(
  "the pinned TLS readiness probe initializes the original native Codex through a Unix relay",
  {
    timeout: 20_000,
    skip: selection,
  },
  async (t) => {
    assert.ok(
      realNative && isAbsolute(realNative),
      "set OCC_TEST_STRANDS_NATIVE_CODEX to a verified native Codex executable",
    );
    const { probe, ca, tls } = await strandsBoxReadinessProbe(
      await temporaryDirectory(t, "strands-readiness-"),
    );
    const directory = await temporaryDirectory(t, "strands-real-native-");
    const path = join(directory, "app-server.sock");
    const capability = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(capability).digest("hex");
    const native = spawn(
      realNative,
      [
        "app-server",
        "--listen",
        "ws://127.0.0.1:0",
        "--ws-auth",
        "capability-token",
        "--ws-token-sha256",
        digest,
      ],
      {
        cwd: directory,
        env: {
          HOME: directory,
          CODEX_HOME: directory,
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          OTEL_SDK_DISABLED: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let startupError: Error | undefined;
    let listener: number | undefined;
    native.once("error", (error) => {
      startupError = error;
    });
    t.after(() => stopProcess(native));
    for (const output of [native.stdout, native.stderr]) {
      let tail = "";
      output.setEncoding("utf8").on("data", (text: string) => {
        tail = (tail + text).slice(-4_096);
        const port = /(?:^|\n) {2}listening on: ws:\/\/127\.0\.0\.1:(\d{1,5})(?:\r?\n|$)/.exec(
          tail,
        )?.[1];
        if (port !== undefined && Number(port) > 0 && Number(port) <= 65535) {
          listener = Number(port);
        }
      });
    }
    const nativePort: number = await waitFor(
      "the native process to announce its owned listener",
      () => {
        if (startupError) {
          throw startupError;
        }
        assert.equal(
          native.exitCode,
          null,
          "the selected Codex must support native WebSocket capability auth",
        );
        return listener;
      },
      5_000,
    );

    // Match the installed route's transport shape. Both bridges pass bytes;
    // only the actual native app-server authenticates and answers initialize.
    const unix = createNetServer((socket) => bridge(socket, connect(nativePort, "127.0.0.1")));
    await new Promise<void>((resolve, reject) => {
      unix.once("error", reject);
      unix.listen(path, resolve);
    });
    await chmod(path, 0o600);
    t.after(
      () =>
        new Promise<void>((resolve) => {
          unix.close(() => resolve());
        }),
    );
    const dispatcher = new Agent({ connect: { socketPath: path } });
    const verifier = new WebSocket("ws://localhost/", {
      dispatcher,
      headers: { authorization: `Bearer ${capability}` },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        verifier.addEventListener("open", () => resolve(), { once: true });
        verifier.addEventListener("error", reject, { once: true });
      });
      await initializeNativeVerifier(async (method, params) => {
        const id = 1;
        const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
          verifier.addEventListener("error", reject, { once: true });
          verifier.addEventListener("message", (event) => {
            try {
              assert.ok(event instanceof MessageEvent && typeof event.data === "string");
              const response = object(JSON.parse(event.data));
              if (response.id === id) {
                resolve(response);
              }
            } catch (error) {
              reject(error);
            }
          });
          verifier.send(JSON.stringify({ id, method, params }));
        });
        const result = object(reply.result);
        assert.equal(result.codexHome, directory);
        const { userAgent } = result;
        assert.ok(typeof userAgent === "string");
        assert.equal(userAgent.includes("codex"), false);
        const nativeVersion = execFileSync(realNative, ["--version"], { encoding: "utf8" })
          .trim()
          .split(" ")[1];
        assert.ok(nativeVersion);
        assert.equal(userAgent.split(" ")[0], `strands-box-verify-native/${nativeVersion}`);
        return reply;
      });
    } finally {
      verifier.close();
      await dispatcher.destroy();
    }
    const server = createTlsServer(tls, (socket) => bridge(socket, connect(path)));
    const port: number = await listen(t, server);
    const url = `wss://127.0.0.1:${port}/`;
    const signal = new AbortController().signal;
    assert.deepEqual(await probe(url, ca, "incorrect-capability", signal), { state: "starting" });
    assert.deepEqual(await probe(url, ca, capability, signal), { state: "serving" });
    assert.equal(native.exitCode, null);
    await stopProcess(native);
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function initialize(socketPath: string, bearer: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      path: "/",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.once("error", reject);
    req.once("response", (response) => {
      response.resume();
      reject(new Error(`native_upgrade_status:${response.statusCode}`));
    });
    req.once("upgrade", (_response, socket) => {
      const id = 5;
      const payload = Buffer.from(
        JSON.stringify({
          id,
          method: "initialize",
          params: { clientInfo: { name: "owner-conformance", version: "1" } },
        }),
      );
      assert(payload.length < 126);
      const key = Buffer.from([21, 43, 65, 87]);
      const masked = Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]!));
      let data = Buffer.alloc(0);
      socket.setTimeout(2_500, () => socket.destroy(new Error("native_initialize_timeout")));
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("native_closed_before_initialize")));
      socket.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        const size = data[1];
        if (data.length < 2 || size === undefined) {
          return;
        }
        if (size > 126 || data[0] !== 0x81) {
          socket.destroy(new Error("unsupported_native_reply_frame"));
          return;
        }
        const offset = size === 126 ? 4 : 2;
        if (data.length < offset) {
          return;
        }
        const end = offset + (size === 126 ? data.readUInt16BE(2) : size);
        if (data.length < end) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(data.subarray(offset, end).toString("utf8"));
          resolve(parsed);
          socket.destroy();
        } catch {
          socket.destroy(new Error("invalid_native_reply_json"));
        }
      });
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, masked]));
    });
    req.end();
  });
}

// Optional same-host wire check with actual Codex. The CLI stand-in only calls
// the emitted agent and deliberately establishes no Box or namespace evidence.
const codexFixture = process.env.STRANDS_HOST_TEST_CODEX;
const compiledFixture = process.env.STRANDS_HOST_TEST_AGENT_BUILD;
test(
  "owned launcher reaches actual native Codex and retires it without carrying auth material",
  {
    skip: selection,
    timeout: 30_000,
  },
  async () => {
    assertOwnedLinux();
    assert.ok(
      codexFixture && compiledFixture,
      "set STRANDS_HOST_TEST_CODEX and STRANDS_HOST_TEST_AGENT_BUILD",
    );
    const directory = temporary();
    const runtimeDir = join(directory, "run");
    const workspace = join(directory, "work");
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const nodeBin = realpathSync(process.execPath);
    const boxBin = join(directory, "box-command-fixture");
    const boxPidPath = join(directory, "fixture-box.pid");
    writeFileSync(boxBin, "", { mode: 0o700 });
    const config = hostConfig({
      agentBuildDir: realpathSync(compiledFixture),
      boxBin,
      nodeBin,
      codexBin: realpathSync(codexFixture),
      runtimeDir,
      workspace,
      read: [],
      exec: [],
      linuxPreview: true,
    });
    const { input, capability } = smokeInput(config);
    const environment = Object.entries(input.environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const expected = join(runtimeDir, "authority", "box.toml");
    const args = [
      nodeBin,
      "--jitless",
      join(config.agentBuildDir, "box-agent.js"),
      join(runtimeDir, "input", "agent.json"),
    ].map(shellQuote);
    writeFileSync(
      boxBin,
      `#!/bin/sh\n[ "$1" = run ] && [ "$2" = --config ] && [ "$3" = ${shellQuote(expected)} ] || exit 2\n` +
        `[ -z "\${APP_SERVER_TOKEN+x}\${OPENAI_API_KEY+x}\${AWS_SECRET_ACCESS_KEY+x}" ] || exit 3\n` +
        `printf '%s\\n' "$$" > ${shellQuote(boxPidPath)}\n` +
        `exec env -i ${environment} ${args.join(" ")}\n`,
      { mode: 0o700 },
    );
    const execution = start(config, input, capability);
    try {
      const ready = await execution.ready;
      const front = join(runtimeDir, "app-server.sock");
      assert(sameSocket(front, { dev: ready.socketDev, ino: ready.socketIno }));
      assert.equal(await upgradeStatus({ path: front }), 401);
      assert.equal(await upgradeStatus({ path: front }, "wrong"), 401);
      assert.equal(await upgradeStatus({ path: front }, capability), 101);
      const result = await initialize(front, capability);
      assert(result && typeof result === "object" && "id" in result && result.id === 5);
      assert(
        "result" in result &&
          result.result &&
          typeof result.result === "object" &&
          "userAgent" in result.result,
      );
      const agentInput = readFileSync(join(runtimeDir, "input", "agent.json"), "utf8");
      assert(agentInput.includes(createHash("sha256").update(capability).digest("hex")));
      assert(!agentInput.includes(capability));
      assert(!readFileSync(expected, "utf8").includes(capability));
      assert.equal(lstatSync(join(runtimeDir, "capability")).mode & 0o777, 0o600);
      const originalBoxPid = Number(readFileSync(boxPidPath, "utf8").trim());
      assert.equal(processIdentity(originalBoxPid).ppid, process.pid);
      process.kill(originalBoxPid, "SIGTERM");
      assert.equal(await execution.done, 1);
      assert.equal(await upgradeStatus({ path: front }, capability), undefined);
      assert.throws(() => lstatSync(join(runtimeDir, "ready.json")), { code: "ENOENT" });
      assert.throws(() => lstatSync(join(runtimeDir, "capability")), { code: "ENOENT" });
    } finally {
      await execution.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
