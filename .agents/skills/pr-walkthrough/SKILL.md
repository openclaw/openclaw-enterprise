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
before recording, and use disposable data you can share. The video contains the
actual page, including visible input values. Label a Storybook scenario as simulated;
use the real controller when the claim depends on permissions, persistence, or recovery.

Call [`recordWalkthrough`](../../../scripts/console/record-walkthrough.ts) from a local
TypeScript evidence script. Give it a new path in an existing directory outside the
checkout. Describe each action and the visible result that proves it worked. The
recorder handles the opening pause, transitions, and reading time. It briefly outlines
the next control in blue. This is a recording annotation, separate from keyboard focus.
Keep these pauses out of product tests.

Replace `/path/to/openclaw-enterprise` with the absolute path to your checkout so
you can run this script from a separate evidence directory.

```ts
import { recordWalkthrough } from "/path/to/openclaw-enterprise/scripts/console/record-walkthrough.ts";

const open = page.getByRole("button", { name: "Create Secret" });
await recordWalkthrough(page, {
  outputPath,
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
```

`action` runs once. If a response matters, start waiting for that response inside
the action before triggering it. Omit `target` for an outside event or a keyboard
interaction whose focus you need to preserve. `verify` runs before and after the
reading pause. Check the specific visible result, such as a sheet meeting the bottom
edge. The recorder waits for ordinary transitions; when the application loads data
later, use a check that waits for that data to appear.

Play the saved WebM at normal speed. Its adjacent JSON gives approximate seek times,
including when the last result was visible and when the recorder checked it again.
Inspect that interval, the opening, and each transition. An incomplete recording
can still have changed application state; inspect that state before another take.
Follow the [Console visual review instructions](../../../AGENTS.md#console-storybook)
to identify the revision, explain what you showed, and share the verified media.
