import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import timers from "node:timers/promises";
import type { Page } from "playwright";

import { pressKey, recordWalkthrough } from "../../scripts/console/record-walkthrough.ts";
import { setEnvironment } from "../helpers/environment.ts";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

async function prepareRecording(t: TestContext) {
  const directory = await temporaryDirectory(t, "record-walkthrough-");
  const recordings = join(directory, "recordings");
  setEnvironment(t, { PATH: directory });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await mkdir(recordings);

  // Advance only viewer pauses. The fixture delivers the opening frame immediately.
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  t.mock.method(
    timers,
    "setTimeout",
    async (delay = 0, value: unknown, options?: Parameters<typeof timers.setTimeout>[2]) => {
      if (options?.ref === false) {
        return new Promise(() => {});
      }
      elapsed += delay;
      return value;
    },
  );
  syncBuiltinESMExports();

  const pressed: string[] = [];
  const page = {
    viewportSize: () => ({ width: 390, height: 844 }),
    waitForFunction: async () => ({ dispose: async () => {} }),
    keyboard: {
      async press(key: string) {
        pressed.push(key);
      },
    },
    screencast: {
      async start(options: Parameters<Page["screencast"]["start"]>[0]) {
        assert.ok(options?.path && options.onFrame);
        const path = options.path;
        await options.onFrame({
          data: Buffer.alloc(0),
          timestamp: 0,
          viewportWidth: 390,
          viewportHeight: 844,
        });
        return { dispose: () => writeFile(path, "raw recording fixture") };
      },
    },
  } as unknown as Page;
  const outputPath = join(recordings, "take.webm");
  const timingPath = outputPath + ".json";
  const reviewPath = join(recordings, "take.mp4");
  return {
    directory,
    recordings,
    page,
    pressed,
    outputPath,
    timingPath,
    reviewPath,
  };
}

async function provideEncoder(directory: string, exitCode = 0) {
  // Use the real process and file boundaries. The fake encoder can leave partial output.
  await writeCommand(
    directory,
    "ffmpeg",
    `while [ "$#" -gt 1 ]; do
  shift
done
case "$1" in
  *.mp4)
    printf 'review recording fixture' > "$1"
    exit ${exitCode}
    ;;
esac`,
    { log: join(directory, "ffmpeg.log") },
  );
}

const noOperation = async () => {};
const unexpectedCallback = async () => assert.fail("scenario callback ran before admission");

test("a key take exports a review copy and preserves the original action timing", async (t) => {
  const { directory, page, pressed, outputPath, timingPath, reviewPath } =
    await prepareRecording(t);
  await provideEncoder(directory);
  const keyStep = {
    action: pressKey(page, "Space"),
    async verify() {
      assert.deepEqual(pressed, ["Escape", "Space"]);
    },
  };
  const ordinaryStep = {
    async action() {
      assert.equal(this, ordinaryStep);
      await page.keyboard.press("Tab");
    },
    async verify() {
      assert.equal(this, ordinaryStep);
    },
  };

  const result = await recordWalkthrough(page, {
    outputPath,
    ready: () => page.keyboard.press("Escape"),
    steps: [{ ...keyStep }, ordinaryStep],
  });

  assert.deepEqual(result, { outputPath, timingPath, reviewPath });
  assert.deepEqual(pressed, ["Escape", "Space", "Tab"]);
  assert.deepEqual(JSON.parse(await readFile(timingPath, "utf8")), {
    status: "complete",
    steps: [
      { actionAtMs: 2400, key: "Space", resultAtMs: 2400, recheckedAtMs: 5200 },
      { actionAtMs: 5200, resultAtMs: 5200, recheckedAtMs: 9700 },
    ],
  });
  assert.equal(await readFile(outputPath, "utf8"), "raw recording fixture");
  assert.equal(await readFile(reviewPath, "utf8"), "review recording fixture");
  const calls = await commandCalls(join(directory, "ffmpeg.log"));
  const reviewCommand = calls.find((call) => call.endsWith(".mp4"));
  assert.ok(reviewCommand, "FFmpeg received a review export");
  assert.match(reviewCommand, /pad=iw:ih\+48:0:0:/u);
  assert.deepEqual(
    [...reviewCommand.matchAll(/:text=([^:]+):/gu)].map((match) => match[1]),
    ["Space"],
  );
});

test("a take without selected keys uses the original WebM without FFmpeg", async (t) => {
  const { page, pressed, outputPath, timingPath, reviewPath } = await prepareRecording(t);
  await writeFile(reviewPath, "existing review");
  const result = await recordWalkthrough(page, {
    outputPath,
    ready: noOperation,
    steps: [{ action: () => page.keyboard.press("Tab"), verify: noOperation }],
  });

  assert.equal(result.outputPath, outputPath);
  assert.equal(result.timingPath, timingPath);
  assert.equal(result.reviewPath, outputPath);
  assert.deepEqual(pressed, ["Tab"]);
  assert.equal(await readFile(outputPath, "utf8"), "raw recording fixture");
  assert.equal(await readFile(reviewPath, "utf8"), "existing review");
});

test("invalid cues and missing FFmpeg are rejected before any scenario callback", async (t) => {
  const { recordings, page, pressed, outputPath } = await prepareRecording(t);
  for (const invalidKey of ["a", "Control+Enter", "constructor"]) {
    assert.throws(
      () => pressKey(page, invalidKey as Parameters<typeof pressKey>[1]),
      /Use Enter, Space, Tab, Escape, or an arrow key/u,
    );
  }
  const options = {
    outputPath,
    ready: unexpectedCallback,
    steps: [{ action: pressKey(page, "Enter"), verify: unexpectedCallback }],
  };
  await assert.rejects(recordWalkthrough({ ...page }, options), /Use the recording page/u);
  await assert.rejects(recordWalkthrough(page, options), /require FFmpeg/u);
  assert.deepEqual(pressed, []);
  assert.deepEqual(await readdir(recordings), []);
});

test("a failed first verification stops at the original key without a review copy", async (t) => {
  const { directory, recordings, page, pressed, outputPath, timingPath } =
    await prepareRecording(t);
  await provideEncoder(directory);
  const failure = new Error("The Enter action did not produce its visible result");
  const options = {
    outputPath,
    ready: noOperation,
    steps: [
      {
        action: pressKey(page, "Enter"),
        async verify() {
          assert.equal(performance.now(), 2400);
          throw failure;
        },
      },
      { action: unexpectedCallback, verify: unexpectedCallback },
    ],
  };

  await assert.rejects(recordWalkthrough(page, options), (error) => error === failure);
  await assert.rejects(recordWalkthrough(page, options), { code: "EEXIST" });
  assert.deepEqual(pressed, ["Enter"]);
  assert.equal(JSON.parse(await readFile(timingPath, "utf8")).status, "incomplete");
  assert.deepEqual(await readdir(recordings), ["take.webm.json"]);
});

test("a failed MP4 export keeps the completed WebM and refuses to replay the key", async (t) => {
  const { directory, recordings, page, pressed, outputPath, timingPath } =
    await prepareRecording(t);
  await provideEncoder(directory, 1);
  const options = {
    outputPath,
    ready: noOperation,
    steps: [{ action: pressKey(page, "ArrowDown"), verify: noOperation }],
  };

  await assert.rejects(recordWalkthrough(page, options), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Could not export the key-cue MP4/u);
    assert.ok(error.message.includes(outputPath));
    assert.ok(error.message.includes(timingPath));
    assert.match(error.message, /Do not replay/u);
    return true;
  });
  await assert.rejects(recordWalkthrough(page, options), /Choose an unused output path/u);
  assert.deepEqual(pressed, ["ArrowDown"]);
  assert.equal(await readFile(outputPath, "utf8"), "raw recording fixture");
  assert.equal(JSON.parse(await readFile(timingPath, "utf8")).status, "complete");
  assert.deepEqual((await readdir(recordings)).sort(), ["take.webm", "take.webm.json"]);
});
