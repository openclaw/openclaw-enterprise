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
} from "./console-agents-browser-helpers.ts";

test("the Console confirms deletion to its finalizing actor and shows other readers only that the Agent is not visible", async (t) => {
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
  const statusLink = await verifyConsoleAgentDeletion(browser, fixture.origin, agent, async () => {
    // Exercise the other scenario's page while the deletion page is following its status.
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
  await loginThroughForm(page, fixture, statusLink + "&returnTo=/console/settings");
  await page.getByRole("heading", { name: "Agent deleted", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has("returnTo"), false);

  // The same saved link and real password sign-in, now as a Namespace reader who did not
  // finish this deletion. Its denial reads the same as for an Agent that still exists, so the
  // page never says Agent deleted.
  const other = await fixture.createNamespaceMember("another-reader", namespace.id, [
    ["read", "namespace"],
  ]);
  const { page: reader } = await newPage(t, fixture);
  const reads = apiRequests(reader, fixture.origin);
  await loginThroughForm(reader, fixture, statusLink, other.credentials);
  const notVisible = reader.getByRole("status").filter({
    has: reader.getByRole("heading", { name: "Agent not visible", exact: true }),
  });
  await notVisible
    .getByText(
      "This Agent is no longer visible to you. It may have been deleted, or your access may have changed.",
    )
    .waitFor();
  assert.equal(await reader.getByRole("heading", { name: "Agent deleted" }).count(), 0);
  assert.deepEqual(
    reads
      .filter((r) => r.path.startsWith(`/namespaces/${namespace.id}/agents/${agent.id}`))
      .map((r) => r.path),
    [`/namespaces/${namespace.id}/agents/${agent.id}/deletion-status`],
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
  // Someone else requested deletion. A reader of the Agent may follow its live status, and the
  // status announcement must not say the reader requested the deletion.
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
  assert.deepEqual(Object.keys(accepted.body.meta), ["requestId"]);

  const url = `/console/agents/${agent.id}/deletion?namespace=${namespace.id}`;
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Deletion queued" }).waitFor();
  const refresh = page.getByRole("button", { name: "Refresh deletion status" });
  const statusUrl = `${fixture.origin}${path}/deletion-status`;
  for (const fault of [
    { agentId: "agt_" + randomUUID() },
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
    // A denial or a missing record never confirms deletion; it reads only as not visible.
    const denied = fault === 403 || fault === 404;
    await page
      .getByRole("status")
      .getByRole("heading", {
        name: denied ? "Agent not visible" : "Deletion status unavailable",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.getByRole("heading", { name: "Agent deleted" }).count(), 0);
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
  const status = `${fixture.origin}${path}/deletion-status`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  // PostgreSQL covers the worker states. Vary only the status shown to this browser; the
  // controller's permission check, repeat admission, and the next status are real.
  let displayed: "waiting" | "failed" | "queued" = "waiting";
  let retried = false;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url() === fixture.origin + path) {
      retried = true;
    }
  });
  const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
  await page.route(status, async (route) => {
    if (retried) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const { data, meta }: AgentDeletionStatusResponse = await response.json();
    assert.equal(data.status, "queued");
    await route.fulfill({
      response,
      json: {
        meta,
        data: { ...data, status: displayed, ...(displayed === "waiting" ? { nextAttemptAt } : {}) },
      },
    });
  });
  const url = `/console/agents/${agent.id}/deletion?namespace=${namespace.id}`;
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
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // With the same failure and permission, keeping confirmation sends one real DELETE. Its next
  // status reads come from the controller, no longer through the interception above. Hold that
  // DELETE while the cancelled attempt's permission read returns: the cancelled attempt must not
  // end this attempt's write, so Escape still cannot dismiss its confirmation.
  const deleting = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>();
  t.after(() => send.resolve());
  const deleteUrl = fixture.origin + path;
  await page.route(deleteUrl, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    deleting.resolve();
    await send.promise;
    await route.continue();
  });
  await retry.click();
  const acceptedRetry = page.waitForResponse(
    (response) => response.url() === deleteUrl && response.request().method() === "DELETE",
  );
  await confirm.click();
  await deleting.promise;
  const settled = page.waitForResponse(permissionUrl);
  release.resolve();
  assert.equal((await settled).status(), 200);
  // Let the cancelled attempt's handler finish after its read resolves.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  send.resolve();
  const response = await acceptedRetry;
  assert.equal(response.status(), 202);
  assert.deepEqual(Object.keys((await response.json()).meta), ["requestId"]);
  await queued.waitFor();
  assert.equal(new URL(page.url()).searchParams.has("receiptId"), false);
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
