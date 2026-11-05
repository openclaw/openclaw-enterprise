import { focusedText } from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  holdRequests,
  login,
  nativeValues,
  newPage,
  recordFocusTrail,
  stopFocusTrail,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.ts";

// After an admitted deployment the held draft page's heading keeps focus, and the loading page's
// heading takes it over only while the held heading still has it (finding 1626). A reader who
// leaves the held heading before the loading page appears is not pulled back to it.
test("A reader who leaves the held heading during an admitted deployment is not pulled back while the loading page stands in", async (t) => {
  const {
    fixture,
    namespace,
  }: {
    fixture: Awaited<ReturnType<typeof createRuntimeAuthFixture>>["fixture"];
    namespace: unknown;
  } = await createRuntimeAuthFixture(t, "Held heading hand-off");
  assert.ok(typeof namespace === "object" && namespace !== null && "id" in namespace);
  assert.ok(typeof namespace.id === "string");
  const agent: unknown = await fixture.createAgent(
    namespace.id,
    "Held heading hand-off",
    nativeValues("held-heading-hand-off"),
    { harnessAuth: { method: "runtime" } },
  );
  assert.ok(typeof agent === "object" && agent !== null && "id" in agent);
  assert.ok(typeof agent.id === "string");
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft`,
  );
  await page.getByText("Configured on the runtime host", { exact: false }).waitFor();
  const admitted = await holdRequests(t, page, `${fixture.origin}${path}/deploy`, {
    method: "POST",
  });
  await page.getByRole("button", { name: "Deploy new version" }).focus();
  await page.keyboard.press("Enter");
  await admitted.requested;
  const focused: unknown = await focusedText(page);
  assert.equal(focused, "Deploying…");
  // Every focused node until the new version shows, numbered so a replaced heading is a new one.
  await recordFocusTrail(page, ["Reading this Agent."]);
  // The reader leaves the held heading as soon as it takes focus. The leave runs in a task queued
  // then, so it always comes before the 250 ms loading page, however late a busy page paints or
  // the test's own calls arrive (finding 2267: the leave raced the loading page under load).
  await page.evaluate(() => {
    const leave = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "H1") {
        globalThis.document.removeEventListener("focusin", leave, true);
        setTimeout(() => target.blur(), 0);
      }
    };
    globalThis.document.addEventListener("focusin", leave, true);
  });
  const agentRead = await holdRequests(t, page, `${fixture.origin}${path}`, {
    once: true,
    method: "GET",
  });
  admitted.release();
  await agentRead.requested;
  await page.waitForFunction(
    () =>
      "focusFrames" in globalThis &&
      typeof globalThis.focusFrames === "object" &&
      globalThis.focusFrames !== null &&
      "loadingShown" in globalThis.focusFrames &&
      globalThis.focusFrames.loadingShown,
  );
  // The loading page stands with nothing taking focus: 18 sampled frames while the read is
  // held (the page itself stays at least loadingMinimumMs).
  const shown = await page.evaluate(() => {
    if (
      !("focusFrames" in globalThis) ||
      typeof globalThis.focusFrames !== "object" ||
      globalThis.focusFrames === null ||
      !("frames" in globalThis.focusFrames) ||
      typeof globalThis.focusFrames.frames !== "number"
    ) {
      throw new Error("Focus trail must record frame counts");
    }
    return globalThis.focusFrames.frames;
  });
  await page.waitForFunction(
    (frames) =>
      "focusFrames" in globalThis &&
      typeof globalThis.focusFrames === "object" &&
      globalThis.focusFrames !== null &&
      "frames" in globalThis.focusFrames &&
      typeof globalThis.focusFrames.frames === "number" &&
      globalThis.focusFrames.frames >= frames + 18,
    shown,
  );
  agentRead.release();
  await page.waitForURL(/revision=rev_/);
  await page.waitForFunction(
    () =>
      globalThis.document.activeElement?.tagName === "H1" &&
      globalThis.document.activeElement.isConnected &&
      !globalThis.document.querySelector(".agent-detail-pending, .holding, [aria-busy=true]") &&
      globalThis.document.querySelector(".agent-tabs [aria-selected=true]") !== null,
  );
  const { trail } = await stopFocusTrail(page);
  const [deploying, held, , settled] = trail;
  assert.ok(
    typeof deploying === "string" && typeof held === "string" && typeof settled === "string",
  );
  assert.match(deploying, /^P#\d+: Deploying…$/, trail.join(" | "));
  assert.match(held, /^H1#\d+: Held heading hand-off$/, trail.join(" | "));
  assert.equal(trail[2], "BODY", trail.join(" | "));
  // Nothing takes focus while the loading page stands in; the new version's heading takes it.
  assert.equal(trail.length, 4, trail.join(" | "));
  assert.match(settled, /^H1#\d+: Held heading hand-off$/, trail.join(" | "));
});
