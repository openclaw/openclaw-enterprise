import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/detail.mjs";
import { DELETION_POLL_MS } from "../../apps/controller/src/console/agents/deletion.mjs";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { WORKSPACE_DEFAULTS } from "../../packages/contracts/src/workspace-defaults.mjs";
import { createConsoleAppFixture, fileConsoleApp } from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  apiRequests,
  detailUrl,
  expectNoText,
  holdRequests,
  login,
  setSlackSelection,
  slackSelectionValue,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  secretOptionLabel,
  selectSecret,
  settlePageRequests,
  trackSettledFetches,
  waitForCondition,
  waitForIdleFetches,
  waitForInputValue,
  waitForSettledFetches,
  statusTone,
} from "./console-agents-browser-helpers.mjs";
import {
  deploymentActivity,
  deploymentRecordUrl,
  expectDeploymentOutcome,
} from "./console-deployment-activity-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  expectNativeAdminHidden,
  withholdPermissionSummary,
  assertRevisionUrl,
  agentDeleteRequests,
  agentStopRequests,
  nativeAdminComputeDriver,
  nativeAdminValues,
  waitForLiveControls,
} from "./console-agents-test-support.mjs";

// The Console Browser lane runs the two Agent detail test files in parallel.

// Tests that need no app of their own share one (fileConsoleApp); each makes its own Namespace.
// Tests that open an Agent link without a Namespace (which reads every Namespace), expire every
// session, register a Driver, use the bootstrap result, or pass fixture options keep an app of
// their own.
const detailApp = fileConsoleApp();

test("Agent delete confirmation can be canceled without sending a write request", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Delete cancellation", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Cancel Candidate", nativeValues("keep"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // A fake clock that keeps running on its own, so the check after Cancel can fire every timer
  // the page has started instead of waiting on wall-clock time (finding 1994).
  await page.clock.install();

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Cancel Candidate?" });
  await dialog.getByText(/Agent, its version history, and its workspace data/i).waitFor();
  // Deletion keeps the Agent's Configuration and model credential Secret, which the console
  // cannot list or delete, so the dialog gives the commands that remove them by ID.
  assert.equal(agent.harnessAuth.method, "api_key");
  await dialog
    .getByText(
      `Its Configuration and model credential Secret are kept, even if they were created with this Agent. Once nothing else uses them, delete them with occ configuration delete ${agent.configurationId} and occ secret delete ${agent.harnessAuth.source.id}.`,
    )
    .waitFor();
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  assert.equal(await cancel.evaluate((node) => node.ownerDocument.activeElement === node), true);
  // Attach the rejection check when the timed wait starts: on a loaded runner the click can
  // outlast the 300 ms window, and a wait that times out with no handler fails the test as an
  // unhandled rejection (finding 1986). This only catches a DELETE sent soon after Cancel; the
  // clock run below catches one the page sends later.
  const unexpectedDelete = assert.rejects(
    page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
        response.request().method() === "DELETE",
      { timeout: 300 },
    ),
    /Timeout/,
  );
  await cancel.click();
  await unexpectedDelete;
  // Cancel returns focus to the control that opened the dialog.
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Delete Agent",
  );

  // A DELETE that Cancel defers to a timer would miss the window above (finding 1994). Run the
  // fake clock 15 s ahead so every one-shot timer due by then fires (a repeating poll fires about
  // once, since it schedules its next run only after its fetch answers), then let the page finish
  // a fetch of its own: a DELETE the timers sent was issued before that fetch, so the requests
  // check below sees it.
  await page.clock.runFor(Math.max(DELETION_POLL_MS, DEPLOYMENT_POLL_MS) * 3);
  await settlePageRequests(page);

  await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "active");
});

test("Agent delete confirmation sends the real delete API and leaves visible queued state", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Delete success", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Success Candidate", nativeValues("go"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Success Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Success Candidate?" });
  await dialog.getByText(/Agent, its version history, and its workspace data/i).waitFor();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  const response = await deleteResponse;
  assert.equal(response.status(), 202);
  assert.equal((await response.json()).data.status, "deleting");

  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  // Queued deletion is an info notice, not a warning (finding 2006).
  assert.deepEqual(await statusTone(page.getByText(/^Deletion was requested\. /)), {
    className: "status",
    tone: "info",
    role: "status",
  });
  await page.getByRole("button", { name: "Refresh deletion status" }).waitFor();
  // The dialog's close event arrives after the request put focus on the status check. It must
  // not move focus back to the relabelled danger button "Request deletion again" (finding 1421).
  // A closed dialog has no dialog role, so wait for the close handler to remove the element.
  await page.locator("dialog.agent-delete-dialog").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Refresh deletion status",
  );
  assert.deepEqual(
    agentDeleteRequests(requests, namespace.id, agent.id).map((request) => [
      request.method,
      request.path,
      request.body,
    ]),
    [["DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`, null]],
  );
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "deleting");

  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "Success Candidate" })
    .getByText("Deleting", { exact: true })
    .waitFor();
});

test("Agent deletion says access ended when the deleter can no longer read the Agent", (t) =>
  checkScopedDeletionEnd(t, { moveFocusDuringPoll: false }));

test("A deletion status poll that ends scoped access respects focus moved during the read", (t) =>
  checkScopedDeletionEnd(t, { moveFocusDuringPoll: true }));

async function checkScopedDeletionEnd(t, { moveFocusDuringPoll }) {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["scoped-deleter"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete scoped", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Scoped Candidate", nativeValues("scoped"));
  const person = fixture.provisionedAccounts[0];
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const bind = async (permissions, resourceKind, resourceId) => {
    const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
    assert.equal(role.status, 201);
    const binding = await fixture.request("POST", `${policyPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: person.principal.id,
        roleId: role.data.id,
        resourceKind,
        resourceId,
      },
    });
    assert.equal(binding.status, 201);
    return binding.data;
  };
  // A member whose only Agent grants target this Agent, as a Namespace administrator shares it.
  await bind([{ action: "read", resourceKind: "namespace" }], "namespace", namespace.id);
  const agentBinding = await bind(
    [
      { action: "read", resourceKind: "agent" },
      { action: "delete", resourceKind: "agent" },
    ],
    "agent",
    agent.id,
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  await page.clock.install({ time: new Date("2026-10-04T12:00:00Z") });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    person.credentials,
  );
  await page.getByRole("heading", { name: "Scoped Candidate" }).first().waitFor();
  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Scoped Candidate?" });
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  const reads = () => pathRequests(requests, "GET", agentPath).length;
  const accepted = reads();

  // While cleanup runs, the member's grants still hold and the poll follows the deletion.
  const followed = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${agentPath}` && response.request().method() === "GET",
  );
  await page.clock.runFor(DELETION_POLL_MS);
  assert.equal((await followed).status(), 200);
  assert.equal(reads(), accepted + 1);
  // Refresh is enabled again once that poll finished and scheduled the next one.
  await page.waitForFunction(() => {
    const refresh = [...globalThis.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Refresh deletion status",
    );
    return refresh !== undefined && !refresh.disabled;
  });
  await page.getByRole("status").getByText("Deletion was requested").waitFor();

  // Finishing the deletion removes the bindings that target the Agent, so the next read is a
  // real 403 for this member (an administrator would get 404 and return to the list).
  const removed = await fixture.request(
    "DELETE",
    `${policyPath}/access-bindings/${agentBinding.id}`,
  );
  assert.ok([200, 204].includes(removed.status), `binding removal answered ${removed.status}`);
  await page.getByRole("button", { name: "Refresh deletion status" }).focus();
  const denied = await holdNextStatusResponse(page, `${fixture.origin}${agentPath}`);
  await page.clock.runFor(DELETION_POLL_MS);
  const status = await denied.status;
  const expectedFocus = moveFocusDuringPoll
    ? page.getByRole("link", { name: "← Agents", exact: true })
    : page.getByRole("heading", { name: "Delete Agent", exact: true });
  if (moveFocusDuringPoll) {
    await expectedFocus.focus();
  }
  denied.release();
  assert.equal(status, 403);
  await page
    .getByRole("status")
    .getByText(
      "Deletion was accepted. Your access to this Agent ended with it, so this page cannot follow the cleanup.",
    )
    .waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Refresh deletion status" }).count(), 0);
  assert.equal(await expectedFocus.evaluate((node) => node.matches(":focus")), true);

  // Polling stops: no further reads, however long the page stays open.
  const settled = reads();
  await page.clock.runFor(DELETION_POLL_MS * 3);
  assert.equal(reads(), settled);
  assert.equal((await fixture.request("GET", agentPath)).data.status, "deleting");
}

test("Agent delete uncertainty requires refresh before another destructive request", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Delete uncertainty", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Candidate",
    nativeValues("uncertain"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const deletePath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  let interceptedDeletes = 0;
  await page.route(`**${deletePath}`, async (route, request) => {
    if (request.method() !== "DELETE") {
      await route.continue();
      return;
    }
    interceptedDeletes += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked deletion response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Uncertain Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Uncertain Candidate?" });
  await dialog.getByText(/Agent, its version history, and its workspace data/i).waitFor();
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();

  await page.getByText("Outcome unknown. Deletion may have started.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete Agent" }).isDisabled(), true);
  assert.equal(interceptedDeletes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  const deleting = await fixture.request("GET", deletePath);
  assert.equal(deleting.data.status, "deleting");

  const refresh = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${deletePath}` && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh deletion status" }).click();
  assert.equal((await refresh).status(), 200);
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  assert.equal(interceptedDeletes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
});

test("An already deleting Agent permits only a confirmed manual repeat DELETE", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Deletion repeat", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Repeat cleanup", nativeValues("repeat"));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("DELETE", path)).status, 202);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("button", { name: "Request deletion again", exact: true }).waitFor();
  requests.length = 0;
  await checkStatusRefreshFocus(page, `${fixture.origin}${path}`, "Refresh deletion status");
  const open = () =>
    page.getByRole("button", { name: "Request deletion again", exact: true }).click();
  await open();
  let dialog = page.getByRole("dialog", { name: "Request deletion again for Repeat cleanup?" });
  await dialog
    .getByText("Cleanup that is queued or running continues unchanged.", { exact: false })
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(
    await page
      .getByRole("button", { name: "Request deletion again", exact: true })
      .evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  await open();
  dialog = page.getByRole("dialog", { name: "Request deletion again for Repeat cleanup?" });
  const response = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + path && response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Request deletion again", exact: true }).click();
  assert.equal((await response).status(), 202);
  assert.deepEqual(
    agentDeleteRequests(requests, namespace.id, agent.id).map(({ method, path, body }) => [
      method,
      path,
      body,
    ]),
    [["DELETE", path, null]],
  );
  assert.equal((await fixture.request("GET", path)).data.status, "deleting");
});

test("Repeat deletion preserves bounded retry ownership feedback and ordinary denial guidance", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Retry refusal feedback", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Owned cleanup", nativeValues("repeat"));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("DELETE", path)).status, 202);
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  const ownership =
    "Only the actor that started this deletion can retry it while that actor still holds delete. Retry as that actor, or remove its delete permission first.";
  let serverMessage = ownership;
  let writes = 0;
  // Exercise the bounded API-client error consumer independently of durable worker admission.
  await page.route(fixture.origin + path, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    writes += 1;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "FORBIDDEN", message: serverMessage } }),
    });
  });
  const confirm = async () => {
    await page.getByRole("button", { name: "Request deletion again", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Request deletion again for Owned cleanup?" })
      .getByRole("button", { name: "Request deletion again", exact: true })
      .click();
  };
  await confirm();
  await page.getByRole("alert").getByText(ownership, { exact: true }).waitFor();
  await expectNoText(page, "Ask an administrator for Agent delete access");
  assert.equal(writes, 1);
  await page.clock.fastForward(DELETION_POLL_MS * 2);
  await page.getByRole("alert").getByText(ownership, { exact: true }).waitFor();
  assert.equal(writes, 1);
  serverMessage = "The exact platform operation was not authorized.";
  await confirm();
  await page
    .getByRole("alert")
    .getByText("You do not have permission to delete this Agent", { exact: false })
    .waitFor();
  assert.equal(writes, 2);
  await page.clock.fastForward(DELETION_POLL_MS * 2);
  await page
    .getByRole("alert")
    .getByText("You do not have permission to delete this Agent", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Refresh deletion status", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  assert.equal(writes, 2);
  assert.equal((await fixture.request("GET", path)).data.status, "deleting");
});

test("failed repeat deletion preserves feedback when a poll was rearmed during its request", async (t) => {
  for (const [status, text, guarded] of [
    [400, "Check the entered values and resource IDs, then try again.", false],
    [
      409,
      "This Agent could not be deleted in its current state. Refresh its status before trying again.",
      true,
    ],
    [429, "Too many requests. Wait before trying again.", false],
  ]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const fixture = await detailApp(t);
      const namespace = await fixture.createNamespace(`Pending repeat poll ${status}`, {
        ready: true,
      });
      const agent = await fixture.createAgent(
        namespace.id,
        "Failed repeat",
        nativeValues("repeat"),
      );
      const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
      assert.equal((await fixture.request("DELETE", path)).status, 202);
      const { page } = await newPage(t, fixture);
      await page.clock.install();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      let entered;
      const pending = new Promise((resolve) => {
        entered = resolve;
      });
      let writes = 0;
      await page.route(fixture.origin + path, async (route) => {
        if (route.request().method() !== "DELETE") {
          await route.continue();
          return;
        }
        writes += 1;
        entered();
        await gate;
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "INVALID_REQUEST", message: "Controlled repeat refusal" },
          }),
        });
      });
      await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
      const repeat = page.getByRole("button", { name: "Request deletion again", exact: true });
      await repeat.click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Request deletion again", exact: true })
        .click();
      await pending;
      // Poll callbacks see pending and rearm. Failure must cancel the rearmed timer too.
      await page.clock.fastForward(DELETION_POLL_MS * 2);
      release();
      await page.getByRole("alert").getByText(text, { exact: true }).waitFor();
      await page.clock.fastForward(DELETION_POLL_MS * 2);
      await page.getByRole("alert").getByText(text, { exact: true }).waitFor();
      assert.equal(await repeat.isDisabled(), guarded);
      assert.equal(writes, 1);
      await page.getByRole("button", { name: "Refresh deletion status", exact: true }).click();
      await page.getByRole("alert").waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        [...globalThis.document.querySelectorAll("button")].some(
          (node) => node.textContent === "Request deletion again" && !node.disabled,
        ),
      );
      assert.equal(writes, 1, "manual readback does not replay a write");
    });
  }
});

test("a repeat confirmed during a deletion status read waits for it, shows as sending, then sends once", (t) =>
  checkRepeatDuringRead(t, { endsAccess: false }));

test("a deletion status read that ends access drops a repeat confirmed while it ran", (t) =>
  checkRepeatDuringRead(t, { endsAccess: true }));

// A read that fails still sends the repeat the reader confirmed, and its outcome replaces the
// read's error (finding 1985; dropping it would bring back finding 1975's lost request).
test("a deletion status read that fails still sends a repeat confirmed while it ran", (t) =>
  checkRepeatDuringRead(t, { endsAccess: false, readFails: true }));

async function checkRepeatDuringRead(t, { endsAccess, readFails = false }) {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace(
    `Read before repeat${endsAccess ? " ending access" : ""}${readFails ? " failing" : ""}`,
    { ready: true },
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Read guarded repeat",
    nativeValues("repeat"),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("DELETE", path)).status, 202);
  const { page } = await newPage(t, fixture);
  await page.clock.install();
  let holdRead = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let entered;
  const pending = new Promise((resolve) => {
    entered = resolve;
  });
  let writes = 0;
  await page.route(fixture.origin + path, async (route) => {
    if (route.request().method() === "DELETE") {
      writes += 1;
    }
    if (route.request().method() !== "GET" || !holdRead) {
      await route.continue();
      return;
    }
    holdRead = false;
    const response = await route.fetch();
    entered();
    await gate;
    if (endsAccess) {
      // Finishing the deletion removed the reader's only grants on this Agent.
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden." } }),
      });
      return;
    }
    if (readFails) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Deletion status unavailable." },
        }),
      });
      return;
    }
    await route.fulfill({ response });
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("button", { name: "Request deletion again", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Request deletion again", exact: true });
  holdRead = true;
  await page.clock.fastForward(DELETION_POLL_MS);
  await pending;
  await confirm.click();
  // The confirmed repeat waits for the read instead of being dropped (finding 1975), and says so.
  const sending = dialog.getByRole("button", { name: "Deleting…", exact: true });
  await sending.waitFor();
  assert.equal(await sending.getAttribute("aria-busy"), "true");
  assert.equal(await sending.isDisabled(), true);
  assert.equal(
    await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "Escape keeps a confirmed repeat");
  assert.equal(writes, 0, "pending read prevents delete admission");
  if (endsAccess) {
    release();
    await dialog.waitFor({ state: "detached" });
    await page
      .getByRole("status")
      .getByText(
        "Deletion was accepted. Your access to this Agent ended with it, so this page cannot follow the cleanup.",
      )
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Delete Agent", exact: true })
        .evaluate((node) => node.matches(":focus")),
      true,
    );
    assert.equal(writes, 0, "a read that ended access sends no repeat");
    return;
  }
  const accepted = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + path && response.request().method() === "DELETE",
  );
  release();
  assert.equal((await accepted).status(), 202);
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll("button")].some(
      (node) => node.textContent === "Refresh deletion status" && !node.disabled,
    ),
  );
  assert.equal(writes, 1);
  if (readFails) {
    assert.equal(
      await page.getByText("Could not refresh deletion status.", { exact: false }).count(),
      0,
      "the repeat's outcome replaces the read's error",
    );
  }
}

test("An uncertain repeat deletion stays blocked until a successful deleting readback", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Repeat deletion uncertainty", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Uncertain repeat", nativeValues("repeat"));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal((await fixture.request("DELETE", path)).status, 202);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.clock.install();
  let writes = 0;
  await page.route(`**${path}`, async (route, request) => {
    if (request.method() !== "DELETE" || ++writes > 1) {
      await route.continue();
      return;
    }
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked repeat response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  const repeat = page.getByRole("button", { name: "Request deletion again", exact: true });
  await repeat.waitFor();
  requests.length = 0;
  await repeat.click();
  let dialog = page.getByRole("dialog", { name: "Request deletion again for Uncertain repeat?" });
  await dialog.getByRole("button", { name: "Request deletion again", exact: true }).click();
  await page.getByText("Outcome unknown. Deletion may have started.").waitFor();
  assert.equal(await repeat.isDisabled(), true);
  assert.equal(writes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  await page.clock.fastForward(DELETION_POLL_MS * 2);
  assert.equal(
    await repeat.isDisabled(),
    true,
    "a background poll cannot settle this unknown write",
  );
  await page.getByText("Outcome unknown. Deletion may have started.").waitFor();
  assert.equal(writes, 1);
  await page.getByRole("button", { name: "Refresh deletion status", exact: true }).click();
  await repeat.waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll("button")].some(
      (node) => node.textContent === "Request deletion again" && !node.disabled,
    ),
  );
  assert.equal(writes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  await repeat.click();
  dialog = page.getByRole("dialog", { name: "Request deletion again for Uncertain repeat?" });
  const response = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + path && response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Request deletion again", exact: true }).click();
  assert.equal((await response).status(), 202);
  assert.equal(writes, 2);
});

test("Agent deletion recovery returns a missing Agent detail to its Namespace list", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Deleted detail", { ready: true });
  const agentId = `agt_${randomUUID()}`;
  const { page } = await newPage(t, fixture);
  const unavailable = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agentId}` &&
      response.request().method() === "GET",
  );

  await login(page, fixture, `/console/agents/${agentId}?namespace=${namespace.id}`);
  assert.equal((await unavailable).status(), 404);
  await page.getByRole("heading", { name: "Resource unavailable" }).waitFor();
  await page.getByRole("button", { name: "Back to Agents" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/console/agents" && url.searchParams.get("namespace") === namespace.id,
  );
  await page.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
});

test("Agent link without a Namespace opens the Agent in the Namespace that holds it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  // Sorted first, so it is the default selection for a link without a Namespace.
  const selected = await fixture.createNamespace("A link default", { ready: true });
  const holder = await fixture.createNamespace("Z link holder", { ready: true });
  const agent = await fixture.createAgent(holder.id, "Linked Agent", nativeValues("link"));
  const { page } = await newPage(t, fixture);
  const missed = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${selected.id}/agents/${agent.id}` &&
      response.request().method() === "GET",
  );

  await login(page, fixture, `/console/agents/${agent.id}`);
  assert.equal((await missed).status(), 404);
  await page.waitForURL(
    (url) =>
      url.pathname === `/console/agents/${agent.id}` &&
      url.searchParams.get("namespace") === holder.id,
  );
  await page.getByRole("heading", { name: "Linked Agent" }).first().waitFor();
  await expectNoText(page, "may have been deleted");
});

test("Agent link without a Namespace says when no readable Namespace has the Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const selected = await fixture.createNamespace("A missing default", { ready: true });
  const other = await fixture.createNamespace("Z missing other", { ready: true });
  const agentId = `agt_${randomUUID()}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/${agentId}`);
  await page.getByRole("heading", { name: "Agent unavailable" }).waitFor();
  await page.getByText("None of your Namespaces has this Agent", { exact: false }).waitFor();
  const reads = (namespaceId) =>
    requests.filter((request) => request.path === `/namespaces/${namespaceId}/agents/${agentId}`)
      .length;
  assert.equal(reads(selected.id), 1);
  assert.equal(reads(other.id), 1);
  await page.getByRole("button", { name: "Back to Agents" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/console/agents" && url.searchParams.get("namespace") === selected.id,
  );
});

test("Agent link without a Namespace offers switching when the lookup is uncertain", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  await fixture.createNamespace("A uncertain default", { ready: true });
  const other = await fixture.createNamespace("Z uncertain other", { ready: true });
  const agentId = `agt_${randomUUID()}`;
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}/namespaces/${other.id}/agents/${agentId}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "unavailable" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    }),
  );

  await login(page, fixture, `/console/agents/${agentId}`);
  await page.getByRole("heading", { name: "Agent not in this Namespace" }).waitFor();
  await page.getByText("not in the A uncertain default Namespace", { exact: false }).waitFor();
  await expectNoText(page, "may have been deleted");
  await page.getByRole("button", { name: "Switch Namespace" }).click();
  assert.equal(
    await page
      .locator("#namespace-selector")
      .evaluate((node) => node === node.ownerDocument.activeElement),
    true,
    "Switch Namespace focuses the Namespace selector",
  );
});

test("Agent delete denial keeps the Agent visible with permission feedback", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Delete denial", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Denied Candidate", nativeValues("stay"));
  const limited = await fixture.createAccountWithPolicy("agent-delete-denied", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-delete-denied",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-delete-denied",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-delete-denied",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    limited.credentials,
  );
  await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Denied Candidate?" });
  await dialog.getByText(/Agent, its version history, and its workspace data/i).waitFor();
  const denied = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  assert.equal((await denied).status(), 403);

  await page.getByText("You do not have permission to delete this Agent").waitFor();
  await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "active");
});

test("Agent detail opens native admin UI only after real API access checks pass", async (t) => {
  const disabledFixture = await detailApp(t);
  const disabledNamespace = await disabledFixture.createNamespace("Native admin disabled", {
    ready: true,
  });
  const disabledAgent = await disabledFixture.createAgent(
    disabledNamespace.id,
    "Disabled native admin Agent",
    nativeValues("disabled-ui"),
  );
  const disabledRevision = await disabledFixture.seedActiveAgentRevision(
    disabledNamespace.id,
    disabledAgent.id,
  );
  const disabledPage = (await newPage(t, disabledFixture)).page;
  const disabledDetail = detailUrl(
    disabledFixture,
    disabledNamespace.id,
    disabledAgent.id,
    disabledRevision.revision.id,
    "configuration",
  );

  await login(disabledPage, disabledFixture, disabledDetail);
  await disabledPage.getByRole("heading", { name: "Disabled native admin Agent" }).waitFor();
  await expectNativeAdminHidden(disabledPage);

  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const nativeDomain = `agents.${cookieDomain}`;
  const gatewayEndpoint =
    "wss://private-gateway.example.invalid/namespaces/native-admin/agents/agent";
  const fixture = await createConsoleAppFixture(t, {
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver(gatewayEndpoint),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin access", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin Agent",
    nativeValues("unsupported-ui"),
  );
  let { page } = await newPage(t, fixture, {
    args: [
      ...fixture.browserArgs,
      `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1,MAP *.${nativeDomain} 127.0.0.1`,
    ],
  });
  let requests = apiRequests(page, fixture.origin);
  const draftDetail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");

  // A fresh shared-cookie login clears legacy host-only cookies from the Console.
  await page.context().addCookies([
    {
      name: "__Secure-openclaw_occ.session_token",
      value: "old-host-only",
      domain: consoleHost,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await login(page, fixture, draftDetail);
  assert.equal(
    (await page.context().cookies(fixture.origin)).some(
      (cookie) => cookie.value === "old-host-only",
    ),
    false,
  );

  // New Agents are stopped; missing an active revision must not suggest a routing problem.
  const initiallyStopped = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initiallyStopped.status, 200);
  assert.deepEqual(initiallyStopped.data, { status: "stopped" });
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open admin console", exact: true }).isVisible(),
    false,
  );

  // A real deployment requests running before reconciliation selects the admitted revision.
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const unavailable = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.data, { status: "unavailable" });
  await page.getByRole("button", { name: "Refresh access" }).click();
  await page
    .getByText(
      "Native admin UI is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
    )
    .waitFor({ timeout: 5_000 });
  assert.equal(
    await page.getByRole("link", { name: "Open admin console", exact: true }).isVisible(),
    false,
  );

  let active = { revision: pending };
  await fixture.activateRevision(namespace.id, agent.id, pending.id);
  const historicalRevisionId = active.revision.id;
  const initialNativeAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initialNativeAccess.status, 200);
  assert.equal(initialNativeAccess.data.status, "unsupported");
  assert.equal(new URL(initialNativeAccess.data.origin).protocol, "https:");
  const detail = () =>
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await page.goto(detail().href);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("heading", { name: "Gateway administration" }).waitFor();
  await page
    .getByText(
      "Native admin UI is not enabled in this Agent’s current version. Someone who can edit its Configuration can enable it (see the native admin UI guide) and deploy a new version.",
    )
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open admin console", exact: true }).isVisible(),
    false,
  );

  fixture.policy.restrictions.push({
    id: "deny-native-administer",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "administer",
    effect: "deny",
  });
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await expectNativeAdminHidden(page);
  fixture.policy.restrictions.length = 0;
  // The audited denial is settled for this tab; a new tab in the same session asks afresh.
  const deniedTabWrites = nonAuthWriteRequests(requests);
  const browserContext = page.context();
  await page.close();
  page = await browserContext.newPage();
  requests = apiRequests(page, fixture.origin);
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.getByRole("heading", { name: "Gateway administration" }).waitFor();

  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  // Reproduce the state after the worker clears the revision, while this historical URL remains open.
  const cleared = await fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.equal(cleared.activeRevisionId, undefined);
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("heading", { name: "Gateway administration" }).waitFor();
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open admin console", exact: true }).isVisible(),
    false,
  );

  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("supported-ui", initialNativeAccess.data.origin),
  );
  active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.goto(detail().href);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("link", { name: "Open admin console" }).waitFor();
  const expectedAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(expectedAccess.status, 200);
  assert.equal(expectedAccess.data.status, "available");
  assert.equal(expectedAccess.data.activeRevisionId, active.revision.id);
  assert.equal(expectedAccess.data.bootstrapUrl, undefined);
  assert.equal(new URL(expectedAccess.data.url).origin, expectedAccess.data.origin);
  assert.match(new URL(expectedAccess.data.url).hostname, new RegExp(`\\.${nativeDomain}$`));

  // Viewing an older configuration snapshot must still open the current active gateway.
  await page.getByLabel("Available versions").selectOption(historicalRevisionId);
  await page.getByRole("link", { name: "Open admin console" }).waitFor();
  assertRevisionUrl(page, historicalRevisionId);
  assert.equal(
    await page.getByRole("link", { name: "Open admin console" }).getAttribute("href"),
    expectedAccess.data.url,
  );
  const sharedCookies = await page.context().cookies(expectedAccess.data.origin);
  const sessionCookies = sharedCookies.filter((cookie) =>
    cookie.name.endsWith("openclaw_occ_shared.session_token"),
  );
  assert.equal(sessionCookies.length, 1);
  assert.equal(sessionCookies[0].domain, `.${cookieDomain}`);
  assert.equal(sessionCookies[0].httpOnly, true);
  assert.equal(sessionCookies[0].sameSite, "Lax");

  let nativeRequestCookie = "";
  await page.context().route(`${expectedAccess.data.origin}/**`, async (route) => {
    nativeRequestCookie = (await route.request().allHeaders()).cookie ?? "";
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>Native admin UI</title>",
    });
  });

  await page.context().addCookies([
    {
      name: "openclaw_occ.session_token",
      value: "legacy-host-only",
      domain: consoleHost,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const consoleCookies = await page.context().cookies(fixture.origin);
  assert.ok(
    consoleCookies.some(
      (cookie) =>
        cookie.name === "openclaw_occ.session_token" && cookie.value === "legacy-host-only",
    ),
    "the migration fixture must contain the legacy host-only console cookie",
  );
  const agentCookies = await page.context().cookies(expectedAccess.data.origin);
  assert.equal(
    agentCookies.some((cookie) => cookie.value === "legacy-host-only"),
    false,
    "a legacy host-only console cookie must not authenticate the Agent host",
  );

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open admin console" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), expectedAccess.data.url);
  assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
  assert.match(nativeRequestCookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
  assert.doesNotMatch(nativeRequestCookie, /legacy-host-only/);

  assert.deepEqual([...deniedTabWrites, ...nonAuthWriteRequests(requests)], []);
});

test("Agent detail rereads native admin access once when a pending deployment activates", async (t) => {
  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const nativeDomain = `agents.${cookieDomain}`;
  const fixture = await createConsoleAppFixture(t, {
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver(
      "wss://private-gateway.example.invalid/namespaces/native-admin/agents/agent",
    ),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin follow", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin follow Agent",
    nativeValues("follow-ui"),
  );
  // The first deployment requests running before any version is selected for service.
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const nativeAdminPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  const { page } = await newPage(t, fixture, {
    args: [...fixture.browserArgs, `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1`],
  });
  const requests = apiRequests(page, fixture.origin);
  // Deployment activity reads a recorded status the worker would write; the native admin
  // reads stay on the real API so the card reflects the Agent's actual active revision.
  let deploymentStatus = "running";
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, pending.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: pending.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: deploymentStatus,
          error: null,
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_native_admin_follow" },
      }),
    }),
  );
  await page.clock.install({ time: new Date("2026-10-03T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, pending.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Native admin follow Agent" }).waitFor();
  const activity = await expectDeploymentOutcome(page, "In progress");
  const card = page.locator(".native-admin-access");
  await card
    .getByText(
      "Native admin UI is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
    )
    .waitFor();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 1);

  // The worker records success and selects the version for service while the page stays open.
  await fixture.activateRevision(namespace.id, agent.id, pending.id);
  deploymentStatus = "succeeded";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await expectDeploymentOutcome(page, "Completed", { folded: false });
  await card
    .getByText(
      "Native admin UI is not enabled in this Agent’s current version. Someone who can edit its Configuration can enable it (see the native admin UI guide) and deploy a new version.",
    )
    .waitFor();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 2);

  // Access is reread only when the serving version changes: Refresh deployment rereads the
  // unchanged Agent through the same path without asking for native admin access again.
  const agentReads = pathRequests(
    requests,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  ).length;
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await waitForCondition(
    () =>
      pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}`).length >
      agentReads,
    "Refresh deployment did not reread the Agent",
  );
  // The button returns from "Refreshing…" only after the reread Agent was applied.
  await activity.getByRole("button", { name: "Refresh deployment", disabled: false }).waitFor();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 2);
});

for (const [dmPolicy, groupPolicy, enterpriseOrgInstall] of [
  ["pairing", "allowlist"],
  ["open", "open"],
  ["disabled", "disabled"],
  [undefined, undefined],
  ["disabled", "allowlist", true],
]) {
  test(`Slack channel editing preserves ${dmPolicy ?? "omitted"} DM and ${groupPolicy ?? "omitted"} group policies${enterpriseOrgInstall ? " on an organization-wide install" : ""}`, async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace(
      `Slack policy editing ${dmPolicy ?? "omitted"} ${groupPolicy ?? "omitted"}${enterpriseOrgInstall ? " organization" : ""}`,
      { ready: true },
    );
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      ...(enterpriseOrgInstall ? { enterpriseOrgInstall } : {}),
      ...(dmPolicy === undefined ? {} : { dmPolicy }),
      ...(groupPolicy === undefined ? {} : { groupPolicy }),
      allowFrom: dmPolicy === "open" ? ["*"] : ["UKEEP123"],
      channels: { CKEEP123: { requireMention: true, users: ["UKEEP123"] } },
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Slack policy Agent",
      nativeValues("policy-preservation", {
        harnessId: "codex",
        channels: { slack },
      }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
    await login(page, fixture, url);
    const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
    await edit.waitFor();
    assert.equal(await edit.isEnabled(), true);
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    if (enterpriseOrgInstall) {
      // Per-user DM authorization cannot be shared across organization workspaces.
      for (const unsupported of ["pairing", "allowlist"]) {
        await dialog.getByLabel("Direct-message policy").selectOption(unsupported);
        await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
        await dialog
          .getByText(
            "Choose Disabled or Open for direct messages on an organization-wide Slack install.",
          )
          .waitFor();
      }
      const unchanged = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(unchanged.data.values.channels.slack, slack);
      await dialog.getByLabel("Direct-message policy").selectOption("disabled");
    }
    const allowedUsers = dialog.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = dialog.getByLabel("Who can use the agent in these channels?");
    assert.equal(await slackSelectionValue(allowedUsers), "UKEEP123");
    assert.equal(await allowEveryone.inputValue(), "selected");
    await setSlackSelection(
      dialog.getByRole("combobox", { name: "Channels", exact: true }),
      "CKEEP123, CNEW123",
    );
    await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${agent.configurationId}`),
    );
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    // Editing channels must neither widen nor narrow DM/group access, including implicit defaults.
    assert.deepEqual(configuration.data.values.channels.slack, {
      ...slack,
      channels: {
        CKEEP123: { requireMention: false, users: ["UKEEP123"] },
        CNEW123: { requireMention: false, users: ["UKEEP123"] },
      },
    });
    assert.equal(
      configuration.data.values.plugins.entries.knowledge.config.marker,
      "policy-preservation",
    );
  });
}

test("Agent detail refocus checks access once without reloading an unfinished revision edit", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Revision refocus", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Revision refocus Agent",
    nativeValues("before-refocus"),
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).click();
  const editor = page.getByLabel("Configuration JSON", { exact: true });
  const editedValues = nativeValues("after-refocus");
  const editedText = JSON.stringify(editedValues, null, 2);
  await editor.fill(editedText);
  await editor.evaluate((node) => node.setSelectionRange(3, 3));
  const editorNode = await editor.elementHandle();
  const selectorNode = await page.locator(".revision-selector").elementHandle();
  const newNamespace = await fixture.createNamespace("New on refocus", { ready: true });
  assert.equal(
    await page.locator(`#namespace-selector option[value="${newNamespace.id}"]`).count(),
    0,
  );
  const requests = apiRequests(page, fixture.origin);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  let releaseSession;
  const sessionGate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  t.after(() => releaseSession());
  let sessionReached;
  const sessionHeld = new Promise((resolve) => {
    sessionReached = resolve;
  });
  await page.route(`${fixture.origin}/api/auth/session`, async (route) => {
    const response = await route.fetch();
    sessionReached();
    await sessionGate;
    await route.fulfill({ response });
  });

  // One tab return can emit both events. The saved revision and unsaved editor stay mounted
  // while a single access check waits for the real session response.
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
  });
  await sessionHeld;
  assert.equal(pathRequests(requests, "GET", "/api/auth/session").length, 1);
  assert.equal(await selectorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editor.inputValue(), editedText);
  assert.equal(await page.locator('.content [aria-live="polite"][inert]').count(), 1);
  assert.equal(await page.getByText("Loading configuration…", { exact: true }).count(), 0);

  const checkedConfiguration = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${configurationPath}` &&
      response.request().method() === "GET",
  );
  releaseSession();
  await checkedConfiguration;
  // The view stays inert until every access read settles (revisions may answer after the
  // Configuration); only then does the editor get its focus and caret back.
  await page.locator('.content [aria-live="polite"][inert]').waitFor({ state: "detached" });
  assert.equal(pathRequests(requests, "GET", "/namespaces").length, 1);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}`).length,
    1,
  );
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}/revisions`)
      .length,
    1,
  );
  assert.equal(pathRequests(requests, "GET", configurationPath).length, 1);
  assert.equal(
    await page.locator(`#namespace-selector option[value="${newNamespace.id}"]`).count(),
    1,
  );
  assert.equal(await selectorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editor.inputValue(), editedText);
  assert.deepEqual(
    await editor.evaluate((node) => [
      node === node.ownerDocument.activeElement,
      node.selectionStart,
    ]),
    [true, 3],
  );
  assert.equal(await page.getByText("Loading configuration…", { exact: true }).count(), 0);
  await page.unroute(`${fixture.origin}/api/auth/session`);

  // Refocus must not cancel a Configuration save that already reached the browser API.
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  t.after(() => releaseSave());
  let saveReached;
  const saveHeld = new Promise((resolve) => {
    saveReached = resolve;
  });
  await page.route(`${fixture.origin}${configurationPath}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    saveReached();
    await saveGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await saveHeld;
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${configurationPath}` &&
      response.request().method() === "PATCH",
  );
  releaseSave();
  assert.equal((await saved).status(), 200);
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "after-refocus"').waitFor();
  assert.equal(pathRequests(requests, "PATCH", configurationPath).length, 1);
});

for (const kind of ["agent", "configuration", "namespace"]) {
  test(`Agent detail refocus removes a revision when ${kind} access is revoked`, async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace(`Revision access revoked ${kind}`, {
      ready: true,
    });
    const agent = await fixture.createAgent(namespace.id, "Revoked revision Agent");
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
    await login(page, fixture, url);
    await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
    fixture.policy.restrictions.push({
      id: `deny-focused-${kind}-read`,
      namespaceId: namespace.id,
      resourceKind: kind,
      ...(kind === "namespace"
        ? {}
        : { resourceId: kind === "agent" ? agent.id : agent.configurationId }),
      action: "read",
      effect: "deny",
    });

    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await page
      .getByRole("heading", {
        name: kind === "namespace" ? "Namespace unavailable" : "Access denied",
        exact: true,
      })
      .waitFor();
    await expectNoText(page, /Configuration draft|Create new version|Revoked revision Agent/);
  });
}

test("Agent detail refocus clears a revision after session expiry", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision session expired", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Expired revision Agent");
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }

  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await expectNoText(page, /Configuration draft|Create new version|Expired revision Agent/);
});

// Agent detail rechecks in place, so a mounted form must not suppress the refocus check.
for (const variant of ["credentials", "workspace", "sharing"]) {
  test(`Agent detail refocus clears the ${variant} view after session expiry`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Refocus ${variant}`, { ready: true });
    const agent = await fixture.createAgent(
      namespace.id,
      `Refocus ${variant} Agent`,
      nativeValues(variant),
    );
    let revision = "draft";
    if (variant === "workspace") {
      revision = (await fixture.seedActiveAgentRevision(namespace.id, agent.id)).revision.id;
    }
    const tab = variant === "sharing" ? "access" : variant;
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, revision, tab);
    await login(page, fixture, url);
    await page.getByRole("heading", { name: `Refocus ${variant} Agent` }).waitFor();
    if (variant === "sharing") {
      const panel = page.getByRole("region", { name: "Share Agent", exact: true });
      await panel.getByLabel("Existing person’s Principal ID").fill("typed-principal");
    } else {
      await page.locator(".content form:not(.agent-access-form)").first().waitFor();
    }
    for (const session of fixture.memoryDatabase.session) {
      session.expiresAt = new Date(Date.now() - 1000);
    }

    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await page.getByText("Your session has expired").waitFor();
    await expectNoText(page, new RegExp(`Refocus ${variant} Agent`));
  });
}

test("Agent detail history navigation rechecks session during refocus", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision history refocus", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "History refocus Agent");
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();

  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  t.after(() => releaseSession());
  let sessionReached;
  const held = new Promise((resolve) => {
    sessionReached = resolve;
  });
  let checks = 0;
  await page.route(`${fixture.origin}/api/auth/session`, async (route) => {
    if (++checks === 1) {
      sessionReached();
      await gate;
    }
    try {
      await route.continue();
    } catch {
      // The route is closed when navigation aborts the first access check.
    }
  });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await held;
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  await page.goBack();
  await page.getByText("Your session has expired").waitFor();
  await expectNoText(page, /Configuration draft|Create new version|History refocus Agent/);
  releaseSession();
});

test("Agent tabs replace only their content and preserve surrounding panels and history", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Tab navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Tab navigation Agent",
    nativeValues("tabs"),
  );
  const { page } = await newPage(t, fixture);
  await page.setViewportSize({ width: 1200, height: 650 });
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  // Late reads (for example the sharing policy) change the page height; measure after them.
  await waitForIdleFetches(page);
  await page.getByRole("tab", { name: "Channels", exact: true }).scrollIntoViewIfNeeded();
  const agentActions = await page.locator(".agent-toolbar-actions").elementHandles();
  assert.equal(agentActions.length, 1, "Agent detail mounted its page actions");
  const panels = await page
    .locator("h1, .native-admin-access, .revision-selector, .agent-tabs")
    .elementHandles();
  const top = await page.evaluate(() => globalThis.scrollY);
  requests.length = 0;

  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "channels");
  // The surrounding DOM must stay mounted; a fast full-page rerender still loses focus and scroll.
  for (const panel of [...agentActions, ...panels]) {
    assert.equal(await panel.evaluate((node) => node.isConnected), true);
  }
  assert.ok(Math.abs((await page.evaluate(() => globalThis.scrollY)) - top) < 2);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const secret = page.getByLabel("API key Secret");
  await secret.waitFor();
  // A tab is kept for Back only if its reads (here the Secret list) finished before leaving it.
  await waitForIdleFetches(page);
  const secretElement = await secret.elementHandle();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page
    .getByText(
      "Workspace files require a deployed Agent with a current version and a reachable gateway.",
    )
    .waitFor();
  assert.equal(await secretElement.evaluate((node) => node.isConnected), false);
  await page.goBack();
  await page.getByLabel("API key Secret").waitFor();
  assert.equal(
    await secretElement.evaluate((node) => node.isConnected),
    true,
    "Returning to Credentials preserves the loaded controls",
  );
  assert.equal(new URL(page.url()).searchParams.get("tab"), "credentials");
  await page.goForward();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  for (const panel of panels) {
    assert.equal(await panel.evaluate((node) => node.isConnected), true);
  }
  assert.deepEqual(
    requests.filter((request) =>
      [
        "/api/auth/session",
        "/namespaces",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      ].includes(request.path),
    ),
    [],
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // Refresh is still explicit and rereads the page, unlike a tab change.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  assert.equal(await panels[0].evaluate((node) => node.isConnected), false);
});

test("Agent tab switches ignore late configuration reads and keep direct workspace access independent", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Slow tabs", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Slow tab Agent",
    nativeValues("slow-tabs"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "workspace");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Agent workspace", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Versions", exact: true }).waitFor();
  // The empty Deployment activity card is read but hidden: the facts already say it (UX spec 3.7).
  const noRecords = page.getByText("No readable deployment records.");
  await noRecords.waitFor({ state: "attached" });
  assert.equal(await noRecords.isHidden(), true);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.equal(
    requests.some((request) => request.path === configurationPath),
    false,
  );
  assert.equal(
    requests.some((request) => request.path.endsWith("/revisions")),
    true,
  );
  const tabs = await page.locator(".agent-tabs").elementHandle();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let reached;
  const held = new Promise((resolve) => {
    reached = resolve;
  });
  // Delay a real authorized response to exercise navigation while the first panel read is pending.
  await page.route(`${fixture.origin}${configurationPath}`, async (route) => {
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await held;
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  const delivered = page.waitForResponse(`${fixture.origin}${configurationPath}`);
  release();
  await delivered;
  // Configuration completion may prepare shared controls, but must not replace the live workspace view.
  await page.getByRole("heading", { name: "Agent workspace", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Workspace files", exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Configure Slack", exact: true }).count(), 0);
  assert.equal(await tabs.evaluate((node) => node.isConnected), true);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  assert.equal(requests.filter((request) => request.path === configurationPath).length, 1);
});

// The version tabs were a row of buttons, each its own Tab stop, with no tab semantics (UX plan
// C7). They are a tablist: the selected tab is the list's one Tab stop, Left/Right (wrapping) and
// Home/End move focus without opening a tab, Enter opens the focused one, Tab leaves the list
// and Shift+Tab returns to the selected tab, and aria-selected follows the URL's tab=, Back
// included. On a phone an edge with more tabs past it fades.
test("Agent tabs are a tablist with arrow keys, one Tab stop and the URL's selection", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Tab keyboard", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Tab keyboard Agent", nativeValues("keys"));
  const { page } = await newPage(t, fixture);
  await page.setViewportSize({ width: 1200, height: 800 });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  const list = page.getByRole("tablist", { name: "Agent configuration views" });
  await list.waitFor();
  const names = [
    "Configuration",
    "Plugins",
    "Channels",
    "Repositories",
    "Credentials",
    "Workspace files",
    "Policy denials",
    "Access",
  ];
  assert.deepEqual(await list.getByRole("tab").allTextContents(), names);
  // Which tab is selected, which one is the Tab stop, which has focus, and the URL's tab=.
  const state = () =>
    page.evaluate(() => {
      const document = globalThis.document;
      const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
      const panel = document.querySelector('[role="tabpanel"]');
      return {
        selected: tabs
          .filter((tab) => tab.getAttribute("aria-selected") === "true")
          .map((tab) => tab.textContent),
        stops: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.textContent),
        focused: document.activeElement.closest('[role="tablist"]')
          ? document.activeElement.textContent
          : null,
        panel: document.getElementById(panel.getAttribute("aria-labelledby"))?.textContent,
        controls: tabs.every((tab) => tab.getAttribute("aria-controls") === panel.id),
        tab: new URL(globalThis.location.href).searchParams.get("tab"),
      };
    });
  const expect = async (expected, message) =>
    assert.deepEqual(
      await state(),
      { panel: expected.selected[0], controls: true, ...expected },
      message,
    );
  await expect({ selected: ["Plugins"], stops: ["Plugins"], focused: null, tab: "plugins" });

  await list.getByRole("tab", { name: "Plugins", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    { selected: ["Plugins"], stops: ["Channels"], focused: "Channels", tab: "plugins" },
    "Right moves focus only",
  );
  for (const [key, focused] of [
    ["ArrowLeft", "Plugins"],
    ["ArrowLeft", "Configuration"],
    ["ArrowLeft", "Access"],
    ["ArrowRight", "Configuration"],
    ["End", "Access"],
    ["Home", "Configuration"],
  ]) {
    await page.keyboard.press(key);
    await expect(
      { selected: ["Plugins"], stops: [focused], focused, tab: "plugins" },
      `${key} to ${focused}`,
    );
  }
  // One Tab stop: Tab leaves the list, and Shift+Tab comes back to the selected tab.
  await page.keyboard.press("Tab");
  await expect({ selected: ["Plugins"], stops: ["Plugins"], focused: null, tab: "plugins" });
  await page.keyboard.press("Shift+Tab");
  await expect({ selected: ["Plugins"], stops: ["Plugins"], focused: "Plugins", tab: "plugins" });

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForURL("**tab=channels**");
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  await expect({
    selected: ["Channels"],
    stops: ["Channels"],
    focused: "Channels",
    tab: "channels",
  });
  await page.goBack();
  await page.waitForURL("**tab=plugins**");
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ===
      "Plugins",
  );
  const back = await state();
  // Focus was in the strip, so it follows the selection back to Plugins.
  assert.deepEqual(back, {
    selected: ["Plugins"],
    stops: ["Plugins"],
    focused: "Plugins",
    panel: "Plugins",
    controls: true,
    tab: "plugins",
  });

  // On a phone the strip scrolls sideways; the edge with more tabs past it fades, from the first
  // paint of a page whose selected tab needs no scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
  await list.waitFor();
  const strip = page.locator(".agent-tabs");
  const edges = () =>
    strip.evaluate((node) => ({
      before: node.hasAttribute("data-more-before"),
      after: node.hasAttribute("data-more-after"),
      masked: globalThis.getComputedStyle(node).maskImage !== "none",
    }));
  await page.waitForFunction(() =>
    globalThis.document.querySelector(".agent-tabs").hasAttribute("data-more-after"),
  );
  assert.deepEqual(await edges(), { before: false, after: true, masked: true });
  // Back moves focus with the selection, and a focused tab stays in view when the strip
  // resizes, rather than the strip scrolling back to the selected tab.
  const focusedInView = () =>
    page.evaluate(() => {
      const tab = globalThis.document.activeElement;
      const strip = tab.closest('[role="tablist"]')?.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      return {
        name: tab.textContent,
        inView: Boolean(strip) && box.left >= strip.left - 1 && box.right <= strip.right + 1,
      };
    });
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
        }),
    );
  await list.getByRole("tab", { name: "Configuration", exact: true }).focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForURL("**tab=access**");
  await page.goBack();
  await page.waitForURL("**tab=configuration**");
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ===
      "Configuration",
  );
  await frames();
  assert.deepEqual(await focusedInView(), { name: "Configuration", inView: true }, "after Back");
  // An arrowed-to tab that is not selected stays in view through a resize.
  await page.keyboard.press("End");
  await page.setViewportSize({ width: 360, height: 844 });
  await frames();
  assert.deepEqual(await focusedInView(), { name: "Access", inView: true }, "after resize");
  await page.setViewportSize({ width: 390, height: 844 });
  await strip.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
  });
  await page.waitForFunction(() =>
    globalThis.document.querySelector(".agent-tabs").hasAttribute("data-more-before"),
  );
  assert.deepEqual(await edges(), { before: true, after: false, masked: true });
  // Include enough desktop width for the additional policy tab to fit without scrolling.
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.waitForFunction(() => {
    const node = globalThis.document.querySelector(".agent-tabs");
    return !node.hasAttribute("data-more-before") && !node.hasAttribute("data-more-after");
  });
  assert.equal((await edges()).masked, false, "a strip that fits does not fade");
});

test("Agent sharing grants existing people exact discovery and native access, then removes only the selected binding", async (t) => {
  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["shared-person"],
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: {
      enabled: true,
      domain: `agents.${cookieDomain}`,
      sharedCookieDomain: cookieDomain,
    },
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/shared"),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Shared workspace", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Shared research Agent",
    nativeValues("shared"),
  );
  const sibling = await fixture.createAgent(
    namespace.id,
    "Private sibling",
    nativeValues("private"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const native = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("shared", native.data.origin),
  );
  const active = await fixture.seedActiveAgentRevision(
    namespace.id,
    agent.id,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .activeRevisionId,
  );
  const person = fixture.provisionedAccounts[0];
  const session = await fixture.signIn(person.credentials);
  assert.deepEqual((await fixture.request("GET", "/namespaces", { session })).data, []);
  const policyPath = `/namespaces/${namespace.id}/iam`;
  // A familiar display name must never substitute for the required exact permission set.
  const misleadingRole = await fixture.request("POST", `${policyPath}/roles`, {
    body: {
      name: "Agent native administration",
      permissions: [{ action: "delete", resourceKind: "agent" }],
    },
  });
  assert.equal(misleadingRole.status, 201);
  const browserOptions = {
    args: [...fixture.browserArgs, `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1`],
  };
  const { page, artifacts } = await newPage(t, fixture, browserOptions);
  const detail = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-granted.png") });
  const bindings = (await fixture.request("GET", `${policyPath}/access-bindings`)).data;
  assert.equal(bindings.length, 2);
  assert.equal(
    bindings.some((binding) => binding.roleId === misleadingRole.data.id),
    false,
  );
  assert.deepEqual(bindings.map((binding) => [binding.resourceKind, binding.resourceId]).sort(), [
    ["agent", agent.id],
    ["namespace", namespace.id],
  ]);
  assert.deepEqual(
    (await fixture.request("GET", "/namespaces", { session })).data.map((item) => item.id),
    [namespace.id],
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data.map(
      (item) => item.id,
    ),
    [agent.id],
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${sibling.id}`, { session }))
      .status,
    403,
  );
  assert.equal(
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        { session },
      )
    ).status,
    403,
  );
  assert.equal((await fixture.request("GET", `${policyPath}/roles`, { session })).status, 403);
  assert.equal(
    (
      await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`, {
        session,
      })
    ).data.status,
    "available",
  );

  const recipient = (await newPage(t, fixture, browserOptions)).page;
  const recipientRequests = apiRequests(recipient, fixture.origin);
  await login(recipient, fixture, detail, person.credentials);
  // Agent sharing does not include version read, so the version pane says so.
  await recipient.getByRole("heading", { name: "You cannot read this version" }).waitFor();
  // The policy reads are denied, so the sharing card is hidden instead of showing an error.
  await recipient.locator(".agent-access").waitFor({ state: "hidden" });
  assert.equal(
    await recipient
      .getByText("Sharing policy requires Installation administration.", { exact: false })
      .count(),
    0,
  );
  await recipient.getByRole("link", { name: "Open admin console" }).waitFor();
  // A non-administrator never reads sharing policy: each denial would be audited. The link to
  // the Access tab opens Configuration, and the strip has no Access tab.
  assert.equal(
    await recipient.getByRole("region", { name: "Share Agent", exact: true }).count(),
    0,
  );
  assert.equal(await recipient.getByRole("tab", { name: "Access" }).count(), 0);
  await recipient.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  assert.deepEqual(
    recipientRequests.filter((request) => request.path.includes("/iam/")),
    [],
  );
  await recipient.screenshot({
    path: join(artifacts, "agent-sharing-recipient.png"),
    fullPage: true,
  });
  // Stop has its own permission. Grant it separately through the real policy API.
  assert.equal(
    (
      await fixture.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`, {
        session,
      })
    ).status,
    403,
  );
  const operateRole = await fixture.request("POST", `${policyPath}/roles`, {
    body: { permissions: [{ action: "operate", resourceKind: "agent" }] },
  });
  const operateBinding = await fixture.request("POST", `${policyPath}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: person.principal.id,
      roleId: operateRole.data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
  });
  assert.equal(operateBinding.status, 201);
  // Stop was granted independently; reloading obtains the new advice without granting version read.
  const refreshedAdvice = recipient.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}/permissions`),
  );
  await recipient.reload();
  const advice = await refreshedAdvice;
  assert.equal(advice.status(), 200);
  assert.equal((await advice.json()).data.operate, true);
  await recipient.getByRole("heading", { name: "You cannot read this version" }).waitFor();
  await recipient.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await recipient
    .getByRole("dialog")
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  await recipient.getByText("Stop requested. OCC will not start", { exact: false }).waitFor();

  // The stale administrator list holds the specific sharing binding, not the new operate grant.
  await panel.getByRole("button", { name: "Remove binding", exact: true }).click();
  await panel.getByText("Binding removed.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-removed.png") });
  const after = (await fixture.request("GET", `${policyPath}/access-bindings`)).data;
  assert.deepEqual(
    after.map((binding) => binding.id).sort(),
    [
      bindings.find((binding) => binding.resourceKind === "namespace").id,
      operateBinding.data.id,
    ].sort(),
  );
  assert.deepEqual(
    (await fixture.request("GET", "/namespaces", { session })).data.map((item) => item.id),
    [namespace.id],
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data,
    [],
  );
  assert.equal(
    (
      await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`, {
        session,
      })
    ).status,
    403,
  );
});

test("Agent sharing reconciles a truncated committed response without replaying writes", async (t) => {
  let loseAgentBindingResponse = true;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["response-recipient"],
    async onSend(request, reply, payload) {
      if (
        loseAgentBindingResponse &&
        request.method === "POST" &&
        request.url.endsWith("/iam/access-bindings") &&
        reply.statusCode === 201 &&
        JSON.parse(payload).data.resourceKind === "agent"
      ) {
        // Truncate only the response after the real route committed its grant.
        loseAgentBindingResponse = false;
        return payload.slice(0, 8);
      }
      return payload;
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing recovery");
  const agent = await fixture.createAgent(namespace.id, "Recovery Agent", nativeValues("recovery"));
  const person = fixture.provisionedAccounts[0];
  const { page, artifacts } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Outcome unknown.", { exact: false }).waitFor();
  await panel.getByText("Namespace discovery is enabled.", { exact: true }).waitFor();
  await panel.getByText("Direct grants need a fresh read.", { exact: false }).waitFor();
  assert.equal(await panel.getByText("No direct Agent grants.", { exact: true }).count(), 0);
  assert.equal(
    await panel.getByRole("button", { name: "Share Agent", exact: true }).isDisabled(),
    true,
  );
  await panel.screenshot({ path: join(artifacts, "agent-sharing-unknown.png") });
  const writes = () =>
    nonAuthWriteRequests(requests).filter((request) => request.path.includes("/iam/"));
  assert.equal(writes().length, 4);
  const session = await fixture.signIn(person.credentials);
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data.map(
      (item) => item.id,
    ),
    [agent.id],
  );
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await panel.getByText("Current policy loaded.", { exact: false }).waitFor();
  assert.equal(writes().length, 4);
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  assert.equal(writes().length, 4);
  const policyPath = `/namespaces/${namespace.id}/iam`;
  assert.equal((await fixture.request("GET", `${policyPath}/roles`)).data.length, 2);
  assert.equal((await fixture.request("GET", `${policyPath}/access-bindings`)).data.length, 2);
  // A sharing read must preserve global expiry handling, including private panel removal.
  for (const savedSession of fixture.memoryDatabase.session) {
    savedSession.expiresAt = new Date(Date.now() - 1000);
  }
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await panel.count(), 0);
});

test("a read-only viewer is denied saved settings and native admin once per tab, not per view", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Read-only detail");
  const agent = await fixture.createAgent(namespace.id, "Viewed Agent", nativeValues("viewed"));
  const viewer = await fixture.createAccountWithPolicy("agent-viewer", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-viewer",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-viewer",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-viewer",
    });
  });
  const denials = (action) =>
    auditSink
      .list()
      .filter((event) => event.kind === "authorization_denial" && event.action === action).length;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await trackSettledFetches(page);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, detail, viewer.credentials);
  const unavailable = page.getByRole("heading", { name: "Configuration unavailable" });
  await unavailable.waitFor();
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const nativeAdminPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  const reads = (path) => requests.filter((request) => request.path === path).length;
  // The tab remembers a denial only once the page has read it; a reload drops a pending read.
  await waitForSettledFetches(page, nativeAdminPath, 1);
  assert.equal(reads(nativeAdminPath), 1);
  assert.equal(reads(configurationPath), 1);
  // The card settles on the denial and stays hidden: a 403 is not a failed read with Refresh.
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(".native-admin-access [role='status']")?.textContent === "",
  );
  assert.equal(await page.locator(".native-admin-access:not([hidden])").count(), 0);

  // Each denied read is an audited authorization denial; reloading the view does not repeat it.
  for (let view = 0; view < 2; view += 1) {
    await page.reload();
    await unavailable.waitFor();
  }
  // The native admin card asks for status as it renders, before the denial panel shows.
  await settlePageRequests(page);
  assert.equal(reads(configurationPath), 1);
  assert.equal(reads(nativeAdminPath), 1);
  assert.equal(denials("openclaw.configurations.read"), 1);
  assert.equal(denials("openclaw.agents.native_admin.read"), 1);
  await page.getByText("Retry checks your access again", { exact: false }).waitFor();
  assert.equal(await page.locator(".native-admin-access:not([hidden])").count(), 0);

  // Retry asks again, so a real denial after a grant change is never hidden.
  await page.getByRole("button", { name: "Retry" }).click();
  await unavailable.waitFor();
  // Fetch tracking restarted at the last reload; the request log still spans both reads.
  await waitForSettledFetches(page, configurationPath, 1);
  assert.equal(reads(configurationPath), 2);
  assert.equal(denials("openclaw.configurations.read"), 2);
});

test("a failed native admin status read keeps the card, its error and Refresh access", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Native admin outage", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Outage Agent", nativeValues("outage"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const nativeAdminPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  let failures = 1;
  await page.route(`${fixture.origin}${nativeAdminPath}`, async (route) => {
    if (failures > 0) {
      failures -= 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "A required platform dependency is unavailable.",
          },
          meta: { requestId: "req_test_native_admin_outage" },
        }),
      });
      return;
    }
    await route.continue();
  });
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, detail);
  await page.getByRole("heading", { name: "Outage Agent" }).waitFor();

  // An outage is not a denial: the card stays, names the failure and can be retried.
  const card = page.locator(".native-admin-access");
  await card.getByRole("alert").getByText("Service unavailable", { exact: false }).waitFor();
  assert.equal(await card.isVisible(), true);
  const reload = card.getByRole("button", { name: "Refresh access" });
  assert.equal(await reload.isEnabled(), true);

  // A later answer still decides visibility: this Installation has native admin disabled.
  const reads = () => requests.filter((request) => request.path === nativeAdminPath).length;
  const before = reads();
  await reload.click();
  await waitForCondition(() => reads() === before + 1, "native admin status reread");
  await card.waitFor({ state: "hidden" });
  await expectNativeAdminHidden(page);
});

test("Agent sharing rejects emails locally and names an unknown Principal ID", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Sharing subject checks");
  const agent = await fixture.createAgent(namespace.id, "Subject Agent", nativeValues("subject"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  const principal = panel.getByLabel("Existing person’s Principal ID");
  const writes = () =>
    nonAuthWriteRequests(requests).filter((request) => request.path.includes("/iam/"));
  await principal.fill("carol@example.invalid");
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("not an email address", { exact: false }).waitFor();
  assert.equal(writes().length, 0);

  await principal.fill("prn_00000000-0000-4000-8000-000000000000");
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel
    .getByText("No existing person with that Principal ID can be granted access here", {
      exact: false,
    })
    .waitFor();
  assert.equal(await panel.getByText("Resource unavailable", { exact: false }).count(), 0);
  const bindings = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.deepEqual(bindings.data, []);
});

test("Agent sharing creates exact Roles instead of reusing strict superset Roles", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["superset-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Superset sharing");
  const agent = await fixture.createAgent(namespace.id, "Superset Agent", nativeValues("superset"));
  const person = fixture.provisionedAccounts[0];
  const policyPath = `/namespaces/${namespace.id}/iam`;
  // Each superset contains every permission sharing needs, plus one it must not grant.
  const supersets = [];
  for (const permissions of [
    [
      { action: "read", resourceKind: "agent" },
      { action: "administer", resourceKind: "agent" },
      { action: "delete", resourceKind: "agent" },
    ],
    [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "secret" },
    ],
  ]) {
    const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    supersets.push(role.data.id);
  }
  const { page } = await newPage(t, fixture);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();

  const roles = (await fixture.request("GET", `${policyPath}/roles`)).data;
  assert.equal(roles.length, 4, "sharing must add two exact Roles beside the supersets");
  const bindings = (await fixture.request("GET", `${policyPath}/access-bindings`)).data;
  assert.equal(bindings.length, 2);
  const grantPermissions = (resourceKind) => {
    const binding = bindings.find((candidate) => candidate.resourceKind === resourceKind);
    assert.equal(supersets.includes(binding.roleId), false, `${resourceKind} reused a superset`);
    return roles
      .find((role) => role.id === binding.roleId)
      .permissions.map((permission) => `${permission.action}:${permission.resourceKind}`)
      .sort();
  };
  assert.deepEqual(grantPermissions("namespace"), ["read:namespace"]);
  assert.deepEqual(grantPermissions("agent"), ["administer:agent", "read:agent"]);
  const session = await fixture.signIn(person.credentials);
  assert.equal(
    (
      await fixture.request("DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        session,
      })
    ).status,
    403,
  );
});

for (const method of ["api_key", "codex_pat"]) {
  test(`Credentials grants exact Agent access when rebinding ${method}`, async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace(`Model credential replacement ${method}`, {
      ready: true,
    });
    const agent = await fixture.createAgent(
      namespace.id,
      "Credential Agent",
      createHarnessConfiguration("codex", "gpt-4.1"),
      { executionMode: "dedicated" },
    );
    const replacement = await fixture.createSecret(
      namespace.id,
      "Replacement model credential",
      "test-replacement-token",
    );
    const unrelated = await fixture.createSecret(
      namespace.id,
      "Unrelated credential",
      "test-unrelated-token",
    );
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByLabel("Authentication source").selectOption(method);
    await selectSecret(
      page,
      method === "api_key" ? "API key Secret" : "Service account token Secret",
      replacement,
    );
    await page.getByRole("button", { name: "Save authentication source" }).click();
    // Wait for the real IAM write and the refreshed form, not just the earlier Agent PATCH.
    await page.waitForFunction(
      () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
    );
    const bindings = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/iam/access-bindings`,
    );
    const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
    const grants = bindings.data.filter(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
    );
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0], {
      id: grants[0].id,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: grants[0].roleId,
      resourceKind: "secret",
      resourceId: replacement.id,
    });
    assert.deepEqual(roles.data.find((role) => role.id === grants[0].roleId).permissions, [
      { action: "operate", resourceKind: "secret" },
    ]);
    assert.equal(
      bindings.data.some((binding) => binding.resourceId === unrelated.id),
      false,
    );
    const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.deepEqual(saved.data.harnessAuth, { method, source: replacement.ref });
    // Saving the same source again repairs missing access and reuses an existing exact binding.
    await page.getByRole("button", { name: "Save authentication source" }).click();
    await page.waitForFunction(
      () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
    );
    assert.deepEqual(
      (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data,
      bindings.data,
    );
  });
}

test("Credentials retries denied and interrupted grants without repeating the authentication save", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential access recovery", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Recovery Agent",
    createHarnessConfiguration("codex", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement credential",
    "test-retry-token",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const bindingsPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  // Native IAM denies the actor's grant authority while the Agent update remains authorized.
  fixture.policy.restrictions.push({
    id: "deny-update-credential-grant",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  await page.getByLabel("Authentication source").selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", replacement);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText(/Authentication source saved, but this Agent's Secret access could not be confirmed/)
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", bindingsPath).length, 0);
  assert.equal(
    (await fixture.request("GET", agentPath)).data.harnessAuth.source.id,
    replacement.id,
  );
  // A partial save survives navigation without repeating PATCH or enabling deployment.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Retry credential access" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-update-credential-grant"),
    1,
  );
  // Commit the binding through the real API, then lose only its response. Read-before-create makes retry safe.
  await page.route(`**${bindingsPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.getByText(/Secret access could not be confirmed.*Request interrupted/).waitFor();
  await page.unroute(`**${bindingsPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.getByRole("button", { name: "Save authentication source" }).waitFor();
  const grants = (await fixture.request("GET", bindingsPath)).data.filter(
    (binding) => binding.resourceId === replacement.id,
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].subjectId, agent.servicePrincipalId);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
  assert.equal(pathRequests(requests, "POST", bindingsPath).length, 1);
});

test("Credentials blocks repeat saves after losing an authentication PATCH response", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Unknown credential save", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Unknown save Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement credential",
    "test-unknown-token",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  // Issued ChatGPT service accounts are a Codex-only PAT source.
  await page.getByLabel("Authentication source", { exact: true }).waitFor();
  assert.deepEqual(
    await page
      .getByLabel("Authentication source", { exact: true })
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["", "api_key", "runtime"],
  );
  await page.route(`**${agentPath}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  await page.getByLabel("Authentication source").selectOption("api_key");
  await selectSecret(page, "API key Secret", replacement);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .locator("form.agent-card")
    .getByText(/Outcome unknown/)
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save authentication source" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/iam/access-bindings`).length,
    0,
  );
  // Explicit reload recovers the committed source; saving it again confirms the missing grant.
  await page.unroute(`**${agentPath}`);
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
  );
  await waitForInputValue(page.getByLabel("API key Secret"), secretOptionLabel(replacement));
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data.some(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
    ),
    true,
  );
});

// Each workspace editor also stays disabled until its own file read lands.
async function waitForWorkspaceEditors(page, names) {
  await waitForLiveControls(
    page,
    names.map((name) => `workspace-${name}`),
  );
}

test("live workspace drafts survive navigation, stay Agent-scoped, and clear on explicit reload or save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "console-workspace-drafts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Exercise the real Console, Fastify, and IAM paths with disk-backed file transport.
  // This checks UI navigation and file requests, not a live Agent gateway.
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ revision, filename }) {
        return {
          status: "ok",
          file: {
            name: filename,
            content: await readFile(join(root, revision.agentId, filename), "utf8"),
          },
        };
      },
      async write({ revision, filename, content }) {
        await writeFile(join(root, revision.agentId, filename), content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Workspace draft owner",
    nativeValues("workspace"),
  );
  const other = await fixture.createAgent(
    namespace.id,
    "Other workspace Agent",
    nativeValues("other"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.seedActiveAgentRevision(namespace.id, other.id);
  for (const owner of [agent, other]) {
    await mkdir(join(root, owner.id));
    for (const name of Object.keys(WORKSPACE_DEFAULTS)) {
      await writeFile(join(root, owner.id, name), `# Saved ${name}\n`);
    }
  }
  // Textareas show CRLF as LF; an untouched read must not enable Save or write.
  const original = "# Saved AGENTS.md\r\n# Windows instructions\r\n";
  await writeFile(join(root, agent.id, "AGENTS.md"), original);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace");
  await login(page, fixture, url);
  await waitForWorkspaceEditors(page, ["AGENTS.md", "USER.md"]);
  const file = page.getByLabel("AGENTS.md", { exact: true });
  assert.equal(await file.inputValue(), original.replaceAll("\r\n", "\n"));
  assert.equal(
    await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).isEnabled(),
    false,
  );
  assert.equal(
    await page.getByRole("button", { name: "Save USER.md", exact: true }).isEnabled(),
    false,
  );
  assert.equal(await readFile(join(root, agent.id, "AGENTS.md"), "utf8"), original);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await file.fill("# Unsaved instructions\n");
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await waitForWorkspaceEditors(page, ["AGENTS.md", "USER.md"]);
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Other workspace Agent", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(await file.inputValue(), "# Saved AGENTS.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByLabel("Search Agents").fill("Workspace draft owner");
  await page.getByRole("link", { name: "Workspace draft owner", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await waitForWorkspaceEditors(page, ["AGENTS.md"]);
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/workspace/files/AGENTS.md"),
  );
  await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal(
    await readFile(join(root, agent.id, "AGENTS.md"), "utf8"),
    "# Unsaved instructions\n",
  );
  await page.getByRole("button", { name: "Reload USER.md", exact: true }).click();
  await page.getByText("USER.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  assert.equal(await page.getByLabel("Search Agents").inputValue(), "Workspace draft owner");
  await page.goBack();
  await waitForWorkspaceEditors(page, ["AGENTS.md", "USER.md"]);
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
});

// Workspace files are live Agent data. A deployment that finishes while a reader types must not
// rebuild the editors: the old remount dropped focus and caret and flashed the editors disabled
// (finding 1836). Files without unsaved edits are still reread from the new current version.
test("a deployment finishing on the poll keeps a typing reader's Workspace editor and rereads unchanged files", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ revision, filename }) {
        const content =
          filename === "AGENTS.md"
            ? `# Saved ${filename}\n`
            : `# ${filename} served by ${revision.id}\n`;
        return { status: "ok", file: { name: filename, content } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace deploy poll", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Workspace typist", nativeValues("ws"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  let status = "running";
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, second.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: second.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status,
          error: null,
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_workspace_poll" },
      }),
    }),
  );
  await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "workspace"),
  );
  await waitForWorkspaceEditors(page, ["AGENTS.md", "SOUL.md", "USER.md"]);
  const soul = page.getByLabel("SOUL.md", { exact: true });
  const user = page.getByLabel("USER.md", { exact: true });
  assert.equal(await soul.inputValue(), `# SOUL.md served by ${first.revision.id}\n`);
  assert.equal(await user.inputValue(), `# USER.md served by ${first.revision.id}\n`);
  const soulEditor = await soul.elementHandle();
  // The reread of USER.md is held until the reader has typed in it.
  const userPath = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`;
  const userReread = await holdRequests(t, page, `${fixture.origin}${userPath}`, { once: true });
  await expectDeploymentOutcome(page, "In progress");

  // The reader is typing in AGENTS.md with a selection in the middle of the text.
  const file = page.getByLabel("AGENTS.md", { exact: true });
  const typed = "# Draft instructions\n# Second line\n";
  await file.fill(typed);
  const editor = await file.elementHandle();
  await editor.evaluate((node) => {
    node.focus();
    node.setSelectionRange(8, 20);
    globalThis.workspaceBlurs = 0;
    globalThis.workspaceDisabled = 0;
    node.addEventListener("blur", () => (globalThis.workspaceBlurs += 1));
    new globalThis.MutationObserver(() => {
      if (node.disabled) {
        globalThis.workspaceDisabled += 1;
      }
    }).observe(node, { attributes: true, attributeFilter: ["disabled"] });
  });

  // The worker finishes the deployment; the next poll reads it and the new current version.
  await fixture.activateRevision(namespace.id, agent.id, second.id, first.revision.id);
  status = "succeeded";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await expectDeploymentOutcome(page, "Completed", { folded: false });
  await waitForInputValue(soul, `# SOUL.md served by ${second.id}\n`);
  await userReread.requested;

  assert.deepEqual(
    await editor.evaluate((node) => ({
      connected: node.isConnected,
      focused: node.ownerDocument.activeElement === node,
      selection: [node.selectionStart, node.selectionEnd],
      value: node.value,
      blurs: globalThis.workspaceBlurs,
      disabled: globalThis.workspaceDisabled,
    })),
    {
      connected: true,
      focused: true,
      selection: [8, 20],
      value: typed,
      blurs: 0,
      disabled: 0,
    },
  );
  await page.getByText("SOUL.md reloaded with its current contents.", { exact: true }).waitFor();
  assert.equal(await soulEditor.evaluate((node) => node.isConnected), true);
  await expectNoText(page, "Unsaved edits restored. Reload replaces them with the current file.");
  // Typing goes on at the caret, and nothing was written for the reader.
  await page.keyboard.type("Workspace");
  assert.equal(await file.inputValue(), "# Draft Workspace\n# Second line\n");

  // An edit made while a reread is in flight is kept; the late answer is dropped.
  await user.fill("# Typed during the reread\n");
  const answered = page.waitForResponse((response) => response.url().endsWith(userPath));
  userReread.release();
  await answered;
  await expectNoText(page, "USER.md reloaded with its current contents.");
  assert.equal(await user.inputValue(), "# Typed during the reread\n");
  assert.equal(
    requests.filter((r) => r.method === "PUT" && r.path.includes("/workspace/files/")).length,
    0,
  );
});

// Opens the Workspace tab while the first of `count` versions serves. Each makeCurrent() selects
// the next version for service and presses Refresh deployment, whose Agent read rereads the
// Workspace files in place (finding 1836).
async function openWorkspaceVersions(t, name, workspaceFilesAccess, count = 2) {
  const fixture = await createConsoleAppFixture(t, { publicOrigin: true, workspaceFilesAccess });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("reread"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const versions = [first.revision];
  while (versions.length < count) {
    versions.push(await fixture.deployAgent(namespace.id, agent.id));
  }
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "workspace"),
  );
  await waitForWorkspaceEditors(page, ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  let current = 0;
  return {
    fixture,
    page,
    requests,
    agentPath,
    versions,
    filePath: (file) => `${agentPath}/workspace/files/${file}`,
    form: (file) => page.locator("form").filter({ has: page.getByLabel(file, { exact: true }) }),
    // keepFocus presses the button without moving focus to it, as the deployment poll reads.
    async makeCurrent({ keepFocus = false } = {}) {
      await fixture.activateRevision(
        namespace.id,
        agent.id,
        versions[current + 1].id,
        versions[current].id,
      );
      current += 1;
      const refresh = deploymentActivity(page).getByRole("button", {
        name: "Refresh deployment",
      });
      await (keepFocus ? refresh.evaluate((button) => button.click()) : refresh.click());
    },
  };
}

function workspaceStatus(form) {
  return form.locator('[role="status"]').textContent();
}

// A missing file already says so; rereading it for another version must not add a "could not be
// reread" status, and a reread that answers clears an earlier one (finding 1878). The first load
// of a file the API confirms missing says so plainly, without an error (finding 1909).
test("a Workspace reread keeps a missing file's notice and clears a failed reread once a file reads again", async (t) => {
  // Files whose next read fails; IDENTITY.md is missing until it is given content.
  let failOnce = new Set();
  let identityContent;
  const saved = new Map();
  const { fixture, page, filePath, form, makeCurrent } = await openWorkspaceVersions(
    t,
    "Workspace missing reread",
    {
      async read({ filename }) {
        if (failOnce.delete(filename)) {
          return { status: "unavailable" };
        }
        if (filename === "IDENTITY.md" && identityContent === undefined) {
          return { status: "missing" };
        }
        const content =
          saved.get(filename) ?? (filename === "IDENTITY.md" ? identityContent : `# ${filename}\n`);
        return { status: "ok", file: { name: filename, content } };
      },
      async write({ filename, content }) {
        saved.set(filename, content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
    6,
  );
  // Settled reads and writes per file, so each step waits for every reread to be applied.
  const settled = { "AGENTS.md": 1, "SOUL.md": 1, "IDENTITY.md": 1, "USER.md": 1 };
  const nextVersion = async (failing) => {
    failOnce = new Set(failing);
    await makeCurrent();
    for (const file of Object.keys(settled)) {
      settled[file] += 1;
      await waitForSettledFetches(page, filePath(file), settled[file]);
    }
  };
  const missingNotice = "IDENTITY.md is missing. Save to create it.";
  const rereadFailed = (file) =>
    `${file} could not be reread. Reload to check its current contents.`;
  const identity = form("IDENTITY.md");
  const identityError = identity.locator('[role="alert"]');
  const soul = form("SOUL.md");
  const user = form("USER.md");
  await identity.getByText(missingNotice, { exact: true }).waitFor();
  assert.equal(await identityError.textContent(), "");
  assert.equal(
    await page.getByRole("button", { name: "Save IDENTITY.md", exact: true }).isEnabled(),
    true,
  );

  // The gateway cannot read SOUL.md; IDENTITY.md is still missing and says nothing new.
  await nextVersion(["SOUL.md"]);
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");

  // SOUL.md reads again, unchanged, so its failure no longer applies. IDENTITY.md cannot be
  // read, which may mean it now exists.
  await nextVersion(["IDENTITY.md"]);
  assert.equal(await workspaceStatus(soul), "");
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).inputValue(), "# SOUL.md\n");
  assert.equal(await workspaceStatus(identity), rereadFailed("IDENTITY.md"));
  assert.equal(await identityError.textContent(), "");

  // IDENTITY.md reads as missing again, which restores its notice. SOUL.md and USER.md fail;
  // the reader reloads one and saves the other, and their own status replaces the failure.
  await nextVersion(["SOUL.md", "USER.md"]);
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await workspaceStatus(user), rereadFailed("USER.md"));
  await page.getByRole("button", { name: "Reload SOUL.md", exact: true }).click();
  settled["SOUL.md"] += 1;
  await waitForSettledFetches(page, filePath("SOUL.md"), settled["SOUL.md"]);
  await soul.getByText("SOUL.md loaded.", { exact: true }).waitFor();
  await page.getByLabel("USER.md", { exact: true }).fill("# Saved USER.md\n");
  await page.getByRole("button", { name: "Save USER.md", exact: true }).click();
  settled["USER.md"] += 1;
  await waitForSettledFetches(page, filePath("USER.md"), settled["USER.md"]);
  await user.getByText("USER.md saved.", { exact: true }).waitFor();

  // The reader reloads IDENTITY.md, which the API confirms is missing.
  await page.getByRole("button", { name: "Reload IDENTITY.md", exact: true }).click();
  settled["IDENTITY.md"] += 1;
  await waitForSettledFetches(page, filePath("IDENTITY.md"), settled["IDENTITY.md"]);
  await identity.getByText("IDENTITY.md is missing. Save to create it.", { exact: true }).waitFor();
  assert.equal(await identityError.textContent(), "");

  // The next version answers SOUL.md and USER.md unchanged, so the reader's statuses stay.
  // IDENTITY.md is answered by a resource 404, which does not confirm the file is still
  // missing, so the reader learns the reread failed.
  await page.route(
    `${fixture.origin}${filePath("IDENTITY.md")}`,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: "The requested platform resource was not found." },
          meta: { requestId: "req_test_workspace_resource_404" },
        }),
      }),
    { times: 1 },
  );
  await nextVersion([]);
  assert.equal(await workspaceStatus(soul), "SOUL.md loaded.");
  assert.equal(await workspaceStatus(user), "USER.md saved.");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
  assert.equal(await workspaceStatus(identity), rereadFailed("IDENTITY.md"));

  // IDENTITY.md now exists, empty, so the failure and any missing error go.
  identityContent = "";
  await nextVersion([]);
  assert.equal(await identityError.textContent(), "");
  assert.equal(await workspaceStatus(identity), "IDENTITY.md reloaded with its current contents.");
  assert.equal(await workspaceStatus(soul), "SOUL.md loaded.");
});

// After a Reload confirms a file missing, its status is the only missing notice: a failed reread
// replaces it until a reread confirms the file still missing (finding 1885). Only a file last
// read as missing is quiet about a missing answer; one read with content that is then deleted
// reports the failed reread and keeps its last text (finding 1886).
test("a Workspace reread restores a reloaded missing file's notice and reports a deleted file", async (t) => {
  // Files whose next read fails; a file without content is missing.
  let failOnce = new Set();
  const contents = new Map([
    ["AGENTS.md", "# AGENTS.md\n"],
    ["SOUL.md", "# SOUL.md\n"],
    ["USER.md", "# USER.md\n"],
  ]);
  const { page, filePath, form, makeCurrent } = await openWorkspaceVersions(
    t,
    "Workspace reloaded missing reread",
    {
      async read({ filename }) {
        if (failOnce.delete(filename)) {
          return { status: "unavailable" };
        }
        if (!contents.has(filename)) {
          return { status: "missing" };
        }
        return { status: "ok", file: { name: filename, content: contents.get(filename) } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
    4,
  );
  const settled = { "AGENTS.md": 1, "SOUL.md": 1, "IDENTITY.md": 1, "USER.md": 1 };
  const nextVersion = async (failing) => {
    failOnce = new Set(failing);
    await makeCurrent();
    for (const file of Object.keys(settled)) {
      settled[file] += 1;
      await waitForSettledFetches(page, filePath(file), settled[file]);
    }
  };
  const rereadFailed = (file) =>
    `${file} could not be reread. Reload to check its current contents.`;
  const missingNotice = "IDENTITY.md is missing. Save to create it.";
  const identity = form("IDENTITY.md");
  const identityError = identity.locator('[role="alert"]');
  const soul = form("SOUL.md");
  const soulEditor = page.getByLabel("SOUL.md", { exact: true });
  await soul.getByText("SOUL.md loaded.", { exact: true }).waitFor();

  // The reader reloads IDENTITY.md, which the API confirms is missing.
  await page.getByRole("button", { name: "Reload IDENTITY.md", exact: true }).click();
  settled["IDENTITY.md"] += 1;
  await waitForSettledFetches(page, filePath("IDENTITY.md"), settled["IDENTITY.md"]);
  await identity.getByText(missingNotice, { exact: true }).waitFor();
  assert.equal(await identityError.textContent(), "");

  // IDENTITY.md cannot be reread. SOUL.md is deleted, and its missing answer is reported as a
  // failed reread, since the editor still shows its last text.
  contents.delete("SOUL.md");
  await nextVersion(["IDENTITY.md"]);
  assert.equal(await workspaceStatus(identity), rereadFailed("IDENTITY.md"));
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await soulEditor.inputValue(), "# SOUL.md\n");

  // IDENTITY.md is confirmed missing again, so its notice returns; SOUL.md still reports that
  // its text may be out of date.
  await nextVersion([]);
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await soulEditor.inputValue(), "# SOUL.md\n");

  // A further confirmed-missing reread leaves the notice as it is.
  await nextVersion([]);
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");
});

test("a Workspace reread answered after a Reload keeps the Reload's answer", async (t) => {
  const before = "# SOUL.md before the deployment\n";
  let soul = before;
  const { fixture, page, filePath, form, makeCurrent } = await openWorkspaceVersions(
    t,
    "Workspace reread order",
    {
      async read({ filename }) {
        const content = filename === "SOUL.md" ? soul : `# ${filename}\n`;
        return { status: "ok", file: { name: filename, content } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
  );
  const editor = page.getByLabel("SOUL.md", { exact: true });
  // The reread reads SOUL.md from the server, and its answer is held.
  const reread = await holdRequests(t, page, `${fixture.origin}${filePath("SOUL.md")}`, {
    once: true,
    afterServer: true,
  });
  soul = "# SOUL.md read by the reread\n";
  await makeCurrent();
  await reread.requested;
  // Someone restores the file, and the reader's Reload answers before the reread.
  soul = before;
  await page.getByRole("button", { name: "Reload SOUL.md", exact: true }).click();
  await form("SOUL.md").getByText("SOUL.md loaded.", { exact: true }).waitFor();
  await waitForSettledFetches(page, filePath("SOUL.md"), 2);
  reread.release();
  await waitForSettledFetches(page, filePath("SOUL.md"), 3);
  assert.equal(await editor.inputValue(), before);
  assert.equal(await workspaceStatus(form("SOUL.md")), "SOUL.md loaded.");
});

// A reader who clicked into a file without editing keeps caret, selection and scroll when the
// file is reread with different contents; assigning the new value alone moved the caret to the
// end, where the next key landed and the editor jumped (finding 1889).
test("a Workspace reread keeps the caret and scroll of a focused, unedited editor", async (t) => {
  const content = (revision) =>
    `# SOUL.md served by ${revision}\n` +
    Array.from({ length: 60 }, (_, line) => `line ${line} of SOUL.md for ${revision}\n`).join("");
  const { page, filePath, form, makeCurrent, versions } = await openWorkspaceVersions(
    t,
    "Workspace focused reread",
    {
      async read({ revision, filename }) {
        const text = filename === "SOUL.md" ? content(revision.id) : `# ${filename}\n`;
        return { status: "ok", file: { name: filename, content: text } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
  );
  const soul = page.getByLabel("SOUL.md", { exact: true });
  const before = content(versions[0].id);
  const after = content(versions[1].id);
  const start = before.indexOf("line 30 ");
  assert.equal(after.indexOf("line 30 "), start);
  await waitForInputValue(soul, before);
  // The files can load while the detail view is still held back for its overview read, and a
  // hidden editor has no scroll height and takes no focus; wait until SOUL.md is shown and
  // overflows (finding 2034).
  await page.waitForFunction(() => {
    const node = globalThis.document.getElementById("workspace-SOUL.md");
    return node?.scrollHeight > node?.clientHeight;
  });
  // The reader clicks into line 30 and selects a word; the editor scrolls to centre that line.
  // Lines are alike, so the line's share of the text is its share of the scroll height.
  await soul.evaluate((node, offset) => {
    node.focus();
    node.setSelectionRange(offset, offset + 4, "backward");
    const lines = node.value.split("\n").length;
    const line = node.value.slice(0, offset).split("\n").length - 0.5;
    node.scrollTop = (line / lines) * node.scrollHeight - node.clientHeight / 2;
  }, start);
  const editorState = () =>
    soul.evaluate((node) => ({
      focused: node.ownerDocument.activeElement === node,
      selection: [node.selectionStart, node.selectionEnd, node.selectionDirection],
      scrollTop: node.scrollTop,
    }));
  const shown = await editorState();
  assert.ok(shown.scrollTop > 0, "SOUL.md must scroll for this test");
  assert.deepEqual(shown.selection, [start, start + 4, "backward"]);

  // The next version serves different contents; the Agent read that rereads the file is started
  // without moving focus, as the deployment poll does.
  await makeCurrent({ keepFocus: true });
  await waitForInputValue(soul, after);
  await form("SOUL.md")
    .getByText("SOUL.md reloaded with its current contents.", { exact: true })
    .waitFor();
  await waitForSettledFetches(page, filePath("SOUL.md"), 2);
  assert.deepEqual(await editorState(), { ...shown, focused: true });

  // The next key replaces the selection where the reader left it, and the editor stays put.
  await page.keyboard.type("Q");
  assert.equal(await soul.inputValue(), `${after.slice(0, start)}Q${after.slice(start + 4)}`);
  assert.equal((await editorState()).scrollTop, shown.scrollTop);
});

test("a Workspace version change during a Reload or Save rereads the file once it settles", async (t) => {
  const saved = new Map();
  const { fixture, page, requests, filePath, form, makeCurrent, versions } =
    await openWorkspaceVersions(t, "Workspace deferred reread", {
      async read({ revision, filename }) {
        const content = saved.get(filename) ?? `# ${filename} served by ${revision.id}\n`;
        return { status: "ok", file: { name: filename, content } };
      },
      async write({ filename, content }) {
        saved.set(filename, content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    });
  const soul = page.getByLabel("SOUL.md", { exact: true });
  const user = page.getByLabel("USER.md", { exact: true });
  // A Reload of SOUL.md reads the first version, and its answer is held.
  const reload = await holdRequests(t, page, `${fixture.origin}${filePath("SOUL.md")}`, {
    once: true,
    afterServer: true,
  });
  await page.getByRole("button", { name: "Reload SOUL.md", exact: true }).click();
  await reload.requested;
  // A Save of USER.md is held before it reaches the server.
  const save = await holdRequests(t, page, `${fixture.origin}${filePath("USER.md")}`, {
    once: true,
    method: "PUT",
  });
  await user.fill("# Saved during the deployment\n");
  await page.getByRole("button", { name: "Save USER.md", exact: true }).click();
  await save.requested;

  await makeCurrent();
  await waitForInputValue(
    page.getByLabel("AGENTS.md", { exact: true }),
    `# AGENTS.md served by ${versions[1].id}\n`,
  );
  // The Reload answers with the first version; the file is then reread from the second.
  reload.release();
  await waitForInputValue(soul, `# SOUL.md served by ${versions[1].id}\n`);
  await form("SOUL.md")
    .getByText("SOUL.md reloaded with its current contents.", { exact: true })
    .waitFor();
  // The Save lands, and the reread after it keeps the saved text.
  const userReads = () => pathRequests(requests, "GET", filePath("USER.md")).length;
  assert.equal(userReads(), 1);
  save.release();
  await form("USER.md").getByText("USER.md saved.", { exact: true }).waitFor();
  await waitForCondition(() => userReads() === 2, "USER.md was not reread after its Save");
  await waitForSettledFetches(page, filePath("USER.md"), 3);
  assert.equal(await user.inputValue(), "# Saved during the deployment\n");
  assert.equal(await workspaceStatus(form("USER.md")), "USER.md saved.");
});

// Deletion replaces the page; an Agent read that answers afterwards has nothing to update.
test("an Agent read answered after deletion was requested leaves the Workspace files alone", async (t) => {
  const name = "Workspace deletion read";
  const { fixture, page, requests, agentPath, makeCurrent } = await openWorkspaceVersions(t, name, {
    async read({ revision, filename }) {
      return {
        status: "ok",
        file: { name: filename, content: `# ${filename} served by ${revision.id}\n` },
      };
    },
    async write() {
      throw new Error("no Workspace file may be written");
    },
  });
  // Refresh deployment reads the Agent with the next version current; the answer is held.
  const agentRead = await holdRequests(t, page, `${fixture.origin}${agentPath}`, {
    once: true,
    method: "GET",
    afterServer: true,
  });
  await makeCurrent();
  await agentRead.requested;
  await page.getByRole("button", { name: "Delete Agent" }).click();
  await page
    .getByRole("dialog", { name: `Delete ${name}?` })
    .getByRole("button", { name: "Permanently delete Agent" })
    .click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  const workspaceReads = () =>
    requests.filter((r) => r.method === "GET" && r.path.startsWith(`${agentPath}/workspace/`))
      .length;
  assert.equal(workspaceReads(), 4);
  agentRead.release();
  await waitForIdleFetches(page);
  await settlePageRequests(page);
  assert.equal(workspaceReads(), 4);
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
});

test("explicit missing-file readback settles an uncertain workspace create without replaying it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "console-workspace-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let unavailable = false;
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ filename }) {
        if (unavailable) {
          return { status: "unavailable" };
        }
        try {
          return {
            status: "ok",
            file: { name: filename, content: await readFile(join(root, filename), "utf8") },
          };
        } catch (cause) {
          return { status: cause.code === "ENOENT" ? "missing" : "unavailable" };
        }
      },
      async write({ filename, content }) {
        await writeFile(join(root, filename), content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing workspace readback", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Missing file Agent",
    nativeValues("missing"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  let dropped = false;
  await page.route(fixture.origin + path, async (route) => {
    if (route.request().method() === "PUT" && !dropped) {
      dropped = true;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
  );
  const editor = page.getByLabel("USER.md", { exact: true });
  await waitForWorkspaceEditors(page, ["USER.md"]);
  await editor.fill("# Interrupted first create\n");
  const save = page.getByRole("button", { name: "Save USER.md", exact: true });
  const reload = page.getByRole("button", { name: "Reload USER.md", exact: true });
  const form = page.locator("form").filter({ has: editor });
  await save.click();
  await form.getByText("Outcome unknown.", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal((await fixture.request("GET", path)).status, 404);
  const writeRequests = () =>
    requests.filter((request) => request.path === path && request.method === "PUT");
  assert.equal(writeRequests().length, 1);
  // A formal resource 404, unlike file absence, cannot settle this unknown write.
  const missingAgent = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/agt_${randomUUID()}/workspace/files/USER.md`,
  );
  assert.equal(missingAgent.status, 404);
  assert.deepEqual(missingAgent.body.error, {
    code: "NOT_FOUND",
    message: "The requested platform resource was not found.",
  });
  await page.route(fixture.origin + path, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: missingAgent.status,
        contentType: "application/json",
        body: JSON.stringify(missingAgent.body),
      });
    } else {
      await route.fallback();
    }
  });
  await reload.click();
  await form.getByText("File unavailable or missing.", { exact: false }).waitFor();
  assert.equal(await editor.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  await page.unroute(fixture.origin + path);
  // A real IAM refusal also leaves the draft guarded. Restore the fixture's own grant afterwards.
  const administrator = fixture.policy.roles[0];
  const permissions = administrator.permissions;
  administrator.permissions = permissions.filter(
    (permission) => !(permission.action === "read" && permission.resourceKind === "agent"),
  );
  await reload.click();
  await form.getByText("Access denied.", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  administrator.permissions = permissions;
  unavailable = true;
  await reload.click();
  await form.getByText("Workspace access is unavailable.", { exact: false }).waitFor();
  assert.equal(await editor.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  unavailable = false;
  const reply = page.waitForResponse(
    (response) => response.url() === fixture.origin + path && response.request().method() === "GET",
  );
  await reload.click();
  const missingFile = await reply;
  assert.equal(missingFile.status(), 404);
  assert.deepEqual((await missingFile.json()).error, {
    code: "NOT_FOUND",
    message: "The requested workspace file was not found.",
  });
  await form.getByText("USER.md is missing. Save to create it.", { exact: true }).waitFor();
  assert.equal(await editor.isEnabled(), true);
  assert.equal(await editor.inputValue(), "", "explicit Reload discards the uncertain draft");
  assert.equal(writeRequests().length, 1, "readback never automatically repeats a write");
  await editor.fill("# Deliberate replacement create\n");
  const saved = page.waitForResponse(
    (response) => response.url() === fixture.origin + path && response.request().method() === "PUT",
  );
  await save.click();
  assert.equal((await saved).status(), 200);
  await form.getByText("USER.md saved.", { exact: true }).waitFor();
  assert.equal(await readFile(join(root, "USER.md"), "utf8"), "# Deliberate replacement create\n");
  assert.equal(writeRequests().length, 2);
});

test("authentication drafts retain Secret references and their original save baseline", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Authentication navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Authentication draft",
    nativeValues("auth"),
  );
  const secret = await fixture.createSecret(namespace.id, "Replacement key", "synthetic-auth-key");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);
  await page.getByLabel("Authentication source").selectOption("api_key");
  await selectSecret(page, "API key Secret", secret);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  // A saved auth change must not rebase the retained local choice when the page is recreated.
  const changed = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(changed.status, 200);
  await page.goBack();
  // Back first restores a disabled copy of the old view, whose picker still shows the Secret.
  await waitForLiveControls(page, ["harness-auth-method"]);
  await waitForInputValue(
    page.getByLabel("API key Secret", { exact: true }),
    secretOptionLabel(secret),
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText("The Configuration changed. Reload authentication source before saving.")
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await page.getByRole("button", { name: "Reload authentication source" }).click();
  await waitForLiveControls(page, ["harness-auth-method"]);
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  await page.getByLabel("Authentication source").selectOption("api_key");
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).evaluate((node) => node.value),
    "",
  );
});

test("Secret summaries retain revision bindings and distinguish unreadable metadata from absent bindings", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Bound Secret summaries", { ready: true });
  const app = await fixture.createSecret(namespace.id, "Revision Slack app", "hidden-app-value");
  const bot = await fixture.createSecret(namespace.id, "Revision Slack bot", "hidden-bot-value");
  const replacement = await fixture.createSecret(namespace.id, "Draft model", "hidden-model-value");
  const secretBindings = {
    SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
  };
  const agent = await fixture.createAgent(namespace.id, "Bound Secrets", nativeValues("bound"), {
    secretBindings,
  });
  // Real admission requires exact Agent access to each projected credential.
  for (const secret of [app, bot, replacement]) {
    fixture.policy.bindings.push({
      id: `grant-${secret.id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: `service-agent-${agent.id}`,
      roleId: `auth-${agent.id}`,
      resourceKind: "secret",
      resourceId: secret.id,
    });
  }
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // Mutate both current owners after admission; the read-only view must keep the old references.
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: replacement.ref },
  });
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("changed"), {
    secretBindings: {},
  });
  const limited = await fixture.createAccountWithPolicy("secret-summary-reader", (principal) => {
    fixture.policy.roles.push(
      {
        id: "summary-reader",
        namespaceId: namespace.id,
        permissions: ["namespace", "agent", "configuration", "agent_revision"].map(
          (resourceKind) => ({ action: "read", resourceKind }),
        ),
      },
      {
        id: "exact-secret-reader",
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "secret" }],
      },
    );
    fixture.policy.bindings.push({
      id: "summary-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "summary-reader",
    });
    // Only these exact Secrets are readable. No Secret collection grant is present.
    for (const id of [agent.harnessAuth.source.id, app.id, replacement.id]) {
      fixture.policy.bindings.push({
        id: `read-${id}`,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "exact-secret-reader",
        resourceKind: "secret",
        resourceId: id,
      });
    }
  });
  const { page, artifacts } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, url, limited.credentials);
  await page.getByRole("link", { name: "Auth Bound Secrets", exact: true }).waitFor();
  assert.equal(await page.getByText("Draft model", { exact: true }).count(), 0);
  await page.screenshot({ path: join(artifacts, "bound-harness-revision.png"), fullPage: true });
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("link", { name: "Revision Slack app", exact: true }).waitFor();
  await page
    .getByText(`Bound Secret · ${bot.id} · Metadata unavailable (access denied)`, { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: /Configure Slack|Edit Slack/ }).count(), 0);
  await page.screenshot({ path: join(artifacts, "bound-channels-restricted.png"), fullPage: true });
  assert.equal(
    requests.some((request) => request.path === `/namespaces/${namespace.id}/secrets`),
    false,
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  for (const value of ["hidden-app-value", "hidden-bot-value", "hidden-model-value"]) {
    assert.equal((await page.locator("body").textContent()).includes(value), false);
  }
  // Active snapshots protect their Secrets even after the draft drops the bindings.
  const secretPath = `/namespaces/${namespace.id}/secrets/${app.id}`;
  assert.equal((await fixture.request("DELETE", secretPath)).status, 409);
  // Admit and select the replacement draft, leaving the viewed revision historical.
  // With no live references, a real deletion makes its bound metadata unavailable.
  await fixture.seedActiveAgentRevision(namespace.id, agent.id, active.revision.id);
  const deleted = await fixture.rawRequest("DELETE", secretPath, {
    headers: authenticatedHeaders(await fixture.signIn()),
  });
  assert.equal(deleted.response.status, 204);
  assert.equal((await fixture.request("GET", secretPath)).status, 404);
  await page.reload();
  await page
    .getByText(`Bound Secret · ${app.id} · Metadata unavailable`, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Open version draft", exact: true }).last().click();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByText("No Secret bound", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("No Secret bound", { exact: true }).count(), 2);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("link", { name: "Draft model", exact: true }).waitFor();
});

test("Slack directory selections show names and save exact channel IDs", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Slack directory picker", { ready: true });
  const appSecret = await fixture.createSecret(namespace.id, "Slack app token", "xapp-test-secret");
  const botSecret = await fixture.createSecret(namespace.id, "Slack bot token", "xoxb-test-secret");
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "disabled",
    channels: { CEXIST123: { requireMention: true, users: ["*"] } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Directory Agent",
    nativeValues("slack-directory", { harnessId: "codex", channels: { slack } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const directoryBodies = [];
  const pendingDirectory = Promise.withResolvers();
  const releaseDirectory = Promise.withResolvers();
  // The browser test owns Console selection and saved API state; only provider directory data is simulated.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      directoryBodies.push(body);
      if (body.query === "pending") {
        pendingDirectory.resolve(route.request());
        await releaseDirectory.promise;
      }
      let nextCursor;
      let candidates;
      if (body.kind === "users") {
        candidates = [{ id: "UTEST123", name: "alex", displayName: "Alex" }];
      } else if (body.query === "GENERALX") {
        if (!body.cursor) {
          candidates = Array.from({ length: 7 }, (_, index) => ({
            id: `CUPPER11${index + 1}`,
            name: `GENERALX-first-${index + 1}`,
          }));
          nextCursor = "upper-next";
        } else if (body.cursor === "upper-next") {
          candidates = [];
          nextCursor = "upper-final";
        } else {
          candidates = [{ id: "CUPPER123", name: "GENERALX" }];
        }
      } else {
        candidates = [
          { id: "CEXIST123", name: "existing-room" },
          { id: "CTEST456", name: "release-room" },
          { id: "CGENERAL", name: "general" },
          { id: "CUPPER123", name: "GENERALX" },
        ];
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workspaceId: "TTEST123",
            workspaceName: "Test workspace",
            candidates: body.ids
              ? candidates.filter((candidate) => body.ids.includes(candidate.id))
              : candidates,
            complete: !nextCursor,
            ...(nextCursor ? { nextCursor } : {}),
          },
          meta: { requestId: "req_test_slack_directory" },
        }),
      });
    },
  );

  const channelsUrl = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, channelsUrl);
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Edit Slack" });
  const channelSearch = channelDialog.getByRole("combobox", { name: "Channels", exact: true });
  const channelPicker = channelSearch.locator("..").locator("..");
  await channelPicker.getByText("#existing-room", { exact: true }).waitFor();
  await channelSearch.focus();
  await channelPicker.getByRole("option", { name: /existing-room.*CEXIST123/ }).waitFor();
  // Advance browser time explicitly: intermediate keystrokes and dismissed searches must not query.
  const clockTime = new Date("2026-09-27T12:00:00Z");
  await page.clock.install({ time: new Date("2026-09-27T11:59:00Z") });
  await page.clock.pauseAt(clockTime);
  await channelSearch.fill("g");
  await page.clock.runFor(200);
  await channelSearch.fill("ge");
  await page.clock.runFor(200);
  await channelSearch.fill("general");
  await page.clock.runFor(299);
  assert.deepEqual(
    directoryBodies.filter((body) => body.query),
    [],
  );
  await page.clock.runFor(1);
  await channelPicker.getByRole("option", { name: /general.*CGENERAL/ }).waitFor();
  assert.deepEqual(
    directoryBodies.filter((body) => body.query).map((body) => body.query),
    ["general"],
  );
  await channelSearch.fill("dismissed");
  await channelSearch.press("Escape");
  await page.clock.runFor(300);
  assert.equal(
    directoryBodies.some((body) => body.query === "dismissed"),
    false,
  );
  // A new query aborts the old browser request, even while its provider response is held.
  await channelSearch.fill("pending");
  await channelSearch.press("Enter");
  const pendingRequest = await pendingDirectory.promise;
  const canceledRequest = page.waitForEvent(
    "requestfailed",
    (request) => request === pendingRequest,
  );
  await channelSearch.fill("general");
  await canceledRequest;
  releaseDirectory.resolve();
  // Enter submits immediately and removes the queued debounce, so it cannot send the same query twice.
  await channelSearch.press("Enter");
  await channelPicker.getByRole("option", { name: /general.*CGENERAL/ }).waitFor();
  await page.clock.runFor(300);
  assert.equal(directoryBodies.filter((body) => body.query === "general").length, 2);
  await page.clock.resume();
  assert.equal(await slackSelectionValue(channelSearch), "CEXIST123");
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.ok(directoryBodies.some((body) => body.query === "general" && !body.ids));
  await channelSearch.press("ArrowUp");
  assert.equal(
    await channelSearch.getAttribute("aria-activedescendant"),
    await channelPicker.getByRole("option").last().getAttribute("id"),
  );
  await channelSearch.press("Escape");
  assert.equal(await channelSearch.getAttribute("aria-expanded"), "false");
  assert.equal(await channelDialog.isVisible(), true);
  await channelSearch.fill("GENERALX");
  await channelPicker.getByRole("option", { name: /GENERALX-first.*CUPPER111/ }).waitFor();
  assert.equal(await channelPicker.getByRole("option").count(), 5);
  // Seven provider matches span two display pages; neither overflow nor Previous rereads the provider.
  const initialSearchRequests = directoryBodies.filter((body) => body.query === "GENERALX").length;
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  await channelPicker.getByRole("option", { name: /GENERALX-first-6.*CUPPER116/ }).waitFor();
  assert.equal(await channelPicker.getByRole("option").count(), 2);
  await channelPicker.getByRole("button", { name: "Previous page" }).click();
  await channelPicker.getByRole("option", { name: /GENERALX-first-1.*CUPPER111/ }).waitFor();
  assert.equal(await channelPicker.getByRole("option").count(), 5);
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  assert.equal(
    directoryBodies.filter((body) => body.query === "GENERALX").length,
    initialSearchRequests,
  );
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  await channelPicker
    .getByText("No results on this page. More results may be available.")
    .waitFor();
  // A provider scan without matches still permits continuing to a later matching channel.
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  await channelPicker.getByRole("option", { name: /GENERALX.*CUPPER123/ }).click();
  assert.equal(await slackSelectionValue(channelSearch), "CEXIST123, CUPPER123");
  assert.ok(directoryBodies.some((body) => body.ids?.[0] === "GENERALX"));
  assert.ok(directoryBodies.some((body) => body.query === "GENERALX" && !body.ids));
  assert.ok(
    directoryBodies.some((body) => body.query === "GENERALX" && body.cursor === "upper-next"),
  );
  await channelPicker.getByRole("button", { name: "Remove CUPPER123", exact: true }).click();
  await channelSearch.fill("CTEST456");
  await channelPicker.getByRole("option", { name: /release-room.*CTEST456/ }).waitFor();
  await channelSearch.press("ArrowDown");
  await channelSearch.press("Enter");
  assert.equal(await channelSearch.inputValue(), "");
  assert.equal(await slackSelectionValue(channelSearch), "CEXIST123, CTEST456");
  // Clearing specific people must not turn channel access into Everyone.
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("selected");
  const people = channelDialog.getByRole("combobox", {
    name: "Allowed people in these channels",
    exact: true,
  });
  await setSlackSelection(people, "UTEST123");
  await people
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Remove UTEST123", exact: true })
    .click();
  await channelDialog.getByRole("button", { name: "Save configuration" }).click();
  await channelDialog
    .getByText("Choose specific people or select Everyone in these channels.")
    .waitFor();
  assert.equal(
    pathRequests(
      requests,
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    ).length,
    0,
  );
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("everyone");
  // Unselected search text is never part of the Configuration save.
  await channelSearch.fill("unselected search text");
  const savedChannels = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/namespaces/${namespace.id}/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await channelDialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await savedChannels).status(), 200);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(Object.keys(configuration.data.values.channels.slack.channels), [
    "CEXIST123",
    "CTEST456",
  ]);
  assert.ok(
    directoryBodies.some(
      (body) =>
        body.secretId === botSecret.id &&
        body.kind === "channels" &&
        body.configurationId === agent.configurationId &&
        body.ids?.[0] === "CTEST456",
    ),
  );
  await page.getByRole("button", { name: "Edit Slack" }).click();
  await page
    .getByRole("dialog", { name: "Edit Slack" })
    .locator('.slack-directory-chip[data-value="CTEST456"]')
    .getByText("#release-room")
    .waitFor();
});

test("Slack editor preserves existing qualified channel and user targets", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Qualified Slack targets", { ready: true });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Qualified Slack app token",
    "xapp-qualified",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Qualified Slack bot token",
    "xoxb-qualified",
  );
  const channelUsers = [
    "team:TTEST123:user:UTEST123",
    "user:UTEST124",
    "slack:UTEST125",
    "@legacy-sender",
  ];
  const dmUsers = ["user:UTEST123", "slack:UTEST124", "team:TTEST123:user:UTEST125", "@legacy-dm"];
  const channelIds = ["team:TTEST123:channel:CEXIST123", "channel:GEXIST456", "#legacy-room"];
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "allowlist",
    allowFrom: dmUsers,
    channels: Object.fromEntries(
      channelIds.map((id) => [id, { requireMention: true, users: channelUsers }]),
    ),
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Qualified Slack Agent",
    nativeValues("qualified-slack", { harnessId: "codex", channels: { slack } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      const candidates =
        body.kind === "channels"
          ? [{ id: "CEXIST123", name: "existing-room" }]
          : [{ id: "UTEST123", name: "alex", displayName: "Alex" }];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workspaceId: "TTEST123",
            candidates: body.ids
              ? candidates.filter((candidate) => body.ids.includes(candidate.id))
              : candidates,
            complete: true,
          },
          meta: { requestId: "req_qualified_slack" },
        }),
      });
    },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.deepEqual(
    (
      await slackSelectionValue(dialog.getByRole("combobox", { name: "Channels", exact: true }))
    ).split(", "),
    channelIds,
  );
  assert.deepEqual(
    new Set(
      (
        await slackSelectionValue(
          dialog.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        )
      ).split(", "),
    ),
    new Set(channelUsers),
  );
  assert.deepEqual(
    (
      await slackSelectionValue(
        dialog.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
      )
    ).split(", "),
    dmUsers,
  );
  for (const [label, candidate] of [
    ["Channels", /existing-room.*CEXIST123/],
    ["Allowed people in these channels", /Alex.*UTEST123/],
    ["Allowed people in direct messages", /Alex.*UTEST123/],
  ]) {
    const search = dialog.getByRole("combobox", { name: label, exact: true });
    await search.focus();
    await search.locator("..").locator("..").getByRole("option", { name: candidate }).click();
  }
  assert.equal(await dialog.locator('.slack-directory-chip[data-value="CEXIST123"]').count(), 0);
  assert.deepEqual(
    (
      await slackSelectionValue(dialog.getByRole("combobox", { name: "Channels", exact: true }))
    ).split(", "),
    channelIds,
  );
  assert.deepEqual(
    new Set(
      (
        await slackSelectionValue(
          dialog.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        )
      ).split(", "),
    ),
    new Set(channelUsers),
  );
  assert.deepEqual(
    (
      await slackSelectionValue(
        dialog.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
      )
    ).split(", "),
    dmUsers,
  );
  await dialog.getByLabel("Require a mention").uncheck();
  const saved = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/namespaces/${namespace.id}/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await saved).status(), 200);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  const persisted = configuration.data.values.channels.slack;
  assert.deepEqual(Object.keys(persisted.channels), channelIds);
  for (const entry of Object.values(persisted.channels)) {
    assert.deepEqual(new Set(entry.users), new Set(channelUsers));
    assert.equal(entry.requireMention, false);
  }
  assert.deepEqual(persisted.allowFrom, dmUsers);
});

test("Credentials saves an issued service account as a PAT source without granting Secret access", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Managed PAT source", { ready: true });
  // Issuance is outside this Console test. Seed its realistic result through State;
  // the browser still lists, selects and saves it through production API/IAM paths.
  const account = await fixture.controller.transact(async (state) => {
    const created = await state.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "Issued research account",
    });
    return state.serviceAccounts.updateCredential(namespace.id, created.id, {
      kind: "access_token",
      secretRef: { name: "managed-pat-browser-fixture", key: "token" },
    });
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Managed PAT Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByLabel("Authentication source", { exact: true }).selectOption("service_account");
  await page.getByLabel("Issued ChatGPT service account", { exact: true }).selectOption(account.id);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith(`/agents/${agent.id}`),
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.getByRole("button", { name: "Save authentication source", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Authentication source", { exact: true }).inputValue(),
    "service_account",
  );
  assert.equal(
    await page.getByLabel("Issued ChatGPT service account", { exact: true }).inputValue(),
    account.id,
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .harnessAuth,
    {
      method: "codex_pat",
      source: { kind: "service_account", namespaceId: namespace.id, id: account.id },
    },
  );
  assert.equal(
    requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/access-bindings"),
    ),
    false,
  );
  // The draft summary names the selected account rather than a Secret.
  await page.goto(
    `${fixture.origin}/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=configuration`,
  );
  await page.getByText(`ChatGPT service account · ${account.id}`, { exact: true }).waitFor();
});

test("Console can repeat Stop without treating the selected version as cleanup completion", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Repeat Stop");
  const agent = await fixture.createAgent(
    namespace.id,
    "Repeat Stop",
    nativeValues("repeat-stop"),
    { harnessAuth: { method: "runtime" } },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const first = await fixture.request("POST", `${path}/stop`);
  assert.equal(first.status, 202);
  assert.equal(first.data.activeRevisionId, active.revision.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Repeat Stop", exact: true }).waitFor();
  const repeat = page.getByRole("button", { name: "Request Stop again", exact: true });
  // Stop shows with the rest of the page once Deployment activity settles.
  await repeat.waitFor();
  assert.equal(await repeat.count(), 1, "the existing Stop API permits another authorized intent");
  assert.equal(await repeat.isEnabled(), true);
  await repeat.focus();
  await repeat.press("Enter");
  let dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.locator(".agent-stop-dialog").waitFor({ state: "detached" });
  assert.equal(await repeat.evaluate((node) => node === node.ownerDocument.activeElement), true);
  await repeat.press("Enter");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".agent-stop-dialog").waitFor({ state: "detached" });
  assert.equal(await repeat.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 0);
  await repeat.click();
  dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  const result = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/stop`,
  );
  await dialog.getByRole("button", { name: "Stop Agent", exact: true }).click();
  assert.equal((await result).status(), 202);
  await page.locator(".agent-stop-dialog").waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh stop status" })
      .evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  const after = await fixture.request("GET", path);
  assert.equal(after.data.activeRevisionId, active.revision.id);
  assert.equal(after.data.desiredRuntimeState, "stopped");
  assert.equal(after.data.configurationId, agent.configurationId);
  await checkStatusRefreshFocus(page, `${fixture.origin}${path}`, "Refresh stop status");
  // No selected version does not prove candidate/history cleanup completed.
  await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page
    .getByText("No version is selected. Deploy a new version to start this Agent.")
    .waitFor();
  assert.equal(await repeat.isEnabled(), true);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  await repeat.click();
  const noSelectionResult = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/stop`,
  );
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  assert.equal((await noSelectionResult).status(), 202);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 2);
});

test("Credentials preserves an existing OpenClaw credential source without offering Codex login", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OpenClaw source", { ready: true });
  const backend = createOpenShellBackend({
    id: "openshell-browser",
    type: "openshell",
    configuration: { endpoint: "http://127.0.0.1:9" },
    drivers: { credential_gateway: "credential-gateway-openshell" },
  });
  t.after(() => backend.client.close());
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/openclaw"] },
    { backend },
  );
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  const input = await fixture.createSecret(
    namespace.id,
    "OpenAI source input",
    "source-browser-fixture",
  );
  // Source registration is outside this Console test. This is the ready API-key
  // source state the existing OpenClaw credential-gateway path supports.
  const source = await fixture.controller.transact((state) =>
    state.credentialSources.createCredentialSource({
      id: `cs_${randomUUID()}`,
      namespaceId: namespace.id,
      name: "OpenAI API key",
      type: "openai",
      config: {},
      secrets: { api_key: input.ref },
      driverId: gateway.id,
      state: "ready",
      createdAt: new Date().toISOString(),
    }),
  );
  const harnessAuth = { method: "credential_source", sourceId: source.id };
  const agent = await fixture.createAgent(
    namespace.id,
    "OpenClaw source Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth,
      credentialSources: [{ sourceId: harnessAuth.sourceId }],
    },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  assert.equal(
    await page.getByLabel("Authentication source", { exact: true }).inputValue(),
    "credential_source",
  );
  assert.equal(
    await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).isVisible(),
    false,
  );
  const granted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/access-bindings"),
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await granted).status(), 201);
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .harnessAuth,
    harnessAuth,
  );
  const save = requests.find(
    (request) => request.method === "PATCH" && request.path.endsWith(`/agents/${agent.id}`),
  );
  assert.deepEqual(save.body.harnessAuth, harnessAuth);
});

async function checkStatusRefreshFocus(page, url, name) {
  const refresh = page.getByRole("button", { name, disabled: false });
  const agentsLink = page.getByRole("link", { name: "← Agents", exact: true });
  for (const expectedFocus of [refresh, agentsLink]) {
    const held = await holdNextStatusResponse(page, url);
    await refresh.press("Enter");
    const status = await held.status;
    if (expectedFocus === agentsLink) {
      await agentsLink.focus();
    }
    held.release();
    assert.equal(status, 200);
    await refresh.waitFor();
    assert.equal(await expectedFocus.evaluate((node) => node.matches(":focus")), true);
  }
}

// Hold the real status response so focus can move before the Console handles it.
async function holdNextStatusResponse(page, url) {
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(
    url,
    async (route) => {
      const response = await route.fetch();
      held.resolve(response.status());
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  return { status: held.promise, release: release.resolve };
}
