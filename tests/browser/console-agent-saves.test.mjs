import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  detailUrl,
  login,
  nativeValues,
  newPage,
  selectSecret,
  waitForInputValue,
  secretOptionLabel,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import { openAdvancedSettings } from "./console-agents-test-support.mjs";

// Marks the rendered Agent page and records any loading state it shows again, so a test can
// tell an in-place update from a page reload.
async function watchForReload(page) {
  await page.evaluate(() => {
    const doc = globalThis.document;
    doc.querySelector(".agent-current-summary").dataset.saveMarker = "kept";
    globalThis.reloadedText = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (/Loading (version details|configuration)/.test(node.textContent ?? "")) {
            globalThis.reloadedText.push(node.textContent);
          }
        }
      }
    }).observe(doc.body, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(() => ({
      marker: globalThis.document.querySelector(".agent-current-summary")?.dataset.saveMarker,
      reloadedText: globalThis.reloadedText,
    }));
}

const focusedText = (page) =>
  page.evaluate(() => globalThis.document.activeElement?.textContent ?? null);
const scrollY = (page) => page.evaluate(() => globalThis.scrollY);
const getReads = (requests) =>
  requests.filter((request) => request.method === "GET").map((request) => request.path);

// Saving the draft's Configuration updated nothing on screen but re-navigated to the same URL:
// the page collapsed to its summary, made about 12 reads, jumped to the top and dropped focus,
// with no saved message (finding 1445). It now refreshes the draft in place.
test("saving the draft Configuration updates the Agent page in place", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Configuration in place");
  const agent = await fixture.createAgent(namespace.id, "Saved In Place", nativeValues("before"), {
    harnessAuth: { method: "runtime" },
  });
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 720 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Create new version" }).waitFor();
  const deploy = page.getByRole("button", { name: "Deploy new version" });
  await page.waitForFunction(
    () => globalThis.document.querySelector(".agent-draft-actions .primary")?.disabled === false,
  );
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  await editor.fill(JSON.stringify(nativeValues("after"), null, 2));
  const save = page.getByRole("button", { name: "Save Configuration" });
  await save.scrollIntoViewIfNeeded();
  const scrollBefore = await scrollY(page);
  assert.ok(scrollBefore > 0, "the Save button sits below the first screen");
  const kept = await watchForReload(page);
  const requests = apiRequests(page, fixture.origin);

  await save.click();
  const saved = page.getByRole("status").filter({ hasText: "Configuration saved." });
  await saved.waitFor();
  assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(page), "Edit Configuration");
  // The reader stays where they were instead of jumping to the top of the page.
  assert.ok((await scrollY(page)) > scrollBefore / 2, "the page kept its scroll position");
  await page.getByText(/Configuration .* · generation 2$/).waitFor();
  // Two preflight reads and one read of the saved Configuration; no Agent page reload.
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.deepEqual(getReads(requests).sort(), [
    `/namespaces/${namespace.id}/agents/${agent.id}`,
    configurationPath,
    configurationPath,
  ]);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "configuration");

  // The refreshed draft is current: deploying it passes the preflight against the saved state.
  assert.equal(await deploy.isDisabled(), false);
  const deploying = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}/deploy`),
  );
  await deploy.click();
  assert.equal((await deploying).status(), 202);
});

// The authentication source save re-navigated the same way. It now refreshes in place from
// the saved Agent, and a second save checks against that saved state instead of the page's
// first read. Reload authentication source keeps focus too (finding 1446).
test("saving and reloading the authentication source update the Agent page in place", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Authentication in place", { ready: true });
  const first = await fixture.createSecret(namespace.id, "First harness Secret", "hidden-first");
  const second = await fixture.createSecret(namespace.id, "Second harness Secret", "hidden-second");
  const agent = await fixture.createAgent(
    namespace.id,
    "Authentication In Place",
    nativeValues("auth", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: first.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Authentication In Place" }).waitFor();
  const secretField = page.getByLabel("API key Secret");
  await waitForInputValue(secretField, secretOptionLabel(first));
  const kept = await watchForReload(page);
  const saveAuthentication = page.getByRole("button", { name: "Save authentication source" });
  const savedAgent = async () =>
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .harnessAuth;

  for (const secret of [second, first]) {
    await selectSecret(page, "API key Secret", secret);
    await saveAuthentication.scrollIntoViewIfNeeded();
    const scrollBefore = await scrollY(page);
    assert.ok(scrollBefore > 0, "the Save button sits below the first screen");
    await saveAuthentication.click();
    await page.getByRole("status").filter({ hasText: "Authentication source saved." }).waitFor();
    await waitForInputValue(secretField, secretOptionLabel(secret));
    assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
    assert.equal(await focusedText(page), "Save authentication source");
    // The staged-Secret hint is gone after the save, so the page may end one line shorter.
    const scrollAfter = await scrollY(page);
    assert.ok(
      Math.abs(scrollAfter - scrollBefore) <= 40,
      `the page kept its scroll: ${scrollBefore} -> ${scrollAfter}`,
    );
    assert.deepEqual(await savedAgent(), { method: "api_key", source: secret.ref });
  }

  const reload = page.getByRole("button", { name: "Reload authentication source" });
  await selectSecret(page, "API key Secret", second);
  await reload.click();
  await waitForInputValue(secretField, secretOptionLabel(first));
  assert.deepEqual(await kept(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(page), "Reload authentication source");
});
