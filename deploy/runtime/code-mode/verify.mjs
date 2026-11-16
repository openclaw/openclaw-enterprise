// Exercise the packaged host over the stdio transport used by Codex.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const app = createRequire("/app/node_modules/openclaw/package.json");
const cli = createRequire(app.resolve("@openai/codex/package.json"));
const platform = path.dirname(cli.resolve("@openai/codex-linux-arm64/package.json"));
const vendor = path.join(platform, "vendor/aarch64-unknown-linux-musl");
const manifest = cli(path.join(vendor, "codex-package.json"));
const packaged = path.join(vendor, manifest.resourcesDir, "codex-code-mode-host");
const host = spawn(packaged, [], {
  stdio: ["pipe", "pipe", "inherit"],
  signal: AbortSignal.timeout(15_000),
});
const closed = once(host, "close");

function send(frame) {
  const payload = Buffer.from(JSON.stringify(frame));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  host.stdin.write(Buffer.concat([header, payload]));
}

async function* frames() {
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

const sessionId = "package-verification";
let executed = false;
let shutdown = false;
send({
  type: "connection/hello",
  supportedVersions: [1],
  requiredCapabilities: [],
  optionalCapabilities: [],
});
try {
  for await (const frame of frames()) {
    if (frame.type === "connection/ready") {
      send({ type: "operation/request", id: 1, request: { method: "session/open", sessionId } });
    } else if (frame.type === "operation/response" && frame.id === 1) {
      assert.equal(frame.result.status, "ok");
      send({
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
      executed = true;
      send({
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
    executed && shutdown,
    "the host exited before returning a result and acknowledging shutdown",
  );
} finally {
  host.kill();
}

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
console.log("Code Mode returned 42 and closed its session.");
