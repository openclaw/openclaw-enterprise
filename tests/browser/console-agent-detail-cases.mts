import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Locator, Page } from "playwright";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { isResourceKind, PERMISSION_ACTIONS } from "../../packages/contracts/src/index.ts";
import type {
  AccessBinding,
  Principal,
  Permission,
  ResourceKind,
  Role,
  ChannelDirectoryLookupInput,
  ChannelDirectoryResult,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorkspaceFilesAccess } from "../../apps/controller/src/gateway/contracts.ts";

import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import { DELETION_POLL_MS } from "../../apps/controller/src/console/agents/deletion.mjs";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { apiErrorResponse, proxyErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture, type fileConsoleApp } from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  AGENT_READ,
  apiRequests,
  authorizationDenials,
  denyRevisionRead,
  detailUrl,
  expectNoText,
  expectReachableReason,
  expireSessionsWhenSettled,
  login,
  setSlackSelection,
  slackSelectionValue as readSlackSelection,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  revokeMemberGrant,
  secretOptionLabel,
  selectSecret,
  settlePageRequests,
  trackSettledFetches,
  waitForCondition,
  waitForEnabled,
  waitForIdleFetches,
  waitForInputValue,
  waitForSettledFetches,
  statusTone,
} from "./console-agents-browser-helpers.mjs";

import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  expectNativeAdminHidden,
  withholdPermissionSummary,
  agentDeleteRequests,
  agentStopRequests,
  replyWithDifferentAgentId,
  waitForLiveControls,
} from "./console-agents-test-support.mjs";
import {
  callerDenied,
  DEPENDENCY_UNAVAILABLE,
  GENERIC_DENIAL,
  MALFORMED_REQUEST,
  RESOURCE_CONFLICT,
  SANDBOX_POLICY_READ_DENIED,
  STOP_REPEAT_CONFIRMATION,
  STOPPED_NO_VERSION,
  WORKSPACE_FILES_UNAVAILABLE,
  askForGrant,
  BOUND_SECRET_UNLISTED,
  notIncluded,
  deleteRefused,
  NAMESPACE_UNAVAILABLE,
  VERSION_READ_DENIED_HEADING,
} from "../helpers/refusal-text.mjs";
import { liftRestriction, restrict } from "../helpers/iam-grants.mjs";

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () =>
    assert.fail("Promise executor did not run");
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function resourceId(value: unknown): string {
  const id = text(record(value).id);
  assert.ok(id.length > 0, "Expected a resource ID");
  return id;
}

function responseData(value: unknown): Record<string, unknown> {
  return record(record(value).data);
}

function slackSettings(value: unknown): Record<string, unknown> {
  const { channels } = record(responseData(value).values);
  return record(record(channels).slack);
}

async function slackSelectionValue(locator: Locator): Promise<string> {
  return text(await readSlackSelection(locator));
}

export function registerDeletionAndNavigationCases(detailApp: ReturnType<typeof fileConsoleApp>) {
  test("Agent delete confirmation can be canceled without sending a write request", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Delete cancellation", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Cancel Candidate", nativeValues("keep"));
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    // A fake clock that keeps running on its own, so the check after Cancel can fire every timer
    // the page has started instead of waiting on wall-clock time (finding 1994).
    await page.clock.install();

    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
    requests.length = 0;

    await page.getByRole("button", { name: "Delete Agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Cancel Candidate?" });
    await dialog.getByText(/Agent, its version history, and its workspace data/i).waitFor();
    // Deletion keeps the Agent's Configuration and model credential Secret, which the console
    // names up front. Exact commands are available separately, without confirming the deletion.
    const harnessAuth = agent.harnessAuth;
    assert.ok(harnessAuth?.method === "api_key");
    const harnessSource = harnessAuth.source;
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    assert.equal(await cancel.evaluate((node) => node.ownerDocument.activeElement === node), true);
    await dialog
      .getByText("The Configuration and model credential Secret stay in this Namespace.")
      .waitFor();
    const cli = `occ --namespace ${namespace.id}`;
    const configuration = `${cli} configuration delete ${agent.configurationId}`;
    const secret = `${cli} secret delete ${harnessSource.id}`;
    assert.equal(await dialog.getByText(configuration, { exact: true }).isVisible(), false);
    assert.equal(await dialog.getByText(secret, { exact: true }).isVisible(), false);
    await dialog.getByText("View separate cleanup commands").press("Enter");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    for (const [kind, command] of [
      ["Configuration", configuration],
      ["Secret", secret],
    ] as const) {
      const row = dialog.locator(".agent-kept-command").filter({ hasText: command });
      await row.getByText(command, { exact: true }).waitFor();
      await row.getByRole("button", { name: `Copy ${kind} command` }).press("Enter");
      await row
        .getByRole("status")
        .filter({ hasText: /^Command copied\.$/ })
        .waitFor();
      assert.equal(await page.evaluate(() => globalThis.navigator.clipboard.readText()), command);
    }
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
    assert.equal(responseData(current).status, "active");
  });

  test("Agent delete confirmation sends the real delete API and leaves visible queued state", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Delete success", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Success Candidate", nativeValues("go"));
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);

    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
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
    assert.equal(record(record(await response.json()).data).status, "deleting");

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
    assert.equal(responseData(current).status, "deleting");

    await page.getByRole("link", { name: "← Agents" }).click();
    await page.getByRole("heading", { name: "Agents" }).waitFor();
    await page
      .getByRole("row")
      .filter({ hasText: "Success Candidate" })
      .getByText("Deleting", { exact: true })
      .waitFor();
  });

  test("A deletion status denial closes an open repeat confirmation without sending it", (t) =>
    checkScopedDeletionEnd(t, { moveFocusDuringPoll: false }));

  test("A deletion status poll that ends scoped access respects focus moved during the read", (t) =>
    checkScopedDeletionEnd(t, { moveFocusDuringPoll: true }));

  async function checkScopedDeletionEnd(
    t: TestContext,
    { moveFocusDuringPoll }: { moveFocusDuringPoll: boolean },
  ) {
    const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["scoped-deleter"] });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Delete scoped", { ready: true });
    const agent = await fixture.createAgent(
      namespace.id,
      "Scoped Candidate",
      nativeValues("scoped"),
    );
    const person = fixture.provisionedAccounts[0];
    assert.ok(person);
    const policyPath = `/namespaces/${namespace.id}/iam`;
    const bind = async (
      permissions: Permission[],
      resourceKind: ResourceKind,
      targetId: string,
    ) => {
      const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
      assert.equal(role.status, 201);
      const binding = await fixture.request("POST", `${policyPath}/access-bindings`, {
        body: {
          subjectKind: "identity",
          subjectId: person.principal.id,
          roleId: resourceId(role.data),
          resourceKind,
          resourceId: targetId,
        },
      });
      assert.equal(binding.status, 201);
      return { id: resourceId(binding.data) };
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

    // An administrator removes the member’s grant while cleanup is still pending. In the dialog
    // case the member has opened the repeat confirmation, but has not confirmed a second request.
    const repeatDialog = page.getByRole("dialog", {
      name: "Request deletion again for Scoped Candidate?",
    });
    if (moveFocusDuringPoll) {
      await page.getByRole("button", { name: "Refresh deletion status" }).focus();
    } else {
      await page.getByRole("button", { name: "Request deletion again", exact: true }).click();
      await repeatDialog.getByRole("button", { name: "Cancel", exact: true }).waitFor();
    }
    const removed = await fixture.request(
      "DELETE",
      `${policyPath}/access-bindings/${agentBinding.id}`,
    );
    assert.ok([200, 204].includes(removed.status), `binding removal answered ${removed.status}`);
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
    // Wait for the page to handle the denial, even if a stale modal still makes the page inert.
    await page
      .getByText(
        "You can no longer read this Agent’s status, so this page cannot tell whether cleanup has finished.",
        { exact: false },
      )
      .waitFor({ state: "attached" });
    assert.equal(
      await repeatDialog.isVisible(),
      false,
      "the stale deletion confirmation must close",
    );
    assert.equal(
      agentDeleteRequests(requests, namespace.id, agent.id).length,
      1,
      "only the original deletion was requested",
    );
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Refresh deletion status" }).count(), 0);
    assert.equal(await expectedFocus.evaluate((node) => node.matches(":focus")), true);

    // Polling stops: no further reads, however long the page stays open.
    const settled = reads();
    await page.clock.runFor(DELETION_POLL_MS * 3);
    assert.equal(reads(), settled);
    assert.equal(responseData(await fixture.request("GET", agentPath)).status, "deleting");
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
      await replyWithDifferentAgentId(route, agent.id, 202);
    });

    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    await page.getByRole("heading", { name: "Uncertain Candidate" }).waitFor();
    requests.length = 0;

    await page.getByRole("button", { name: "Delete Agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Uncertain Candidate?" });
    await dialog.getByText(/Agent, its version history, and its workspace data/i).waitFor();
    await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();

    await page.getByText("Outcome unknown. Deletion may have started.").waitFor();
    const remove = page.getByRole("button", { name: "Delete Agent" });
    assert.equal(await remove.isDisabled(), true);
    // Delete waits for Refresh deletion status. It stays in the Tab order, described by the alert
    // that says so, and sends nothing (finding 2935).
    const alert = page.locator("#agent-deletion-error");
    await expectReachableReason(page, remove, (await alert.textContent())?.trim());
    assert.equal(interceptedDeletes, 1);
    assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
    const deleting = await fixture.request("GET", deletePath);
    assert.equal(responseData(deleting).status, "deleting");

    // A read for a different Agent cannot unlock another destructive request either.
    await page.route(
      fixture.origin + deletePath,
      (route) => replyWithDifferentAgentId(route, agent.id, 200),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Refresh deletion status" }).click();
    await page.getByText("Could not refresh deletion status.").waitFor();
    assert.equal(await remove.isDisabled(), true);
    await expectReachableReason(page, remove, (await alert.textContent())?.trim());

    const refresh = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${deletePath}` &&
        response.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Refresh deletion status" }).click();
    assert.equal((await refresh).status(), 200);
    await page.getByRole("status").getByText("Deletion was requested").waitFor();
    // The confirmed read clears the wait: the repeat is offered, with no stale reason.
    const repeat = page.getByRole("button", { name: "Request deletion again", exact: true });
    await waitForEnabled(repeat);
    assert.deepEqual(
      await repeat.evaluate((node) => ({
        ariaDisabled: node.getAttribute("aria-disabled"),
        describedby: node.getAttribute("aria-describedby"),
      })),
      { ariaDisabled: null, describedby: null },
    );
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
    assert.equal(responseData(await fixture.request("GET", path)).status, "deleting");
  });

  test("Repeat deletion preserves bounded retry ownership feedback and ordinary denial guidance", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Retry refusal feedback", {
      ready: true,
    });
    const agent = await fixture.createAgent(namespace.id, "Owned cleanup", nativeValues("repeat"));
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    assert.equal((await fixture.request("DELETE", path)).status, 202);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
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
    await expectNoText(page, askForGrant("Agent delete on it"), () => waitForIdleFetches(page));
    assert.equal(writes, 1);
    await page.clock.fastForward(DELETION_POLL_MS * 2);
    await page.getByRole("alert").getByText(ownership, { exact: true }).waitFor();
    assert.equal(writes, 1);
    serverMessage = GENERIC_DENIAL;
    await confirm();
    await page
      .getByRole("alert")
      .getByText(deleteRefused("Owned cleanup"), { exact: false })
      .waitFor();
    assert.equal(writes, 2);
    await page.clock.fastForward(DELETION_POLL_MS * 2);
    await page
      .getByRole("alert")
      .getByText(deleteRefused("Owned cleanup"), { exact: false })
      .waitFor();
    await page.getByRole("button", { name: "Refresh deletion status", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "hidden" });
    assert.equal(writes, 2);
    assert.equal(responseData(await fixture.request("GET", path)).status, "deleting");
  });

  // The API's 400 and 409 answers for Stop (contractMessage and occ's stopAgent). Stop has no form,
  // so a schema refusal does not ask to check entered values; a typed 409 shows the API's sentence;
  // a conflict the API does not explain keeps the page's own sentence (findings 2538, 2561).
  test("Agent page Stop shows the API's 400 and 409 reasons", async (t) => {
    for (const [label, status, serverMessage, text] of [
      ["schema", 400, "The request does not match the operation contract.", MALFORMED_REQUEST],
      [
        "typed conflict",
        409,
        "The Agent lifecycle changed during stop.",
        "The Agent lifecycle changed during stop. Refresh stop status before trying again.",
      ],
      [
        "generic conflict",
        409,
        RESOURCE_CONFLICT,
        "This Agent lifecycle changed while stopping. Refresh stop status before trying again.",
      ],
    ] as const) {
      await t.test(label, async (t) => {
        const fixture = await detailApp(t);
        const namespace = await fixture.createNamespace(`Refused stop ${label}`, {
          ready: true,
        });

        const agent = await fixture.createAgent(namespace.id, "Refused stop", nativeValues("stop"));

        const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
        const { page } = await newPage(t, fixture);
        await trackSettledFetches(page);
        await page.route(
          `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop`,
          (route) =>
            route.fulfill(
              apiErrorResponse(
                status,
                status === 400 ? "INVALID_REQUEST" : "RESOURCE_CONFLICT",
                serverMessage,
              ),
            ),
        );
        await login(
          page,
          fixture,
          detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
        );
        const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
        await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Stop this Agent?" })
          .getByRole("button", { name: "Stop Agent" })
          .click();
        await stopRegion.getByText(text, { exact: false }).waitFor();
        await expectNoText(page, /entered values/, () => waitForIdleFetches(page));
      });
    }
  });

  test("failed repeat deletion preserves feedback when a poll was rearmed during its request", async (t) => {
    // The API's 400 and 409 answers for this route (contractMessage and occ's deleteAgent). Delete
    // has no form, so a schema refusal does not ask to check entered values, and the API's typed
    // 409 sentence shows with the step that recovers (finding 2538).
    for (const [status, text, guarded, serverMessage] of [
      [400, MALFORMED_REQUEST, false, "The request does not match the operation contract."],
      [
        409,
        "The Agent lifecycle changed during deletion. Refresh deletion status before trying again.",
        true,
        "The Agent lifecycle changed during deletion.",
      ],
      [429, "Too many requests. Wait before trying again.", false],
    ] as const) {
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
        const { promise: gate, resolve: release } = deferred<void>();
        t.after(() => release());
        const { promise: pending, resolve: entered } = deferred<void>();
        let writes = 0;
        await page.route(fixture.origin + path, async (route) => {
          if (route.request().method() !== "DELETE") {
            await route.continue();
            return;
          }
          writes += 1;
          entered();
          await gate;
          // The Agent DELETE route sends 400 and 409 itself; it has no 429, which comes from a
          // rate limit in front of the API.
          await route.fulfill(
            status === 429
              ? proxyErrorResponse(429)
              : apiErrorResponse(
                  status,
                  status === 409 ? "RESOURCE_CONFLICT" : "INVALID_REQUEST",
                  serverMessage,
                ),
          );
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

  async function checkRepeatDuringRead(
    t: TestContext,
    { endsAccess, readFails = false }: { endsAccess: boolean; readFails?: boolean },
  ) {
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
    const { promise: gate, resolve: release } = deferred<void>();
    t.after(() => release());
    const { promise: pending, resolve: entered } = deferred<void>();
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
          "Deletion was accepted. You can no longer read this Agent’s status, so this page cannot tell whether cleanup has finished.",
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
    const namespace = await fixture.createNamespace("Repeat deletion uncertainty", {
      ready: true,
    });
    const agent = await fixture.createAgent(
      namespace.id,
      "Uncertain repeat",
      nativeValues("repeat"),
    );
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
    await trackSettledFetches(page);
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
    await expectNoText(page, "may have been deleted", () => waitForIdleFetches(page));
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
    const reads = (namespaceId: string) =>
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
    await trackSettledFetches(page);
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
    await expectNoText(page, "may have been deleted", () => waitForIdleFetches(page));
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
    const limited = await fixture.createNamespaceMember(
      "agent-delete-denied",
      namespace.id,
      AGENT_READ,
    );
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

    // The page names the Agent and the grant the delete checked, not the API's Agent ID
    // (findings 2534, 2951).
    await page.getByText(deleteRefused("Denied Candidate"), { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
    assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
    assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
    const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.equal(responseData(current).status, "active");
  });
}

export function registerSettingsRefocusAndTabsCases(detailApp: ReturnType<typeof fileConsoleApp>) {
  for (const [dmPolicy, groupPolicy, enterpriseOrgInstall] of [
    ["pairing", "allowlist"],
    ["open", "open"],
    ["disabled", "disabled"],
    [undefined, undefined],
    ["disabled", "allowlist", true],
  ] as const) {
    test(`Slack channel editing preserves ${dmPolicy ?? "omitted"} DM and ${groupPolicy ?? "omitted"} group policies${enterpriseOrgInstall ? " on an organization-wide install" : ""}`, async (t) => {
      const fixture = await detailApp(t);
      const namespace = await fixture.createNamespace(
        `Slack policy editing ${dmPolicy ?? "omitted"} ${groupPolicy ?? "omitted"}${enterpriseOrgInstall ? " organization" : ""}`,
        { ready: true },
      );

      const appSecret = await fixture.createSecret(namespace.id, "Slack app token", "xapp-policy");

      const botSecret = await fixture.createSecret(namespace.id, "Slack bot token", "xoxb-policy");

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
        {
          executionMode: "dedicated",
          secretBindings: {
            SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
            SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
          },
        },
      );

      const { page } = await newPage(t, fixture);
      const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
      await login(page, fixture, url);
      const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
      await edit.waitFor();
      await waitForEnabled(edit);
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
        assert.deepEqual(slackSettings(unchanged), slack);
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
      assert.deepEqual(slackSettings(configuration), {
        ...slack,
        channels: {
          CKEEP123: { requireMention: false, users: ["UKEEP123"] },
          CNEW123: { requireMention: false, users: ["UKEEP123"] },
        },
      });
      const plugins = record(record(responseData(configuration).values).plugins);
      const knowledge = record(record(plugins.entries).knowledge);
      assert.equal(record(knowledge.config).marker, "policy-preservation");
    });
  }

  // The Configuration card's Model row reads agents.defaults.model in both shapes the native
  // Configuration accepts: a model reference, or an object that names the primary model.
  test("The Configuration card names the model given as a reference or as a primary model", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Model summary", { ready: true });
    const { page } = await newPage(t, fixture);
    const values = nativeValues("model-summary");
    const reference = values.agents.defaults.model;
    assert.equal(typeof reference, "string");
    const shapes = [
      ["reference", reference],
      ["primary model", { primary: reference }],
    ] as const;
    for (const [index, [shape, model]] of shapes.entries()) {
      const agent = await fixture.createAgent(namespace.id, `Model ${shape} Agent`, {
        ...values,
        agents: { ...values.agents, defaults: { ...values.agents.defaults, model } },
      });

      const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
      if (index === 0) {
        await login(page, fixture, url);
      } else {
        await page.goto(String(url));
      }
      await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
      assert.equal(
        await page.locator('.configuration-summary dt:text-is("Model") + dd').textContent(),
        reference,
        `Model row for a ${shape}`,
      );
    }
  });

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
    await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 3));
    const editorNode = await editor.elementHandle();
    assert.ok(editorNode);
    const selectorNode = await page.locator(".revision-selector").elementHandle();
    assert.ok(selectorNode);
    const newNamespace = await fixture.createNamespace("New on refocus", { ready: true });

    assert.equal(
      await page.locator(`#namespace-selector option[value="${newNamespace.id}"]`).count(),
      0,
    );
    const requests = apiRequests(page, fixture.origin);
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const { promise: sessionGate, resolve: releaseSession } = deferred<void>();
    t.after(() => releaseSession());
    const { promise: sessionHeld, resolve: sessionReached } = deferred<void>();
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
      await editor.evaluate((node: HTMLTextAreaElement) => [
        node === node.ownerDocument.activeElement,
        node.selectionStart,
      ]),
      [true, 3],
    );
    assert.equal(await page.getByText("Loading configuration…", { exact: true }).count(), 0);
    await page.unroute(`${fixture.origin}/api/auth/session`);

    // Refocus must not cancel a Configuration save that already reached the browser API.
    const { promise: saveGate, resolve: releaseSave } = deferred<void>();
    t.after(() => releaseSave());
    const { promise: saveHeld, resolve: saveReached } = deferred<void>();
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

  // A link to a tab this version or this reader does not have silently showed Configuration and
  // kept tab=… in the address (finding 2552). The page now names the tab and why, shows
  // Configuration, and drops the note once another tab is chosen. The address then names
  // Configuration, so a reload or a shared link does not repeat the note (finding 2567).
  test("a link to an unavailable Agent tab names it and shows Configuration", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Unavailable tab links", {
      ready: true,
    });
    const agent = await fixture.createAgent(namespace.id, "Tab link Agent", nativeValues("tabs"));
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    const reader = await fixture.createNamespaceMember("tab-reader", namespace.id, AGENT_READ);
    const notice = (page: Page) => page.locator(".agent-tab-notice");
    for (const [revisionId, tab, text] of [
      [
        revision.id,
        "credentials",
        "The Credentials tab is on the version draft only. Showing Configuration.",
      ],
      [
        revision.id,
        "repositories",
        "The Repositories tab is on the version draft only. Showing Configuration.",
      ],
      ["draft", "logs", "The Logs tab is on deployed versions only. Showing Configuration."],
      [
        "draft",
        "access",
        "The Access tab needs Installation administration, which your access does not include. Showing Configuration.",
      ],
      ["draft", "bogus", "This Agent has no “bogus” tab. Showing Configuration."],
    ] as const) {
      const { page } = await newPage(t, fixture);
      await trackSettledFetches(page);
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, revisionId, tab),
        reader.credentials,
      );
      await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
      await notice(page).getByText(text, { exact: true }).waitFor();
      assert.equal(await notice(page).getAttribute("role"), "status");
      // The address names the tab shown, in place: the page and its note stay.
      await page.waitForURL((url) => url.searchParams.get("tab") === "configuration");
      assert.equal(new URL(page.url()).searchParams.get("revision"), revisionId);
      await notice(page).getByText(text, { exact: true }).waitFor();
      if (tab === "bogus") {
        // A reload opens Configuration from the corrected address, without the note.
        await page.reload();
        await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
        await waitForIdleFetches(page);
        assert.equal(await notice(page).isHidden(), true);
        continue;
      }
      // Choosing a tab answers the note.
      await page.getByRole("tab", { name: "Plugins", exact: true }).click();
      await page.getByRole("tab", { name: "Plugins", selected: true }).waitFor();
      assert.equal(await notice(page).isHidden(), true);
    }
    // A tab the reader has, or an empty tab, shows no note.
    for (const tab of ["plugins", ""]) {
      const { page } = await newPage(t, fixture);
      await trackSettledFetches(page);
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", tab),
        reader.credentials,
      );
      await page
        .getByRole("tab", { name: tab ? "Plugins" : "Configuration", selected: true })
        .waitFor();
      await waitForIdleFetches(page);
      assert.equal(await notice(page).isHidden(), true);
    }
  });

  // Only Logs noticed a revoke mid-session: a member whose Agent grant was removed was refused on
  // Workspace files, then went back to Configuration and saw the Configuration read before the
  // revoke, with no notice (finding 2568). A refusal on any tab of a read the page had the grant
  // for now makes the next tab change read the page again, which the API refuses.
  test("a tab refused after a revoke makes the next tab change read the page again", async (t) => {
    // Workspace files served from memory: this checks the console and API authorization, not a
    // live Agent gateway.
    const fixture = await createConsoleAppFixture(t, {
      publicOrigin: true,
      workspaceFilesAccess: {
        async read({ filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
          return { status: "ok", file: { name: filename, content: `${filename} contents` } };
        },
      },
    });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Revoked tab reads", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Revoked tabs Agent", nativeValues("rt"));
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    const member = await fixture.createNamespaceMember("revoked-tabs", namespace.id, AGENT_READ);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const requests = apiRequests(page, fixture.origin);
    const agentReads = () =>
      pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}`).length;
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
      member.credentials,
    );
    await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
    await page.locator(".version-selection-notice").waitFor();
    await waitForIdleFetches(page);

    // Configuration's read of the bound Secret, which an Agent reader may not read, is refused.
    // The page never had that grant, so tab changes still reuse the tabs read before.
    const readsBefore = agentReads();
    for (const name of ["Plugins", "Configuration"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await page.getByRole("tab", { name, selected: true }).waitFor();
    }
    await waitForIdleFetches(page);
    assert.equal(agentReads(), readsBefore, "tab changes do not read the page again");

    // An administrator removes the member's Agent read. The Workspace files read is refused.
    revokeMemberGrant(fixture, "revoked-tabs", ["read", "agent"]);
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url() ===
          `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`,
    );
    await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
    assert.equal((await refused).status(), 403);
    await waitForIdleFetches(page);

    // Back on Configuration, the page reads the Agent again and shows the refusal, not the
    // Configuration it read before the revoke.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
    assert.equal(await page.locator(".agent-tabs").count(), 0);
    assert.equal(await page.locator(".version-selection-notice").count(), 0);
  });

  // Returning to an open Agent page rechecks the Agent, its versions and the shown version in
  // place. Those are three grants, so a refusal shows the one the API names instead of "You do not
  // have permission to read this Agent, its versions, or its Configuration" (finding D753).
  test("A refused recheck of an open Agent page names the grant the API checked", async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Refused recheck", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Refused recheck", nativeValues("rr"));
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    const member = await fixture.createNamespaceMember("refused-recheck", namespace.id, AGENT_READ);
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
      member.credentials,
    );
    await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
    revokeMemberGrant(fixture, "refused-recheck", ["read", "agent"]);
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    );
    await page.evaluate(() => {
      globalThis.dispatchEvent(new Event("focus"));
      globalThis.document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal((await refused).status(), 403);
    await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
    await page
      .getByText(callerDenied("Agent read", `Agent ${agent.id}`), { exact: true })
      .waitFor();
  });

  // Finding D799. A refocus rechecks the session, the Agent and its versions, and reads the shown
  // version again only when the page had it on screen. A version the page proved unreadable on load
  // is not read again: that read would add an audited denial per refocus and its refusal would
  // replace the page with "Access denied". One the page showed and that is revoked since is still
  // taken off the page, current version or not (finding 2913).
  test("A refocus does not read again a version the Agent page proved unreadable", async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Unreadable refocus", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Unreadable refocus", nativeValues("ur"));
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const requests = apiRequests(page, fixture.origin);
    const versionDenials = () =>
      records(authorizationDenials(fixture.auditSink, "openclaw.agent_revisions.read")).length;
    const accessDenied = page.getByRole("heading", { name: "Access denied", exact: true });
    // Returns the paths this refocus check sent, once the page is idle again. It waits for the
    // check to send its version list read, not for that read's answer: the list read and the shown
    // version's read go out together, and when the version's refusal settles first the page shows
    // it and abandons the list read, which then gets no response (finding 2983).
    async function refocus() {
      const sent = requests.length;
      const listed = page.waitForRequest(
        (request) => new URL(request.url()).pathname === `${path}/revisions`,
      );
      await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
      await listed;
      await waitForIdleFetches(page);
      return requests.slice(sent).map((request) => request.path);
    }

    // The current version v2 is readable and shown, opened without ?revision. Revoked since, the
    // newest page of versions leaves it out too, but the page had it on screen: a refocus still
    // reads it and takes it off the page (finding 2913).
    await login(page, fixture, `/console/agents/${agent.id}?namespace=${namespace.id}`);
    await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
    await waitForIdleFetches(page);
    denyRevisionRead(fixture, namespace, second.revision);
    assert.ok((await refocus()).includes(`${path}/revisions/${second.revision.id}`));
    await accessDenied.waitFor();
    assert.equal(versionDenials(), 1);

    // Opened again, the newest page of versions lists every version this reader can read and leaves
    // the current version out, so the page reads it neither on load (finding D791) nor on any
    // refocus, and keeps its tabs.
    await page.goto(detailUrl(fixture, namespace.id, agent.id).href);
    await page.getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true }).waitFor();
    await waitForIdleFetches(page);
    for (let check = 0; check < 2; check += 1) {
      const sent = await refocus();
      assert.ok(sent.includes(path), "the refocus check reads the Agent again");
      assert.equal(sent.filter((sentPath) => sentPath.startsWith(`${path}/revisions/`)).length, 0);
    }
    await page.getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true }).waitFor();
    assert.equal(await accessDenied.count(), 0);
    assert.equal(await page.locator(".agent-tabs").count(), 1);
    assert.equal(versionDenials(), 1);

    // v1 is readable and shown. Revoked since, a refocus finds it and takes it off the page.
    const olderPath = `${path}/revisions/${first.revision.id}`;
    await page.goto(
      detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration").href,
    );
    await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
    await waitForIdleFetches(page);
    denyRevisionRead(fixture, namespace, first.revision);
    assert.ok((await refocus()).includes(olderPath));
    await accessDenied.waitFor();
    assert.equal(versionDenials(), 2);

    // Opened again, the page shows v1's refusal. A refocus keeps it without another refusal: v1 is
    // not the current version, so this tab's settled refusal is the proof.
    await page.goto(
      detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration").href,
    );
    await page.getByRole("heading", { name: "Unreadable refocus", exact: true }).waitFor();
    await waitForIdleFetches(page);
    const denials = versionDenials();
    const tabs = await page.locator(".agent-tabs").count();
    assert.equal(await accessDenied.count(), 0);
    assert.equal((await refocus()).includes(olderPath), false);
    assert.equal(await accessDenied.count(), 0);
    assert.equal(await page.locator(".agent-tabs").count(), tabs);
    assert.equal(versionDenials(), denials);
  });

  for (const kind of ["agent", "configuration", "namespace"] as const) {
    test(`Agent detail refocus removes a revision when ${kind} access is revoked`, async (t) => {
      const fixture = await detailApp(t);
      const namespace = await fixture.createNamespace(`Revision access revoked ${kind}`, {
        ready: true,
      });

      const agent = await fixture.createAgent(namespace.id, "Revoked revision Agent");

      const { page } = await newPage(t, fixture);
      await trackSettledFetches(page);
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
      if (kind === "namespace") {
        // The page listed this Namespace earlier in the sign-in, so access was lost (finding 2550).
        const unavailable = NAMESPACE_UNAVAILABLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await page.getByText(new RegExp(`^${unavailable}`)).waitFor();
      }
      await expectNoText(page, /Configuration draft|Open draft|Revoked revision Agent/, () =>
        waitForIdleFetches(page),
      );
    });
  }

  test("Agent detail refocus clears a revision after session expiry", async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Revision session expired", {
      ready: true,
    });
    const agent = await fixture.createAgent(namespace.id, "Expired revision Agent");
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
    await login(page, fixture, url);
    await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
    // The refocus check, not a late read of the view, must find the expiry.
    await expireSessionsWhenSettled(page, fixture);

    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await page.getByText("Your session has expired").waitFor();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await expectNoText(page, /Configuration draft|Open draft|Expired revision Agent/, () =>
      waitForIdleFetches(page),
    );
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
        revision = (await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined))
          .revision.id;
      }
      const tab = variant === "sharing" ? "access" : variant;
      const { page } = await newPage(t, fixture);
      await trackSettledFetches(page);
      const url = detailUrl(fixture, namespace.id, agent.id, revision, tab);
      await login(page, fixture, url);
      await page.getByRole("heading", { name: `Refocus ${variant} Agent` }).waitFor();
      if (variant === "sharing") {
        const panel = page.getByRole("region", { name: "Share Agent", exact: true });
        await panel.getByLabel("Existing person’s Principal ID").fill("typed-principal");
      } else {
        await page.locator(".content form:not(.agent-access-form)").first().waitFor();
      }
      // The refocus check, not a late read of the view, must find the expiry.
      await expireSessionsWhenSettled(page, fixture);

      await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
      await page.getByText("Your session has expired").waitFor();
      await expectNoText(page, new RegExp(`Refocus ${variant} Agent`), () =>
        waitForIdleFetches(page),
      );
    });
  }

  test("Agent detail history navigation rechecks session during refocus", async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Revision history refocus", {
      ready: true,
    });
    const agent = await fixture.createAgent(namespace.id, "History refocus Agent");
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
    await login(page, fixture, url);
    await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Plugins", exact: true }).click();
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();

    const { promise: gate, resolve: releaseSession } = deferred<void>();
    t.after(() => releaseSession());
    const { promise: held, resolve: sessionReached } = deferred<void>();
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
    // The held session check and the history navigation, not a late read of the view, must find
    // the expiry.
    await expireSessionsWhenSettled(page, fixture, { except: "/api/auth/session" });
    await page.goBack();
    await page.getByText("Your session has expired").waitFor();
    await expectNoText(page, /Configuration draft|Open draft|History refocus Agent/);
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
    assert.ok(secretElement);
    await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
    await page.getByText(WORKSPACE_FILES_UNAVAILABLE).waitFor();
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
    assert.ok(panels[0]);
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
    await page.getByRole("heading", { name: "Live Agent workspace", exact: true }).waitFor();
    assert.equal(await page.locator("#revision-selector").isHidden(), true);
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
    assert.ok(tabs);
    const { promise: gate, resolve: release } = deferred<void>();
    t.after(() => release());
    const { promise: held, resolve: reached } = deferred<void>();
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
    await page.getByRole("heading", { name: "Live Agent workspace", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "Workspace files", exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Configure Slack", exact: true }).count(),
      0,
    );
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
    const agent = await fixture.createAgent(
      namespace.id,
      "Tab keyboard Agent",
      nativeValues("keys"),
    );
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
      "Deployment",
      "Access",
    ];
    assert.deepEqual(await list.getByRole("tab").allTextContents(), names);
    // Which tab is selected, which one is the Tab stop, which has focus, and the URL's tab=.
    const state = () =>
      page.evaluate(() => {
        const document = globalThis.document;
        const tabs = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
        const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
        const activeElement = document.activeElement;
        const selectedTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
        const labelId = panel?.getAttribute("aria-labelledby");
        if (!panel || !activeElement || !selectedTab || !labelId) {
          throw new Error("Expected an active element and a labelled, selected tab panel");
        }
        return {
          selected: tabs
            .filter((tab) => tab.getAttribute("aria-selected") === "true")
            .map((tab) => tab.textContent),
          stops: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.textContent),
          focused: activeElement.closest('[role="tablist"]') ? activeElement.textContent : null,
          panel: document.getElementById(labelId)?.textContent,
          controls:
            tabs.every((tab) => {
              const controls = tab.getAttribute("aria-controls");
              return controls !== null && document.getElementById(controls);
            }) && selectedTab.getAttribute("aria-controls") === panel.id,
          tab: new URL(globalThis.location.href).searchParams.get("tab"),
        };
      });
    const expect = async (
      expected: { selected: string[]; stops: string[]; focused: string | null; tab: string },
      message = "",
    ) =>
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
    ] as const) {
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
    await page.waitForFunction(() => {
      const strip = globalThis.document.querySelector(".agent-tabs");
      if (!strip) {
        throw new Error("Expected the Agent tab strip");
      }
      return strip.hasAttribute("data-more-after");
    });
    assert.deepEqual(await edges(), { before: false, after: true, masked: true });
    // Back moves focus with the selection, and a focused tab stays in view when the strip
    // resizes, rather than the strip scrolling back to the selected tab.
    const focusedInView = () =>
      page.evaluate(() => {
        const tab = globalThis.document.activeElement;
        if (!tab) {
          throw new Error("Expected a focused tab");
        }
        const strip = tab.closest('[role="tablist"]')?.getBoundingClientRect();
        const box = tab.getBoundingClientRect();
        return {
          name: tab.textContent,
          inView: strip !== undefined && box.left >= strip.left - 1 && box.right <= strip.right + 1,
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
    await page.waitForFunction(() => {
      const strip = globalThis.document.querySelector(".agent-tabs");
      if (!strip) {
        throw new Error("Expected the Agent tab strip");
      }
      return strip.hasAttribute("data-more-before");
    });
    assert.deepEqual(await edges(), { before: true, after: false, masked: true });
    // Include enough desktop width for the additional policy tab to fit without scrolling.
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.waitForFunction(() => {
      const node = globalThis.document.querySelector(".agent-tabs");
      if (!node) {
        throw new Error("Expected the Agent tab strip");
      }
      return !node.hasAttribute("data-more-before") && !node.hasAttribute("data-more-after");
    });
    assert.equal((await edges()).masked, false, "a strip that fits does not fade");
  });
}

export function registerSharingCredentialsAndChannelsCases(
  detailApp: ReturnType<typeof fileConsoleApp>,
) {
  function assertPermission(value: unknown): asserts value is Permission {
    const entry = record(value);
    assert.ok(PERMISSION_ACTIONS.some((action) => action === entry.action));
    assert.ok(isResourceKind(entry.resourceKind));
  }

  function assertRole(value: unknown): asserts value is Role {
    const entry = record(value);
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.namespaceId === undefined || typeof entry.namespaceId === "string");
    assert.ok(entry.name === undefined || typeof entry.name === "string");
    assert.ok(Array.isArray(entry.permissions));
    entry.permissions.forEach(assertPermission);
  }

  function readRole(value: unknown): Role {
    assertRole(value);
    return value;
  }

  function assertBinding(value: unknown): asserts value is AccessBinding {
    const entry = record(value);
    for (const field of ["id", "subjectId", "roleId"]) {
      assert.equal(typeof entry[field], "string");
    }
    assert.ok(entry.subjectKind === "identity" || entry.subjectKind === "group");
    assert.ok(entry.namespaceId === undefined || typeof entry.namespaceId === "string");
    assert.ok(entry.resourceId === undefined || typeof entry.resourceId === "string");
    assert.ok(entry.resourceKind === undefined || isResourceKind(entry.resourceKind));
  }

  function bindingsFrom(value: unknown): AccessBinding[] {
    assert.ok(Array.isArray(value));
    return value.map((entry: unknown) => {
      assertBinding(entry);
      return entry;
    });
  }

  type DirectoryBody = Omit<ChannelDirectoryLookupInput, "token"> & {
    secretId: string;
    configurationId?: string;
    agentId?: string;
  };

  function assertDirectoryBody(value: unknown): asserts value is DirectoryBody {
    const entry = record(value);
    assert.equal(typeof entry.secretId, "string");
    assert.ok(entry.kind === "users" || entry.kind === "channels");
    for (const field of ["query", "cursor", "configurationId", "agentId"]) {
      assert.ok(entry[field] === undefined || typeof entry[field] === "string");
    }
    if (entry.ids !== undefined) {
      assert.ok(Array.isArray(entry.ids));
      assert.ok(entry.ids.every((id: unknown) => typeof id === "string"));
    }
  }

  function directoryBody(value: unknown): DirectoryBody {
    assertDirectoryBody(value);
    return value;
  }

  test("Agent sharing reconciles a truncated committed response without replaying writes", async (t) => {
    let loseAgentBindingResponse = true;
    const fixture = await createConsoleAppFixture(t, {
      provisionedPeople: ["response-recipient"],
      async onSend(
        request: { method: string; url: string },
        reply: { statusCode: number },
        payload: string,
      ) {
        if (
          loseAgentBindingResponse &&
          request.method === "POST" &&
          request.url.endsWith("/iam/access-bindings") &&
          reply.statusCode === 201 &&
          record(record(JSON.parse(payload)).data).resourceKind === "agent"
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
    const agent = await fixture.createAgent(
      namespace.id,
      "Recovery Agent",
      nativeValues("recovery"),
    );
    const person = fixture.provisionedAccounts[0];
    assert.ok(person);
    const { page, artifacts } = await newPage(t, fixture);
    await trackSettledFetches(page);
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
      records(
        (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data,
      ).map((item) => item.id),
      [agent.id],
    );
    await panel.getByRole("button", { name: "Refresh sharing" }).click();
    await panel.getByText("Current policy loaded.", { exact: false }).waitFor();
    assert.equal(writes().length, 4);
    await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
    await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
    assert.equal(writes().length, 4);
    const policyPath = `/namespaces/${namespace.id}/iam`;
    assert.equal(records((await fixture.request("GET", `${policyPath}/roles`)).data).length, 2);
    assert.equal(
      records((await fixture.request("GET", `${policyPath}/access-bindings`)).data).length,
      2,
    );
    // A sharing read must preserve global expiry handling, including private panel removal. A late
    // read that found the expiry first would remove the panel before the Refresh click.
    await expireSessionsWhenSettled(page, fixture);
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
    const viewer = await fixture.createNamespaceMember("agent-viewer", namespace.id, [
      ["read", "namespace"],
      ["read", "agent"],
    ]);
    const denials = (action: string) =>
      auditSink
        .list()
        .filter((event) => event.kind === "authorization_denial" && event.action === action).length;
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await trackSettledFetches(page);
    // A failed permission read leaves the administer answer unknown, so the native admin card asks
    // for its status as it did before the answer had that bit. With the answer it does not ask
    // (the next test).
    await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
    const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
    await login(page, fixture, detail, viewer.credentials);
    const unavailable = page.getByRole("heading", { name: "Configuration unavailable" });
    await unavailable.waitFor();
    // The viewer holds Agent read but not Configuration read: the panel names that grant.
    const draftDenied = page.getByText(
      notIncluded("reading this Agent's draft Configuration", "Configuration read"),
      { exact: true },
    );
    await draftDenied.waitFor();
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const nativeAdminPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
    const reads = (path: string) => requests.filter((request) => request.path === path).length;
    // The tab remembers a denial only once the page has read it; a reload drops a pending read.
    await waitForSettledFetches(page, nativeAdminPath, 1);
    assert.equal(reads(nativeAdminPath), 1);
    assert.equal(reads(configurationPath), 1);
    // The card settles on the denial and stays hidden: a 403 is not a failed read with Refresh.
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector(".native-admin-access [role='status']")?.textContent ===
        "",
    );
    assert.equal(await page.locator(".native-admin-access:not([hidden])").count(), 0);

    // Each denied read is an audited authorization denial; reloading the view does not repeat it.
    for (let view = 0; view < 2; view += 1) {
      await page.reload();
      await unavailable.waitFor();
      // The remembered denial names the same grant without asking again.
      await draftDenied.waitFor();
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

    // The tab keeps denials for one session owner. Signing in again after the session expired
    // starts another session, even for the same person, so its first view asks again. A late read
    // that found the expiry first would move to /console/login, and the reload would reload that.
    await expireSessionsWhenSettled(page, fixture);
    await page.reload();
    await page.getByText("Your session has expired").waitFor();
    await login(page, fixture, detail, viewer.credentials);
    await unavailable.waitFor();
    await waitForSettledFetches(page, configurationPath, 1);
    await waitForSettledFetches(page, nativeAdminPath, 1);
    assert.equal(reads(configurationPath), 3);
    assert.equal(reads(nativeAdminPath), 2);
    assert.equal(denials("openclaw.configurations.read"), 3);
    assert.equal(denials("openclaw.agents.native_admin.read"), 2);
  });

  // Native admin status needs Agent administer, and each refused read is a browser console error
  // and an audited denial. The permission answer already says the caller lacks it, so the card is
  // never asked for, on any view of the page.
  test("a viewer without Agent administer never asks for native admin status", async (t) => {
    const auditSink = new InMemoryAuditSink();
    const fixture = await createConsoleAppFixture(t, { auditSink });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Administer answer");
    const agent = await fixture.createAgent(namespace.id, "Viewed Agent", nativeValues("viewed"));
    const viewer = await fixture.createNamespaceMember("administer-viewer", namespace.id, [
      ["read", "namespace"],
      ["read", "agent"],
    ]);
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await trackSettledFetches(page);
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const nativeAdminPath = `${agentPath}/native-admin`;
    const reads = (path: string) => requests.filter((request) => request.path === path).length;
    const answer = page.waitForResponse((r) => r.url().endsWith(`${agentPath}/permissions`));
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id), viewer.credentials);
    assert.equal(record(record(await (await answer).json()).data).administer, false);
    for (let view = 0; view < 2; view += 1) {
      await page.getByRole("heading", { name: "Viewed Agent" }).waitFor();
      // The card would ask right after the answer lands; let that turn finish first.
      await waitForSettledFetches(page, `${agentPath}/permissions`, 1);
      await settlePageRequests(page);
      await waitForIdleFetches(page);
      assert.equal(reads(nativeAdminPath), 0);
      assert.equal(await page.locator(".native-admin-access:not([hidden])").count(), 0);
      await page.reload();
    }
    assert.equal(
      auditSink
        .list()
        .filter(
          (event) =>
            event.kind === "authorization_denial" &&
            event.action === "openclaw.agents.native_admin.read",
        ).length,
      0,
    );
  });

  // An Agent reader (read and read_logs, no update, operate or sandbox policy read) met 403s on the
  // Repositories, Policy denials and Logs tabs: a refused repository choices read with a danger
  // block, refused policy and suggestion reads, and a raw runtime status error with its Request ID
  // (finding 2454). Each read the permission answer says will be refused is now skipped, and the
  // tab says what the reader can see instead. The Policy denials draft view also stopped telling
  // the reader of a deployed Agent to deploy one.
  test("an Agent reader meets no refused read on Repositories, Policy denials or Logs", async (t) => {
    const runtime = await createRuntimeAuthFixture(t, "Tab reader");
    const { fixture } = runtime;
    const namespace = runtime.namespace;

    const agent = await fixture.createAgent(namespace.id, "Tab reader Agent", nativeValues("v1"), {
      harnessAuth: { method: "runtime" },
    });
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    const reader = await fixture.createNamespaceMember("tab-reader", namespace.id, [
      ...AGENT_READ,
      ["read_logs", "agent"],
    ]);
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await trackSettledFetches(page);
    const answer = page.waitForResponse((r) => r.url().endsWith(`${agentPath}/permissions`));
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"),
      reader.credentials,
    );
    const permissions = record(record(await answer.then((response) => response.json())).data);
    assert.equal(permissions.update, false);
    assert.equal(permissions.operate, false);
    assert.equal(permissions.sandboxPolicyRead, false);
    const settle = async () => {
      await settlePageRequests(page);
      await waitForIdleFetches(page);
    };

    // Repositories: the saved selection, read-only, with no choices read and no Retry or Save.
    await page
      .getByText(
        "The version draft selects no repositories. The Agent runs without repository access.",
      )
      .waitFor();
    await expectNoText(
      page,
      /repository choices for this Agent|Repository choices are not shown/,
      settle,
    );
    assert.equal(await page.getByRole("button", { name: "Retry repository choices" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Save repository access" }).count(), 0);

    // Policy denials on the draft: the denials live on the deployed versions, and the policy and
    // its suggestions are not read. The suggestions do not send the reader to the current
    // version, which refuses them too.
    await page.getByRole("tab", { name: "Policy denials", exact: true }).click();
    await page
      .getByText(
        "Policy denials come from deployed versions. Open the current version to see them.",
      )
      .waitFor();
    const noPolicyAccess = page.getByText(SANDBOX_POLICY_READ_DENIED);
    await noPolicyAccess.first().waitFor();
    await expectNoText(
      page,
      /Deploy an Agent to load Sandbox policy decisions|include reading (?:this Agent’s policy|policy suggestions|this Agent’s Sandbox logs)|Suggestions come from|No Driver configurations/,
      settle,
    );
    // The sentence names the suggestions too, so it is said once, on the network policy card: no
    // suggestions card repeats it (finding 2522).
    const sayOnce = async () => {
      assert.equal(await noPolicyAccess.count(), 1);
      assert.equal(
        await page.getByRole("heading", { name: "Policy suggestions", exact: true }).isVisible(),
        false,
      );
    };
    await sayOnce();

    // Policy denials on the current version: still no policy or suggestions read. The version
    // runs without a Sandbox, so it has no denial log either: the tab says so instead of reading
    // it and showing the 400 "no such runtime log source" (finding 2484).
    await page.goto(detailUrl(fixture, namespace.id, agent.id, active.revision.id, "policy").href);
    await noPolicyAccess.first().waitFor();
    await page
      .getByText(
        "This Agent version runs without a Sandbox, so no policy denials are recorded for it.",
        { exact: true },
      )
      .waitFor();
    await expectNoText(
      page,
      /include reading (?:this Agent’s policy|policy suggestions|this Agent’s Sandbox logs)|no such runtime log source|window: unavailable|Denials in the loaded window/,
      settle,
    );
    await sayOnce();
    // With no denial log, the window's controls could only show nothing; only the reason stays
    // (finding 2497).
    const policyTab = page.locator(".sandbox-policy");
    for (const name of ["Refresh denials", "Refresh suggestions"]) {
      assert.equal(await policyTab.getByRole("button", { name }).count(), 0, name);
    }
    assert.equal(
      await policyTab.getByRole("checkbox", { name: "Follow policy denials" }).count(),
      0,
    );
    assert.equal(
      await policyTab.getByRole("searchbox", { name: "Filter loaded denials" }).count(),
      0,
    );
    assert.deepEqual(
      requests.filter(({ path }) => path.includes("/runtime/logs")),
      [],
      "no Sandbox log read",
    );

    // Logs: the runtime status read needs Agent operate; the strip says so without a refused read.
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await page.getByText(/^Runtime status requires Agent operate/).waitFor();
    await settle();
    // The strip shows no refusal's Request ID. (This Compute Driver has no log text, a separate
    // answer that is not about access.)
    assert.doesNotMatch(
      (await page.getByText(/^Runtime status requires Agent operate/).textContent()) ?? "",
      /Request ID/,
    );

    const refused = [
      `${agentPath}/repository-options`,
      `${agentPath}/sandbox-policy/networking`,
      `${agentPath}/revisions/${active.revision.id}/sandbox-policy/networking/recommendations`,
      `${agentPath}/deployments/${active.revision.id}/runtime`,
    ];
    for (const path of refused) {
      assert.deepEqual(pathRequests(requests, "GET", path), [], path);
    }
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
              message: DEPENDENCY_UNAVAILABLE,
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
    await waitForEnabled(reload);

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
    const bindings = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/iam/access-bindings`,
    );
    assert.deepEqual(bindings.data, []);
  });

  // Commit the narrow role, then return a real, broader role from the same Namespace in its place.
  // Both sharing and credential access must stop before sending any binding request.
  async function expectBroaderCreatedRoleRefused(
    page: Page,
    requests: ReturnType<typeof apiRequests>,
    rolesPath: string,
    broader: Role,
    submit: () => Promise<void>,
  ) {
    const routePattern = `**${rolesPath}`;
    await page.route(routePattern, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const body = record(await response.json());
      const createdRole = readRole(body.data);
      assert.deepEqual(createdRole.permissions, record(route.request().postDataJSON()).permissions);
      assert.equal(createdRole.namespaceId, broader.namespaceId);
      assert.notEqual(createdRole.id, broader.id);
      assert.ok(broader.permissions.length > createdRole.permissions.length);
      await route.fulfill({ response, json: { ...body, data: broader } });
    });
    const returned = page.waitForResponse(
      (response) => response.url().endsWith(rolesPath) && response.request().method() === "POST",
    );
    await submit();
    assert.equal(await (await returned).finished(), null);
    await settlePageRequests(page);
    const bindingsPath = rolesPath.replace(/\/roles$/, "/access-bindings");
    assert.equal(
      pathRequests(requests, "POST", bindingsPath).length,
      0,
      "never bind the broader role",
    );
    assert.equal(pathRequests(requests, "POST", rolesPath).length, 1, "never repeat role creation");
    await page.unroute(routePattern);
  }

  test("Agent sharing creates exact Roles instead of reusing strict superset Roles", async (t) => {
    const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["superset-recipient"] });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Superset sharing");
    const agent = await fixture.createAgent(
      namespace.id,
      "Superset Agent",
      nativeValues("superset"),
    );
    const person = fixture.provisionedAccounts[0];
    assert.ok(person);
    const policyPath = `/namespaces/${namespace.id}/iam`;
    // Each superset contains every permission sharing needs, plus one it must not grant.
    const supersets: Role[] = [];
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
    ] as const) {
      const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      supersets.push(readRole(role.data));
    }
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
    await login(page, fixture, detail);
    const panel = page.getByRole("region", { name: "Share Agent", exact: true });
    await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
    await panel.getByRole("checkbox").check();
    const share = panel.getByRole("button", { name: "Share Agent", exact: true });
    const broaderDiscoveryRole = supersets[1];
    assert.ok(broaderDiscoveryRole);
    await expectBroaderCreatedRoleRefused(
      page,
      requests,
      `${policyPath}/roles`,
      broaderDiscoveryRole,
      () => share.click(),
    );
    await panel
      .getByText(/Refresh sharing to inspect current policy before another change/)
      .waitFor();
    assert.equal(await share.isDisabled(), true);
    // An explicit refresh and retry can reuse the narrow role that actually committed.
    await panel.getByRole("button", { name: "Refresh sharing" }).click();
    await share.click();
    await panel.getByText("Agent access is shared.", { exact: false }).waitFor();

    const roles = records((await fixture.request("GET", `${policyPath}/roles`)).data).map(readRole);
    assert.equal(roles.length, 4, "sharing must add two exact Roles beside the supersets");
    const currentBindings = bindingsFrom(
      (await fixture.request("GET", `${policyPath}/access-bindings`)).data,
    );
    assert.equal(currentBindings.length, 2);
    const grantPermissions = (resourceKind: ResourceKind) => {
      const binding = currentBindings.find((candidate) => candidate.resourceKind === resourceKind);
      assert.ok(binding);
      assert.equal(
        supersets.some((role) => role.id === binding.roleId),
        false,
        `${resourceKind} reused a superset`,
      );
      const grantedRole = roles.find((role) => role.id === binding.roleId);
      assert.ok(grantedRole);
      return grantedRole.permissions
        .map((permission) => `${permission.action}:${permission.resourceKind}`)
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

  for (const method of ["api_key", "codex_pat"] as const) {
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
        () =>
          globalThis.document.querySelector<HTMLSelectElement>("#harness-auth-method")?.disabled ===
          false,
      );
      const bindings = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/iam/access-bindings`,
      );
      const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
      const currentBindings = bindingsFrom(bindings.data);
      const grants = currentBindings.filter(
        (binding) =>
          binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
      );
      assert.equal(grants.length, 1);
      const grant = grants[0];
      assert.ok(grant);
      assert.deepEqual(grant, {
        id: grant.id,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: grant.roleId,
        resourceKind: "secret",
        resourceId: replacement.id,
      });
      assert.deepEqual(
        readRole(records(roles.data).find((role) => role.id === grant.roleId)).permissions,
        [{ action: "operate", resourceKind: "secret" }],
      );
      assert.equal(
        currentBindings.some((binding) => binding.resourceId === unrelated.id),
        false,
      );
      const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
      assert.deepEqual(responseData(saved).harnessAuth, { method, source: replacement.ref });
      // Saving the same source again repairs missing access and reuses an existing exact binding.
      await page.getByRole("button", { name: "Save authentication source" }).click();
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector<HTMLSelectElement>("#harness-auth-method")?.disabled ===
          false,
      );
      assert.deepEqual(
        (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data,
        bindings.data,
      );
    });
  }

  test("Credentials retries denied and interrupted grants without repeating the authentication save", async (t) => {
    const fixture = await createConsoleAppFixture(t);
    const installation: unknown = await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Credential access recovery", {
      ready: true,
    });

    // No model credential yet: its listed grant would leave an exact Secret operate role for the
    // console to reuse, and this test checks the role the console creates.
    const agent = await fixture.createAgent(
      namespace.id,
      "Recovery Agent",
      createHarnessConfiguration("codex", "gpt-4.1"),
      { executionMode: "dedicated", harnessAuth: null },
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
    const probe = page.waitForResponse(`${fixture.origin}/observability`);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    // The session knows this actor administers the Installation before the denial below, so it
    // sends the grant request; a member's session sends none (finding 2259).
    assert.equal((await probe).status(), 200);
    // Native IAM denies the actor's grant authority while the Agent update remains authorized.
    const deniedGrant = restrict(fixture.policy, "administer", "installation", {
      resourceId: resourceId(installation),
    });
    await page.getByLabel("Authentication source").selectOption("codex_pat");
    await selectSecret(page, "Service account token Secret", replacement);
    await page.getByRole("button", { name: "Save authentication source" }).click();
    await page
      .getByText(
        /Authentication source saved, but the request to grant this Agent access to the selected Secret was refused/,
      )
      .waitFor();
    assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
    assert.equal(pathRequests(requests, "POST", bindingsPath).length, 0);
    assert.equal(
      resourceId(record(responseData(await fixture.request("GET", agentPath)).harnessAuth).source),
      replacement.id,
    );
    // A partial save survives navigation without repeating PATCH or enabling deployment.
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "Retry credential access" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
    liftRestriction(fixture.policy, deniedGrant);
    const rolesPath = `/namespaces/${namespace.id}/iam/roles`;
    const broader = await fixture.request("POST", rolesPath, {
      body: {
        permissions: ["operate", "delete"].map((action) => ({ action, resourceKind: "secret" })),
      },
    });
    assert.equal(broader.status, 201);
    const retry = page.getByRole("button", { name: "Retry credential access" });
    await expectBroaderCreatedRoleRefused(page, requests, rolesPath, readRole(broader.data), () =>
      retry.click(),
    );
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
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
    const grants = bindingsFrom((await fixture.request("GET", bindingsPath)).data).filter(
      (binding) => binding.resourceId === replacement.id,
    );
    assert.equal(grants.length, 1);
    assert.ok(grants[0]);
    assert.equal(grants[0].subjectId, agent.servicePrincipalId);
    assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
    assert.equal(pathRequests(requests, "POST", bindingsPath).length, 1);
  });

  test("Credentials blocks repeat saves after losing an authentication PATCH response", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Unknown credential save", {
      ready: true,
    });
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
        .evaluateAll((options: HTMLOptionElement[]) => options.map((option) => option.value)),
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
      () =>
        globalThis.document.querySelector<HTMLSelectElement>("#harness-auth-method")?.disabled ===
        false,
    );
    await waitForInputValue(page.getByLabel("API key Secret"), secretOptionLabel(replacement));
    await page.getByRole("button", { name: "Save authentication source" }).click();
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector<HTMLSelectElement>("#harness-auth-method")?.disabled ===
        false,
    );
    assert.equal(
      bindingsFrom(
        (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data,
      ).some(
        (binding) =>
          binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
      ),
      true,
    );
  });

  test("authentication drafts retain Secret references and their original save baseline", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Authentication navigation", {
      ready: true,
    });
    const agent = await fixture.createAgent(
      namespace.id,
      "Authentication draft",
      nativeValues("auth"),
    );
    const secret = await fixture.createSecret(
      namespace.id,
      "Replacement key",
      "synthetic-auth-key",
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
    await login(page, fixture, url);
    await page.getByLabel("Authentication source").selectOption("api_key");
    await selectSecret(page, "API key Secret", secret);
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
    // A saved auth change must not rebase the retained local choice when the page is recreated.
    const changed = await fixture.request(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      {
        body: { configurationId: agent.configurationId, harnessAuth: null },
      },
    );
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
      await page
        .getByLabel("API key Secret", { exact: true })
        .evaluate((node: HTMLInputElement) => node.value),
      "",
    );
  });

  test("Secret summaries retain revision bindings and distinguish unreadable metadata from absent bindings", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Bound Secret summaries", {
      ready: true,
    });
    const app = await fixture.createSecret(namespace.id, "Revision Slack app", "hidden-app-value");
    const bot = await fixture.createSecret(namespace.id, "Revision Slack bot", "hidden-bot-value");
    const replacement = await fixture.createSecret(
      namespace.id,
      "Draft model",
      "hidden-model-value",
    );
    const secretBindings = {
      SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
      SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
    };
    const agent = await fixture.createAgent(namespace.id, "Bound Secrets", nativeValues("bound"), {
      secretBindings,
    });

    // Real admission requires exact Agent access to each projected credential.
    for (const secret of [app, bot, replacement]) {
      await fixture.grantAgentSecretOperate(agent, secret.ref);
    }
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    // Mutate both current owners after admission; the read-only view must keep the old references.
    await fixture.updateAgent(namespace.id, agent.id, {
      configurationId: agent.configurationId,
      harnessAuth: { method: "api_key", source: replacement.ref },
    });
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      nativeValues("changed"),
      {
        secretBindings: {},
      },
    );
    const limited = await fixture.createAccountWithPolicy(
      "secret-summary-reader",
      (principal: Pick<Principal, "id">) => {
        fixture.policy.roles.push(
          {
            id: "summary-reader",
            namespaceId: namespace.id,
            permissions: (
              ["namespace", "agent", "configuration", "agent_revision"] satisfies ResourceKind[]
            ).map((resourceKind) => ({ action: "read", resourceKind })),
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
        assert.ok(agent.harnessAuth?.method === "api_key");
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
      },
    );
    const { page, artifacts } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
    await login(page, fixture, url, limited.credentials);
    await page.getByRole("link", { name: "Auth Bound Secrets", exact: true }).waitFor();
    assert.equal(await page.getByText("Draft model", { exact: true }).count(), 0);
    await page.screenshot({ path: join(artifacts, "bound-harness-revision.png"), fullPage: true });
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByRole("link", { name: "Revision Slack app", exact: true }).waitFor();
    // The readable Secret list leaves the bot token's Secret out, so it is not read: its refusal
    // would be an audited denial (finding 2619).
    const hiddenSecret = page.getByText(BOUND_SECRET_UNLISTED, { exact: true });
    await hiddenSecret.waitFor();
    assert.equal(await hiddenSecret.getAttribute("title"), bot.id);
    assert.equal(await page.getByRole("button", { name: /Configure Slack|Edit Slack/ }).count(), 0);
    await page.screenshot({
      path: join(artifacts, "bound-channels-restricted.png"),
      fullPage: true,
    });
    assert.equal(
      requests.some((request) => request.path === `/namespaces/${namespace.id}/secrets/${bot.id}`),
      false,
    );
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    for (const value of ["hidden-app-value", "hidden-bot-value", "hidden-model-value"]) {
      const text = await page.locator("body").textContent();
      assert.ok(text !== null);
      assert.equal(text.includes(value), false);
    }
    // Active snapshots protect their Secrets even after the draft drops the bindings.
    const secretPath = `/namespaces/${namespace.id}/secrets/${app.id}`;
    assert.equal((await fixture.request("DELETE", secretPath)).status, 409);
    // Admit and select the replacement draft, leaving the viewed revision historical.
    // With no live references, a real deletion makes its bound metadata unavailable. The readable
    // list leaves a deleted Secret out too, so the summary says either may be why.
    await fixture.seedActiveAgentRevision(namespace.id, agent.id, active.revision.id);
    const deleted = await fixture.rawRequest("DELETE", secretPath, {
      headers: authenticatedHeaders(await fixture.signIn()),
    });
    assert.equal(deleted.response.status, 204);
    assert.equal((await fixture.request("GET", secretPath)).status, 404);
    await page.reload();
    await page
      .locator(`.secret-reference[title="${app.id}"]`)
      .filter({ hasText: BOUND_SECRET_UNLISTED })
      .waitFor();
    await page.getByRole("button", { name: "Open draft", exact: true }).last().click();
    await page.getByRole("tab", { name: "Channels", exact: true }).click();
    await page.getByText("No Secret bound", { exact: true }).first().waitFor();
    assert.equal(await page.getByText("No Secret bound", { exact: true }).count(), 2);
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("link", { name: "Draft model", exact: true }).waitFor();
  });

  test("Slack directory selections show names and save exact channel IDs", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Slack directory picker", {
      ready: true,
    });
    const appSecret = await fixture.createSecret(
      namespace.id,
      "Slack app token",
      "xapp-test-secret",
    );
    const botSecret = await fixture.createSecret(
      namespace.id,
      "Slack bot token",
      "xoxb-test-secret",
    );
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
    const directoryBodies: DirectoryBody[] = [];
    const releaseDirectory = deferred<void>();
    const releaseChangedQuery = deferred<void>();
    t.after(() => {
      releaseDirectory.resolve();
      releaseChangedQuery.resolve();
    });
    // The browser test owns Console selection and saved API state; only provider directory data is simulated.
    await page.route(
      `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
      async (route) => {
        const body = directoryBody(route.request().postDataJSON());
        const ids = body.ids;
        directoryBodies.push(body);
        if (body.query === "pending") {
          await releaseDirectory.promise;
        }
        if (body.query === "pending-query") {
          await releaseChangedQuery.promise;
        }
        let nextCursor;
        let candidates: ChannelDirectoryResult["candidates"];
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
              candidates: ids
                ? candidates.filter((candidate) => ids.includes(candidate.id))
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
    await channelSearch.click();
    await channelPicker.getByRole("option", { name: /existing-room.*CEXIST123/ }).waitFor();
    assert.equal(
      directoryBodies.filter((body) => body.kind === "channels" && !body.ids).length,
      1,
      "pointer focus and click start only one lookup",
    );
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
    // Escape cancels a keyboard reopen while its synthetic directory response is held.
    await channelSearch.fill("pending");
    await channelSearch.press("Escape");
    const pendingDirectory = page.waitForRequest(
      (request) =>
        request.url() === `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup` &&
        request.method() === "POST" &&
        directoryBody(request.postDataJSON()).query === "pending",
      { timeout: 10_000 },
    );
    await channelSearch.press("ArrowDown");
    assert.equal(await channelSearch.getAttribute("aria-expanded"), "true");
    const pendingRequest = await pendingDirectory;
    await channelSearch.press("ArrowDown");
    await channelSearch.press("ArrowDown");
    await page.clock.runFor(300);
    assert.equal(directoryBodies.filter((body) => body.query === "pending").length, 1);
    assert.equal(await channelSearch.getAttribute("aria-activedescendant"), null);
    const canceledRequest = page.waitForEvent(
      "requestfailed",
      (request) => request === pendingRequest,
    );
    await channelSearch.press("Escape");
    await canceledRequest;
    releaseDirectory.resolve();
    assert.equal(await channelSearch.getAttribute("aria-expanded"), "false");
    assert.equal(await channelSearch.getAttribute("aria-activedescendant"), null);
    // Changing the query also aborts the exact held request, independently of dismissal.
    const changingQuery = page.waitForRequest(
      (request) =>
        request.url() === `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup` &&
        request.method() === "POST" &&
        directoryBody(request.postDataJSON()).query === "pending-query",
      { timeout: 10_000 },
    );
    await channelSearch.fill("pending-query");
    await channelSearch.press("Enter");
    const changedQueryRequest = await changingQuery;
    const canceledByQuery = page.waitForEvent("requestfailed", {
      predicate: (request) => request === changedQueryRequest,
      timeout: 10_000,
    });
    await channelSearch.fill("general");
    await canceledByQuery;
    releaseChangedQuery.resolve();
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
    assert.equal(await channelSearch.evaluate((input) => input === document.activeElement), true);
    assert.equal(await channelSearch.inputValue(), "general");
    assert.equal(await channelSearch.getAttribute("aria-activedescendant"), null);
    const directoryPath = `/namespaces/${namespace.id}/channel-directory/lookup`;
    const directoryResponse = () =>
      page.waitForResponse(
        (response) =>
          response.url() === `${fixture.origin}${directoryPath}` &&
          response.request().method() === "POST",
      );
    const beforeReopen = pathRequests(requests, "POST", directoryPath).length;
    const reopened = directoryResponse();
    await channelSearch.press("ArrowDown");
    assert.equal((await reopened).status(), 200);
    await channelPicker.locator('[role="option"].active').waitFor();
    assert.equal(await channelSearch.getAttribute("aria-expanded"), "true");
    assert.equal(directoryBodies.filter((body) => body.query === "general").length, 3);
    assert.equal(
      await channelSearch.getAttribute("aria-activedescendant"),
      await channelPicker.getByRole("option").first().getAttribute("id"),
    );
    assert.equal(await channelSearch.evaluate((input) => input === document.activeElement), true);
    await channelSearch.press("ArrowDown");
    assert.equal(
      await channelSearch.getAttribute("aria-activedescendant"),
      await channelPicker.getByRole("option").nth(1).getAttribute("id"),
    );
    assert.equal(pathRequests(requests, "POST", directoryPath).length, beforeReopen + 1);
    await channelSearch.press("Escape");
    const clicked = directoryResponse();
    await channelSearch.click();
    assert.equal((await clicked).status(), 200);
    await channelPicker.getByRole("option", { name: /general.*CGENERAL/ }).waitFor();
    assert.equal(pathRequests(requests, "POST", directoryPath).length, beforeReopen + 2);
    assert.equal(directoryBodies.filter((body) => body.query === "general").length, 4);
    assert.equal(await channelSearch.getAttribute("aria-expanded"), "true");
    assert.equal(await channelSearch.getAttribute("aria-activedescendant"), null);
    await channelSearch.press("Tab");
    assert.equal(await channelSearch.getAttribute("aria-expanded"), "false");
    assert.equal(await channelSearch.getAttribute("aria-activedescendant"), null);
    assert.equal(await channelSearch.evaluate((input) => input === document.activeElement), false);
    assert.equal(await slackSelectionValue(channelSearch), "CEXIST123");
    assert.deepEqual(
      nonAuthWriteRequests(requests).filter((request) => request.path !== directoryPath),
      [],
    );
    await channelSearch.fill("GENERALX");
    await channelPicker.getByRole("option", { name: /GENERALX-first.*CUPPER111/ }).waitFor();
    assert.equal(await channelPicker.getByRole("option").count(), 5);
    // Seven provider matches span two display pages; neither overflow nor Previous rereads the provider.
    const initialSearchRequests = directoryBodies.filter(
      (body) => body.query === "GENERALX",
    ).length;
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
    assert.deepEqual(Object.keys(record(slackSettings(configuration).channels)), [
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
    const namespace = await fixture.createNamespace("Qualified Slack targets", {
      ready: true,
    });
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
    const dmUsers = [
      "user:UTEST123",
      "slack:UTEST124",
      "team:TTEST123:user:UTEST125",
      "@legacy-dm",
    ];
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
        const body = directoryBody(route.request().postDataJSON());
        const ids = body.ids;
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
              candidates: ids
                ? candidates.filter((candidate) => ids.includes(candidate.id))
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
    ] as const) {
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
    const persisted = slackSettings(configuration);
    const persistedChannels = record(persisted.channels);
    assert.deepEqual(Object.keys(persistedChannels), channelIds);
    for (const value of Object.values(persistedChannels)) {
      const entry = record(value);
      const users = entry.users;
      assert.ok(Array.isArray(users));
      assert.deepEqual(new Set(users), new Set(channelUsers));
      assert.equal(entry.requireMention, false);
    }
    assert.deepEqual(persisted.allowFrom, dmUsers);
  });

  test("Credentials saves an issued service account as a PAT source without granting Secret access", async (t) => {
    const fixture = await detailApp(t);
    const namespace = await fixture.createNamespace("Managed PAT source", { ready: true });

    // Issuance is outside this Console test. Seed its realistic result through State;
    // the browser still lists, selects and saves it through production API/IAM paths.
    const controller: unknown = fixture.controller;
    assert.ok(controller instanceof OpenClawController);
    const account = await controller.transact(async (state) => {
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
    assert.ok(account);
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
    await page
      .getByLabel("Issued ChatGPT service account", { exact: true })
      .selectOption(account.id);
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
      responseData(await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
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
    const runtime = await createRuntimeAuthFixture(t, "Repeat Stop");
    const { fixture, state } = runtime;
    const namespace = runtime.namespace;

    const agent = await fixture.createAgent(
      namespace.id,
      "Repeat Stop",
      nativeValues("repeat-stop"),
      { harnessAuth: { method: "runtime" } },
    );
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id, undefined);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const first = await fixture.request("POST", `${path}/stop`);
    assert.equal(first.status, 202);
    assert.equal(responseData(first).activeRevisionId, active.revision.id);
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
    assert.equal(
      await repeat.count(),
      1,
      "the existing Stop API permits another authorized intent",
    );
    await waitForEnabled(repeat);
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
    // The selected version is kept, but the Agent is already requested to stop: the confirmation
    // repeats the request and does not describe interrupting a running gateway (finding D815).
    await dialog.getByText(STOP_REPEAT_CONFIRMATION, { exact: true }).waitFor();
    const result = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `${path}/stop`,
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
    assert.equal(responseData(after).activeRevisionId, active.revision.id);
    assert.equal(responseData(after).desiredRuntimeState, "stopped");
    assert.equal(responseData(after).configurationId, agent.configurationId);
    await checkStatusRefreshFocus(page, `${fixture.origin}${path}`, "Refresh stop status");
    // No selected version does not prove candidate/history cleanup completed.
    await state.transact((unit) =>
      unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
    );
    await page.getByRole("button", { name: "Refresh stop status" }).click();
    await page.getByText(STOPPED_NO_VERSION).waitFor();
    await waitForEnabled(repeat);
    assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
    await repeat.click();
    const noSelectionResult = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `${path}/stop`,
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
      drivers: {
        sandbox: "sandbox-openshell-local",
        credential_gateway: "credential-gateway-openshell",
      },
    });
    t.after(() => backend.client.close());
    const gateway = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/openclaw"] },
      { backend },
    );
    const controller: unknown = fixture.controller;
    assert.ok(controller instanceof OpenClawController);
    controller.registerDriver(gateway);
    controller.selectDriver("credential_gateway", gateway.id);
    const input = await fixture.createSecret(
      namespace.id,
      "OpenAI source input",
      "source-browser-fixture",
    );

    // Source registration is outside this Console test. This is the ready API-key
    // source state the existing OpenClaw credential-gateway path supports.
    const source = await controller.transact((state) =>
      state.credentialSources.createCredentialSource({
        id: `cs_${randomUUID()}`,
        namespaceId: namespace.id,
        name: "OpenAI API key",
        type: "openai",
        config: {},
        secrets: { api_key: input.ref },
        ownerCapability: "credential_gateway",
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
    // No grant lets the Agent operate this source yet: the administrator's tab reads the IAM policy,
    // names the step that grants it and holds Deploy (finding 2260).
    await page
      .getByText(
        "This Agent has no access to its authentication credential source, so deploying it would be refused. Select Save authentication source to grant it.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
    const granted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/access-bindings"),
    );
    await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
    assert.equal((await granted).status(), 201);
    assert.deepEqual(
      responseData(await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
        .harnessAuth,
      harnessAuth,
    );
    const save = requests.find(
      (request) => request.method === "PATCH" && request.path.endsWith(`/agents/${agent.id}`),
    );
    assert.ok(save);
    assert.deepEqual(record(save.body).harnessAuth, harnessAuth);
    // The rebuilt tab reads the new grant: nothing is missing any more.
    await page.getByRole("status").filter({ hasText: "Authentication source saved." }).waitFor();
    assert.equal(
      await page.getByText(/has no access to its authentication credential source/).count(),
      0,
    );
  });
}

async function checkStatusRefreshFocus(page: Page, url: string, name: string) {
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
async function holdNextStatusResponse(page: Page, url: string) {
  const held = deferred<number>();
  const release = deferred<void>();
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
