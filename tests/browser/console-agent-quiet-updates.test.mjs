import assert from "node:assert/strict";
import test from "node:test";

import { DELETION_POLL_MS } from "../../apps/controller/src/console/agents/deletion.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

// The Agent summary showed "vN · Loading…" for a frame or more on every load while the newest
// version's deployment record was read (finding 1438). Its loading text now follows the 250 ms
// rule: it is hidden for the first 250 ms, so a read that settles sooner never shows it.
test("the Agent summary's loading text follows the 250 ms rule", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Quiet summary", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Quiet Summary", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    async (route) => {
      await held;
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              deploymentId: revision.id,
              namespaceId: namespace.id,
              agentId: agent.id,
              status: "succeeded",
              error: null,
              warnings: [],
              progress: null,
            },
            meta: { requestId: "req_quiet_summary" },
          }),
        })
        .catch(() => {});
    },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  const value = summary.locator(":scope > div:nth-child(2) > strong");
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('[aria-label="Agent state at a glance"] > div:nth-child(2) > strong')
      ?.textContent.startsWith("v1 · "),
  );
  // The version shows at once; only the loading word waits, hidden by a 250 ms animation.
  const delayed = (node) =>
    [...node.querySelectorAll("*")].map((child) => {
      const style = child.ownerDocument.defaultView.getComputedStyle(child);
      return {
        text: child.textContent,
        animation: `${style.animationName} ${style.animationDuration}`,
      };
    });
  assert.equal(await value.textContent(), "v1 · Loading…");
  assert.deepEqual(await value.evaluate(delayed), [
    { text: "Loading…", animation: "loading-delay 0.25s" },
  ]);
  const note = summary.locator(":scope > div:nth-child(2) > p");
  assert.deepEqual(await note.evaluate(delayed), [
    { text: "Reading recorded deployment status.", animation: "loading-delay 0.25s" },
  ]);

  release();
  await summary.getByText("v1 · Completed", { exact: true }).waitFor();
});

// While an Agent was deleting, every 3 s poll flipped "Refresh deletion status" to a disabled
// "Checking…", which dropped its focus, and rebuilt the role=status notice, which screen
// readers announced again (finding 1409). A poll now leaves both alone unless they change.
test("deletion status polls leave Refresh and the deletion notice untouched", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Quiet deletion", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Quiet Deletion", nativeValues("v1"));
  const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Quiet Deletion" }).first().waitFor();
  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Quiet Deletion?" });
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  // Polls run only when the test advances the clock.
  await page.clock.pauseAt(new Date("2026-10-16T12:00:01Z"));
  // The confirmation removes itself on its close event, a task after the request settles.
  await page.locator(".deletion-note dialog").waitFor({ state: "detached" });
  const refresh = page.getByRole("button", { name: "Refresh deletion status" });
  await refresh.focus();
  await page.evaluate(() => {
    globalThis.deletionChanges = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        globalThis.deletionChanges.push(
          record.type === "attributes"
            ? `${record.target.textContent}: ${record.attributeName}`
            : `${record.type}: ${record.target.textContent.slice(0, 40)}`,
        );
      }
    }).observe(globalThis.document.querySelector(".deletion-note"), {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });

  for (let poll = 0; poll < 2; poll += 1) {
    const read = page.waitForResponse(
      (response) => response.url() === agentUrl && response.request().method() === "GET",
    );
    await page.clock.runFor(DELETION_POLL_MS);
    assert.equal((await read).status(), 200);
    // Let the poll's render run.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.deepEqual(await page.evaluate(() => globalThis.deletionChanges), []);
  assert.equal(await refresh.evaluate((node) => node.matches(":focus")), true);

  // Refresh pressed while a quiet poll reads turns that poll into a shown check, and focus
  // comes back to Refresh when it ends.
  for (const during of ["poll", "idle"]) {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let requested;
    const read = new Promise((resolve) => {
      requested = resolve;
    });
    await page.route(
      agentUrl,
      async (route) => {
        requested();
        await held;
        await route.continue().catch(() => {});
      },
      { times: 1 },
    );
    if (during === "poll") {
      await page.clock.runFor(DELETION_POLL_MS);
      await read;
      assert.equal(await refresh.isEnabled(), true);
    }
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Checking…" }).waitFor();
    release();
    await refresh.waitFor();
    await page.waitForFunction(() => globalThis.document.activeElement?.tagName === "BUTTON");
    assert.equal(await refresh.evaluate((node) => node.matches(":focus")), true, during);
  }
});

// Share Agent hid its form until the sharing policy loaded, so the form popped in and pushed
// the grants list down on every Agent page load (finding 1410). It now shows, disabled, while
// the policy loads, under a placeholder line that the loaded result replaces.
test("the Share Agent form shows disabled while the sharing policy loads", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady sharing", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Steady Sharing", nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let requested;
  const roleRead = new Promise((resolve) => {
    requested = resolve;
  });
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/iam/roles`, async (route) => {
    requested();
    await held;
    await route.continue().catch(() => {});
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await roleRead;
  const sharing = page.getByRole("region", { name: "Share Agent", exact: true });
  const principal = sharing.getByLabel("Existing person’s Principal ID");
  await principal.waitFor();
  const share = sharing.getByRole("button", { name: "Share Agent" });
  assert.equal(await principal.isDisabled(), true);
  assert.equal(await share.isDisabled(), true);
  const grants = sharing.getByRole("heading", { name: "Direct Agent grants" });
  const before = await grants.boundingBox();

  release();
  await sharing.getByText("Current policy loaded.", { exact: false }).waitFor();
  assert.equal(await principal.isEnabled(), true);
  // The read's placeholder held the line its result takes, so nothing below moved.
  const after = await grants.boundingBox();
  assert.ok(Math.abs(after.y - before.y) < 1, `the grants moved ${after.y - before.y}px`);
});
