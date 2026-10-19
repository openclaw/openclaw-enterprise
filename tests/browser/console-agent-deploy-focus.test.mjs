import assert from "node:assert/strict";
import test from "node:test";

import { holdRequests, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";
import { focusedText } from "./console-agents-test-support.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";

// After an admitted deployment the held draft page's heading keeps focus, and the loading page's
// heading takes it over only while the held heading still has it (finding 1626). A reader who
// leaves the held heading before the loading page appears is not pulled back to it.
test("A reader who leaves the held heading during an admitted deployment is not pulled back while the loading page stands in", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Held heading hand-off");
  const agent = await fixture.createAgent(
    namespace.id,
    "Held heading hand-off",
    nativeValues("held-heading-hand-off"),
    { harnessAuth: { method: "runtime" } },
  );
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
  assert.equal(await focusedText(page), "Deploying…");
  // Every focused node until the new version shows, numbered so a replaced heading is a new one.
  await page.evaluate(() => {
    const ids = new WeakMap();
    let next = 0;
    const state = { trail: [], loadingShown: false, stopped: false, frames: 0 };
    const sample = () => {
      if (state.stopped) {
        return;
      }
      state.frames += 1;
      const node = globalThis.document.activeElement;
      if (node && node !== globalThis.document.body && !ids.has(node)) {
        ids.set(node, ++next);
      }
      const entry =
        !node || node === globalThis.document.body
          ? "BODY"
          : `${node.tagName}#${ids.get(node)}: ${node.textContent.trim()}`;
      if (state.trail.at(-1) !== entry) {
        state.trail.push(entry);
      }
      state.loadingShown ||= (
        globalThis.document.querySelector(".content")?.textContent ?? ""
      ).includes("Reading this Agent.");
      globalThis.requestAnimationFrame(sample);
    };
    globalThis.focusFrames = state;
    sample();
  });
  const agentRead = await holdRequests(t, page, `${fixture.origin}${path}`, {
    once: true,
    method: "GET",
  });
  admitted.release();
  await agentRead.requested;
  // The held heading has focus; the reader leaves it before the 250 ms loading page appears.
  await page.waitForFunction(() => globalThis.document.activeElement?.tagName === "H1");
  await page.evaluate(() => globalThis.document.activeElement?.blur());
  await page.waitForFunction(() => globalThis.focusFrames.loadingShown);
  // The loading page stands with nothing taking focus: 18 sampled frames while the read is
  // held (the page itself stays at least loadingMinimumMs).
  const shown = await page.evaluate(() => globalThis.focusFrames.frames);
  await page.waitForFunction((frames) => globalThis.focusFrames.frames >= frames + 18, shown);
  agentRead.release();
  await page.waitForURL(/revision=rev_/);
  await page.waitForFunction(
    () =>
      globalThis.document.activeElement?.tagName === "H1" &&
      globalThis.document.activeElement.isConnected &&
      !globalThis.document.querySelector(".agent-detail-pending, .holding, [aria-busy=true]") &&
      globalThis.document.querySelector(".agent-tabs [aria-selected=true]") !== null,
  );
  const { trail } = await page.evaluate(() => {
    globalThis.focusFrames.stopped = true;
    return globalThis.focusFrames;
  });
  assert.match(trail[0], /^P#\d+: Deploying…$/, trail.join(" | "));
  assert.match(trail[1], /^H1#\d+: Held heading hand-off$/, trail.join(" | "));
  assert.equal(trail[2], "BODY", trail.join(" | "));
  // Nothing takes focus while the loading page stands in; the new version's heading takes it.
  assert.equal(trail.length, 4, trail.join(" | "));
  assert.match(trail[3], /^H1#\d+: Held heading hand-off$/, trail.join(" | "));
});
