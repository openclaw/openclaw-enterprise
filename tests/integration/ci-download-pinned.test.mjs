import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = resolve(
  fileURLToPath(new URL("../../scripts/ci/download-pinned.sh", import.meta.url)),
);
const body = Buffer.alloc(16 * 1024, "pinned-tool-bytes ");
const sha256 = createHash("sha256").update(body).digest("hex");

// Serves `body` on 127.0.0.1. `plan(request number)` picks how each request
// is answered: "fast" sends it at once; "trickle" sends 4 bytes per second
// and never finishes.
async function withServer(plan, run) {
  const requests = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    requests.push(request.url);
    const mode = plan(requests.length);
    response.writeHead(200, { "content-length": body.length });
    // Send the headers now, so a trickle's first second already counts as a 200.
    response.flushHeaders();
    if (mode === "fast") {
      response.end(body);
      return;
    }
    const timer = setInterval(() => response.write(body.subarray(0, 4)), 1000);
    timers.add(timer);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const dir = await mkdtemp(join(tmpdir(), "ci-download-pinned-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/tool`;
    return await run({ url, destination: join(dir, "tool"), requests, dir });
  } finally {
    for (const timer of timers) {
      clearInterval(timer);
    }
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(dir, { recursive: true, force: true });
  }
}

function download(url, destination, checksum, env = {}) {
  return new Promise((resolveRun) => {
    execFile(
      "bash",
      [script, url, destination, checksum],
      {
        env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", ...env },
        timeout: 30_000,
      },
      (error, stdout, stderr) =>
        resolveRun({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const fastAbort = { DOWNLOAD_PINNED_SPEED_LIMIT: "1000", DOWNLOAD_PINNED_SPEED_TIME: "2" };

test("a stalled download is cut off and retried, then checksum-verified", async () => {
  await withServer(
    (n) => (n === 1 ? "trickle" : "fast"),
    async ({ url, destination, requests }) => {
      const started = Date.now();
      const result = await download(url, destination, sha256, fastAbort);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 2);
      assert.match(result.stderr, /Transient download failure \(curl exit 28, HTTP 200\)/);
      assert.match(result.stdout, /: OK$/m);
      assert.deepEqual(await readFile(destination), body);
      // The stall ends after the speed window, not at the 300 s attempt cap.
      assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
    },
  );
});

test("a slow but moving download above the floor is not cut off", async () => {
  await withServer(
    () => "fast",
    async ({ url, destination, requests, dir }) => {
      // Let curl pace the response, so a delayed server timer cannot turn it into a stall.
      await writeFile(join(dir, ".curlrc"), "limit-rate = 4096\n");
      const started = performance.now();
      const result = await download(url, destination, sha256, {
        ...fastAbort,
        CURL_HOME: dir,
        DOWNLOAD_PINNED_SPEED_TIME: "1",
      });
      const elapsed = performance.now() - started;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /Transient download failure/);
      assert.ok(elapsed >= 2000, `expected at least two speed windows, took ${elapsed} ms`);
    },
  );
});

test("default settings download a fast file once and never retry a checksum mismatch", async () => {
  await withServer(
    () => "fast",
    async ({ url, destination, requests }) => {
      const ok = await download(url, destination, sha256);
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(requests.length, 1);

      const bad = await download(url, destination, "0".repeat(64));
      assert.notEqual(bad.code, 0);
      assert.equal(requests.length, 2);
      assert.doesNotMatch(bad.stderr, /Transient download failure/);
    },
  );
});
