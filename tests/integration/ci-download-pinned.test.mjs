import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, open, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
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
const half = body.length / 2;

// Serves `body` on 127.0.0.1. `plan(request number)` picks how each request
// is answered: "fast" sends it at once and honors a `Range: bytes=N-` resume
// with 206; "no-range" sends it whole and ignores Range; "half" sends the
// first half, then holds the connection open; "trickle" sends the next 4 bytes
// each second and never finishes.
async function withServer(plan, run) {
  const requests = [];
  const ranges = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    requests.push(request.url);
    ranges.push(request.headers.range);
    const mode = plan(requests.length);
    if (mode === "missing") {
      response.writeHead(404);
      response.end();
      return;
    }
    const resumeAt = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
    if (mode === "fast" && resumeAt > 0) {
      response.writeHead(206, {
        "content-length": body.length - resumeAt,
        "content-range": `bytes ${resumeAt}-${body.length - 1}/${body.length}`,
      });
      response.end(body.subarray(resumeAt));
      return;
    }
    response.writeHead(200, { "content-length": body.length });
    // Send the headers now, so a trickle's first second already counts as a 200.
    response.flushHeaders();
    if (mode === "fast" || mode === "no-range") {
      response.end(body);
      return;
    }
    if (mode === "half") {
      response.write(body.subarray(0, half));
      return;
    }
    let sent = 0;
    const timer = setInterval(() => {
      response.write(body.subarray(sent, sent + 4));
      sent += 4;
    }, 1000);
    timers.add(timer);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const dir = await mkdtemp(join(tmpdir(), "ci-download-pinned-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/tool`;
    return await run({ url, destination: join(dir, "tool"), requests, ranges, dir });
  } finally {
    for (const timer of timers) {
      clearInterval(timer);
    }
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(dir, { recursive: true, force: true });
  }
}

function download(
  url,
  destination,
  checksum,
  env = {},
  creationMask = "022",
  cache,
  existing,
  mode,
) {
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
        ...(cache || existing || mode ? [cache ?? ""] : []),
        ...(existing || mode ? [existing ?? ""] : []),
        ...(mode ? [mode] : []),
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
    return { bytes: await file.readFile(), mode: (await file.stat()).mode & 0o7777 };
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

// The attempt cap (3 s here, 300 s on CI) ends an attempt that is still moving
// data, after the 4 s retry budget would have run out. On CI, dl.k8s.io sent
// kubectl at about 140 KB/s, so one attempt got about 42 of its 59 MB.
const cappedAttempt = { DOWNLOAD_PINNED_MAX_TIME: "3", DOWNLOAD_PINNED_RETRY_BUDGET: "4" };

test("an attempt cut off with bytes received is retried and resumes from them", async () => {
  await withServer(
    (n) => (n === 1 ? "half" : "fast"),
    async ({ url, destination, requests, ranges }) => {
      const result = await download(url, destination, sha256, cappedAttempt);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 2);
      assert.match(
        result.stderr,
        /curl exit 28, HTTP 200\); retrying in 2s \(attempt 2\/8, resuming at byte 8192\)/,
      );
      // The retry asks only for the missing half, and the joined file passes the checksum.
      assert.deepEqual(ranges, [undefined, `bytes=${half}-`]);
      assert.match(result.stdout, /: OK$/m);
      assert.deepEqual(await readFile(destination), body);
    },
  );
});

test("a server that ignores the resume request gets a fresh download", async () => {
  await withServer(
    (n) => (n === 1 ? "half" : n === 2 ? "no-range" : "fast"),
    async ({ url, destination, requests, ranges }) => {
      const result = await download(url, destination, sha256, { DOWNLOAD_PINNED_MAX_TIME: "3" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 3);
      assert.match(result.stderr, /Server refused to resume at byte 8192; starting over/);
      // A 200 answer to a resume is never appended to the partial file.
      assert.deepEqual(ranges, [undefined, `bytes=${half}-`, undefined]);
      assert.deepEqual(await readFile(destination), body);
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

      // Replacing an old executable must not grant its setuid/setgid privileges
      // to new bytes. A failed download still leaves the old file untouched.
      await writeFile(destination, previous);
      await chmod(destination, 0o6755);
      const privilegedFailure = await download(url, destination, "0".repeat(64));
      assert.notEqual(privilegedFailure.code, 0);
      const privilegedRetained = await readTool(destination);
      assert.equal(privilegedRetained.mode, 0o6755);
      assert.deepEqual(privilegedRetained.bytes, previous);
      const unprivilegedReplacement = await download(url, destination, sha256);
      assert.equal(unprivilegedReplacement.code, 0, unprivilegedReplacement.stderr);
      const unprivileged = await readTool(destination);
      assert.equal(unprivileged.mode, 0o755);
      assert.deepEqual(unprivileged.bytes, body);
    },
  );
});

// The local server represents transport only; the real shell and checksum tools
// decide whether restored bytes can be published.
test("a verified cached download works offline and an empty cache is populated", async () => {
  await withServer(
    () => "fast",
    async ({ url, destination, requests, dir }) => {
      const cache = join(dir, "cache");
      const cold = await download(url, destination, sha256, {}, "022", cache);
      assert.equal(cold.code, 0, cold.stderr);
      assert.equal(requests.length, 1);
      assert.deepEqual(await readFile(join(cache, sha256)), body);
      await rm(destination);
      const hit = await download(
        "http://127.0.0.1:1/unreachable",
        destination,
        sha256,
        {},
        "022",
        cache,
      );
      assert.equal(hit.code, 0, hit.stderr);
      assert.deepEqual(await readFile(destination), body);
      assert.equal(requests.length, 1);
    },
  );
});

test("corrupt cache falls back to pinned transport and failed transport preserves the destination", async () => {
  let mode = "missing";
  await withServer(
    () => mode,
    async ({ url, destination, requests, dir }) => {
      const cache = join(dir, "cache");
      await mkdir(cache);
      await writeFile(join(cache, sha256), "untrusted cached bytes");
      await writeFile(destination, "previous tool");
      const refused = await download(url, destination, sha256, {}, "022", cache, destination);
      assert.equal(refused.code, 22, refused.stderr);
      assert.equal(await readFile(destination, "utf8"), "previous tool");
      assert.equal(requests.length, 1);
      mode = "fast";
      const recovered = await download(url, destination, sha256, {}, "022", cache, destination);
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.equal(requests.length, 2);
      assert.deepEqual(await readFile(destination), body);
      assert.deepEqual(await readFile(join(cache, sha256)), body);
    },
  );
});

test("unavailable cache storage does not block the pinned download", async () => {
  await withServer(
    () => "fast",
    async ({ url, destination, requests, dir }) => {
      const cache = join(dir, "not-a-directory");
      await writeFile(cache, "occupied");
      const result = await download(url, destination, sha256, {}, "022", cache);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 1);
      assert.deepEqual(await readFile(destination), body);
      assert.equal(await readFile(cache, "utf8"), "occupied");
    },
  );
});

test("a checksum-valid installed candidate is reused offline without a cache", async () => {
  await withServer(
    () => "missing",
    async ({ destination, requests, dir }) => {
      const installed = join(dir, "installed");
      await writeFile(installed, body, { mode: 0o555 });
      const result = await download(
        "http://127.0.0.1:1/unreachable",
        destination,
        sha256,
        {},
        "022",
        undefined,
        installed,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 0);
      assert.deepEqual(await readFile(destination), body);
      assert.deepEqual(await readFile(installed), body);
      // Tool callers publish executable permissions atomically, even with a
      // writable old destination or a permissive process umask.
      for (const replace of [false, true]) {
        await rm(destination);
        if (replace) {
          await writeFile(destination, "previous tool");
          await chmod(destination, 0o666);
        }
        const executable = await download(
          "http://127.0.0.1:1/unreachable",
          destination,
          sha256,
          {},
          "0002",
          undefined,
          installed,
          "0755",
        );
        assert.equal(executable.code, 0, executable.stderr);
        const published = await readTool(destination);
        assert.equal(published.mode, 0o755);
        assert.deepEqual(published.bytes, body);
      }
    },
  );
});

test("a cache hit replaces a read-only tool without rewriting a read-only cache", async () => {
  await withServer(
    () => "missing",
    async ({ destination, requests, dir }) => {
      const cache = join(dir, "cache");
      await mkdir(cache);
      const entry = join(cache, sha256);
      await writeFile(entry, body, { mode: 0o444 });
      await writeFile(destination, "previous tool", { mode: 0o555 });
      await chmod(destination, 0o555);
      const before = statSync(entry);
      await chmod(cache, 0o555);
      try {
        const result = await download(
          "http://127.0.0.1:1/unreachable",
          destination,
          sha256,
          {},
          "022",
          cache,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /cache unavailable/i);
        assert.equal(requests.length, 0);
        assert.deepEqual(await readFile(destination), body);
        assert.equal(statSync(destination).mode & 0o777, 0o555);
        assert.equal(statSync(entry).ino, before.ino);
        assert.equal(statSync(entry).mtimeMs, before.mtimeMs);
      } finally {
        await chmod(cache, 0o755);
      }
    },
  );
});

test("a writable destination does not expose unverified staging bytes", async () => {
  let directory;
  let observedMode;
  // Inspect the actual staging file while real curl waits for this HTTP reply.
  await withServer(
    () => {
      const temporary = readdirSync(directory).find((name) => name.startsWith("tool.download."));
      observedMode = statSync(join(directory, temporary)).mode & 0o777;
      return "fast";
    },
    async ({ url, destination, dir }) => {
      directory = dir;
      await writeFile(destination, "previous tool");
      await chmod(destination, 0o666);
      const result = await download(url, destination, sha256);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(observedMode, 0o600);
      assert.deepEqual(await readFile(destination), body);
      assert.equal(statSync(destination).mode & 0o777, 0o666);
    },
  );
});

for (const tool of ["yq", "k3d"]) {
  test(`Linux tool setup never executes corrupt cached or existing ${tool} before verification`, async (t) => {
    if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
      t.skip("Linux amd64/arm64 pinned tool setup");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "ci-tool-cache-"));
    try {
      const bin = join(dir, "bin");
      const cache = join(dir, "cache");
      await mkdir(bin);
      await mkdir(cache);
      const marker = join(dir, "unverified-executed");
      const version = tool === "yq" ? "yq version v4.48.1" : "k3d version v5.8.3";
      const untrusted = `#!/bin/sh\nprintf executed > "$TOOL_TEST_MARKER"\necho "${version}"\n`;
      // Other tool prerequisites are outside this test. The selected tool's
      // verifier and downloader stay real; curl reports a terminal failure.
      for (const [name, text] of Object.entries({
        docker: "#!/bin/sh\necho 29.9.2\n",
        helm: "#!/bin/sh\necho v3.19.2\n",
        kubectl: `#!/bin/sh\necho '{"clientVersion":{"gitVersion":"v1.35.0"}}'\n`,
        curl: "#!/bin/sh\nprintf '404 0'\nexit 22\n",
        [tool]: untrusted,
      })) {
        await writeFile(join(bin, name), text, { mode: 0o755 });
      }
      const digests =
        tool === "yq"
          ? {
              arm64: "0e46b5b926a9e57c526fa2bd8f8e38b7e17fbf6e2403ff1741f3b268e3363a9e",
              x64: "99df6047f5b577a9d25f969f7c3823ada3488de2e2115b30a0abb10d9324fd9f",
            }
          : {
              arm64: "0b8110f2229631af7402fb828259330985918b08fefd38b7f1b788a1c8687216",
              x64: "dbaa79a76ace7f4ca230a1ff41dc7d8a5036a8ad0309e9c54f9bf3836dbe853e",
            };
      await writeFile(join(cache, digests[process.arch]), untrusted, { mode: 0o755 });
      const setup = fileURLToPath(new URL("../../scripts/ci/setup-tools.sh", import.meta.url));
      const runSetup = () =>
        new Promise((done) => {
          execFile(
            "bash",
            [setup, tool === "yq" ? "images" : "k3d"],
            {
              env: {
                ...process.env,
                BASH_ENV: "/dev/null",
                ENV: "/dev/null",
                RUNNER_TEMP: dir,
                CI_PINNED_TOOL_CACHE: cache,
                TOOL_TEST_MARKER: marker,
                PATH: `${bin}:${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
              },
              timeout: 15_000,
            },
            (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
          );
        });
      const result = await runSetup();
      assert.equal(
        (await readdir(dir)).includes("unverified-executed"),
        false,
        "unverified tool executed",
      );
      assert.notEqual(result.code, 0, result.stderr);
      assert.match(result.stderr, /Download failed.*HTTP 404/);
      assert.equal(await readFile(join(bin, tool), "utf8"), untrusted);
      await writeFile(
        join(bin, "uname"),
        '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo riscv64; fi\n',
        { mode: 0o755 },
      );
      const unsupported = await runSetup();
      assert.notEqual(unsupported.code, 0);
      assert.match(unsupported.stderr, /No supported checksum pin/);
      assert.equal((await readdir(dir)).includes("unverified-executed"), false);
      const manualTool = tool === "yq" ? "helm" : "kubectl";
      await writeFile(join(bin, manualTool), "#!/bin/sh\nexit 1\n");
      const manual = await runSetup();
      assert.notEqual(manual.code, 0);
      assert.match(
        manual.stderr,
        new RegExp(`Install ${tool === "yq" ? "Helm" : "kubectl"} .* manually`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
