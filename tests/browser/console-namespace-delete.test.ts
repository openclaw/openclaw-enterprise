import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../../packages/contracts/src/index.ts";

import { createConsoleAppFixture, grantMember, memberRole } from "../helpers/console-app.mjs";
import {
  apiRequests,
  fileBrowser,
  holdRequests,
  login,
  newPage,
  pathRequests,
  settledView,
} from "./console-agents-browser-helpers.mjs";

const browser = fileBrowser();

test("Namespace trash action confirms, keeps pending cleanup visible, and repairs the selected Namespace after removal", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const target = await fixture.createNamespace("Retired team", { ready: true });
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
  assert.equal(await remove.evaluate((node) => node === node.ownerDocument.activeElement), true);
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
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Occupied team", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Remaining assistant");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Delete Occupied team", exact: true }).click();
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  const blocked = page.getByRole("dialog", {
    name: "Namespace still contains resources",
    exact: true,
  });
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
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain cleanup", { ready: true });
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
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Restricted cleanup", { ready: true });
  const label = "restricted-namespace-deleter";
  const member = await fixture.createNamespaceMember(label, namespace.id, [["read", "namespace"]]);
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, `/console/namespaces?namespace=${namespace.id}`, member.credentials);
  const remove = page.getByRole("button", { name: "Delete Restricted cleanup", exact: true });
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete Restricted cleanup"]')
        ?.disabled === true,
  );
  assert.equal(await remove.isDisabled(), true);
  grantMember(fixture, label, [["delete", "namespace"]]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await remove.click();
  // Revocation after the advisory answer must prevent any lifecycle transition.
  memberRole(fixture, label).permissions = [{ action: "read", resourceKind: "namespace" }];
  await page.getByRole("button", { name: "Delete Namespace", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  assert.equal((await fixture.request("GET", `/namespaces/${namespace.id}`)).data.status, "ready");
  assert.equal(await remove.isDisabled(), true);
});

test("losing Namespace read permission during cleanup does not report deletion", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Lost read access", { ready: true });
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
