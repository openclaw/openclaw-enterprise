import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { boxTurnPolicy } from "../helpers/strands-box-turn-policy.ts";

// The Box Codex is the operator's host binary. Probe the one on PATH, or OCE_CODEX_BIN.
const codex = process.env.OCE_CODEX_BIN ?? "codex";
const codexVersion = spawnSync(codex, ["--version"], { encoding: "utf8", timeout: 10_000 });
// Manual lane strands-box-native (docs/testing/strands-box.md): the Codex CLI
// is a host input CI does not stage, so this case runs only when the lane
// selects it and then fails, never skips, without it.
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

test(
  "Codex applies no network sandbox of its own under the Box turn policy, so Box egress is the fence",
  { skip: selection, timeout: 60_000 },
  async (t) => {
    assert.equal(process.platform, "linux", "the Box turn check needs a Linux Codex CLI");
    assert.equal(codexVersion.status, 0, "put a Linux Codex CLI on PATH or set OCE_CODEX_BIN");
    const policy = await boxTurnPolicy();
    const directory = await temporaryDirectory(t, "strands-turn-");
    const home = join(directory, "codex-home");
    const work = join(directory, "work");
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(work)]);
    const listener = createServer((socket) => socket.end());
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    t.after(() => listener.close());
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    // A fresh CODEX_HOME: no login, no user configuration, no model call.
    const child = spawn(codex, ["app-server"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    });
    t.after(() => child.kill("SIGKILL"));
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (typeof message.id === "number") {
            waiting.get(message.id)?.(message);
          }
        } catch {
          // Notifications and logs are not replies.
        }
      }
    });
    let next = 0;
    const call = (method: string, params: object) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    const initialized = await call("initialize", {
      clientInfo: { name: "oce-box-turn-probe", version: "0" },
    });
    assert.ok(initialized.result, "app-server initializes without a login");
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const probe = [
      process.execPath,
      "-e",
      `const s=require("node:net").connect(${address.port},"127.0.0.1");` +
        `s.on("connect",()=>{console.log("connected",process.env.CODEX_SANDBOX_NETWORK_DISABLED??"unset");process.exit(0)});` +
        `s.on("error",(e)=>{console.log("refused",e.code);process.exit(3)});`,
    ];
    const run = async (sandboxPolicy: object) => {
      const reply = await call("command/exec", {
        command: probe,
        cwd: work,
        sandboxPolicy,
        timeoutMs: 20_000,
      });
      const result = reply.result as { stdout?: string } | undefined;
      return result?.stdout?.trim() ?? JSON.stringify(reply.error);
    };
    // The Box policy reaches the network. Codex only marks the environment as restricted.
    assert.equal(await run(policy), "connected 1");
    // Control: this probe does detect a Codex-enforced network sandbox.
    assert.doesNotMatch(
      await run({ type: "workspaceWrite", writableRoots: [work], networkAccess: false }),
      /^connected/,
    );
  },
);
