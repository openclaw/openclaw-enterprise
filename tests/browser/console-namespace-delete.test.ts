import assert from "node:assert/strict";
import test from "node:test";
import type { Locator } from "playwright";
import type { AuditEvent } from "../../packages/contracts/src/index.ts";
import { DeletionRetryOwnedError } from "../../packages/occ/src/index.ts";

import { apiErrorResponse } from "../helpers/api-error.mjs";
import { restrict } from "../helpers/iam-grants.mjs";
import { NAMESPACE_DELETE_DENIED, NAMESPACE_DELETE_RESTRICTED } from "../helpers/refusal-text.mjs";
import { createConsoleAppFixture, grantMember, memberRole } from "../helpers/console-app.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";
import {
  apiRequests,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  newPage,
  pathRequests,
  settledFetches,
  settledView,
  trackSettledFetches,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { focusedLabel, waitForFocusedLabel } from "./console-refocus-helpers.mjs";

const browser = fileBrowser();

// How a refused, still focusable delete control looks once a keyboard user reaches it (findings
// D788, 2863): its icon or label fades as a disabled button's does, but nothing fades the control
// itself or an ancestor, so its focus ring keeps the full focus colour. `faded` is the icon's
// opacity, or the alpha of the label's colour.
function refusedFocusLook(control: Locator) {
  return control.evaluate((node) => {
    let opacity = 1;
    for (let at: Element | null = node; at; at = at.parentElement) {
      opacity *= Number(getComputedStyle(at).opacity);
    }
    const focus = document.createElement("span");
    focus.style.color = "var(--color-focus)";
    document.body.append(focus);
    const focusColor = getComputedStyle(focus).color;
    focus.remove();
    const style = getComputedStyle(node);
    const icon = node.querySelector("svg");
    // An opaque colour serializes as rgb(r, g, b), a faded one as rgba(...) or color(... / a).
    const alpha = (/\/\s*([\d.]+)\)$/.exec(style.color) ??
      /^rgba\(.*,\s*([\d.]+)\)$/.exec(style.color))?.[1];
    return {
      ariaDisabled: node.getAttribute("aria-disabled"),
      focusVisible: node.matches(":focus-visible"),
      opacity,
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor === focusColor}`,
      faded: icon ? Number(getComputedStyle(icon).opacity) : Number(alpha ?? 1),
    };
  });
}

test("Namespace trash action confirms, keeps pending cleanup visible, and repairs the selected Namespace after removal", async (t) => {
  const { fixture, namespace: target } = await createReadyConsoleNamespace(t, "Retired team");
  const remaining = await fixture.createNamespace("Remaining team", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/namespaces?namespace=${target.id}`);
  const remove = page.getByRole("button", { name: "Delete Retired team", exact: true });
  await remove.click();
  const dialog = page.getByRole("dialog", { name: "Delete Retired team?", exact: true });
  await dialog
    .getByText("This cannot be undone. The name cannot be reused.", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await hasFocus(remove), true);
  assert.equal(pathRequests(requests, "DELETE", `/namespaces/${target.id}`).length, 0);

  // Hold the real accepted response: Escape and navigation cannot abandon or replay the write.
  const pending = await holdRequests(t, page, `${fixture.origin}/namespaces/${target.id}`, {
    method: "DELETE",
    afterServer: true,
    once: true,
  });
  await remove.click();
  await dialog.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  await pending.requested;
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    await dialog.getByRole("button", { name: "Deleting…", exact: true }).isDisabled(),
    true,
  );
  pending.release();
  await dialog.waitFor({ state: "detached" });
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: target.name, exact: true }) });
  await row.getByText("Deleting…", { exact: true }).waitFor();
  assert.equal((await fixture.request("GET", `/namespaces/${target.id}`)).data.status, "deleting");
  const event = fixture.auditSink
    .list()
    .find((entry: AuditEvent) => entry.action === "openclaw.namespaces.delete");
  assert.ok(event);
  await fixture.controller!.handleNamespaceLifecycle(event.actorId, target.id, "deleted");
  await row
    .getByRole("button", { name: "Refresh Retired team deletion status", exact: true })
    .click();
  await page
    .getByText("Retired team was deleted. Its name remains reserved.", { exact: true })
    .waitFor();
  // Refresh, disabled while it read, left with its row; the outcome takes focus, not the page.
  assert.equal(await hasFocus(page.locator(".namespace-deletion-outcome")), true);
  assert.equal(new URL(page.url()).searchParams.get("namespace"), remaining.id);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page
    .locator(settledView)
    .getByRole("heading", { name: "No Agents yet", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).inputValue(),
    remaining.id,
  );
  assert.equal(pathRequests(requests, "DELETE", `/namespaces/${target.id}`).length, 1);
});

test("Namespace deletion blockers name real Agent resources and keep cleanup navigation in their owning Namespace", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Occupied team");
  const agent = await fixture.createAgent(namespace.id, "Remaining assistant");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  const remove = page.getByRole("button", { name: "Delete Occupied team", exact: true });
  const confirm = page.getByRole("button", { name: "Delete Namespace", exact: true });
  const blocked = page.getByRole("dialog", {
    name: "Namespace still contains resources",
    exact: true,
  });
  // Closing the blockers, which replaced the confirmation's content, returns focus to the trash
  // control that opened it.
  await remove.click();
  await confirm.click();
  await blocked.getByRole("button", { name: "Close", exact: true }).click();
  await blocked.waitFor({ state: "detached" });
  assert.equal(await hasFocus(remove), true);
  await remove.click();
  await confirm.click();
  await blocked.getByText(agent.id, { exact: true }).waitFor();
  await blocked.getByText(agent.configurationId, { exact: true }).waitFor();
  await blocked.getByText("Configuration cleanup commands", { exact: true }).click();
  await blocked
    .getByText(`occ --namespace ${namespace.id} configuration delete ${agent.configurationId}`, {
      exact: true,
    })
    .waitFor();
  assert.equal((await fixture.request("GET", `/namespaces/${namespace.id}`)).data.status, "ready");
  await blocked.getByRole("button", { name: "View Agents", exact: true }).click();
  await page.locator(settledView).getByRole("link", { name: agent.name, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), namespace.id);
});

test("a lost Namespace deletion response requires a status read without automatically replaying DELETE", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Uncertain cleanup");
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  const lost = await holdRequests(t, page, `${fixture.origin}/namespaces/${namespace.id}`, {
    method: "DELETE",
    afterServer: true,
    loseResponse: true,
    once: true,
  });
  await page.getByRole("button", { name: "Delete Uncertain cleanup", exact: true }).click();
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  await lost.requested;
  lost.release();
  await page
    .getByText(
      "Outcome unknown. Deletion may have started. Select Refresh status before deciding to try again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Request deletion again", exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Refresh Uncertain cleanup deletion status", exact: true })
    .click();
  await page.getByRole("button", { name: "Request deletion again", exact: true }).waitFor();
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}`)).data.status,
    "deleting",
  );
  assert.equal(pathRequests(requests, "DELETE", `/namespaces/${namespace.id}`).length, 1);
});

test("Namespace deletion permission is advisory and a later revocation is enforced by the real write", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Restricted cleanup");
  const label = "restricted-namespace-deleter";
  const member = await fixture.createNamespaceMember(label, namespace.id, [["read", "namespace"]]);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`, member.credentials);
  const remove = page.getByRole("button", { name: "Delete Restricted cleanup", exact: true });
  // No Namespace Role grants delete, so the reason names who can delete, not a grant to ask for.
  // The icon stays in the Tab order, so a keyboard user reaches the reason, and it opens nothing
  // (finding D788).
  await page
    .getByRole("button", {
      name: "Delete Restricted cleanup",
      exact: true,
      description: NAMESPACE_DELETE_DENIED,
    })
    .waitFor();
  assert.equal(await remove.isDisabled(), true);
  assert.equal(await remove.getAttribute("aria-disabled"), "true");
  await remove.focus();
  assert.equal(await hasFocus(remove), true);
  // Each is checked on its own: a click on the modal's backdrop would close a dialog Enter opened.
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await remove.click({ force: true });
  assert.equal(await page.locator("dialog[open]").count(), 0);
  grantMember(fixture, label, [["delete", "namespace"]]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await remove.click();
  // Revocation after the advisory answer must prevent any lifecycle transition.
  memberRole(fixture, label).permissions = [{ action: "read", resourceKind: "namespace" }];
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  assert.equal((await fixture.request("GET", `/namespaces/${namespace.id}`)).data.status, "ready");
  assert.equal(await remove.isDisabled(), true);
  // The refused trash control, natively disabled while the write ran, takes focus back.
  assert.equal(await hasFocus(remove), true);
});

// Finding 2861. A deny Restriction refuses Namespace delete even to an Installation administrator,
// and administration cannot lift it. Her permission answer shows administration without delete,
// so the reason names the Restriction and who lifts it, not an administrator to ask: she is one.
test("a Restriction on Namespace delete names the Restriction to an Installation administrator", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Held cleanup");
  restrict(fixture.policy, "delete", "namespace", { namespaceId: namespace.id });
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  const remove = page.getByRole("button", {
    name: "Delete Held cleanup",
    exact: true,
    description: NAMESPACE_DELETE_RESTRICTED,
  });
  await remove.waitFor();
  assert.equal(await page.getByText(NAMESPACE_DELETE_DENIED, { exact: true }).count(), 0);
  // A keyboard user reaches the refused icon, and its focus ring is not faded with it.
  await remove.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.deepEqual(await refusedFocusLook(remove), {
    ariaDisabled: "true",
    focusVisible: true,
    opacity: 1,
    ring: "solid 2px true",
    faded: 0.6,
  });
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("dialog[open]").count(), 0);
});

test("losing Namespace read permission during cleanup does not report deletion", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Lost read access");
  const label = "namespace-cleanup-reader";
  const member = await fixture.createNamespaceMember(label, namespace.id, [
    ["read", "namespace"],
    ["delete", "namespace"],
  ]);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`, member.credentials);
  await page.getByRole("button", { name: "Delete Lost read access", exact: true }).click();
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  const refresh = page.getByRole("button", {
    name: "Refresh Lost read access deletion status",
    exact: true,
  });
  await refresh.waitFor();
  // Revoke only read after acceptance; the Namespace still exists and the next GET really denies.
  memberRole(fixture, label).permissions = [{ action: "delete", resourceKind: "namespace" }];
  await refresh.click();
  await page
    .getByText(
      "This Namespace is no longer readable. It may have been deleted or your access changed. Refresh Namespaces to check your access.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}`)).data.status,
    "deleting",
  );
  assert.equal(
    await page
      .getByText("Lost read access was deleted. Its name remains reserved.", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Request deletion again", exact: true }).count(),
    0,
  );
});

test("a background Namespace deletion poll keeps keyboard focus and the shown status", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Polled cleanup");
  const { page } = await newPage(t, fixture, { browser });
  await trackSettledFetches(page);
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  const path = `/namespaces/${namespace.id}`;
  const refreshLabel = "Refresh Polled cleanup deletion status";
  await page.getByRole("button", { name: "Delete Polled cleanup", exact: true }).click();
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  // Acceptance moves focus to Refresh status while cleanup runs.
  await waitForFocusedLabel(page, refreshLabel);
  const statusSelector = `#namespace-delete-feedback-${namespace.id} [role="status"]`;
  // Keep a reference to the shown status node; an attribute marker would itself change the HTML.
  const shownStatus = await page.locator(statusSelector).elementHandle();
  // The next read of this path is the 3 s background status poll.
  await waitForSettledFetches(page, path, (await settledFetches(page, path)) + 1);
  // A keyboard user who just confirmed stays on Refresh status, and a screen reader is not told
  // the same status again: the background poll changed nothing on screen.
  assert.equal(await focusedLabel(page), refreshLabel);
  assert.equal(
    await page.evaluate(([selector, shown]) => document.querySelector(selector) === shown, [
      statusSelector,
      shownStatus,
    ] as const),
    true,
  );
  // A requested check disables the button while it reads, then gives focus back to it. It ends
  // with the permission answer, which only a requested check reads while cleanup runs.
  const permissions = `${path}/permissions`;
  const answered = (await settledFetches(page, permissions)) + 1;
  await page.keyboard.press("Enter");
  await waitForSettledFetches(page, permissions, answered);
  assert.equal(await focusedLabel(page), refreshLabel);
});

test("a Namespace deletion confirmation opened during a background poll closes when that poll finds the Namespace removed", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Finishing cleanup");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Delete Finishing cleanup", exact: true }).click();
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  const retry = page.getByRole("button", { name: "Request deletion again", exact: true });
  await retry.waitFor();
  // Hold the next background status read; it reaches the server only on release, after
  // cleanup has finished.
  const poll = await holdRequests(t, page, `${fixture.origin}/namespaces/${namespace.id}`, {
    method: "GET",
    once: true,
  });
  const event = fixture.auditSink
    .list()
    .find((entry: AuditEvent) => entry.action === "openclaw.namespaces.delete");
  assert.ok(event);
  await fixture.controller!.handleNamespaceLifecycle(event.actorId, namespace.id, "deleted");
  await poll.requested;
  // A background read leaves the retry usable, so the confirmation can open during it.
  await retry.click();
  const dialog = page.getByRole("dialog", {
    name: "Retry deletion of Finishing cleanup?",
    exact: true,
  });
  await dialog.waitFor();
  poll.release();
  await page
    .getByText("Finishing cleanup was deleted. Its name remains reserved.", { exact: true })
    .waitFor();
  // Nothing is left to delete, so the confirmation closes instead of offering a dead action.
  await dialog.waitFor({ state: "detached" });
  // Its opener left with the row, so focus goes to the outcome, not the page.
  assert.equal(await hasFocus(page.locator(".namespace-deletion-outcome")), true);
});

test("returning to an unchanged Namespaces page reads each row's delete permission once", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespaces = [
    await fixture.createNamespace("First return", { ready: true }),
    await fixture.createNamespace("Second return", { ready: true }),
  ];
  const { page } = await newPage(t, fixture, { browser });
  await trackSettledFetches(page);
  await login(page, fixture, `/console/namespaces?namespace=${namespaces[0].id}`);
  const permissions = namespaces.map(({ id }) => `/namespaces/${id}/permissions`);
  const reads = () => Promise.all(permissions.map((path) => settledFetches(page, path)));
  for (const path of permissions) {
    await waitForSettledFetches(page, path, 1);
  }
  // A view with a read still in flight is rebuilt on return, not reused.
  await waitForIdleFetches(page);
  // Mark the shown view: a reused view keeps the mark, a rebuilt one does not.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".content [aria-live='polite']")!.dataset.returnMark = "1";
  });
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page
    .locator(settledView)
    .getByRole("heading", { name: "No Agents yet", exact: true })
    .waitFor();
  // Counted from here: the Agents page reads the selected Namespace's permissions itself.
  await waitForIdleFetches(page);
  const before = await reads();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.locator(settledView).getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector<HTMLElement>(".content [aria-live='polite']")?.dataset.returnMark,
    ),
    "1",
    "the unchanged Namespaces page was rebuilt instead of reused",
  );
  // The return's recheck replays each row's permission read once to prove the page unchanged;
  // resuming the reused rows must not read the same answers again (finding 2799).
  assert.deepEqual(
    await reads(),
    before.map((count) => count + 1),
  );
});

test("a refused Namespace deletion retry keeps its reason through a background poll", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Owned retry");
  const path = `/namespaces/${namespace.id}`;
  assert.equal((await fixture.request("DELETE", path)).status, 202);
  const { page } = await newPage(t, fixture, { browser });
  await trackSettledFetches(page);
  // The in-memory fixture has no failed teardown work, so the retry's refusal is the API's own
  // ownership error, mapped as the HTTP layer maps it (403 FORBIDDEN with the error's message).
  const ownership = new DeletionRetryOwnedError("prn_initiator", {
    kind: "namespace",
    id: namespace.id,
    namespaceId: namespace.id,
  }).message;
  await page.route(fixture.origin + path, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    await route.fulfill(apiErrorResponse(403, "FORBIDDEN", ownership));
  });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  const retry = page.getByRole("button", { name: "Request deletion again", exact: true });
  await retry.click();
  await page
    .getByRole("dialog", { name: "Retry deletion of Owned retry?", exact: true })
    .getByRole("button", { name: "Request deletion again", exact: true })
    .click();
  const reason = page.locator(`#namespace-delete-feedback-${namespace.id}`).getByText(ownership, {
    exact: true,
  });
  await reason.waitFor();
  assert.equal(await retry.isDisabled(), true);
  // The next read of this path is the 3 s background status poll; cleanup is still running.
  await waitForSettledFetches(page, path, (await settledFetches(page, path)) + 1);
  // The poll changed nothing, so the refusal and the disabled retry stay; re-enabling the retry
  // would invite the same 403 (finding 2725).
  assert.equal(await reason.isVisible(), true);
  assert.equal(await retry.isDisabled(), true);
  // The refused retry stays focusable (aria-disabled), still looks unavailable, and keeps a
  // full-strength focus ring (findings D788, 2863).
  await retry.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.deepEqual(await refusedFocusLook(retry), {
    ariaDisabled: "true",
    focusVisible: true,
    opacity: 1,
    ring: "solid 2px true",
    faded: 0.6,
  });
});
