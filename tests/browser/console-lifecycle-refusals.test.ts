import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import {
  AGENT_READ,
  accessibleDescription,
  detailUrl,
  expectReachableReason,
  fileBrowser,
  grantMember,
  hasFocus,
  login,
  nativeValues,
  newPage,
  waitForEnabled,
} from "./console-agents-browser-helpers.mjs";
import { withholdPermissionSummary } from "./console-agents-test-support.mjs";
import {
  AGENT_STOP_AND_DELETE_DENIED,
  SECRET_CREATE_DENIED,
  deleteRefused,
  stopRefused,
} from "../helpers/refusal-text.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

// A member who can read an Agent and its versions, and holds no operate or delete.
const MEMBER = "lifecycle-refusal-reader";

// Delete on an Agent page that the API refused (403) showed the API's own denial, which names the
// Agent by ID, and Delete stayed usable, so a retry was refused and audited again (finding 2951).
// The page now shows the console's sentence with the Agent's name and the Request ID, and keeps
// Delete unavailable, described by that refusal, until a newer permission answer allows delete.
test("an Agent page Delete refusal names the Agent and stays until a later answer allows delete", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refused page delete");
  const name = "Refused page delete";
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("page-delete"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const permissionsUrl = `${fixture.origin}${agentPath}/permissions`;
  await routeOperateDenials(page, fixture.origin, agentPath, active.revision.id);
  // With no permission answer the page keeps Delete, and the API decides.
  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").href,
    member.credentials,
  );
  const row = page.getByRole("region", { name: "Delete Agent", exact: true });
  const remove = row.getByRole("button", { name: "Delete Agent", exact: true });
  await waitForEnabled(remove);
  await remove.click();
  const refused = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${agentPath}` &&
      response.request().method() === "DELETE",
  );
  await page
    .getByRole("dialog", { name: `Delete ${name}?` })
    .getByRole("button", { name: "Permanently delete Agent", exact: true })
    .click();
  // The real API refuses the member and names the grant by the Agent's ID.
  const response = await refused;
  assert.equal(response.status(), 403);
  const { error, meta } = await response.json();
  assert.ok(
    error.message.startsWith(`Not authorized: this needs Agent delete on Agent ${agent.id}`),
  );
  const alert = row.getByRole("alert");
  await alert.getByText(deleteRefused(name), { exact: true }).waitFor();
  await alert.getByText(`Request ID: ${meta.requestId}`, { exact: true }).waitFor();
  assert.equal(await page.getByText("Not authorized:").count(), 0);
  // Focus stays on Delete, which stays in the Tab order, described by the refusal, and sends
  // nothing: the API would refuse it again.
  assert.equal(await hasFocus(remove), true);
  const refusal = (await alert.textContent())?.trim() ?? "";
  await expectReachableReason(page, remove, refusal);

  // A grant, seen by a later permission read, makes Delete available again without the refusal.
  await page.unroute(permissionsUrl);
  grantMember(fixture, MEMBER, [["delete", "agent"]]);
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await page.getByText(/Runtime status requires Agent operate/).waitFor();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  assert.equal(await remove.getAttribute("aria-disabled"), "true");
  const answered = page.waitForResponse(
    (reply) =>
      reply.url() === permissionsUrl &&
      reply.request().method() === "GET" &&
      reply.status() === 200,
  );
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await answered;
  await alert.waitFor({ state: "detached" });
  await waitForEnabled(remove);
  assert.deepEqual(
    await remove.evaluate((node) => ({
      ariaDisabled: node.getAttribute("aria-disabled"),
      describedby: node.getAttribute("aria-describedby"),
    })),
    { ariaDisabled: null, describedby: null },
  );
});

// On the Agents list, a refused row Stop or Delete is reported above the table, which at 390 px
// is far above the row that takes focus back, and the row's icon was not linked to it. An icon
// unavailable for missing access was described by its short grant line and the sentence run
// together ("Needs operate and deleteYour access…", finding 2952).
test("an Agents list row refusal describes the row's icon, and an unavailable icon only its reason", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Refused row actions");
  const refusedRow = await fixture.createAgent(namespace.id, "Refused Row", nativeValues("row"));
  await fixture.seedActiveAgentRevision(namespace.id, refusedRow.id);
  const guarded = await fixture.createAgent(namespace.id, "Guarded Row", nativeValues("guard"));
  await fixture.seedActiveAgentRevision(namespace.id, guarded.id);
  const member = await fixture.createNamespaceMember(MEMBER, namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture, { browser });
  // The refused row has no permission answer, so its icons stay available and the real API
  // refuses the member's writes. The guarded row has the real answer: neither action.
  await withholdPermissionSummary(page, fixture, namespace.id, refusedRow.id);
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
  for (const [icon, title, confirm, text] of [
    [stop, "Stop Refused Row?", "Stop Agent", stopRefused("Refused Row")],
    [remove, "Delete Refused Row?", "Permanently delete Agent", deleteRefused("Refused Row")],
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
  }
  // Only the latest refusal describes its icon.
  assert.equal(await stop.getAttribute("aria-describedby"), null);
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
