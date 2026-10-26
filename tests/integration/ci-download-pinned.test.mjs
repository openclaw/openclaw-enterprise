import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, open, writeFile } from "node:fs/promises";
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
    if (mode === "missing") {
      response.writeHead(404);
      response.end();
      return;
    }
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

function download(url, destination, checksum, env = {}, creationMask = "022") {
  return new Promise((resolveRun) => {
    execFile(
      "bash",
      [
        "-c",
        'umask "$1"; shift; exec bash "$@"',
        "download-pinned-test",
        creationMask,
        script,
        url,
        destination,
        checksum,
      ],
      {
        env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", ...env },
        timeout: 30_000,
      },
      (error, stdout, stderr) =>
        resolveRun({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

// Observe bytes and permissions through the same opened file, rather than
// combining path-based metadata checks with later accesses to that path.
async function readTool(path) {
  const file = await open(path, "r");
  try {
    return { bytes: await file.readFile(), mode: (await file.stat()).mode & 0o777 };
  } finally {
    await file.close();
  }
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

test("downloads publish only verified bytes and preserve existing tools on failure", async () => {
  let mode = "fast";
  await withServer(
    () => mode,
    async ({ url, destination, requests, dir }) => {
      const ok = await download(url, destination, sha256);
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(requests.length, 1);
      const first = await readTool(destination);
      assert.deepEqual(first.bytes, body);
      assert.equal(first.mode, 0o644);

      const previous = Buffer.from("#!/bin/sh\nprintf old-tool\n");
      await writeFile(destination, previous);
      await chmod(destination, 0o755);
      const bad = await download(url, destination, "0".repeat(64));
      assert.notEqual(bad.code, 0);
      assert.equal(requests.length, 2);
      assert.doesNotMatch(bad.stderr, /Transient download failure/);
      const rejected = await readTool(destination);
      assert.ok(rejected.bytes.equals(previous), "failed download replaced the tool");
      assert.equal(rejected.mode, 0o755);
      assert.deepEqual(await readdir(dir), ["tool"]);

      const replacement = await download(url, destination, sha256);
      assert.equal(replacement.code, 0, replacement.stderr);
      const published = await readTool(destination);
      assert.deepEqual(published.bytes, body);
      assert.equal(published.mode, 0o755);
      assert.deepEqual(await readdir(dir), ["tool"]);

      await rm(destination);
      const absent = await download(url, destination, "0".repeat(64));
      assert.notEqual(absent.code, 0);
      assert.deepEqual(await readdir(dir), []);

      mode = "missing";
      await writeFile(destination, previous);
      await chmod(destination, 0o755);
      const missing = await download(url, destination, sha256);
      assert.equal(missing.code, 22);
      assert.equal(requests.length, 5);
      const retained = await readTool(destination);
      assert.ok(retained.bytes.equals(previous));
      assert.equal(retained.mode, 0o755);
      assert.deepEqual(await readdir(dir), ["tool"]);

      mode = "fast";
      await rm(destination);
      const restrictive = await download(url, destination, sha256, {}, "077");
      assert.equal(restrictive.code, 0, restrictive.stderr);
      const privateTool = await readTool(destination);
      assert.deepEqual(privateTool.bytes, body);
      assert.equal(privateTool.mode, 0o600);
      assert.deepEqual(await readdir(dir), ["tool"]);
    },
  );
});
