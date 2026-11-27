import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as hold } from "node:timers/promises";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright";

const cueKeys = [
  "Enter",
  "Space",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;
type CueKey = (typeof cueKeys)[number];

type Walkthrough = {
  outputPath: string;
  /** Wait for the opening state, after sign-in and fixture setup. */
  ready(): Promise<void>;
  steps: readonly {
    /** Outline this control before acting. Omit for an off-screen or keyboard action. */
    target?: Locator;
    action(): Promise<unknown>;
    /** Read-only check of the visible result, repeated after the viewer has time to read it. */
    verify(): Promise<void>;
  }[];
};

type Action = Walkthrough["steps"][number]["action"];
type StepTiming = {
  actionAtMs: number;
  resultAtMs?: number;
  recheckedAtMs?: number;
  key?: CueKey;
};

const keyActions = new WeakMap<Action, { page: Page; key: CueKey }>();

/** Use this function directly as the action to add a key cue to the review video. */
export function pressKey(page: Page, key: CueKey): () => Promise<void> {
  if (!cueKeys.some((allowed) => allowed === key)) {
    throw new Error("Use Enter, Space, Tab, Escape, or an arrow key for a key cue.");
  }
  const action = () => page.keyboard.press(key);
  keyActions.set(action, { page, key });
  return action;
}

function keyFor(page: Page, action: Action) {
  const cue = keyActions.get(action);
  if (cue && cue.page !== page) {
    throw new Error("Use the recording page for the key cue.");
  }
  return cue?.key;
}

/** Record a prepared page for a PR. Viewing pauses belong here, outside product tests. */
export async function recordWalkthrough(page: Page, { outputPath, ready, steps }: Walkthrough) {
  const size = page.viewportSize();
  if (!size || !steps.length || !outputPath.endsWith(".webm")) {
    throw new Error("Use a fixed viewport, at least one step, and a new .webm output path.");
  }
  const keys = steps.map(({ action }) => keyFor(page, action));
  const mp4Path = keys.some((key) => key !== undefined)
    ? outputPath.replace(/\.webm$/, ".mp4")
    : undefined;
  if (mp4Path) {
    await preflightKeyCues(size, mp4Path);
  }
  await ready();
  await settleTransitions(page);

  // Reserve this take before acting. A failed or interrupted recording never retries an action.
  const timingPath = outputPath + ".json";
  if (existsSync(outputPath)) {
    throw new Error("Choose an unused output path.");
  }
  const saveTiming = (status: string, flag = "w") =>
    writeFile(timingPath, JSON.stringify({ status, steps: timing }, null, 2) + "\n", { flag });
  // Milliseconds from the first received video frame, useful for seeking in the saved video.
  const timing: StepTiming[] = [];
  await saveTiming("recording", "wx");
  const workDir = await mkdtemp(join(dirname(outputPath), ".walkthrough-"));
  const video = join(workDir, "incomplete.webm");
  let rawComplete = false;
  try {
    let onFrame!: () => void;
    const firstFrame = new Promise<number>((resolve) => {
      onFrame = () => resolve(performance.now());
    });
    const recording = await page.screencast.start({ path: video, size, onFrame });
    try {
      const start = await Promise.race([
        firstFrame,
        hold(10_000, undefined, { ref: false }).then(() => {
          throw new Error("No opening screencast frame in 10 seconds.");
        }),
      ]);
      const elapsed = () => Math.round(performance.now() - start);
      await hold(2400);

      for (const [index, step] of steps.entries()) {
        if (step.target) {
          await cueTarget(step.target);
        }
        const times: StepTiming = { actionAtMs: elapsed() };
        timing.push(times);
        await saveTiming("recording");
        const action = step.action;
        const key = keyFor(page, action);
        if (key !== keys[index]) {
          throw new Error("The step's key cue changed after recording preflight.");
        }
        if (key) {
          times.actionAtMs = elapsed();
        }
        await action.call(step);
        if (key) {
          times.key = key;
        }
        // A click can resolve while a sheet is still sliding. Let it arrive before checking geometry.
        await settleTransitions(page);
        await step.verify();
        await settleTransitions(page);
        times.resultAtMs = elapsed();
        await hold(index === steps.length - 1 ? 4500 : 2800);
        await step.verify();
        times.recheckedAtMs = elapsed();
      }
    } finally {
      await recording.dispose();
    }
    await link(video, outputPath);
    await saveTiming("complete");
    rawComplete = true;
    if (mp4Path) {
      await exportKeyCues(video, join(workDir, "review.mp4"), mp4Path, timing);
    }
  } catch (error) {
    if (rawComplete) {
      throw new Error(
        `Could not export the key-cue MP4. Keep the completed WebM (${outputPath}) and timing (${timingPath}). Do not replay the recorded actions to repair the export.`,
        { cause: error },
      );
    }
    await saveTiming("incomplete");
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return { outputPath, timingPath, reviewPath: mp4Path ?? outputPath };
}

const cueStrip = "pad=iw:ih+48:0:0:color=0x101724";
const runFfmpeg = promisify(execFile);

function keycap(key: CueKey, startMs: number) {
  const endMs = startMs + 1200;
  if (!Number.isSafeInteger(endMs) || !Number.isSafeInteger(startMs) || startMs < 0) {
    throw new Error("Invalid key cue timing.");
  }
  const enable = `enable='gte(t,${(startMs / 1000).toFixed(3)})*lt(t,${(endMs / 1000).toFixed(3)})'`;
  return [
    `drawbox=x=12:y=ih-39:w=112:h=30:color=0x526681:t=fill:${enable}`,
    `drawbox=x=13:y=ih-38:w=110:h=28:color=0x202F44:t=fill:${enable}`,
    `drawtext=font=DejaVu Sans:text=${key}:expansion=none:fontcolor=white:fontsize=16:x=12+(112-tw)/2:y=h-24-th/2:${enable}`,
  ].join(",");
}

async function preflightKeyCues(
  { width, height }: { width: number; height: number },
  output: string,
) {
  if (
    !Number.isSafeInteger(width) ||
    width < 136 ||
    width % 2 !== 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    height % 2 !== 0
  ) {
    throw new Error("Key cues require an even-size viewport at least 136 pixels wide.");
  }
  if (lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error("Choose an unused MP4 output path for the key cues.");
  }
  try {
    await encodeKeyCues(
      ["-f", "lavfi", "-i", `color=s=${width}x${height}`],
      [cueStrip, keycap("ArrowRight", 0)],
      ["-frames:v", "1", "-f", "null", "-"],
    );
  } catch (cause) {
    throw new Error(
      "Key cues require FFmpeg with libx264 and fontconfig-enabled drawtext on PATH.",
      {
        cause,
      },
    );
  }
}

async function exportKeyCues(
  video: string,
  staged: string,
  output: string,
  timing: readonly StepTiming[],
) {
  const filters = [cueStrip];
  for (const { key, actionAtMs } of timing) {
    if (key) {
      filters.push(keycap(key, actionAtMs));
    }
  }
  await encodeKeyCues(["-protocol_whitelist", "file", "-i", resolve(video)], filters, [
    "-movflags",
    "+faststart",
    resolve(staged),
  ]);
  await link(staged, output);
}

function encodeKeyCues(input: string[], filters: string[], output: string[]) {
  return runFfmpeg("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-xerror",
    ...input,
    "-map",
    "0:v:0",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    filters.join(","),
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "fast",
    ...output,
  ]);
}

async function cueTarget(target: Locator) {
  await target.waitFor({ state: "visible", timeout: 5000 });
  await target.scrollIntoViewIfNeeded({ timeout: 5000 });
  // Playwright's showActions and locator.highlight can display input or locator text.
  // Animate just an outline: it works in native dialogs, preserves focus, and restores itself.
  await Promise.race([
    target.evaluate(async (element) => {
      const ring = { outline: "4px solid #1769df", outlineOffset: "3px" };
      await element.animate([ring, ring], 1250).finished;
    }),
    hold(4000, undefined, { ref: false }).then(() => {
      throw new Error(
        "The action cue did not finish in 4 seconds; stopped before this step's action.",
      );
    }),
  ]);
}

async function settleTransitions(page: Page) {
  // Playwright's deadline also bounds a hidden page that stops delivering animation frames.
  const settled = await page.waitForFunction(
    async () => {
      await new Promise<void>((paint) =>
        requestAnimationFrame(() => requestAnimationFrame(() => paint())),
      );
      const finite = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
      if (finite.length) {
        await Promise.race([
          Promise.allSettled(finite.map((animation) => animation.finished)),
          new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
      }
      return true;
    },
    undefined,
    { timeout: 4000 },
  );
  await settled.dispose();
}
