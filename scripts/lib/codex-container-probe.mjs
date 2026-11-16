import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";

// Credential-free startup proof for an explicitly selected container boundary.
// It does not qualify model credentials or workspace-write isolation.
const expectedVersion = process.argv.at(-1);
assert.equal(
  execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  `codex-cli ${expectedVersion}`,
);
await mkdir("/home/node/.codex", { recursive: true });
const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let id = 0;
const timer = setTimeout(() => child.kill(), 45_000);
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const request = pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(`Codex refused ${request.method} (${message.error.code})`));
    } else {
      request.resolve(message.result);
    }
  }
});
child.on("exit", () => {
  for (const request of pending.values()) {
    request.reject(new Error("Codex exited before the container probe completed."));
  }
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { method, resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
try {
  await request("initialize", {
    clientInfo: { name: "oce_container_probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const thread = await request("thread/start", {
    cwd: "/workspace",
    permissions: ":danger-full-access",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    ephemeral: true,
  });
  assert.equal(thread.sandbox?.type, "dangerFullAccess");
  assert.equal(thread.approvalPolicy, "on-request");
  assert.equal(thread.approvalsReviewer, "auto_review");
  const result = await request("command/exec", {
    command: [
      "sh",
      "-c",
      'set -eu; test "$(id -u)" = 1000; grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status; grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status; echo container-boundary > /home/node/.codex/container-probe; test "$(cat /home/node/.codex/container-probe)" = container-boundary; if touch /oce-container-root-probe 2>/dev/null; then exit 70; fi; rm /home/node/.codex/container-probe',
    ],
    cwd: "/workspace",
    sandboxPolicy: { type: "dangerFullAccess" },
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  process.stdout.write(
    `${JSON.stringify({ codexVersion: expectedVersion, sandbox: "dangerFullAccess", containerBoundaryVerified: true, workspaceIsolationVerified: false, modelExecutionVerified: false })}\n`,
  );
} finally {
  clearTimeout(timer);
  child.kill();
  lines.close();
}
