import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import {
  AGENT_READ,
  accessibleDescription,
  apiRequests,
  detailUrl,
  expectReachableReason,
  fileBrowser,
  grantMember,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nextFrames,
  pathRequests,
  revokeMemberGrant,
  settlePageRequests,
  settledView,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { withholdPermissionSummary } from "./console-agents-test-support.mjs";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import {
  AGENT_STOP_AND_DELETE_DENIED,
  GENERIC_DENIAL,
  SECRET_CREATE_DENIED,
  deleteRefused,
  stopRefused,
} from "../helpers/refusal-text.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A member who can read an Agent and its versions, and holds no operate or delete.
const MEMBER = "lifecycle-refusal-reader";
// The shown view while a refocus recheck holds it.
const heldView = '.content [aria-live="polite"][inert]';

// Delete on an Agent page that the API refused (403) showed the API's own denial, which names the
// Agent by ID, and Delete stayed usable, so a retry was refused and audited again (finding 2951).
// Stop said "this Agent" and stayed usable (finding 2955). Both now show the console's sentence
// with the Agent's name and the Request ID, and stay unavailable, described by that refusal,
// until a newer permission answer allows them. A permission read that fails says nothing about
// this viewer's access, so it keeps the refusal.
for (const action of ["Stop", "Delete"] as const) {
  test(`an Agent page ${action} refusal names the Agent and stays until a later answer allows it`, async (t) => {
    const stopping = action === "Stop";
    const name = `Refused page ${action.toLowerCase()}`;
    const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(`page-${action}`));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
    const { page } = await newPage(t, fixture, { browser });
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const permissionsUrl = `${fixture.origin}${agentPath}/permissions`;
    await routeOperateDenials(page, fixture.origin, agentPath, active.revision.id);
    // With no permission answer the page keeps Stop and Delete, and the API decides.
    await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
      member.credentials,
    );
    const row = page.getByRole("region", { name: `${action} Agent`, exact: true });
    const control = row.getByRole("button", { name: `${action} Agent`, exact: true });
    await waitForEnabled(control);
    await control.click();
    const refused = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${agentPath}${stopping ? "/stop" : ""}` &&
        response.request().method() === (stopping ? "POST" : "DELETE"),
    );
    await page
      .getByRole("dialog", { name: stopping ? "Stop this Agent?" : `Delete ${name}?` })
      .getByRole("button", {
        name: stopping ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      })
      .click();
    // The real API refuses the member and names the grant by the Agent's ID.
    const response = await refused;
    assert.equal(response.status(), 403);
    const { error, meta } = await response.json();
    const grant = stopping ? "operate" : "delete";
    assert.ok(
      error.message.startsWith(`Not authorized: this needs Agent ${grant} on Agent ${agent.id}`),
    );
    const alert = row.getByRole("alert");
    const text = stopping ? stopRefused(name) : deleteRefused(name);
    await alert.getByText(text, { exact: true }).waitFor();
    await alert.getByText(`Request ID: ${meta.requestId}`, { exact: true }).waitFor();
    assert.equal(await row.getByText("Not authorized:").count(), 0);
    // Focus stays on the control, which stays in the Tab order, described by the refusal, and
    // sends nothing: the API would refuse it again.
    assert.equal(await hasFocus(control), true);
    const refusal = (await alert.textContent())?.trim() ?? "";
    await expectReachableReason(page, control, refusal);

    // The first Logs visit records the runtime status denial; the next rereads the permission
    // answer, which fails here and keeps the refusal.
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await page.getByText(/Runtime status requires Agent operate/).waitFor();
    await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
    const failed = page.waitForResponse(
      (reply) => reply.url() === permissionsUrl && reply.status() === 503,
    );
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await failed;
    await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
    await nextFrames(page);
    assert.equal(await control.getAttribute("aria-disabled"), "true");
    assert.equal(await accessibleDescription(control), refusal);

    // A grant, seen by a later permission read, makes the control available without the refusal.
    await page.unroute(permissionsUrl);
    grantMember(fixture, MEMBER, [[grant, "agent"]]);
    const answered = page.waitForResponse(
      (reply) =>
        reply.url() === permissionsUrl &&
        reply.request().method() === "GET" &&
        reply.status() === 200,
    );
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await answered;
    await alert.waitFor({ state: "detached" });
    await waitForEnabled(control);
    assert.deepEqual(
      await control.evaluate((node) => ({
        ariaDisabled: node.getAttribute("aria-disabled"),
        describedby: node.getAttribute("aria-describedby"),
      })),
      { ariaDisabled: null, describedby: null },
    );
  });
}

// A refused Stop or Delete stayed unavailable after a re-grant until header Refresh, though coming
// back to the window rechecks the Agent page and the Agents list follows a refocus (r54 row 11).
// The refocus recheck now reads the permission answer again, which lifts the refusal.
for (const action of ["Stop", "Delete"] as const) {
  test(`a re-grant lifts an Agent page ${action} refusal when the reader comes back to the window`, async (t) => {
    const stopping = action === "Stop";
    const name = `Regranted ${action.toLowerCase()}`;
    const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(`regrant-${action}`));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
    const { page } = await newPage(t, fixture, { browser });
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const permissionsUrl = `${fixture.origin}${agentPath}/permissions`;
    await routeOperateDenials(page, fixture.origin, agentPath, active.revision.id);
    // With no permission answer the page keeps Stop and Delete, and the real API refuses them.
    await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
      member.credentials,
    );
    const row = page.getByRole("region", { name: `${action} Agent`, exact: true });
    const control = row.getByRole("button", { name: `${action} Agent`, exact: true });
    await waitForEnabled(control);
    await control.click();
    await page
      .getByRole("dialog", { name: stopping ? "Stop this Agent?" : `Delete ${name}?` })
      .getByRole("button", {
        name: stopping ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      })
      .click();
    const alert = row.getByRole("alert");
    await alert.getByText(stopping ? stopRefused(name) : deleteRefused(name)).waitFor();
    assert.equal(await control.getAttribute("aria-disabled"), "true");
    await page.unroute(permissionsUrl);
    grantMember(fixture, MEMBER, [[stopping ? "operate" : "delete", "agent"]]);
    const answered = page.waitForResponse(
      (reply) =>
        reply.url() === permissionsUrl &&
        reply.request().method() === "GET" &&
        reply.status() === 200,
    );
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await answered;
    await alert.waitFor({ state: "detached" });
    await waitForEnabled(control);
    assert.equal(await hasFocus(control), true);
  });
}

// A refocus reread that started before an Agent page Stop or Delete refusal lifted it when its
// older "allowed" answer landed (finding 2966): the grant was revoked after that read and the API
// refused the action. As on the Agents list, only a read started after the refusal lifts it.
for (const action of ["Stop", "Delete"] as const) {
  test(`a refocus reread started before an Agent page ${action} refusal keeps it`, async (t) => {
    const stopping = action === "Stop";
    const name = `Reread race ${action.toLowerCase()}`;
    const label = `reread-race-${action.toLowerCase()}`;
    const grant = stopping ? "operate" : "delete";
    const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(label));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const member = await fixture.createNamespaceMember(label, namespace.id, AGENT_READ);
    grantMember(fixture, label, [[grant, "agent"]]);
    const { page } = await newPage(t, fixture, { browser });
    const permissionsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`;
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
      member.credentials,
    );
    const row = page.getByRole("region", { name: `${action} Agent`, exact: true });
    const control = row.getByRole("button", { name: `${action} Agent`, exact: true });
    await waitForEnabled(control);
    // The refocus reread reaches the real API while the grant holds; its answer is held.
    const reread = await holdRequests(t, page, permissionsUrl, {
      once: true,
      method: "GET",
      afterServer: true,
    });
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    const allowed = await reread.requested;
    assert.ok(allowed, "the real API answered the reread");
    assert.equal((await allowed.json()).data[grant], true);
    // The grant is revoked, so the real API refuses the action for grants.
    revokeMemberGrant(fixture, label, [grant, "agent"]);
    await page.locator(settledView).waitFor();
    await control.click();
    await page
      .getByRole("dialog", { name: stopping ? "Stop this Agent?" : `Delete ${name}?` })
      .getByRole("button", {
        name: stopping ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      })
      .click();
    const alert = row.getByRole("alert");
    await alert
      .getByText(stopping ? stopRefused(name) : deleteRefused(name), { exact: true })
      .waitFor();
    const refusal = (await alert.textContent())?.trim() ?? "";
    // The older "allowed" answer lands and keeps the refusal.
    reread.release();
    await settlePageRequests(page);
    await nextFrames(page);
    assert.equal(await control.getAttribute("aria-disabled"), "true");
    assert.equal(await accessibleDescription(control), refusal);
    // A refocus after a re-grant reads the answer again, and that read lifts the refusal.
    grantMember(fixture, label, [[grant, "agent"]]);
    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await alert.waitFor({ state: "detached" });
    await waitForEnabled(control);
  });
}

// An Agent page whose Agent is being deleted shows only its deletion row, which polls the Agent.
// A refocus recheck reads no permission answer for it (finding 2968).
test("a refocus reads no permission answer for an Agent page being deleted", async (t) => {
  const name = "Refocus deleting";
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("refocus-deleting"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const permissionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/permissions`;
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
  );
  const control = page.getByRole("button", { name: "Delete Agent", exact: true });
  await waitForEnabled(control);
  await control.click();
  await page
    .getByRole("dialog", { name: `Delete ${name}?` })
    .getByRole("button", { name: "Permanently delete Agent", exact: true })
    .click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  const reads = () => pathRequests(requests, "GET", permissionsPath).length;
  const before = reads();
  // The recheck runs its handlers before it releases the view, so a reread would have started.
  const session = await holdRequests(t, page, "**/api/auth/session", { once: true });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await session.requested;
  await page.locator(heldView).waitFor();
  session.release();
  await page.locator(settledView).waitFor();
  await settlePageRequests(page);
  assert.equal(reads(), before);
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
});

// The page's first permission answer was requested before any Stop or Delete, so it never lifts a
// refusal, even when it answers after a grant that allows the action: only a read started after
// the refusal speaks for this viewer's access now (finding 2955).
for (const action of ["Stop", "Delete"] as const) {
  test(`a first permission answer that arrives after an Agent page ${action} refusal keeps it`, async (t) => {
    const stopping = action === "Stop";
    const name = `Early answer ${action.toLowerCase()}`;
    const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(`early-${action}`));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
    const { page } = await newPage(t, fixture, { browser });
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const permissionsUrl = `${fixture.origin}${agentPath}/permissions`;
    await routeOperateDenials(page, fixture.origin, agentPath, active.revision.id);
    // The first read waits until released; any reread fails and says nothing.
    await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
    const firstAnswer = await holdRequests(t, page, permissionsUrl, { once: true, method: "GET" });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
      member.credentials,
    );
    const row = page.getByRole("region", { name: `${action} Agent`, exact: true });
    const control = row.getByRole("button", { name: `${action} Agent`, exact: true });
    await waitForEnabled(control);
    await control.click();
    await page
      .getByRole("dialog", { name: stopping ? "Stop this Agent?" : `Delete ${name}?` })
      .getByRole("button", {
        name: stopping ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      })
      .click();
    const alert = row.getByRole("alert");
    await alert
      .getByText(stopping ? stopRefused(name) : deleteRefused(name), { exact: true })
      .waitFor();
    const refusal = (await alert.textContent())?.trim() ?? "";
    // The grant reaches the API before the held first read, so that read allows the action.
    const grant = stopping ? "operate" : "delete";
    grantMember(fixture, MEMBER, [[grant, "agent"]]);
    const answered = page.waitForResponse(
      (reply) => reply.url() === permissionsUrl && reply.status() === 200,
    );
    firstAnswer.release();
    assert.equal((await (await answered).json()).data[grant], true);
    await nextFrames(page);
    assert.equal(await control.getAttribute("aria-disabled"), "true");
    assert.equal(await accessibleDescription(control), refusal);
  });
}

// Request Stop again on an Agent already stopped follows the same rule as Stop: the API's grant
// refusal names the Agent, and the control stays unavailable, described by it (finding 2955).
test("a refused Request Stop again names the Agent and stays unavailable", async (t) => {
  const name = "Refused repeat stop";
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("repeat-stop"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("POST", `${agentPath}/stop`)).status, 202);
  const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  // With no permission answer the page offers the repeat, and the API decides.
  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id).href,
    member.credentials,
  );
  const row = page.getByRole("region", { name: "Stop Agent", exact: true });
  const repeat = row.getByRole("button", { name: "Request Stop again", exact: true });
  await waitForEnabled(repeat);
  await repeat.click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const alert = row.getByRole("alert");
  await alert.getByText(stopRefused(name), { exact: true }).waitFor();
  await expectReachableReason(page, repeat, (await alert.textContent())?.trim() ?? "");
});

// A first Stop or Delete that the API refuses for a reason other than grants shows the API's text
// as written (findings 2534, 2955): the caller-state denial any authorized request can get, and
// the retry-ownership denial a Delete gets when another actor's deletion failed after this page
// loaded. Sending it again would be refused the same way, so the control stays unavailable,
// described by that text. The API's answer is fulfilled here: the in-memory app has no disabled
// identity or permanently failed deletion work.
test("a first Stop or Delete refused for another reason shows the API's text and stays unavailable", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Other refusals");
  for (const [action, message, requestId] of [
    ["Stop", "The acting identity is unavailable.", "req_00000000-0000-4000-8000-000000000a01"],
    [
      "Delete",
      "Only the actor that started this deletion can retry it while that actor still holds delete. Retry as that actor, or remove its delete permission first.",
      "req_00000000-0000-4000-8000-000000000a02",
    ],
  ] as const) {
    const stopping = action === "Stop";
    const name = `Other ${action.toLowerCase()} refusal`;
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(`other-${action}`));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const { page } = await newPage(t, fixture, { browser });
    await page.route(`${fixture.origin}${agentPath}${stopping ? "/stop" : ""}`, (route) =>
      route.request().method() === (stopping ? "POST" : "DELETE")
        ? route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "FORBIDDEN", message },
              meta: { requestId },
            }),
          })
        : route.continue(),
    );
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, active.revision.id).href);
    const row = page.getByRole("region", { name: `${action} Agent`, exact: true });
    const control = row.getByRole("button", { name: `${action} Agent`, exact: true });
    await waitForEnabled(control);
    await control.click();
    await page
      .getByRole("dialog", { name: stopping ? "Stop this Agent?" : `Delete ${name}?` })
      .getByRole("button", {
        name: stopping ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      })
      .click();
    const alert = row.getByRole("alert");
    await alert.getByText(message, { exact: true }).waitFor();
    await alert.getByText(`Request ID: ${requestId}`, { exact: true }).waitFor();
    assert.equal(await hasFocus(control), true);
    await expectReachableReason(page, control, (await alert.textContent())?.trim() ?? "");
  }
});

// On the Agents list, a refused row Stop or Delete is reported above the table, which at 390 px
// is far above the row that takes focus back, and the row's icon was not linked to it. An icon
// unavailable for missing access was described by its short grant line and the sentence run
// together ("Needs operate and deleteYour access…", finding 2952). The refused icon stayed
// usable, and nothing near the row said why (finding 2955): now it is unavailable, and the row's
// note under it names the grant, until a permission answer read later allows it.
test("an Agents list row refusal describes the row's icon, and an unavailable icon only its reason", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refused row actions");
  const refusedRow = await fixture.createAgent(namespace.id, "Refused Row", nativeValues("row"));
  await fixture.seedActiveAgentRevision(namespace.id, refusedRow.id);
  const guarded = await fixture.createAgent(namespace.id, "Guarded Row", nativeValues("guard"));
  await fixture.seedActiveAgentRevision(namespace.id, guarded.id);
  const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  // The refused row's permission answer is still pending, so its icons stay available and the
  // real API refuses the member's writes. The guarded row has the real answer: neither action.
  const firstAnswer = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${refusedRow.id}/permissions`,
    { once: true, method: "GET" },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, member.credentials);

  const guardedRow = page.getByRole("row").filter({ hasText: "Guarded Row" });
  await guardedRow.getByText("Needs operate and delete", { exact: true }).waitFor();
  for (const label of ["Stop Guarded Row", "Delete Guarded Row"]) {
    const icon = guardedRow.getByRole("button", { name: label, exact: true });
    assert.equal(await accessibleDescription(icon), AGENT_STOP_AND_DELETE_DENIED, label);
  }

  const row = page.getByRole("row").filter({ hasText: "Refused Row" });
  const stop = row.getByRole("button", { name: "Stop Refused Row", exact: true });
  const remove = row.getByRole("button", { name: "Delete Refused Row", exact: true });
  for (const [icon, title, confirm, text, grant] of [
    [stop, "Stop Refused Row?", "Stop Agent", stopRefused("Refused Row"), "Needs Agent operate"],
    [
      remove,
      "Delete Refused Row?",
      "Permanently delete Agent",
      deleteRefused("Refused Row"),
      "Needs operate and delete",
    ],
  ] as const) {
    await waitForEnabled(icon);
    await icon.click();
    await page
      .getByRole("dialog", { name: title })
      .getByRole("button", { name: confirm, exact: true })
      .click();
    const alert = page.getByRole("alert").filter({ hasText: text });
    await alert.waitFor();
    // Focus returns to the row's icon, which is described by the refusal above the table.
    await page.waitForFunction(
      (label) => globalThis.document.activeElement?.getAttribute("aria-label") === label,
      await icon.getAttribute("aria-label"),
    );
    assert.equal(await accessibleDescription(icon), (await alert.textContent())?.trim());
    // The icon is unavailable, and the row's note right under it names the grant in view.
    assert.equal(await icon.getAttribute("aria-disabled"), "true");
    const note = row.getByText(grant, { exact: true });
    await note.waitFor();
    const [iconBox, noteBox] = [await icon.boundingBox(), await note.boundingBox()];
    assert.ok(iconBox && noteBox && noteBox.y - iconBox.y < 80, `${grant} sits under the icon`);
    assert.ok(noteBox.y + noteBox.height <= 844, `${grant} is in view`);
  }
  // Only the latest refusal describes its icon; the earlier one is described by the row's reason.
  assert.equal(await accessibleDescription(stop), AGENT_STOP_AND_DELETE_DENIED);
  // A permission answer read after the refusal that allows delete makes Delete available again.
  // A search that hides the row retires its pending read, and showing the row again reads anew.
  assert.equal(firstAnswer.wasRequested(), true);
  grantMember(fixture, MEMBER, [["delete", "agent"]]);
  const search = page.getByRole("searchbox", { name: "Search Agents" });
  await search.fill("Guarded");
  await row.waitFor({ state: "detached" });
  await search.fill("");
  await waitForEnabled(remove);
  // A later accepted write replaces the refusal, and no icon is described by it any more.
  await row.getByText("Needs Agent operate", { exact: true }).waitFor();
  assert.equal(await stop.getAttribute("aria-disabled"), "true");
  await remove.click();
  await page
    .getByRole("dialog", { name: "Delete Refused Row?" })
    .getByRole("button", { name: "Permanently delete Agent", exact: true })
    .click();
  await page.getByText("Deletion requested for Refused Row.", { exact: false }).waitFor();
  assert.equal(await page.locator("[aria-describedby~='agent-row-refusal']").count(), 0);
});

// A row's permission answer requested before its refusal never lifts it, even when it answers
// after a grant (finding 2955). A read started after the refusal that allows the action lifts it,
// and the row shows that at once, also when that answer restricts nothing.
test("an Agents list row refusal lifts only for a permission answer read after it", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Row answer order");
  const names = ["Early Answer Row", "Fresh Answer Row"] as const;
  const urls: string[] = [];
  for (const name of names) {
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(name));
    await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    urls.push(`${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`);
  }
  const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  // Both rows' first answers are held, so Delete stays available and the real API refuses it.
  const [early, fresh] = await Promise.all(
    urls.map((url) => holdRequests(t, page, url, { once: true, method: "GET" })),
  );
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, member.credentials);
  const rows = names.map((name) => page.getByRole("row").filter({ hasText: name }));
  const deletes = names.map((name, index) =>
    rows[index]!.getByRole("button", { name: `Delete ${name}`, exact: true }),
  );
  for (const [index, name] of names.entries()) {
    const remove = deletes[index]!;
    await waitForEnabled(remove);
    await remove.click();
    await page
      .getByRole("dialog", { name: `Delete ${name}?` })
      .getByRole("button", { name: "Permanently delete Agent", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: deleteRefused(name) })
      .waitFor();
    assert.equal(await remove.getAttribute("aria-disabled"), "true");
  }
  assert.equal(fresh!.wasRequested(), true);
  grantMember(fixture, MEMBER, [
    ["operate", "agent"],
    ["delete", "agent"],
  ]);
  // The early row's held read reaches the API after the grant and allows delete, but it was
  // requested before the refusal.
  const earlyAnswered = page.waitForResponse(
    (reply) => reply.url() === urls[0] && reply.status() === 200,
  );
  early!.release();
  assert.equal((await (await earlyAnswered).json()).data.delete, true);
  // A search that hides the fresh row retires its held read; showing it again reads anew, and
  // that answer, which restricts nothing, makes its Delete available.
  const search = page.getByRole("searchbox", { name: "Search Agents" });
  await search.fill("Early");
  await rows[1]!.waitFor({ state: "detached" });
  await search.fill("");
  await waitForEnabled(deletes[1]!);
  assert.equal(await deletes[0]!.getAttribute("aria-disabled"), "true");
});

// The Agents list worded every refused row Stop or Delete as a missing grant, in the alert and in
// the row's note under the icon, so a refusal about something else told a person who holds the
// grant that the row "Needs Agent operate" (finding 2958). As on the Agent page, a refusal that is
// not about grants now shows the API's text with the Agent's name and names no grant; the row
// waits for Refresh, since a repeat would be refused the same way. At 390 px that alert is far
// above the row, which showed only a faded icon, and a refocus dropped it (finding D812): the row's
// note now points to it, both icons stay reachable, described by it, and a refocus keeps it until
// Refresh. A denial about grants, here the older API's generic one, keeps the console's sentence
// and the row's grant note. The API's answers are fulfilled: the in-memory app has no disabled
// identity, no permanently failed deletion work and no older API.
test("an Agents list row refused for another reason shows the API's text and names no grant", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Other row refusals");
  const other = await fixture.createAgent(namespace.id, "Other Row", nativeValues("other-row"));
  await fixture.seedActiveAgentRevision(namespace.id, other.id);
  const denied = await fixture.createAgent(namespace.id, "Denied Row", nativeValues("denied-row"));
  await fixture.seedActiveAgentRevision(namespace.id, denied.id);
  const { page } = await newPage(t, fixture, { browser });
  let answer: ReturnType<typeof apiErrorResponse> | undefined;
  for (const agent of [other, denied]) {
    const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
    await page.route(`${agentUrl}/stop`, (route) =>
      route.request().method() === "POST" ? route.fulfill(answer) : route.fallback(),
    );
    await page.route(agentUrl, (route) =>
      route.request().method() === "DELETE" ? route.fulfill(answer) : route.fallback(),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // The owner holds every grant, so each row's icons are available and only the API refuses.
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });

  async function refuse(name: string, action: "Stop" | "Delete", message: string, id: string) {
    const stopping = action === "Stop";
    const row = page.getByRole("row").filter({ hasText: name });
    const icon = row.getByRole("button", { name: `${action} ${name}`, exact: true });
    await waitForEnabled(icon);
    answer = apiErrorResponse(403, "FORBIDDEN", message, { requestId: id });
    await icon.click();
    await page
      .getByRole("dialog", { name: `${action} ${name}?` })
      .getByRole("button", { name: stopping ? "Stop Agent" : "Permanently delete Agent" })
      .click();
    const alert = page.getByRole("alert").filter({ hasText: `Request ID: ${id}` });
    await alert.waitFor();
    return { row, icon, alert: (await alert.locator(".status-body").textContent())?.trim() };
  }

  for (const [action, message, id] of [
    // A caller-state denial any authorized request can get.
    ["Stop", "The acting identity is unavailable.", "req_00000000-0000-4000-8000-000000000b01"],
    // Another actor's deletion failed after this list loaded: the row is stale.
    [
      "Delete",
      "Only the actor that started this deletion can retry it while that actor still holds delete. Retry as that actor, or remove its delete permission first.",
      "req_00000000-0000-4000-8000-000000000b02",
    ],
  ] as const) {
    const { row, icon, alert } = await refuse("Other Row", action, message, id);
    assert.equal(
      alert,
      `Could not ${action.toLowerCase()} Other Row. ${message} Select Refresh before trying again.`,
    );
    const shown = page.getByRole("alert").filter({ hasText: `Request ID: ${id}` });
    const refusal = (await shown.textContent())?.trim() ?? "";
    const note = action === "Stop" ? "Not stopped: see above" : "Not deleted: see above";
    // No grant under the icons: the row's note, in view under them, points to the alert, and
    // both icons wait for Refresh, reachable and described by it. Focus stays on the refused icon.
    const checkRow = async ({ inView = false } = {}) => {
      const line = row.getByText(note, { exact: true });
      await line.waitFor();
      const [iconBox, lineBox] = [await icon.boundingBox(), await line.boundingBox()];
      assert.ok(iconBox && lineBox && lineBox.y - iconBox.y < 80, `${note} sits under the icon`);
      // Where the refused icon took focus back, the note is in view with it.
      assert.ok(!inView || lineBox.y + lineBox.height <= 844, `${note} is in view`);
      assert.equal(await hasFocus(icon), true);
      for (const kind of ["Stop", "Delete"]) {
        const each = row.getByRole("button", { name: `${kind} Other Row`, exact: true });
        // The refused icon is described by the alert, with its Request ID; the other by the note.
        await expectReachableReason(page, each, kind === action ? refusal : alert);
      }
    };
    await checkRow({ inView: true });
    // A refocus rebuilds the list (a row write makes it one it does not reuse). The alert and
    // the row's note stay until Refresh, and focus stays on the refused icon.
    // A second refocus, rebuilt because another Agent was added meanwhile, keeps it too.
    const view = page.locator('.content [aria-live="polite"]');
    for (const round of [1, 2]) {
      if (round === 2) {
        await fixture.createAgent(namespace.id, `Added ${action}`, nativeValues(`added-${action}`));
      }
      await icon.focus();
      await view.evaluate((node) => node.setAttribute("data-before-refocus", ""));
      await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
      await page.locator("[data-before-refocus]").waitFor({ state: "detached" });
      await page.locator(settledView).waitFor();
      assert.equal((await shown.textContent())?.trim(), refusal);
      await checkRow();
    }
    // Refresh rereads the row and makes its icons available again.
    await refresh.click();
    await waitForEnabled(icon);
    assert.equal(await shown.count(), 0);
  }

  // A denial about grants keeps the console's sentence, and the refused icon stays unavailable
  // with the grant in the row's note.
  for (const [action, text, grant, id] of [
    [
      "Stop",
      stopRefused("Denied Row"),
      "Needs Agent operate",
      "req_00000000-0000-4000-8000-000000000b03",
    ],
    [
      "Delete",
      deleteRefused("Denied Row"),
      "Needs operate and delete",
      "req_00000000-0000-4000-8000-000000000b04",
    ],
  ] as const) {
    const { row, icon, alert } = await refuse("Denied Row", action, GENERIC_DENIAL, id);
    assert.equal(alert, text);
    assert.equal(await icon.getAttribute("aria-disabled"), "true");
    await row.getByText(grant, { exact: true }).waitFor();
  }
});

// Request deletion again on an Agent already deleting passes a refusal that is not about grants,
// such as another actor's deletion, through as written (finding 2534). A named grant denial is
// still the console's sentence with the Agent's name.
test("a refused Request deletion again names the Agent, not the API's denial", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refused repeat delete");
  const name = "Refused repeat delete";
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("repeat-delete"));
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("DELETE", agentPath)).status, 202);
  const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  // With no permission answer the page offers the repeat, and the API decides.
  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id).href, member.credentials);
  const row = page.getByRole("region", { name: "Delete Agent", exact: true });
  const repeat = row.getByRole("button", { name: "Request deletion again", exact: true });
  await waitForEnabled(repeat);
  await repeat.click();
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${agentPath}` &&
      response.request().method() === "DELETE",
  );
  await page
    .getByRole("dialog", { name: `Request deletion again for ${name}?` })
    .getByRole("button", { name: "Request deletion again", exact: true })
    .click();
  const response = await refused;
  assert.equal(response.status(), 403);
  assert.ok((await response.json()).error.message.startsWith("Not authorized: "));
  const alert = row.getByRole("alert");
  await alert.getByText(deleteRefused(name), { exact: true }).waitFor();
  assert.equal(await row.getByText("Not authorized:").count(), 0);
  // A grant refusal keeps the repeat unavailable, described by the alert, as for a first Delete.
  await expectReachableReason(page, repeat, (await alert.textContent())?.trim() ?? "");
});

// After the API refused a Create Secret, the dialog's Show value toggle was natively disabled
// with no reason, and the page's Create Secret still offered another attempt the API would
// refuse (r57 rows 14 and 15).
test("a refused Create Secret explains Show value and the page's Create Secret", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refused Secret create");
  const member = await fixture.createNamespaceMember("secret-create-reader", namespace.id, [
    ["read", "namespace"],
    ["read", "secret"],
  ]);
  const { page } = await newPage(t, fixture, { browser });
  // A permission answer that predates a revocation still offers creation; the API refuses it.
  await page.route(`**/namespaces/${namespace.id}/permissions`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, data: { ...body.data, secrets: { create: true } } },
    });
  });
  await login(page, fixture, `/console/secrets?namespace=${namespace.id}`, member.credentials);
  const create = page.getByRole("button", { name: "Create Secret", exact: true });
  await waitForEnabled(create);
  await create.click();
  const dialog = page.getByRole("dialog", { name: "Create Secret" });
  await dialog.getByLabel("Secret name").fill("Refused credential");
  await dialog.getByLabel("Value", { exact: true }).fill("synthetic-refused-value");
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  assert.equal((await refused).status(), 403);
  const alert = dialog.getByRole("alert");
  await alert.getByText(SECRET_CREATE_DENIED, { exact: true }).waitFor();
  // Show value stays in the Tab order, described by the refusal, and does not unmask.
  const reveal = dialog.getByRole("button", { name: "Show value", exact: true });
  await expectReachableReason(page, reveal, (await alert.textContent())?.trim() ?? "");
  assert.equal(await reveal.getAttribute("aria-pressed"), "false");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  // The page's Create Secret says why instead of offering another refused attempt.
  await expectReachableReason(page, create, `${SECRET_CREATE_DENIED} Then select Refresh.`);
  assert.equal(await page.getByRole("dialog").count(), 0);
});

// The member's runtime status read and workspace file reads, answered without a running Agent:
// runtime status is refused, as for a member without operate, and each file reads back.
async function routeOperateDenials(
  page: Page,
  origin: string,
  agentPath: string,
  revision: string,
) {
  await page.route(`${origin}${agentPath}/deployments/${revision}/runtime`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden." } }),
    }),
  );
  await page.route(`${origin}${agentPath}/workspace/files/*`, (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { name: file, content: `# ${file}\n` } }),
    });
  });
}
