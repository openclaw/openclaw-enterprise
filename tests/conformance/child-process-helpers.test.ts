import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { captureChild, concurrencyLimit, eachSettled } from "../helpers/child-processes.ts";
import { stopProcess } from "../helpers/stop-process.ts";

test("captureChild preserves binary stdin and stdout, and resolves a nonzero exit", async () => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const result = await captureChild(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout); process.exitCode = 7"],
    {
      input: bytes,
      encoding: null,
    },
  );
  assert.deepEqual(result.stdout, bytes);
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(Object.hasOwn(result, "timing"), false);
});

test("captureChild distinguishes complete stderr, a matching prefix, and a mismatched prefix", async () => {
  for (const [stderr, prefix, exact] of [
    ["é", true, true],
    ["é!", true, false],
    ["xé", false, false],
  ] as const) {
    const result = await captureChild(
      process.execPath,
      ["-e", "process.stderr.write(process.argv[1])", stderr],
      { expectedStderr: "é" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, stderr);
    assert.ok(result.timing);
    assert.equal(typeof result.timing.firstStderrMs, "number");
    assert.equal(result.timing.expectedPrefixMs !== null, prefix);
    assert.equal(result.timing.exactStderr, exact);
    assert.equal(result.timing.parentSentSignal, false);
  }
});

test(
  "a queued task gets the slot after rejection, and eachSettled waits for cleanup",
  { timeout: 5_000 },
  async () => {
    const limit = concurrencyLimit(1);
    const started: number[] = [];
    const release = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstError = new Error("first task");
    const done = eachSettled([0, 1, 2], (index) =>
      limit(async () => {
        started.push(index);
        if (index === 0) {
          throw firstError;
        }
        if (index === 1) {
          secondStarted.resolve();
          await release.promise;
          throw new Error("second task");
        }
      }),
    );
    let settled = false;
    const checked = assert
      .rejects(done, (reason) => reason === firstError)
      .then(() => {
        settled = true;
      });
    await secondStarted.promise;
    try {
      await nextTurn();
      assert.deepEqual(started, [0, 1]);
      assert.equal(settled, false);
    } finally {
      release.resolve();
    }
    await checked;
    assert.deepEqual(started, [0, 1, 2]);
  },
);

test(
  "stopProcess escalates for an unresponsive child and is safe to call again",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    // Signal only this child; wait for its handler to be installed before teardown.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => stopProcess(child, { signal: "SIGKILL" }));
    await once(child.stdout, "data");
    await stopProcess(child, { graceMs: 50 });
    assert.equal(child.signalCode, "SIGKILL");
    await stopProcess(child);
  },
);
