import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";

test("cancelled bootstrap directory setup dispatches no command and retains its cleanup", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oce-bootstrap-cancellation-"));
  const previousTmpdir = process.env.TMPDIR;
  const controller = new AbortController();
  const cleanups = [];
  let processCount = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "PROCESSWRAP") {
        processCount += 1;
      }
    },
  });
  try {
    process.env.TMPDIR = parent;
    hook.enable();
    // Cancellation arrives only after the real private-directory setup has completed.
    // No model credentials or usable database endpoint are supplied, including on red.
    await assert.rejects(
      ensureDevelopmentBootstrap(
        {
          after(cleanup) {
            cleanups.push(cleanup);
            controller.abort();
          },
        },
        { signal: controller.signal, environment: {}, databaseUrl: "", timeout: 1_000 },
      ),
      (error) => {
        assert.equal(processCount, 0, "cancelled setup must not spawn the bootstrap command");
        assert.equal(error.name, "AbortError");
        return true;
      },
    );
    assert.equal(cleanups.length, 1);
    assert.equal(
      (await readdir(parent)).length,
      1,
      "the real directory was created before cancellation",
    );
    await cleanups.pop()();
    assert.deepEqual(await readdir(parent), [], "cancellation must not disable directory cleanup");
  } finally {
    hook.disable();
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    await rm(parent, { recursive: true, force: true });
  }
});
