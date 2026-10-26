import { existsSync } from "node:fs";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as hold } from "node:timers/promises";
import type { Locator, Page } from "playwright";

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

/** Record a prepared page for a PR. Viewing pauses belong here, outside product tests. */
export async function recordWalkthrough(page: Page, { outputPath, ready, steps }: Walkthrough) {
  const size = page.viewportSize();
  if (!size || !steps.length || !outputPath.endsWith(".webm")) {
    throw new Error("Use a fixed viewport, at least one step, and a new .webm output path.");
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
  const timing: { actionAtMs: number; resultAtMs?: number; recheckedAtMs?: number }[] = [];
  await saveTiming("recording", "wx");
  const workDir = await mkdtemp(join(dirname(outputPath), ".walkthrough-"));
  const video = join(workDir, "incomplete.webm");
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
        const times: (typeof timing)[number] = { actionAtMs: elapsed() };
        timing.push(times);
        await saveTiming("recording");
        await step.action();
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
  } catch (error) {
    await saveTiming("incomplete");
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  await saveTiming("complete");
  return { outputPath, timingPath };
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
