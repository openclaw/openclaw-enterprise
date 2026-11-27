---
name: pr-walkthrough
description: Record a readable Console walkthrough for a pull request. Use when reviewers need to see an interaction, transition, recovery, or keyboard flow.
---

# Record a pull request walkthrough

Start where the change becomes visible. Show what the reviewer should notice before
the action, then leave the result on screen long enough to read it at normal speed.
Three to five meaningful actions usually make a 15–30 second video. Use fewer when
one interaction explains the change.

Prepare a Playwright page at the viewport you want to show. Finish sign-in and setup
before recording, and use synthetic data only. The video contains the actual page,
including visible input values. Label a Storybook scenario as simulated;
use the real controller when the claim depends on permissions, persistence, or recovery.

When recording a resize, the video keeps its opening width and height. If only
width matters, start narrow and scale both dimensions together, for example from
920 × 900 to 1150 × 1125 and back, to avoid gray bands. If exact width and height
or orientation matter, keep them and accept padding or use separate recordings.
Do not crop the captured viewport or edit the proof.
See the [Agent tab resize walkthrough](https://github.com/openclaw/openclaw-enterprise/pull/7194#verification).

Call [`recordWalkthrough`](../../../scripts/console/record-walkthrough.ts) from a local
TypeScript evidence script. Give it a new path in an existing directory outside the
checkout. Describe each action and the visible result that proves it worked. The
recorder handles the opening pause, transitions, and reading time. It briefly outlines
the next control in blue. This is a recording annotation, separate from keyboard focus.
Keep these pauses out of product tests.

Run this code after preparing `page`. Replace the checkout and evidence paths with
absolute paths on your machine.

```ts
import { recordWalkthrough } from "/path/to/openclaw-enterprise/scripts/console/record-walkthrough.ts";

const open = page.getByRole("button", { name: "Create Secret" });
const { reviewPath } = await recordWalkthrough(page, {
  outputPath: "/path/to/evidence/create-secret.webm",
  ready: () => open.waitFor({ state: "visible" }),
  steps: [
    {
      target: open,
      action: () => open.click(),
      verify: () =>
        page.getByRole("dialog", { name: "Create Secret" }).waitFor({ state: "visible" }),
    },
  ],
});
console.log(reviewPath);
```

To use Enter in this example, import `pressKey` from the same module and focus
`open` before recording. Replace the click step with the following keyboard step.

```ts
const keyboardStep = {
  action: pressKey(page, "Enter"),
  verify: () => page.getByRole("dialog", { name: "Create Secret" }).waitFor({ state: "visible" }),
};
```

Use `Enter`, `Space`, `Tab`, `Escape`, or an arrow key (`ArrowUp`, `ArrowDown`,
`ArrowLeft`, `ArrowRight`). Pass the function returned by `pressKey` directly as
`action`. Only declared keys appear in the strip and the timing JSON. The video
still shows values visible on the page.

Each action runs once. If a response matters, start listening before triggering
it. Omit `target` for outside events and keyboard steps to preserve focus.
`verify` runs before and after the reading pause. Check the specific visible
result, such as a sheet meeting the bottom edge. The recorder waits for ordinary
transitions. When the application loads data later, wait for that data to appear.

Recording a declared key requires FFmpeg on `PATH` with `libx264` and
fontconfig-enabled `drawtext`. Use even viewport dimensions and a width of at
least 136 pixels. The recorder checks these requirements and the MP4 destination
before acting. It keeps the original WebM and timing JSON, then exports an MP4
with a fixed 48-pixel key strip below the full viewport. A 390 × 844 viewport
produces a 390 × 892 MP4. Recordings without declared keys still produce a WebM
and need no extra dependency.

Play `reviewPath` at normal speed and use it for the PR. It points to the MP4 for
a key take and the WebM otherwise. The JSON beside the WebM gives approximate seek
times, including when the last result was visible and when the recorder checked it
again. Inspect that interval, the opening, and each transition. If export fails,
keep the completed WebM and JSON. Avoid replaying actions to repair an export.
Even an incomplete recording can change application state. Check that state
before another take.

Follow the [Console visual review instructions](../../../AGENTS.md#console-storybook)
to identify the revision, explain what you showed, and share the verified media.
