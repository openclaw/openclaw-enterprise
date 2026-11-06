import assert from "node:assert/strict";
import test from "node:test";

import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import {
  nativeValues,
  detailUrl,
  login,
  newPage,
  waitForCondition,
  waitForEnabled,
} from "./console-agents-browser-helpers.ts";
import { trackSettledFetches, waitForIdleFetches } from "./console-fetch-accounting.ts";

// Exercise the real HTTP controller, Native IAM Driver, and normal Agent State fixture.
// These tests do not claim PostgreSQL durability or live authenticated ingress access.
async function setup(t) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Bookmarks");
  const agent = await fixture.createAgent(namespace.id, "Bookmark Agent", nativeValues("bookmark"));
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id + "/control-ui-bookmark";
  assert.deepEqual(await stored(fixture, path), { url: null, version: 0 });
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  await page
    .getByRole("button", { name: "Add direct URL", exact: true })
    .waitFor()
    .catch(async (cause) => {
      throw new Error(await page.locator("body").innerText(), { cause });
    });
  return { fixture, namespace, agent, path, page };
}

async function saveUrl(page, url) {
  await page.getByLabel("Direct Control UI URL", { exact: true }).fill(url);
  const save = page
    .locator(".control-ui-bookmark-form")
    .getByRole("button", { name: "Save", exact: true });
  await waitForEnabled(save);
  await save.click();
}

async function stored(fixture, path) {
  const response = await fixture.request("GET", path);
  assert.equal(response.status, 200, path + ": " + JSON.stringify(response.body));
  return response.data;
}

test("shared bookmark edits, conflicts and removal use versioned real controller state", async (t) => {
  const { fixture, namespace, agent, path, page } = await setup(t);
  const urls = [
    "https://control.example.com/research",
    "https://other.example.com/control",
    "https://operator.example.com/agent",
  ];
  const outgoing = [];
  page.on("request", (request) => outgoing.push(request.url()));
  await page.getByRole("button", { name: "Add direct URL", exact: true }).click();
  await saveUrl(page, urls[0]);
  const link = page.getByRole("link", { name: "Open direct Control UI", exact: true });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), urls[0]);
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(await stored(fixture, path), { url: urls[0], version: 1 });
  assert.equal(
    outgoing.some((url) => new URL(url).origin === "https://control.example.com"),
    false,
    "saving and displaying a bookmark must not fetch its destination",
  );

  // A separately authenticated Agent updater reads the same value without configuration
  // read or native administration. Sharing is server-side, not this browser's storage.
  const updater = await fixture.createNamespaceMember("other-operator", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["update", "agent"],
  ]);
  const { revision: selected } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const selectedRevision = selected.id;
  const { page: other } = await newPage(t, fixture);
  await trackSettledFetches(other);
  await login(
    other,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, selectedRevision, "access"),
    updater.credentials,
  );
  await other.getByRole("link", { name: "Open direct Control UI", exact: true }).waitFor();
  // Refocus must recheck Agent authority without demanding unreadable Configuration.
  const resumedBookmark = other.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === "GET",
  );
  await other.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await resumedBookmark;
  await waitForIdleFetches(other);
  await other.getByRole("tab", { name: "Access", selected: true }).waitFor();
  await other.getByRole("link", { name: "Open direct Control UI", exact: true }).waitFor();
  assert.equal(await other.locator(".control-ui-bookmark-link").getAttribute("href"), urls[0]);
  await page.getByRole("button", { name: "Edit link", exact: true }).click();
  await page.getByLabel("Direct Control UI URL", { exact: true }).fill(urls[2]);
  await other.getByRole("button", { name: "Edit link", exact: true }).click();
  await saveUrl(other, urls[1]);
  await other.getByText("Direct URL saved.", { exact: true }).waitFor();
  await page
    .locator(".control-ui-bookmark-form")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.getByText(/This bookmark changed elsewhere/).waitFor();
  assert.equal(
    await page.getByLabel("Direct Control UI URL", { exact: true }).inputValue(),
    urls[2],
  );
  assert.equal(
    await page.locator(".control-ui-bookmark-form button[type=submit]").isDisabled(),
    true,
  );
  assert.deepEqual(await stored(fixture, path), { url: urls[1], version: 2 });
  await page.getByRole("button", { name: "Refresh bookmark", exact: true }).click();
  await page.getByText(/Current bookmark refreshed\. Your input is preserved/).waitFor();
  assert.equal(
    await page.getByLabel("Direct Control UI URL", { exact: true }).inputValue(),
    urls[2],
  );
  await saveUrl(page, urls[2]);
  await page.getByText("Direct URL saved.", { exact: true }).waitFor();
  assert.deepEqual(await stored(fixture, path), { url: urls[2], version: 3 });
  await page.getByRole("button", { name: "Edit link", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("No direct URL saved.", { exact: true }).waitFor();
  assert.deepEqual(await stored(fixture, path), { url: null, version: 4 });
});

test("Agent readers see only the saved link while real IAM denies bookmark writes and native roster reads", async (t) => {
  const { fixture, namespace, agent, path } = await setup(t);
  const url = "https://control.example.com/readonly";
  const saved = await fixture.request("PUT", path, { body: { url, expectedVersion: 0 } });
  assert.equal(saved.status, 200);
  const reader = await fixture.createNamespaceMember("bookmark-reader", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
  ]);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "access"),
    reader.credentials,
  );
  await page.getByRole("link", { name: "Open direct Control UI", exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await page.locator(".control-ui-bookmark-link").getAttribute("href"), url);
  const resumedRead = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === "GET",
  );
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await resumedRead;
  await waitForIdleFetches(page);
  await page.getByRole("tab", { name: "Access", selected: true }).waitFor();
  assert.equal(await page.locator(".control-ui-bookmark-link").getAttribute("href"), url);
  assert.equal(await page.getByRole("button", { name: "Edit link", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Refresh users", exact: true }).count(), 0);
  assert.equal(
    requests.some((request) => request.includes("/gateway/people")),
    false,
    "read permission must not initiate the administer-gated native roster read",
  );
  const denied = await page.request.put(new URL(path, fixture.origin).href, {
    data: { url: "https://forbidden.example.com/", expectedVersion: 1 },
    headers: { origin: new URL(fixture.origin).origin },
  });
  assert.equal(denied.status(), 403);
  const roster = await page.request.get(
    new URL(path.replace("/control-ui-bookmark", "/gateway/people"), fixture.origin).href,
  );
  assert.equal(roster.status(), 403);
  assert.deepEqual(await stored(fixture, path), { url, version: 1 });
});

test("an uncertain real save is reconciled once without replay, and unrelated tabs do not replay bookmark reads", async (t) => {
  const { fixture, path, page } = await setup(t);
  let writes = 0;
  const url = "https://control.example.com/confirmed-on-read";
  // Only the response is lost: route.fetch sends the PUT through the real controller and
  // commits its state. This protects against retrying a possibly committed versioned edit.
  await page.route("**/control-ui-bookmark", async (route) => {
    if (route.request().method() === "PUT") {
      writes += 1;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByRole("button", { name: "Add direct URL", exact: true }).click();
  await saveUrl(page, url);
  await page.getByText(/Current bookmark refreshed without retrying the change/).waitFor();
  assert.equal(writes, 1);
  assert.deepEqual(await stored(fixture, path), { url, version: 1 });
  assert.equal(await page.getByLabel("Direct Control UI URL", { exact: true }).inputValue(), url);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await waitForIdleFetches(page);
  const bookmarkReads = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/control-ui-bookmark")) {
      bookmarkReads.push(request.url());
    }
  });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await waitForIdleFetches(page);
  assert.equal(
    bookmarkReads.length,
    0,
    "focus on Configuration must not replay an Access-owned bookmark read",
  );
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await waitForCondition(() => bookmarkReads.length > 0, "Access resumes its bookmark read");
  assert.equal(writes, 1);
});
