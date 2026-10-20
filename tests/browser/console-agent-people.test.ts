import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGatewayPerson } from "@openclaw-enterprise/contracts";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { AGENT_UPDATE_DENIED } from "../helpers/refusal-text.mjs";
import {
  detailUrl,
  login,
  loginThroughForm,
  nativeValues,
  newPage,
  settlePageRequests,
} from "./console-agents-browser-helpers.ts";
import { trackSettledFetches, waitForIdleFetches } from "./console-fetch-accounting.ts";

// These are the feature-owned real-controller browser workflows ported from the
// retired detail suite. Gateway adapters are fixtures; IAM and HTTP remain real.
function resourceId(value: unknown): string {
  assert.ok(value && typeof value === "object" && "id" in value && typeof value.id === "string");
  return value.id;
}

test("Gateway people show native roles and recover from a failed refresh", async (t) => {
  let fail = false;
  let reads = 0;
  const { promise: firstRead, resolve: releaseFirstRead } = Promise.withResolvers<void>();
  t.after(() => releaseFirstRead());
  let people: AgentGatewayPerson[] = [
    {
      identity: "alice@example.com",
      profileId: "profile-alice",
      displayName: "Alice Team",
      role: "member",
      hasAvatar: true,
    },
    {
      identity: "bob@example.com",
      profileId: "profile-bob",
      displayName: "Bob Team",
      role: "maintainer",
      hasAvatar: true,
    },
    // Configured identities appear even before their first connection creates a profile.
    {
      identity: "oidc:never-connected-collaborator-with-a-long-subject-identifier",
      profileId: null,
      displayName: "",
      role: null,
      hasAvatar: false,
    },
  ];
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        reads++;
        await firstRead;
        if (fail) {
          throw new Error("Gateway unavailable");
        }
        return people;
      },
      async avatar({ profileId }: { profileId: string }) {
        return profileId === "profile-alice"
          ? {
              mime: "image/png",
              bytes: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMc0AAAAASUVORK5CYII=",
                "base64",
              ),
            }
          : undefined;
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("People roster", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(namespaceId, "Team Claw", nativeValues("people"));
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, detailUrl(fixture, namespaceId, agentId, "draft", "configuration"));
  // Overview and unrelated tabs never probe the optional Gateway read.
  assert.equal(reads, 0);
  assert.equal(await page.locator(".gateway-people").count(), 0);
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  // Sharing remains usable while the independent roster request is pending.
  await page.getByRole("button", { name: "Share Agent", exact: true }).waitFor();
  await page.getByText("Current policy loaded.", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Share Agent", exact: true }).isEnabled(),
    true,
  );
  const pendingCard = page.locator(".gateway-people");
  await pendingCard.waitFor({ state: "attached" });
  await pendingCard.getByText("Loading configured users…").waitFor();
  assert.equal(await pendingCard.getAttribute("hidden"), null);
  // Leaving while the optional read is in flight must not enqueue another background probe.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  releaseFirstRead();
  await settlePageRequests(page);
  await waitForIdleFetches(page);
  assert.equal(reads, 1, "no queued roster request runs on Configuration");
  assert.equal(await page.locator(".gateway-people").count(), 0);
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  const card = page.getByRole("region", { name: "Direct Control UI access" });
  await card.getByText("Alice Team", { exact: true }).waitFor();
  assert.equal(await card.getByText("Gateway role: member", { exact: true }).count(), 1);
  assert.equal(await card.getByText("Gateway role: maintainer", { exact: true }).count(), 1);
  await page.waitForFunction(
    () =>
      (globalThis.document.querySelector<HTMLImageElement>(".gateway-people img")?.naturalWidth ??
        0) > 0,
  );
  await card.getByText("BT", { exact: true }).waitFor();
  const namedUser = card.getByRole("listitem").filter({ hasText: "Alice Team" });
  await namedUser.getByText("alice@example.com", { exact: true }).waitFor();
  assert.equal(
    await namedUser.locator(".gateway-person-identity.resource-id").textContent(),
    "alice@example.com",
  );
  const neverConnected = card
    .getByRole("listitem")
    .filter({ hasText: "oidc:never-connected-collaborator-with-a-long-subject-identifier" });
  assert.equal(
    await neverConnected
      .getByText("oidc:never-connected-collaborator-with-a-long-subject-identifier", {
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(await neverConnected.locator(".resource-id").count(), 1);
  assert.equal(await neverConnected.locator("img, .gateway-person-role").count(), 0);
  assert.equal(await card.getByText("Unnamed person", { exact: true }).count(), 0);
  // A long configured OIDC login remains readable on a phone without widening the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await neverConnected.scrollIntoViewIfNeeded();
  assert.equal(
    await neverConnected
      .locator(".resource-id")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );
  // A failed read removes stale results and leaves a working, explicit retry.
  assert.ok(
    await card.evaluate((node) => {
      const sharing = globalThis.document.querySelector(".agent-access");
      return (
        sharing !== null &&
        Boolean(node.compareDocumentPosition(sharing) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING)
      );
    }),
    "direct access precedes OCC sharing",
  );
  await card.getByText("Current serving Gateway · Read-only", { exact: true }).waitFor();
  assert.equal(
    await card.getByText(/^v[0-9]+$/).count(),
    0,
    "the response has no revision metadata",
  );
  fail = true;
  await card.getByRole("button", { name: "Refresh users" }).click();
  await card
    .getByRole("alert")
    .getByText("Couldn’t load configured users from the Gateway. Try refreshing.")
    .waitFor();
  assert.equal(await card.getByText("Alice Team", { exact: true }).count(), 0);
  fail = false;
  people = [];
  await card.getByRole("button", { name: "Refresh users" }).click();
  await card.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("button", { name: "Share Agent", exact: true }).isEnabled(),
    true,
  );
});

test("Access keeps a large Gateway roster inline, searchable, and scoped to the serving Gateway", async (t) => {
  let reads = 0;
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        reads++;
        return Array.from({ length: 50 }, (_, index) => ({
          identity:
            index === 0
              ? "oidc:never-connected-long-subject-identifier@example.test"
              : "teammate-" + index + "@example.test",
          profileId: index === 0 ? null : "profile-" + index,
          displayName: index === 0 ? "" : "Teammate " + String(49 - index).padStart(2, "0"),
          role: index === 1 ? "maintainer" : null,
          hasAvatar: false,
        }));
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Inline roster", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(namespaceId, "Team Claw", nativeValues("people"));
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespaceId, agentId, "draft", "configuration"));
  assert.equal(reads, 0, "opening a selected draft does not read the serving roster");
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  const card = page.getByRole("region", { name: "Direct Control UI access", exact: true });
  const list = card.getByRole("list", { name: "Configured Control UI users", exact: true });
  await card.getByText("50 configured users", { exact: true }).waitFor();
  assert.equal(await list.getByRole("listitem").count(), 50);
  assert.equal(await card.getByRole("dialog").count(), 0, "the complete roster is inline");
  assert.equal(
    await card.locator(".gateway-people-heading").getByRole("button").count(),
    1,
    "Refresh is the only roster action",
  );
  assert.ok(
    (await list.getByRole("listitem").first().innerText()).includes("oidc:never-connected"),
    "identity-only entries sort by their configured identity",
  );
  assert.ok(
    (await list.getByRole("listitem").nth(1).innerText()).includes("Teammate 00"),
    "profiled entries sort by their friendly name",
  );
  assert.ok(
    await list.evaluate((node) => node.scrollHeight > node.clientHeight),
    "large roster scrolls within a compact list",
  );
  const search = card.getByRole("searchbox", { name: "Search configured users", exact: true });
  await search.fill("Teammate 48");
  assert.equal(await list.getByRole("listitem").count(), 1, "friendly names are searchable");
  await search.fill("never-connected-long");
  await card
    .getByText("oidc:never-connected-long-subject-identifier@example.test", { exact: true })
    .waitFor();
  assert.equal(
    await list.getByRole("listitem").count(),
    1,
    "configured identity is searchable without a profile",
  );
  assert.equal(
    await list.locator(".gateway-person-role").count(),
    0,
    "missing roles are not invented",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await card.evaluate(
      (node) => node.getBoundingClientRect().right <= globalThis.window.innerWidth,
    ),
    "inline roster fits the phone",
  );
  await search.fill("no such person");
  await card.getByText("No configured users match your search.").waitFor();
  await search.fill("");
  const prior = reads;
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.waitForFunction(
    () =>
      !globalThis.document.querySelector<HTMLButtonElement>(".gateway-people-heading button")
        ?.disabled,
  );
  assert.ok(reads > prior, "returning to retained Access revalidates the current serving roster");
  // Refocusing a retained Access page revalidates Gateway configuration even without a
  // selected-version change; direct identities can change independently of saved versions.
  const focusedRead = page.waitForResponse(
    (response) => response.url().endsWith("/gateway/people") && response.status() === 200,
  );
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await focusedRead;
  await card.getByText("50 configured users", { exact: true }).waitFor();
});

test("Gateway roster administrators can search without Agent update and recover access after denial", async (t) => {
  let reads = 0;
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        reads++;
        return Array.from({ length: 7 }, (_, index) => ({
          identity: `teammate-${index}@example.com`,
          profileId: `profile-${index}`,
          displayName: `Teammate ${index}`,
          role: "member",
          hasAvatar: false,
        }));
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Roster read access", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(namespaceId, "Team Claw", nativeValues("people"));
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const reader = await fixture.createAccountWithPolicy("roster-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-roster-reader",
      namespaceId: namespaceId,
      permissions: [
        ...(["namespace", "agent", "agent_revision", "configuration"] as const).map(
          (resourceKind) => ({
            action: "read" as const,
            resourceKind,
          }),
        ),
        { action: "administer", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-roster-reader",
      namespaceId: namespaceId,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-roster-reader",
    });
  });
  const { page } = await newPage(t, fixture);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (["PATCH", "PUT", "DELETE"].includes(request.method())) {
      writes.push(request.url());
    }
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespaceId, agentId, "draft", "plugins"),
    reader.credentials,
  );
  const save = page.getByRole("button", { name: "Save plugin selections", exact: true });
  await page.getByText(AGENT_UPDATE_DENIED, { exact: true }).waitFor();
  assert.equal(await save.count(), 0, "read-only plugin selections offer no Save");
  const card = page.getByRole("region", { name: "Direct Control UI access" });
  assert.equal(reads, 0, "Plugins does not probe the roster");
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  const panel = card.locator(".gateway-people-roster");
  await card.getByText("7 configured users", { exact: true }).waitFor();
  await page
    .getByText(
      "OCC sharing requires Installation administration. Direct Control UI access is checked separately.",
      { exact: true },
    )
    .waitFor();
  await panel.getByRole("searchbox", { name: "Search configured users" }).fill("Teammate 6");
  await panel.getByText("1 of 7 users", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("listitem").count(), 1);
  assert.deepEqual(writes, [], "roster search never writes Agent settings");
  const readsBeforeDenial = reads;
  // Withdraw only roster administration. The real HTTP denial must clear
  // previously readable data without contacting the Gateway adapter again.
  fixture.policy.restrictions.push({
    id: "deny-roster-read",
    namespaceId: namespaceId,
    effect: "deny",
    action: "administer",
    resourceKind: "agent",
    resourceId: agentId,
  });

  await card.getByRole("button", { name: "Refresh users" }).click();
  await card.locator(".gateway-people-roster").waitFor({ state: "hidden" });
  assert.equal(await card.locator(".control-ui-bookmark").isVisible(), true);
  assert.equal(await page.locator(".gateway-people li").count(), 0);
  assert.equal(await panel.isVisible(), false);
  assert.equal(reads, readsBeforeDenial);
  // A grant must be recoverable in this tab. Reload retains the remembered
  // denial; an explicit page Refresh asks the real API to authorize again.
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((restriction) => restriction.id === "deny-roster-read"),
    1,
  );
  await page.reload();
  await page.getByRole("heading", { name: "Team Claw", exact: true }).waitFor();
  assert.equal(await panel.isVisible(), false);
  assert.equal(await card.locator(".control-ui-bookmark").isVisible(), true);
  assert.equal(reads, readsBeforeDenial);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await card.getByText("7 configured users", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(reads, readsBeforeDenial + 1);
  assert.deepEqual(writes, [], "retrying roster access never writes Agent settings");
});

test("a denied direct roster never blocks OCC sharing and page Refresh recovers cached denial", async (t) => {
  let reads = 0;
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        reads++;
        return [
          {
            identity: "oidc:casey@example.test",
            profileId: null,
            displayName: "",
            role: null,
            hasAvatar: false,
          },
        ];
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Independent access", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(namespaceId, "Team Claw", nativeValues("people"));
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const { page } = await newPage(t, fixture);
  let rosterRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/gateway/people")) {
      rosterRequests++;
    }
  });
  await login(page, fixture, detailUrl(fixture, namespaceId, agentId, "draft", "configuration"));
  assert.equal(rosterRequests, 0);
  // Revoke only this Agent operation after the advisory permission read. The real API must
  // deny the optional roster while Installation policy reads continue to authorize sharing.
  fixture.policy.restrictions.push({
    id: "deny-only-roster",
    namespaceId: namespaceId,
    effect: "deny",
    action: "administer",
    resourceKind: "agent",
    resourceId: agentId,
  });
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  const share = page.getByRole("button", { name: "Share Agent", exact: true });
  await share.waitFor();
  await page.waitForFunction(
    () => globalThis.document.querySelector<HTMLElement>(".gateway-people-roster")?.hidden,
  );
  assert.equal(await page.locator(".control-ui-bookmark").isVisible(), true);
  assert.equal(reads, 0, "a denied request never reaches the serving Gateway adapter");
  const requestsAfterDenial = rosterRequests;
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await share.waitFor();
  assert.equal(rosterRequests, requestsAfterDenial, "retained Access honors the denied-read cache");
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((restriction) => restriction.id === "deny-only-roster"),
    1,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("region", { name: "Direct Control UI access", exact: true })
    .getByText("oidc:casey@example.test", { exact: true })
    .waitFor();
  assert.ok(reads > 0, "explicit page Refresh authorizes and reads the serving roster again");
  await share.waitFor();
});

test("Access re-entry discards a superseded pending roster response", async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  let reads = 0;
  const person = (identity: string): AgentGatewayPerson => ({
    identity,
    profileId: null,
    displayName: "",
    role: null,
    hasAvatar: false,
  });
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        if (++reads === 1) {
          started.resolve();
          await release.promise;
          return [person("oidc:superseded-access-read")];
        }
        return [person("oidc:current-access-read")];
      },
      async avatar() {
        return undefined;
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Access pending re-entry", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(
    namespaceId,
    "Pending roster Agent",
    nativeValues("pending-roster"),
  );
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespaceId, agentId, "draft", "configuration"));
  const access = page.getByRole("tab", { name: "Access", exact: true });
  await access.click();
  await started.promise;
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await access.click();
  // Returning requests a fresh snapshot. The old response must not flash an
  // identity that has already been replaced before the queued read completes.
  const observation = await page.evaluateHandle(() => {
    const list = globalThis.document.querySelector(".gateway-people-list");
    if (!list) {
      throw new Error("Expected the retained roster list");
    }
    const identities: string[] = [];
    const observer = new MutationObserver(() => {
      identities.push(
        ...Array.from(list.querySelectorAll(".resource-id"), (node) => node.textContent ?? ""),
      );
    });
    observer.observe(list, { childList: true, subtree: true });
    return { observer, identities };
  });
  release.resolve();
  const direct = page.getByRole("region", { name: "Direct Control UI access", exact: true });
  await direct.getByText("oidc:current-access-read", { exact: true }).waitFor();
  const observed = await observation.evaluate(({ observer, identities }) => {
    observer.disconnect();
    return identities;
  });
  await observation.dispose();
  assert.equal(reads, 2);
  assert.equal(
    observed.includes("oidc:superseded-access-read"),
    false,
    "a superseded read never commits a visible roster row",
  );
});

test("Returning to Configuration never reads an inactive Gateway roster", async (t) => {
  let reads = 0;
  let identity = "oidc:retained-access-person";
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        reads++;
        return [{ identity, profileId: null, displayName: "", role: null, hasAvatar: false }];
      },
      async avatar() {
        return undefined;
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Retained direct access", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(
    namespaceId,
    "Retained Team Claw",
    nativeValues("retained-people"),
  );
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, detailUrl(fixture, namespaceId, agentId, "draft", "configuration"));
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.getByText(identity, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await waitForIdleFetches(page);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  const beforeReturn = reads;
  await page.goBack();
  await page.getByRole("heading", { name: "Retained Team Claw", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(reads, beforeReturn, "inactive roster must not gate Configuration restoration");
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.getByText(identity, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(reads, beforeReturn + 1, "Access activation still refreshes its roster");
  const beforeActiveReturn = reads;
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  identity = "oidc:allowlist-changed-while-away";
  await page.goBack();
  await page.getByRole("tab", { name: "Access", selected: true }).waitFor();
  await page.getByText(identity, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(reads, beforeActiveReturn + 1, "returning to Access refreshes the changed roster");
  assert.equal(await page.getByText("oidc:retained-access-person", { exact: true }).count(), 0);
});

test("confirmed empty direct access stays hidden until a human roster returns", async (t) => {
  // The adapter contract already excludes the reserved OCC machine principal. Its
  // successful [] is distinct from a failed read or a search with no matches.
  let people: AgentGatewayPerson[] = [];
  let fail = false;
  let gate: Promise<void> = Promise.resolve();
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: {
      async list() {
        await gate;
        if (fail) {
          throw new Error("Gateway unavailable");
        }
        return people;
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Direct access visibility", { ready: true });
  const namespaceId = resourceId(namespace);
  const agent = await fixture.createAgent(namespaceId, "Team Claw", nativeValues("visibility"));
  const agentId = resourceId(agent);
  await fixture.seedActiveAgentRevision(namespaceId, agentId);
  const saved = await fixture.request(
    "PUT",
    "/namespaces/" + namespaceId + "/agents/" + agentId + "/control-ui-bookmark",
    {
      body: { url: "https://control.example.com/team", expectedVersion: 0 },
    },
  );
  assert.equal(saved.status, 200);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await loginThroughForm(
    page,
    fixture,
    detailUrl(fixture, namespaceId, agentId, "draft", "access"),
  );
  await waitForIdleFetches(page);
  const card = page.locator(".gateway-people");
  const sharing = page.getByRole("button", { name: "Share Agent", exact: true });
  assert.equal(
    await card.isVisible(),
    false,
    "successful zero-human roster hides the whole direct card, including the saved bookmark",
  );
  assert.equal(await sharing.isEnabled(), true);

  const { promise, resolve } = Promise.withResolvers<void>();
  t.after(() => resolve());
  gate = promise;
  const started = page.waitForRequest((request) => request.url().endsWith("/gateway/people"));
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await started;
  assert.equal(await card.isVisible(), false, "confirmed empty does not flash during refocus");
  assert.equal(await sharing.isEnabled(), true);
  people = [
    {
      identity: "oidc:casey@example.test",
      profileId: null,
      displayName: "",
      role: null,
      hasAvatar: false,
    },
  ];
  resolve();
  await card.getByText("oidc:casey@example.test", { exact: true }).waitFor();
  await card.getByRole("link", { name: "Open direct Control UI", exact: true }).waitFor();
  await card.getByRole("searchbox", { name: "Search configured users" }).fill("no such person");
  await card.getByText("No configured users match your search.").waitFor();
  assert.equal(
    await card.isVisible(),
    true,
    "a search result does not redefine configured membership",
  );
  fail = true;
  await card.getByRole("button", { name: "Refresh users" }).click();
  await card
    .getByText("Couldn’t load configured users from the Gateway. Try refreshing.")
    .waitFor();
  assert.equal(
    await card.getByRole("link", { name: "Open direct Control UI", exact: true }).isVisible(),
    true,
    "failure is not proof of empty membership",
  );
  fail = false;
  people = [];
  await card.getByRole("button", { name: "Refresh users" }).click();
  await card.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await waitForIdleFetches(page);
  assert.equal(
    await card.isVisible(),
    false,
    "returning Access preserves a confirmed empty result",
  );
  assert.equal(await sharing.isEnabled(), true);
  const recipient = await fixture.createAccountWithPolicy("sharing-recipient", () => {});
  await page
    .getByLabel("Existing person’s Principal ID", { exact: true })
    .fill(recipient.principal.id);
  await page
    .getByRole("checkbox", {
      name: "I understand this grants full native administration of this Agent.",
      exact: true,
    })
    .check();
  await sharing.click();
  await page
    .getByText("Agent access is shared. Effective access remains subject to current IAM policy.", {
      exact: true,
    })
    .waitFor();
  await page
    .locator(".agent-access-grant")
    .getByText("identity: " + recipient.principal.id, { exact: true })
    .waitFor();
  assert.equal(
    await card.isVisible(),
    false,
    "real OCC sharing does not reveal an empty direct-access card",
  );
});
