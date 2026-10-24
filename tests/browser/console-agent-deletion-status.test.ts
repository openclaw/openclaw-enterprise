import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentDeletionStatusResponse } from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { verifyConsoleAgentDeletion } from "../helpers/console-agent-deletion.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { stopQaAgentForCleanup } from "../helpers/qa-repository.mjs";
import {
  apiRequests,
  detailUrl,
  expireSessions,
  login,
  loginThroughForm,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  settlePageRequests,
} from "./console-agents-browser-helpers.mjs";

test("the Console confirms deletion and reloads its receipt after the Agent and its grants are removed", async (t) => {
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { state, recordOperations: true });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Follow deletion", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Follow deletion to completion",
    nativeValues("delete"),
  );
  const { page } = await newPage(t, fixture);
  const agents = "/console/agents?namespace=" + namespace.id;
  await loginThroughForm(page, fixture, agents);
  const browser = page.context();
  const search = page.getByRole("searchbox", { name: "Search Agents" });
  const receipt = await verifyConsoleAgentDeletion(browser, fixture.origin, agent, async () => {
    // Exercise the other scenario's page while the deletion page is following its receipt.
    // They share this sign-in, but neither may navigate or close the other's page.
    assert.equal(browser.pages().length, 2);
    await search.fill(agent.name);
    await page.getByRole("link", { name: agent.name, exact: true }).waitFor();

    // Memory retains real admitted work but never runs workers. Use its normal finalizer;
    // the shipped QA journey calls the same browser flow with its real worker and no callback.
    assert.equal(await state.completeAgentDeletion(namespace.id, agent.id), true);
    const gone = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.equal(gone.status, 404);
  });
  assert.deepEqual(browser.pages(), [page]);
  assert.equal(page.url(), new URL(agents, fixture.origin).href);
  assert.equal(await search.inputValue(), agent.name);
  // An explicit sign-out forgets the status destination. Only opening the saved link again
  // carries it through sign-in; no result, arbitrary return URL or Agent fields travel with it.
  await page.locator(".account-toggle:visible").first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL("**/console/login");
  await loginThroughForm(page, fixture, receipt + "&returnTo=/console/settings");
  await page.getByRole("heading", { name: "Agent deleted", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has("returnTo"), false);

  // The same saved receipt and real password sign-in, now as a different Namespace reader.
  const other = await fixture.createNamespaceMember("another-reader", namespace.id, [
    ["read", "namespace"],
  ]);
  const { page: reader } = await newPage(t, fixture);
  const reads = apiRequests(reader, fixture.origin);
  await loginThroughForm(reader, fixture, receipt, other.credentials);
  await reader.getByRole("heading", { name: "Deletion status unavailable", exact: true }).waitFor();
  assert.deepEqual(
    reads
      .filter((r) => r.path.startsWith(`/namespaces/${namespace.id}/agents/${agent.id}`))
      .map((r) => r.path),
    [
      `/namespaces/${namespace.id}/agents/${agent.id}/deletion-status?receiptId=${new URL(receipt).searchParams.get("receiptId")}`,
    ],
  );
  assert.equal(await reader.getByRole("list", { name: "Deletion progress" }).isVisible(), false);
  assert.equal(await reader.getByRole("button", { name: "Retry cleanup" }).isVisible(), false);
  assert.deepEqual(nonAuthWriteRequests(reads), []);
});

test("missing, unavailable or mismatched deletion status never confirms completion or sends a write", async (t) => {
  const fixture = await createConsoleAppFixture(t, { recordOperations: true });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unconfirmed cleanup", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Unconfirmed cleanup",
    nativeValues("delete"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const accepted = await fixture.request("DELETE", path);
  assert.equal(accepted.status, 202);
  // Someone else requested deletion. A reader may follow the live status without learning
  // its receipt, and the status announcement must not say the reader requested the deletion.
  const member = await fixture.createNamespaceMember("deletion-observer", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
  ]);
  const { page: observer } = await newPage(t, fixture);
  const live = observer.waitForResponse(fixture.origin + path + "/deletion-status");
  await login(observer, fixture, detailUrl(fixture, namespace.id, agent.id), member.credentials);
  const observed = await live;
  assert.equal(observed.status(), 200);
  assert.deepEqual((await observed.json()).data, {
    agentId: agent.id,
    namespaceId: namespace.id,
    status: "queued",
  });
  const announcement = observer
    .getByRole("status")
    .filter({ has: observer.getByRole("heading", { name: "Deletion queued" }) });
  await announcement
    .getByText("The deletion request was accepted. Cleanup will start automatically.", {
      exact: true,
    })
    .waitFor();
  assert.equal(new URL(observer.url()).searchParams.has("receiptId"), false);

  const receiptId: string = accepted.body.meta.deletionReceiptId;
  const url = `/console/agents/${agent.id}/deletion?namespace=${namespace.id}&receiptId=${receiptId}`;
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Deletion queued" }).waitFor();
  const refresh = page.getByRole("button", { name: "Refresh deletion status" });
  const statusUrl = `${fixture.origin}${path}/deletion-status?receiptId=${receiptId}`;
  for (const fault of [
    { agentId: "agt_" + randomUUID() },
    { receiptId: "aud_" + randomUUID() },
    { namespaceId: "ns_" + randomUUID() },
    403,
    404,
    503,
    "disconnect",
  ] as const) {
    await page.route(
      statusUrl,
      async (route) => {
        if (fault === "disconnect") {
          await route.abort("connectionreset");
        } else if (typeof fault === "number") {
          await route.fulfill({
            status: fault,
            json: { error: { message: "Status unavailable." } },
          });
        } else {
          const response = await route.fetch();
          const { data, meta }: AgentDeletionStatusResponse = await response.json();
          assert.equal(response.status(), 200);
          assert.equal(data.status, "queued");
          assert.equal(data.receiptId, receiptId);
          // A real response with an apparent completion for another target must not be accepted.
          await route.fulfill({
            response,
            json: { data: { ...data, status: "deleted", ...fault }, meta },
          });
        }
      },
      { times: 1 },
    );
    await refresh.click();
    await page
      .getByRole("status")
      .getByRole("heading", { name: "Deletion status unavailable", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("list", { name: "Deletion progress" }).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Retry cleanup" }).isVisible(), false);
    await refresh.click();
    await page.getByRole("heading", { name: "Deletion queued" }).waitFor();
  }
  expireSessions(fixture);
  await refresh.click();
  await page.waitForURL("**/console/login");
  await page.getByLabel("Email", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Deletion queued" }).count(), 0);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("cleanup retry needs a still-failed status, current delete permission and an uncanceled confirmation", async (t) => {
  const fixture = await createConsoleAppFixture(t, { recordOperations: true });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Stale cleanup status", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Stale cleanup", nativeValues("delete"));
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const accepted = await fixture.request("DELETE", path);
  assert.equal(accepted.status, 202);
  const receiptId: string = accepted.body.meta.deletionReceiptId;
  const status = `${fixture.origin}${path}/deletion-status?receiptId=${receiptId}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  // PostgreSQL covers the worker states. Vary only the status shown to this browser; the
  // controller's permission check, repeat admission, new receipt, and its next status are real.
  let displayed: "waiting" | "failed" | "queued" = "waiting";
  const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
  await page.route(status, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const { data, meta }: AgentDeletionStatusResponse = await response.json();
    assert.equal(data.status, "queued");
    assert.equal(data.receiptId, receiptId);
    await route.fulfill({
      response,
      json: {
        meta,
        data: { ...data, status: displayed, ...(displayed === "waiting" ? { nextAttemptAt } : {}) },
      },
    });
  });
  const url = `/console/agents/${agent.id}/deletion?namespace=${namespace.id}&receiptId=${receiptId}`;
  await login(page, fixture, url);
  const localTime = await page.evaluate((value) => new Date(value).toLocaleString(), nextAttemptAt);
  await page
    .getByRole("status")
    .getByText(
      `Cleanup can retry after ${localTime}. The start time depends on worker availability.`,
      { exact: true },
    )
    .waitFor();
  const retry = page.getByRole("button", { name: "Retry cleanup", exact: true });
  assert.equal(await retry.isVisible(), false);
  const refresh = page.getByRole("button", { name: "Refresh deletion status" });
  const dialog = page.getByRole("dialog", { name: "Retry Agent cleanup?" });
  const confirm = dialog.getByRole("button", { name: "Retry cleanup", exact: true });
  async function offerRetry() {
    displayed = "failed";
    await refresh.click();
    await retry.click();
    assert.equal(
      await dialog
        .getByRole("button", { name: "Cancel" })
        .evaluate((node) => node.matches(":focus")),
      true,
    );
  }

  // Confirmation discovers the displayed failure is stale. Return to following live work.
  await offerRetry();
  displayed = "queued";
  await confirm.click();
  const queued = page.getByRole("heading", { name: "Deletion queued", exact: true });
  await queued.waitFor();
  assert.equal(await retry.isVisible(), false);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // The failure still stands and the caller really can delete, but Escape before that permission
  // check returns cancels the unsent request. Neither the stale-status guard nor a denial can pass this.
  await offerRetry();
  const permissionUrl = `${fixture.origin}${path}/permissions`;
  const permitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route(
    permissionUrl,
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).data.delete, true);
      permitted.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await confirm.click();
  await permitted.promise;
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const settled = page.waitForResponse(permissionUrl);
  release.resolve();
  assert.equal((await settled).status(), 200);
  await settlePageRequests(page);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // With the same failure and permission, keeping confirmation sends one real DELETE. Follow
  // its new receipt through the controller, outside the old receipt's intercepted status above.
  await retry.click();
  const acceptedRetry = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + path && response.request().method() === "DELETE",
  );
  await confirm.click();
  const response = await acceptedRetry;
  assert.equal(response.status(), 202);
  const nextReceipt = (await response.json()).meta.deletionReceiptId;
  assert.notEqual(nextReceipt, receiptId);
  await queued.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("receiptId"), nextReceipt);
  assert.deepEqual(
    nonAuthWriteRequests(requests).map(({ method, path }) => [method, path]),
    [["DELETE", path]],
  );
});

test("shipped deletion QA retains an unconfirmed stop instead of sending another at teardown", async (t) => {
  const fixture = await createConsoleAppFixture(t, { recordOperations: true });
  await fixture.bootstrap();
  const ns = await fixture.createNamespace("Unconfirmed stop before deletion", { ready: true });
  const agent = await fixture.createAgent(ns.id, "Stop response lost", nativeValues("stop"));
  await fixture.seedActiveAgentRevision(ns.id, agent.id);

  // The real controller accepts Stop. Lose only its response, before the QA owner can observe
  // completion; installation teardown calls this same helper and must leave the outcome unresolved.
  const sent: string[] = [];
  const stopPath = `/namespaces/${ns.id}/agents/${agent.id}/stop`;
  const qa = {
    retained: false,
    async api(method: string, path: string) {
      sent.push(`${method} ${path}`);
      const response = await fixture.request(method, path);
      assert.equal(response.status, 202);
      assert.equal(response.data.desiredRuntimeState, "stopped");
      throw new Error("lost response to the accepted Stop");
    },
  };
  const owned = { id: agent.id, namespaceId: ns.id, stopped: false };
  await assert.rejects(stopQaAgentForCleanup(qa, owned), /lost response to the accepted Stop/);
  assert.equal(qa.retained, true);
  assert.equal(owned.stopped, false, "an accepted stop is not observed completion");
  assert.equal(
    await stopQaAgentForCleanup(qa, owned),
    false,
    "teardown cannot dispatch or claim a completed stop",
  );
  assert.deepEqual(sent, ["POST " + stopPath]);
});
