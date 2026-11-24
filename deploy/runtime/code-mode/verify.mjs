// Exercise the packaged and stock hosts over the stdio transport used by Codex.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const app = createRequire("/app/node_modules/openclaw/package.json");
const cli = createRequire(app.resolve("@openai/codex/package.json"));
const platform = path.dirname(cli.resolve("@openai/codex-linux-arm64/package.json"));
const vendor = path.join(platform, "vendor/aarch64-unknown-linux-musl");
const manifest = cli(path.join(vendor, "codex-package.json"));
const packaged = path.join(vendor, manifest.resourcesDir, "codex-code-mode-host");
const stock = path.join(vendor, "bin", "codex-code-mode-host");

// Count executable memory that no file backs. A JIT-enabled V8 maps its code
// range executable for the first expression; that is the memory a sandbox that
// forbids JIT refuses. An interpreter-only V8 never maps any.
function anonymousExecutableMappings(pid) {
  return readFileSync(`/proc/${pid}/maps`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([, perms, , , , name = ""]) => {
      return perms.includes("x") && (name === "" || /^\[anon|^\/memfd:/.test(name));
    }).length;
}

function send(host, frame) {
  const payload = Buffer.from(JSON.stringify(frame));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  host.stdin.write(Buffer.concat([header, payload]));
}

async function* frames(host) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of host.stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE();
      assert.ok(length <= 1024 * 1024, "unexpected Code Mode frame length");
      if (buffer.length < 4 + length) break;
      yield JSON.parse(buffer.subarray(4, 4 + length).toString());
      buffer = buffer.subarray(4 + length);
    }
  }
  assert.equal(buffer.length, 0, "incomplete Code Mode response");
}

// Open a session, evaluate one expression, record the host's executable
// memory after the result, then require a clean shutdown.
async function evaluate(program) {
  const host = spawn(program, [], {
    stdio: ["pipe", "pipe", "inherit"],
    signal: AbortSignal.timeout(15_000),
  });
  const closed = once(host, "close");
  const sessionId = "package-verification";
  let executableMappings;
  let shutdown = false;
  send(host, {
    type: "connection/hello",
    supportedVersions: [1],
    requiredCapabilities: [],
    optionalCapabilities: [],
  });
  try {
    for await (const frame of frames(host)) {
      if (frame.type === "connection/ready") {
        // An emulator would map its own translated code; only a native process qualifies.
        assert.equal(
          readlinkSync(`/proc/${host.pid}/exe`),
          realpathSync(program),
          "Code Mode qualification requires native ARM64 execution, not user-mode emulation",
        );
        send(host, {
          type: "operation/request",
          id: 1,
          request: { method: "session/open", sessionId },
        });
      } else if (frame.type === "operation/response" && frame.id === 1) {
        assert.equal(frame.result.status, "ok");
        send(host, {
          type: "operation/request",
          id: 2,
          request: {
            method: "session/execute",
            sessionId,
            request: {
              tool_call_id: "arithmetic",
              enabled_tools: [],
              source: "text(19 + 23);",
              yield_time_ms: 1000,
              max_output_tokens: 100,
            },
          },
        });
      } else if (frame.type === "execute/initialResponse" && frame.id === 2) {
        assert.equal(frame.result.status, "ok");
        const result = frame.result.value.Result;
        assert.equal(result.error_text, null);
        assert.deepEqual(result.content_items, [{ type: "input_text", text: "42" }]);
        executableMappings = anonymousExecutableMappings(host.pid);
        send(host, {
          type: "operation/request",
          id: 3,
          request: { method: "session/shutdown", sessionId },
        });
      } else if (frame.type === "operation/response" && frame.id === 3) {
        assert.equal(frame.result.status, "ok");
        shutdown = true;
        host.stdin.end();
      }
    }
    assert.deepEqual(await closed, [0, null]);
    assert.ok(
      executableMappings !== undefined && shutdown,
      `${program} exited before returning a result and acknowledging shutdown`,
    );
    return executableMappings;
  } finally {
    host.kill();
  }
}

// The stock host is the control: it must map JIT memory here, or this check
// cannot tell the interpreter apart from a host that would fail in the sandbox.
assert.ok(
  (await evaluate(stock)) > 0,
  "the stock Code Mode host mapped no executable memory; this check cannot detect JIT",
);
assert.equal(
  await evaluate(packaged),
  0,
  "the packaged Code Mode host mapped executable memory; it must run V8 without JIT",
);

// The refreshed runtime inventory must identify the host that Codex now selects.
const runtime = "/opt/oce/runtime";
const contents = readFileSync(path.join(runtime, "contents.json"));
const provenance = JSON.parse(readFileSync(path.join(runtime, "provenance.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hostSha256 = sha256(readFileSync(packaged));
assert.equal(provenance.runtimeContentsSha256, sha256(contents));
assert.equal(provenance.codeModeHost.sha256, hostSha256);
assert.ok(
  JSON.parse(contents.toString("utf8")).some(
    (entry) =>
      path.join("/app/node_modules/openclaw", entry.path) === packaged &&
      entry.sha256 === hostSha256 &&
      entry.mode === 0o555,
  ),
  "the runtime inventory must list the packaged Code Mode host",
);
console.log("Code Mode returned 42 without JIT memory; the stock control mapped JIT memory.");
