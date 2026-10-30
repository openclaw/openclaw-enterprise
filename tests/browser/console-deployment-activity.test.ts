import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import type {
  PlatformReadView,
  PlatformStateStore,
} from "../../packages/occ/src/state/platform-state.ts";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";
import {
  AGENT_READ,
  detailUrl,
  denyRevisionRead,
  expireSessions,
  revokeMemberGrant,
  login,
  nativeValues,
  newPage,
  waitForIdleFetches,
  trackSettledFetches,
} from "./console-agents-browser-helpers.mjs";

// The real controller admits and authorizes the deployment. The fixture has no
// worker: change only its exact work lookup/lease, then its revision lookup.
// No route interception supplies a status or conceals a missing controller route.
async function deploymentFixture(t: TestContext) {
  let workKey = "";
  let cleanupKey = "";
  let revisionId = "";
  const control = {
    // The work record stays unreadable to every read until cleared (see unavailableDuring).
    unavailable: false,
    claimed: false,
    succeeded: false,
    // A permanent failure whose failed preparation queued the version's retire cleanup.
    failed: false,
    cleanup: null as "queued" | "claimed" | "succeeded" | null,
    missingRevision: false,
    refusedLookups: 0,
  };
  const wrapState = (base: PlatformStateStore): PlatformStateStore => ({
    transact: base.transact.bind(base),
    read: <T>(work: (view: PlatformReadView) => Promise<T>) =>
      base.read((view) =>
        work({
          ...view,
          operations: {
            ...view.operations,
            async findWork(key: string) {
              if (key === cleanupKey && control.cleanup !== null) {
                // The cleanup row the worker would enqueue for this revision, in its states.
                const work = await view.operations.findWork(workKey);
                return control.cleanup === "queued"
                  ? { ...work!, idempotencyKey: cleanupKey }
                  : control.cleanup === "claimed"
                    ? {
                        ...work!,
                        idempotencyKey: cleanupKey,
                        state: "claimed" as const,
                        attemptCount: 1,
                        leaseActive: true,
                      }
                    : { ...work!, idempotencyKey: cleanupKey, state: "succeeded" as const };
              }
              const record = await view.operations.findWork(key);
              if (key !== workKey) {
                return record;
              }
              assert.equal(record?.state, "queued");
              if (control.unavailable) {
                return undefined;
              }
              if (control.failed) {
                return {
                  ...record!,
                  state: "failed_permanent" as const,
                  reasonCode: "CONVERGENCE_DEADLINE_EXCEEDED",
                };
              }
              if (control.succeeded) {
                return {
                  ...record!,
                  state: "succeeded" as const,
                  reasonCode: "REVISION_ALREADY_ACTIVE",
                };
              }
              return control.claimed
                ? { ...record!, state: "claimed" as const, attemptCount: 1, leaseActive: true }
                : record;
            },
          },
          revisions: {
            ...view.revisions,
            async findRevision(namespaceId: string, agentId: string, id: string) {
              const record = await view.revisions.findRevision(namespaceId, agentId, id);
              if (id === revisionId && control.missingRevision) {
                assert.equal(
                  record?.id,
                  revisionId,
                  "the admitted revision exists behind the controlled lookup",
                );
                control.refusedLookups++;
                return undefined;
              }
              return record;
            },
          },
        }),
      ),
  });
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Keyboard activity", {
    recordOperations: true,
    wrapState,
  });
  const agent = await fixture.createAgent(namespace.id, "Keyboard reader", nativeValues("reader"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  revisionId = revision.id;
  workKey = `agent_revision:${revisionId}:reconcile`;
  cleanupKey = `agent_revision:${revisionId}:repository_cleanup:retire:${createHash("sha256").update(revisionId, "utf8").digest("hex")}`;
  const url = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`;
  // An outage lasts for the whole read under test. A Refresh also lists the versions, and that
  // list reads the same work record concurrently, so a one-shot failure could reach the list
  // first and leave the deployment read a 200 (finding 2794).
  async function unavailableDuring(read: () => Promise<void>) {
    control.unavailable = true;
    try {
      await read();
    } finally {
      control.unavailable = false;
    }
  }
  return { fixture, namespace, agent, revisionId, url, control, unavailableDuring };
}

for (const source of ["selected", "automatic", "overlapping refresh", "regrant"] as const) {
  test(
    `terminal ${source} record refreshes current version once`,
    { timeout: 30_000 },
    async (t) => {
      const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
      const member = await fixture.createNamespaceMember(
        "terminal-reader",
        namespace.id,
        AGENT_READ,
      );
      const { page } = await newPage(t, fixture);
      await trackSettledFetches(page);
      const agentUrl = url.split("/deployments/")[0]!;
      const counts = { record: 0, agent: 0, revisions: 0 };
      page.on("request", (request) => {
        if (request.method() !== "GET") {
          return;
        }
        if (request.url() === url) {
          counts.record++;
        } else if (request.url() === agentUrl) {
          counts.agent++;
        } else if (request.url().split("?")[0] === `${agentUrl}/revisions`) {
          counts.revisions++;
        }
      });
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment"),
        member.credentials,
      );
      const card = page.locator(".version-deployment-record");
      const activity = page.getByRole("region", { name: "Deployment activity" });
      await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
      await waitForIdleFetches(page);
      assert.match(await page.locator("main").innerText(), /Selected for service\nNone/);
      counts.record = counts.agent = counts.revisions = 0;
      const route = page.url();
      const refresh = card.getByRole("button", { name: "Refresh record", exact: true });
      const release = Promise.withResolvers<void>();
      if (source === "overlapping refresh") {
        const ready = Promise.withResolvers<void>();
        let held = false;
        await page.route(agentUrl, async (request) => {
          if (held) {
            await request.continue();
            return;
          }
          held = true;
          const response = await request.fetch();
          assert.equal(response.status(), 200);
          assert.equal((await response.json()).data.activeRevisionId, undefined);
          ready.resolve();
          await release.promise;
          await request.fulfill({ response });
        });
        // The full refresh already owns an overview read. Its captured old Agent response
        // must be discarded, then one fresh pair must establish the new current version.
        await activity.getByRole("button", { name: "Refresh deployment" }).click();
        await ready.promise;
      }
      let restore: (() => void) | undefined;
      if (source === "regrant") {
        restore = revokeMemberGrant(fixture, "terminal-reader", ["read", "agent_revision"]);
        const refusal = page.waitForResponse(url);
        await refresh.press("Enter");
        const response = await refusal;
        assert.equal(response.status(), 403);
        const message = (await response.json()).error.message;
        await card.getByText(message, { exact: true }).waitFor();
        await activity.getByText(message, { exact: true }).waitFor();
        assert.doesNotMatch(await activity.innerText(), /Recorded status:/);
        counts.record = counts.agent = counts.revisions = 0;
      }
      // Use the real state transaction for current-version selection. Only worker
      // progress is projected: this fixture does not execute a Compute Driver.
      await fixture.activateRevision(namespace.id, agent.id, revisionId, undefined);
      control.succeeded = true;
      restore?.();
      if (source !== "automatic") {
        await refresh.press("Enter");
      }
      await card.getByText("Recorded outcome: Completed", { exact: true }).waitFor();
      release.resolve();
      await page
        .getByText("v1 remains selected for service. Browsing does not deploy or roll back.", {
          exact: true,
        })
        .waitFor();
      await waitForIdleFetches(page);
      assert.match(await page.locator("main").innerText(), /Selected for service\nv1/);
      assert.match(await activity.innerText(), /Recorded status: Completed/);
      assert.equal(page.url(), route);
      if (source !== "automatic") {
        assert.equal(await refresh.evaluate((node) => node === document.activeElement), true);
      }
      assert.deepEqual(counts, {
        record: source === "overlapping refresh" ? 2 : 1,
        agent: source === "overlapping refresh" ? 2 : 1,
        revisions: source === "overlapping refresh" ? 2 : 1,
      });
      // A second verified terminal record must not repeat an already successful overview.
      counts.record = counts.agent = counts.revisions = 0;
      const repeated = page.waitForResponse(url);
      await refresh.press("Enter");
      assert.equal((await repeated).status(), 200);
      await waitForIdleFetches(page);
      assert.deepEqual(counts, { record: 1, agent: 0, revisions: 0 });
    },
  );
}

test(
  "terminal overview retries explicitly and shares its in-flight read",
  { timeout: 30_000 },
  async (t) => {
    const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await page.clock.install();
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment"),
    );
    const card = page.locator(".version-deployment-record");
    const refresh = card.getByRole("button", { name: "Refresh record", exact: true });
    await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
    await waitForIdleFetches(page);
    const agentUrl = url.split("/deployments/")[0]!;
    let overviewReads = 0;
    let revisionReads = 0;
    let recordReads = 0;
    page.on("request", (request) => {
      if (request.url() === url) {
        recordReads++;
      } else if (request.url().split("?")[0] === `${agentUrl}/revisions`) {
        revisionReads++;
      }
    });
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    await page.route(agentUrl, async (route) => {
      overviewReads++;
      if (overviewReads === 1) {
        await route.abort("connectionfailed");
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).data.activeRevisionId, revisionId);
      held.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await fixture.activateRevision(namespace.id, agent.id, revisionId, undefined);
    control.succeeded = true;
    // Pending cleanup keeps genuine automatic record reads running after completion.
    control.cleanup = "queued";
    await refresh.press("Enter");
    const failure = page
      .getByRole("region", { name: "Deployment activity" })
      .getByText(/Current version and version history could not be refreshed/);
    await failure.waitFor();
    await waitForIdleFetches(page);
    await page.clock.runFor(DEPLOYMENT_POLL_MS);
    await waitForIdleFetches(page);
    assert.deepEqual([recordReads, overviewReads, revisionReads], [2, 1, 1]);
    await failure.waitFor();

    // Only an explicit fresh record retries the failed overview. Another successful
    // record while that pair is held shares it instead of discarding or duplicating it.
    await refresh.press("Enter");
    await held.promise;
    const repeated = page.waitForResponse(url);
    await refresh.press("Enter");
    assert.equal((await repeated).status(), 200);
    assert.deepEqual([recordReads, overviewReads, revisionReads], [4, 2, 2]);
    release.resolve();
    await waitForIdleFetches(page);
    await failure.waitFor({ state: "detached" });
    assert.match(
      await page.getByRole("region", { name: "Agent state at a glance" }).innerText(),
      /Selected for service\s+v1/,
    );
    await refresh.press("Enter");
    await waitForIdleFetches(page);
    assert.deepEqual([recordReads, overviewReads, revisionReads], [5, 2, 2]);
  },
);

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(
    `deployment activity preserves reading position and reveals final refusal at ${viewport.width}`,
    { timeout: 60_000 },
    async (t) => {
      const { fixture, namespace, agent, revisionId, url, control, unavailableDuring } =
        await deploymentFixture(t);
      const { page } = await newPage(t, fixture, { context: { viewport } });
      const region = page.getByRole("region", { name: "Deployment activity" });
      const details = region.locator("details");
      const run = page.getByRole("button", { name: "Run diagnostics for this version" });
      const refresh = region.getByRole("button", { name: "Refresh deployment" });
      const responses: number[] = [];
      page.on("response", (response) => {
        if (response.url() === url) {
          responses.push(response.status());
        }
      });
      const next = () =>
        page.waitForResponse(
          (response) => response.url() === url && response.request().method() === "GET",
        );
      let recordedLabel = "Queued";
      type Outcome = "queued" | "running" | "succeeded" | 503 | 404;
      async function received(
        pending: ReturnType<typeof next>,
        expected: Outcome,
        retained = false,
      ) {
        const response = await pending;
        assert.equal(response.status(), typeof expected === "number" ? expected : 200);
        const body = await response.json();
        if (typeof expected === "number") {
          assert.equal(body.data, undefined, "failed reads do not return a private record");
          assert.equal(body.error.code, expected === 503 ? "DEPENDENCY_UNAVAILABLE" : "NOT_FOUND");
          const card = page.locator(".version-deployment-record");
          if (retained) {
            await region
              .getByText("Update delayed · last known status", { exact: true })
              .waitFor({ state: "attached" });
            await card
              .getByText(`Recorded outcome: ${recordedLabel} · update delayed`, { exact: true })
              .waitFor();
            assert.equal(await region.locator(".deployment-outcome").count(), 1);
            assert.equal(await page.getByRole("alert").count(), 0);
            await page
              .getByRole("region", { name: "Agent state at a glance" })
              .getByText("Update delayed.", { exact: true })
              .waitFor();
          } else {
            const message =
              expected === 503
                ? "Service unavailable. The read could not be completed. Try again."
                : "Resource unavailable in this Namespace. Check the ID and your access.";
            await region.getByText(message, { exact: true }).waitFor({ state: "attached" });
            assert.equal(await region.locator(".deployment-outcome").count(), 0);
            await card.getByText(message, { exact: true }).waitFor();
            assert.doesNotMatch(
              await card.innerText(),
              /Recorded outcome:|No persisted startup failure/,
            );
            assert.equal(await page.getByRole("alert").count(), 1);
            await page
              .getByRole("region", { name: "Agent state at a glance" })
              .getByText("Recorded deployment status could not be read.", { exact: true })
              .waitFor();
          }
        } else {
          assert.equal(body.data.deploymentId, revisionId);
          assert.equal(body.data.namespaceId, namespace.id);
          assert.equal(body.data.agentId, agent.id);
          assert.equal(body.data.status, expected);
          recordedLabel = { queued: "Queued", running: "In progress", succeeded: "Completed" }[
            expected
          ];
          await region
            .getByText(
              `Recorded status: ${{ queued: "Queued", running: "In progress", succeeded: "Completed" }[expected]}`,
              {
                exact: true,
              },
            )
            .waitFor({ state: "attached" });
        }
      }
      const first = next();
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
      );
      await received(first, "queued");
      await page.evaluate(() => document.fonts.ready);
      // Advance only the application's existing poll timer; no arbitrary wall-clock sleeps.
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(new Date(now + 1000));
      async function poll(expected: Outcome) {
        const response = next();
        await page.clock.runFor(DEPLOYMENT_POLL_MS);
        await received(response, expected, expected === 503);
      }
      const isOpen = () => details.evaluate((node: HTMLDetailsElement) => node.open);
      async function focusDiagnostics(folded: boolean) {
        await details.locator("summary").focus();
        if ((await isOpen()) === folded) {
          await page.keyboard.press("Enter");
        }
        for (
          let i = 0;
          i < 40 && !(await run.evaluate((node) => node === document.activeElement));
          i++
        ) {
          await page.keyboard.press("Tab");
        }
        const focused = await run.elementHandle();
        assert.ok(focused);
        assert.equal(await focused.evaluate((node) => node === document.activeElement), true);
        return focused;
      }
      // An idle reader has no focused control: layout itself must remain stable.
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      const idleTop = await details
        .locator("summary")
        .evaluate((node) => node.getBoundingClientRect().top);
      await unavailableDuring(() => poll(503));
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      assert.equal(
        await details.locator("summary").evaluate((node) => node.getBoundingClientRect().top),
        idleTop,
      );
      await poll("queued");
      assert.equal(
        await details.locator("summary").evaluate((node) => node.getBoundingClientRect().top),
        idleTop,
      );
      // Distinguishes the old collision: both 503 and 404 used to stamp "///false".
      // Start with the first folded reader position, before later phases can scroll.
      const original = await focusDiagnostics(true);
      async function readerPosition() {
        return original.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return {
            focused: node.isConnected && node === document.activeElement,
            top: box.top,
            bottom: box.bottom,
            viewport: window.innerHeight,
            hit: node.contains(
              document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
            ),
          };
        });
      }
      const foldedPosition = await readerPosition();
      assert.equal(foldedPosition.focused && foldedPosition.hit, true);
      assert.ok(foldedPosition.top >= 0 && foldedPosition.bottom <= foldedPosition.viewport);
      await unavailableDuring(() => poll(503));
      assert.equal(await isOpen(), false);
      const transientPosition = await readerPosition();
      assert.equal(transientPosition.focused && transientPosition.hit, true);
      assert.ok(Math.abs(transientPosition.top - foldedPosition.top) <= 1);
      control.missingRevision = true;
      await poll(404);
      assert.ok(control.refusedLookups > 0, "404 came from the selected real revision lookup");
      assert.equal(await isOpen(), true, "a final refusal after 503 reveals its generic notice");
      assert.equal(await region.getByRole("alert").isVisible(), true);
      const finalPosition = await readerPosition();
      assert.equal(finalPosition.focused, true, "the original diagnostics button retains focus");
      assert.equal(finalPosition.hit, true, "the refusal leaves diagnostics hit-testable");
      assert.ok(
        finalPosition.top >= 0 && finalPosition.bottom <= finalPosition.viewport,
        "the required new refusal leaves the focused diagnostics button inside the viewport",
      );
      assert.deepEqual(responses, [200, 503, 200, 503, 404]);
      await page.clock.runFor(2 * DEPLOYMENT_POLL_MS);
      assert.equal(responses.length, 5, "final refusal stops automatic polling");
      // Explicit refresh reveals even the same repeated error after a reader folds it.
      await details.locator("summary").click();
      const retried = next();
      await refresh.click();
      await received(retried, 404);
      await page.waitForFunction(
        () => document.querySelector<HTMLDetailsElement>(".deployment-status > details")?.open,
      );
      assert.equal(await isOpen(), true);
      control.missingRevision = false;
      const recovered = next();
      await refresh.click();
      await received(recovered, "queued");
      assert.equal(await isOpen(), true);

      for (const folded of [false, true]) {
        const focused = await focusDiagnostics(folded);
        const before = await run.boundingBox();
        assert.ok(before);
        async function readerStays(stage: string) {
          assert.equal(await isOpen(), !folded, `${stage}: preserve disclosure`);
          assert.equal(
            await focused!.evaluate((node) => node.isConnected && node === document.activeElement),
            true,
            `${stage}: original control stays focused`,
          );
          const after = await run.boundingBox();
          assert.ok(after);
          assert.ok(Math.abs(after.y - before!.y) <= 1, `${stage}: moved ${after.y - before!.y}px`);
          assert.ok(
            after.y >= 0 && after.y + after.height <= viewport.height,
            `${stage}: focus stays in viewport`,
          );
        }
        const pending = control.claimed ? "running" : "queued";
        await poll(pending);
        await readerStays("unchanged/queued poll");
        await unavailableDuring(() => poll(503));
        await readerStays("transient failure");
        await poll(pending);
        await readerStays("recovery");
        control.claimed = true;
        await poll("running");
        await readerStays("routine progress");
      }

      // An explicit refresh is not an instruction to expand unchanged healthy evidence.
      // Reuse the same controller and page, including a completed terminal record.
      for (const outcome of ["running", "succeeded"] as const) {
        await t.test(`unchanged ${outcome} refresh respects a manual fold`, async () => {
          control.succeeded = outcome === "succeeded";
          const established = next();
          await refresh.click();
          await received(established, outcome);
          await region.locator('button[aria-disabled="false"]').waitFor();
          if (await isOpen()) {
            await details.locator("summary").click();
          }
          assert.equal(await isOpen(), false);
          const unchanged = next();
          await refresh.click();
          await received(unchanged, outcome);
          // The text may be identical before the response: wait for the owning read to finish.
          await region.locator('button[aria-disabled="false"]').waitFor();
          assert.equal(
            await isOpen(),
            false,
            "an unchanged successful refresh must preserve the manual fold",
          );
        });
      }
      // Hold a verified real response: an explicit refresh must retain hover feedback
      // while aria-disabled communicates busy and repeated Enter remains guarded.
      await t.test("explicit refresh keeps its hovered fill while busy", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let verified!: () => void;
        const upstreamReady = new Promise<void>((resolve) => {
          verified = resolve;
        });
        let requests = 0;
        await page.route(url, async (route) => {
          requests++;
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          const body = await response.json();
          assert.equal(body.data.deploymentId, revisionId);
          assert.equal(body.data.status, "succeeded");
          verified();
          await held;
          await route.fulfill({ response });
        });
        await refresh.hover();
        await refresh.focus();
        const fill = () => refresh.evaluate((node) => getComputedStyle(node).backgroundColor);
        const before = await fill();
        const receivedRefresh = next();
        try {
          await page.keyboard.press("Enter");
          await upstreamReady;
          assert.equal(await refresh.getAttribute("aria-disabled"), "true");
          assert.equal(await fill(), before, "busy must preserve the hovered fill");
          assert.equal(await refresh.evaluate((node) => node === document.activeElement), true);
          await page.keyboard.press("Enter");
          assert.equal(requests, 1);
        } finally {
          release();
          await received(receivedRefresh, "succeeded");
          await page.unroute(url);
        }
        await region.locator('button[aria-disabled="false"]').waitFor();
        assert.equal(await fill(), before);
      });
      // A human-triggered repeated transient error still needs a visible result.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await isOpen()) {
          await details.locator("summary").click();
        }
        await unavailableDuring(async () => {
          const failed = next();
          await refresh.click();
          await received(failed, 503);
        });
        await page.waitForFunction(
          () => document.querySelector<HTMLDetailsElement>(".deployment-status > details")?.open,
        );
        assert.equal(await region.getByRole("alert").isVisible(), true);
      }
    },
  );
}

// A failed deploy keeps polling while its retire cleanup is pending. Its cleanup's progress and a
// recovered read are routine: the reader's fold and focus stay; the cleanup's result reveals.
test("a pending cleanup after a final outcome keeps the reader's fold until it ends", async (t) => {
  const { fixture, namespace, agent, revisionId, url, control, unavailableDuring } =
    await deploymentFixture(t);
  control.failed = true;
  control.cleanup = "queued";
  const { page } = await newPage(t, fixture);
  const region = page.getByRole("region", { name: "Deployment activity" });
  const details = region.locator("details");
  // A failed version that is not current offers no diagnostics: the reader moves on to its record.
  const run = page
    .locator(".version-deployment-record")
    .getByRole("button", { name: "Refresh record", exact: true });
  const next = () =>
    page.waitForResponse(
      (response) => response.url() === url && response.request().method() === "GET",
    );
  async function received(pending: ReturnType<typeof next>, cleanup: string | null) {
    const response = await pending;
    if (cleanup === null) {
      assert.equal(response.status(), 503);
      await region
        .getByText("Update delayed · last known status", { exact: true })
        .waitFor({ state: "attached" });
      return;
    }
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.data.status, "failed");
    assert.equal(body.data.cleanup?.status, cleanup);
    await region
      .locator(".deployment-cleanup")
      .getByText(
        { queued: /cleanup pending/, running: /cleanup is running/, succeeded: /completed/ }[
          cleanup
        ]!,
      )
      .waitFor({ state: "attached" });
  }
  const first = next();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
  );
  await received(first, "queued");
  const isOpen = () => details.evaluate((node: HTMLDetailsElement) => node.open);
  assert.equal(await isOpen(), true, "the failure and its pending cleanup open the details");
  await page.evaluate(() => document.fonts.ready);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  async function poll(cleanup: string | null) {
    const response = next();
    await page.clock.runFor(DEPLOYMENT_POLL_MS);
    await received(response, cleanup);
  }
  // The reader has read the failure, folds it and moves on to the version's record below.
  await details.locator("summary").click();
  await run.focus();
  const before = await run.boundingBox();
  assert.ok(before);
  async function readerStays(stage: string) {
    assert.equal(await isOpen(), false, `${stage}: preserve the fold`);
    assert.equal(
      await run.evaluate((node) => node === document.activeElement),
      true,
      `${stage}: the record's Refresh keeps focus`,
    );
    const after = await run.boundingBox();
    assert.ok(after);
    assert.ok(Math.abs(after.y - before!.y) <= 1, `${stage}: moved ${after.y - before!.y}px`);
  }
  await poll("queued");
  await readerStays("unchanged poll");
  await unavailableDuring(() => poll(null));
  await readerStays("transient failure");
  await poll("queued");
  await readerStays("recovery");
  control.cleanup = "claimed";
  await poll("running");
  await readerStays("cleanup progress");
  // The cleanup's result is final: it reveals, as a deploy's result does, and polling stops.
  control.cleanup = "succeeded";
  await poll("succeeded");
  assert.equal(await isOpen(), true, "the cleanup result reveals the details");
});

// Hold only delivery of a genuine Controller response. A later shared refusal must
// invalidate that response, not let it restore evidence the reader can no longer read.
for (const refusal of [403, 404] as const) {
  test(`selected record discards an older success after a real ${refusal}`, async (t) => {
    const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
    );
    const card = page.locator(".version-deployment-record");
    const activity = page.getByRole("region", { name: "Deployment activity" });
    await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    const captured = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    t.after(() => delivery.resolve());
    let holdNext = true;
    await page.route(url, async (route) => {
      if (!holdNext) {
        await route.continue();
        return;
      }
      holdNext = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).data.deploymentId, revisionId);
      captured.resolve();
      await delivery.promise;
      await route.fulfill({ response });
    });
    await card.getByRole("button", { name: "Refresh record", exact: true }).click();
    await captured.promise;
    if (refusal === 403) {
      fixture.policy.restrictions.push({
        id: `deny-record-${revisionId}`,
        namespaceId: namespace.id,
        resourceKind: "agent_revision",
        resourceId: revisionId,
        action: "read",
        effect: "deny",
      });
    } else {
      control.missingRevision = true;
    }
    const refused = page.waitForResponse(url);
    await page.clock.runFor(DEPLOYMENT_POLL_MS);
    const response = await refused;
    assert.equal(response.status(), refusal);
    const refusedBody = await response.json();
    assert.equal(refusedBody.data, undefined);
    assert.equal(refusedBody.error.code, refusal === 403 ? "FORBIDDEN" : "NOT_FOUND");
    if (refusal === 403) {
      assert.match(refusedBody.error.message, /^Not authorized: /);
      assert.match(refusedBody.error.message, /Ask an Installation administrator to grant it\./);
    }
    // Named denials are shown verbatim; do not restore the old generic refusal copy.
    const notice =
      refusal === 403
        ? refusedBody.error.message
        : "Resource unavailable in this Namespace. Check the ID and your access.";
    await activity.getByRole("alert").getByText(notice, { exact: true }).waitFor();
    await card.getByText(notice, { exact: true }).waitFor();
    const older = page.waitForResponse(url);
    delivery.resolve();
    assert.equal((await older).status(), 200);
    await waitForIdleFetches(page);
    assert.doesNotMatch(await card.innerText(), /Recorded outcome:|No persisted startup failure/);
    assert.equal(
      await card
        .getByRole("button", { name: "Refresh record", exact: true })
        .getAttribute("aria-disabled"),
      null,
    );
    assert.equal(await page.getByRole("alert").count(), 1);
    assert.equal(await card.getByRole("alert").count(), 0);
    // Folding transfers announcement ownership to the visible selected record.
    await activity.locator("summary").click();
    await card.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").count(), 1);
    await activity.locator("summary").click();
    await card.getByRole("alert").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("alert").count(), 1);
    // Both panels remain mounted across tabs; returning must not duplicate alerts.
    await page
      .locator(".agent-tabs")
      .getByRole("tab", { name: "Configuration", exact: true })
      .click();
    await page.locator(".agent-tabs").getByRole("tab", { name: "Deployment", exact: true }).click();
    assert.equal(await page.getByRole("alert").count(), 1);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url() === url) {
        requests.push(request.url());
      }
    });
    await page.clock.runFor(DEPLOYMENT_POLL_MS * 2);
    assert.equal(requests.length, 0, "a definitive refusal stops automatic reads");
  });
}

// The selected record can refuse a read while the activity's older request is in flight.
// Capture real controller responses and require their order: no successful read may
// refresh the cache between the refusal and the stale delivery under test.
for (const refusal of [403, 404] as const) {
  for (const delayed of [200, 503] as const) {
    test(
      `selected ${refusal} invalidates activity before late ${delayed}`,
      { timeout: 60_000 },
      async (t) => {
        const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
        const member = await fixture.createNamespaceMember(
          "record-reader",
          namespace.id,
          AGENT_READ,
        );
        const { page } = await newPage(t, fixture);
        await trackSettledFetches(page);
        await page.clock.install();
        await login(
          page,
          fixture,
          detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
          member.credentials,
        );
        const card = page.locator(".version-deployment-record");
        const activity = page.getByRole("region", { name: "Deployment activity" });
        const refresh = card.getByRole("button", { name: "Refresh record", exact: true });
        await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
        await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        t.after(() => release.resolve());
        const responses: number[] = [];
        page.on("response", (response) => {
          if (response.url() === url) {
            responses.push(response.status());
          }
        });
        let first = true;
        await page.route(url, async (route) => {
          if (!first) {
            await route.continue();
            return;
          }
          first = false;
          // A late success was fetched before revocation. A transient response is
          // fetched after revocation is lifted, without any successful record read.
          const response = delayed === 200 ? await route.fetch() : null;
          if (response) {
            assert.equal(response.status(), 200);
            assert.equal((await response.json()).data.deploymentId, revisionId);
          }
          held.resolve();
          await release.promise;
          if (response) {
            await route.fulfill({ response });
          } else {
            await route.continue();
          }
        });
        await page.clock.runFor(DEPLOYMENT_POLL_MS + 1);
        await held.promise;
        if (refusal === 403) {
          denyRevisionRead(fixture, namespace, { id: revisionId });
        } else {
          control.missingRevision = true;
        }
        const denied = page.waitForResponse(url);
        await refresh.focus();
        await refresh.hover();
        await refresh.press("Enter");
        const response = await denied;
        assert.equal(response.status(), refusal);
        const body = await response.json();
        assert.equal(body.data, undefined);
        assert.equal(body.error.code, refusal === 403 ? "FORBIDDEN" : "NOT_FOUND");
        const notice =
          refusal === 403
            ? body.error.message
            : "Resource unavailable in this Namespace. Check the ID and your access.";
        await card.getByText(notice, { exact: true }).waitFor();
        await activity.getByText(notice, { exact: true }).waitFor();
        assert.doesNotMatch(
          await activity.innerText(),
          /Recorded status:|Waiting for a worker claim/,
        );
        assert.deepEqual(responses, [refusal]);
        assert.equal(await refresh.evaluate((el) => el === document.activeElement), true);
        if (refusal === 403) {
          fixture.policy.restrictions.pop();
        }
        control.missingRevision = false;
        control.unavailable = delayed === 503;
        const older = page.waitForResponse(url);
        release.resolve();
        assert.equal((await older).status(), delayed);
        await waitForIdleFetches(page);
        assert.deepEqual(responses, [refusal, delayed]);
        await card.getByText(notice, { exact: true }).waitFor();
        await activity.getByText(notice, { exact: true }).waitFor();
        assert.doesNotMatch(
          await card.innerText(),
          /Recorded outcome:|No persisted startup failure/,
        );
        // Timer-only idle proof uses the clock; private role dogfood uses real time.
        await page.clock.runFor(DEPLOYMENT_POLL_MS * 2 + 100);
        assert.deepEqual(responses, [refusal, delayed]);
        control.unavailable = false;
        control.claimed = true;
        await refresh.press("Enter");
        await card.getByText("Recorded outcome: In progress", { exact: true }).waitFor();
        await activity.getByText("Recorded status: In progress", { exact: true }).waitFor();
        await waitForIdleFetches(page);
        assert.deepEqual(
          responses,
          [refusal, delayed, 200],
          "one fresh selected read restores both panels",
        );
        control.succeeded = true;
        await page.clock.runFor(DEPLOYMENT_POLL_MS + 1);
        await card.getByText("Recorded outcome: Completed", { exact: true }).waitFor();
        await activity.getByText("Recorded status: Completed", { exact: true }).waitFor();
      },
    );
  }
}

test("a selected historical refusal leaves the latest deployment readable", async (t) => {
  const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
  const newest = await fixture.deployAgent(namespace.id, agent.id);
  assert.notEqual(newest.id, revisionId);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
  );
  const card = page.locator(".version-deployment-record");
  const activity = page.getByRole("region", { name: "Deployment activity" });
  await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
  await activity.getByText("Recorded status: Queued", { exact: true }).waitFor();
  denyRevisionRead(fixture, namespace, { id: revisionId });
  const denied = page.waitForResponse(url);
  await card.getByRole("button", { name: "Refresh record", exact: true }).click();
  assert.equal((await denied).status(), 403);
  await card.getByRole("alert").waitFor();
  const newestUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${newest.id}`;
  const latest = page.waitForResponse(newestUrl);
  await activity.getByRole("button", { name: "Refresh deployment", exact: true }).click();
  const response = await latest;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).data.deploymentId, newest.id);
  await waitForIdleFetches(page);
  await activity.getByText("Recorded status: Queued", { exact: true }).waitFor();
  await card.getByRole("alert").waitFor();
  assert.doesNotMatch(await card.innerText(), /Recorded outcome:/);
  fixture.policy.restrictions.pop();
  control.claimed = true;
  await card.getByRole("button", { name: "Refresh record", exact: true }).click();
  await card.getByText("Recorded outcome: In progress", { exact: true }).waitFor();
  await activity.getByText("Recorded status: Queued", { exact: true }).waitFor();
});

// An earlier activity success may settle while a selected-record refusal is pending.
// Its render generation must not erase the subsequently delivered authorization decision.
for (const refusal of [403, 404] as const) {
  test(`selected ${refusal} survives an earlier activity success`, async (t) => {
    const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await page.clock.install();
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
    );
    const card = page.locator(".version-deployment-record");
    const activity = page.getByRole("region", { name: "Deployment activity" });
    const refresh = card.getByRole("button", { name: "Refresh record", exact: true });
    await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
    await waitForIdleFetches(page);
    const captured = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    t.after(() => release.forEach((gate) => gate.resolve()));
    let requests = 0;
    const replies: number[] = [];
    page.on("response", (response) => {
      if (response.url() === url) {
        replies.push(response.status());
      }
    });
    await page.route(url, async (route) => {
      const index = requests++;
      if (index !== 0 && index !== 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), index === 0 ? 200 : refusal);
      const body = await response.json();
      if (index === 0) {
        assert.equal(body.data.deploymentId, revisionId);
      } else {
        assert.equal(body.data, undefined);
        assert.equal(body.error.code, refusal === 403 ? "FORBIDDEN" : "NOT_FOUND");
      }
      captured[index].resolve();
      await release[index].promise;
      await route.fulfill({ response });
    });
    await page.clock.runFor(DEPLOYMENT_POLL_MS + 1);
    await captured[0].promise;
    if (refusal === 403) {
      denyRevisionRead(fixture, namespace, { id: revisionId });
    } else {
      control.missingRevision = true;
    }
    await refresh.press("Enter");
    await captured[1].promise;
    assert.equal(await card.locator("button").first().getAttribute("aria-disabled"), "true");
    const accepted = page.waitForResponse(url);
    release[0].resolve();
    assert.equal((await accepted).status(), 200);
    // The shared success has actually rendered, not merely reached the network listener.
    await page.waitForFunction(
      () =>
        document
          .querySelector(".version-deployment-record button")
          ?.getAttribute("aria-disabled") !== "true",
    );
    const denied = page.waitForResponse(url);
    release[1].resolve();
    assert.equal((await denied).status(), refusal);
    await waitForIdleFetches(page);
    assert.deepEqual(replies, [200, refusal]);
    assert.doesNotMatch(await card.innerText(), /Recorded outcome:/);
    assert.doesNotMatch(await activity.innerText(), /Recorded status:/);
    assert.equal(await refresh.evaluate((node) => node === document.activeElement), true);
    if (refusal === 403) {
      fixture.policy.restrictions.pop();
    }
    control.missingRevision = false;
    const fresh = page.waitForResponse(url);
    await activity.getByRole("button", { name: "Refresh deployment", exact: true }).click();
    assert.equal((await fresh).status(), 200);
    await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
    await activity.getByText("Recorded status: Queued", { exact: true }).waitFor();
  });
}

// A selected success replaces older activity work without turning a late refusal
// into a success. Both responses come from the real controller before delivery is held.
for (const delayed of [200, 403] as const) {
  test(`selected success supersedes activity work but honors late ${delayed}`, async (t) => {
    const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
    const member = await fixture.createNamespaceMember("recovery-reader", namespace.id, AGENT_READ);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await page.clock.install();
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment").href,
      member.credentials,
    );
    const card = page.locator(".version-deployment-record");
    const activity = page.getByRole("region", { name: "Deployment activity" });
    const refresh = card.getByRole("button", { name: "Refresh record", exact: true });
    await card.getByText("Recorded outcome: Queued", { exact: true }).waitFor();
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    if (delayed === 403) {
      denyRevisionRead(fixture, namespace, { id: revisionId });
    }
    let first = true;
    await page.route(url, async (route) => {
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      const response = await route.fetch();
      assert.equal(response.status(), delayed);
      const body = await response.json();
      if (delayed === 200) {
        assert.equal(body.data.deploymentId, revisionId);
        assert.equal(body.data.status, "queued");
      } else {
        assert.equal(body.error.code, "FORBIDDEN");
      }
      held.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    const replies: number[] = [];
    page.on("response", (response) => {
      if (response.url() === url) {
        replies.push(response.status());
      }
    });
    await page.clock.runFor(DEPLOYMENT_POLL_MS + 1);
    await held.promise;
    if (delayed === 403) {
      fixture.policy.restrictions.pop();
    }
    control.claimed = true;
    await refresh.press("Enter");
    await card.getByText("Recorded outcome: In progress", { exact: true }).waitFor();
    await activity.getByText("Recorded status: In progress", { exact: true }).waitFor();
    assert.deepEqual(replies, [200], "sharing a fresh read sends no second request");
    const late = page.waitForResponse(url);
    release.resolve();
    assert.equal((await late).status(), delayed);
    await waitForIdleFetches(page);
    assert.deepEqual(replies, [200, delayed]);
    if (delayed === 403) {
      assert.doesNotMatch(await card.innerText(), /Recorded outcome:/);
      assert.doesNotMatch(await activity.innerText(), /Recorded status:/);
      // An unchanged denial must stay denied; recovery needs a genuinely authorized read.
      denyRevisionRead(fixture, namespace, { id: revisionId });
      const denied = page.waitForResponse(url);
      await refresh.press("Enter");
      assert.equal((await denied).status(), 403);
      await waitForIdleFetches(page);
      assert.doesNotMatch(await activity.innerText(), /Recorded status:/);
      fixture.policy.restrictions.pop();
      await refresh.press("Enter");
    }
    await card.getByText("Recorded outcome: In progress", { exact: true }).waitFor();
    await activity.getByText("Recorded status: In progress", { exact: true }).waitFor();
    assert.equal(await refresh.evaluate((node) => node === document.activeElement), true);
  });
}

// This non-browser check proves the fixture's failure injection reaches the real
// status route and IAM evaluator. It does not prove DOM behavior or runtime work.
test("deployment activity fixture returns real scoped Controller responses", async (t) => {
  const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
  for (const state of [
    "queued",
    "unavailable",
    "queued",
    "running",
    "denied",
    "missing",
  ] as const) {
    control.unavailable = state === "unavailable";
    control.claimed = state === "running";
    control.missingRevision = state === "missing";
    if (state === "denied") {
      fixture.policy.restrictions.push({
        id: `deny-wire-${revisionId}`,
        namespaceId: namespace.id,
        resourceKind: "agent_revision",
        resourceId: revisionId,
        action: "read",
        effect: "deny",
      });
    } else if (state === "missing") {
      fixture.policy.restrictions.pop();
    }
    const result = await fixture.request("GET", new URL(url).pathname);
    const expected =
      state === "unavailable" ? 503 : state === "denied" ? 403 : state === "missing" ? 404 : 200;
    assert.equal(result.status, expected);
    if (expected === 200) {
      assert.equal(result.data.deploymentId, revisionId);
      assert.equal(result.data.namespaceId, namespace.id);
      assert.equal(result.data.agentId, agent.id);
      assert.equal(result.data.status, state);
    } else {
      assert.equal(result.data, undefined);
      assert.equal(
        result.body.error.code,
        state === "unavailable"
          ? "DEPENDENCY_UNAVAILABLE"
          : state === "denied"
            ? "FORBIDDEN"
            : "NOT_FOUND",
      );
    }
  }
});

// An already reconciled record must not cancel a separate user-requested overview read.
for (const scenario of ["selected first", "overview first", "newer cleanup"] as const) {
  test(`settled terminal overlap preserves ${scenario}`, async (t) => {
    const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
    await fixture.activateRevision(namespace.id, agent.id, revisionId, undefined);
    control.succeeded = true;
    control.cleanup = "queued";
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await page.clock.install();
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment"),
    );
    const card = page.locator(".version-deployment-record");
    const activity = page.getByRole("region", { name: "Deployment activity" });
    const refresh = activity.getByRole("button", { name: "Refresh deployment" });
    const selectedRefresh = card.getByRole("button", { name: "Refresh record" });
    await card.getByText("Recorded outcome: Completed", { exact: true }).waitFor();
    await waitForIdleFetches(page);
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
    const location = page.url();
    // A real admission changes the overview; the same-version control isolates cleanup
    // freshness without replacing the activity panel under test.
    const next =
      scenario === "newer cleanup" ? null : await fixture.deployAgent(namespace.id, agent.id);
    const agentUrl = url.split("/deployments/")[0]!;
    const release = Promise.withResolvers<void>();
    const selectedRelease = Promise.withResolvers<void>();
    const selectedCaptured = Promise.withResolvers<void>();
    t.after(() => {
      release.resolve();
      selectedRelease.resolve();
    });
    const captured = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const counts = { record: 0, agent: 0, revisions: 0, next: 0 };
    page.on("request", (request) => {
      if (request.url() === url) {
        counts.record++;
      }
      if (request.url() === agentUrl) {
        counts.agent++;
      }
      if (request.url().split("?")[0] === `${agentUrl}/revisions`) {
        counts.revisions++;
      }
      if (next && request.url() === `${agentUrl}/deployments/${next.id}`) {
        counts.next++;
      }
    });
    for (const [index, target] of [url, agentUrl, `${agentUrl}/revisions*`].entries()) {
      let first = true;
      await page.route(target, async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        const body = (await response.json()).data;
        if (!first) {
          assert.equal(index, 0, "overview must not be reread to resolve an overlap");
          assert.equal(body.cleanup.status, "succeeded");
          selectedCaptured.resolve();
          if (scenario === "overview first") {
            await selectedRelease.promise;
          }
          await route.fulfill({ response });
          return;
        }
        first = false;
        if (index === 0) {
          assert.equal(body.cleanup.status, "queued");
        }
        if (index === 1) {
          assert.equal(body.activeRevisionId, revisionId);
        }
        if (index === 2 && next) {
          assert.ok(body.some((item: { id: string }) => item.id === next.id));
        }
        captured[index]!.resolve();
        await release.promise;
        await route.fulfill({ response });
      });
    }
    await refresh.click();
    await Promise.all(captured.map((item) => item.promise));
    assert.equal(await refresh.getAttribute("aria-disabled"), "true");
    // This later genuine GET has the same terminal status but newer cleanup evidence.
    control.cleanup = "succeeded";
    const selected = page.waitForResponse(url);
    await selectedRefresh.press("Enter");
    await selectedCaptured.promise;
    if (scenario === "overview first") {
      release.resolve();
      await page
        .getByLabel("Viewing version")
        .locator(`option[value="${next!.id}"]`)
        .waitFor({ state: "attached" });
      selectedRelease.resolve();
    }
    assert.equal((await selected).status(), 200);
    if (scenario !== "overview first") {
      await selectedRefresh.waitFor();
      if (scenario === "newer cleanup") {
        assert.match(await activity.innerText(), /Revision cleanup completed for this version\./);
        assert.doesNotMatch(await activity.innerText(), /Revision cleanup pending/);
        assert.equal(await refresh.getAttribute("aria-disabled"), "true");
        assert.equal(
          await selectedRefresh.evaluate((node) => node === document.activeElement),
          true,
        );
      }
      release.resolve();
    }
    await waitForIdleFetches(page);
    assert.equal(page.url(), location);
    assert.equal(await selectedRefresh.evaluate((node) => node === document.activeElement), true);
    assert.equal(await refresh.getAttribute("aria-disabled"), "false");
    if (next) {
      assert.match(await page.locator("main").innerText(), /v2/);
      assert.equal(await page.getByLabel("Viewing version").inputValue(), revisionId);
    } else {
      await activity
        .getByText("Revision cleanup completed for this version.", { exact: true })
        .waitFor();
      assert.doesNotMatch(await activity.innerText(), /Revision cleanup pending/);
    }
    await card.getByText("Recorded outcome: Completed", { exact: true }).waitFor();
    assert.deepEqual(counts, { record: 2, agent: 1, revisions: 1, next: next ? 1 : 0 });
    t.diagnostic(
      JSON.stringify({
        scenario,
        counts,
        selected: await page.getByLabel("Viewing version").inputValue(),
      }),
    );
  });
}

// These settled overlaps exercise the overview path, including its ability to
// replace the activity panel. A refusal must win before that replacement occurs.
for (const scenario of [
  "old 403",
  "old 404",
  "new 403",
  "new 404",
  "mixed 401",
  "navigation",
] as const) {
  test(`settled terminal overlap honors ${scenario}`, async (t) => {
    const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
    await fixture.activateRevision(namespace.id, agent.id, revisionId, undefined);
    control.succeeded = true;
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await page.clock.install();
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revisionId, "deployment"),
    );
    const card = page.locator(".version-deployment-record");
    const activity = page.getByRole("region", { name: "Deployment activity" });
    await card.getByText("Recorded outcome: Completed", { exact: true }).waitFor();
    await waitForIdleFetches(page);
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
    await fixture.deployAgent(namespace.id, agent.id);
    const agentUrl = url.split("/deployments/")[0]!;
    const release = Promise.withResolvers<void>();
    const captured = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    t.after(() => release.resolve());
    const oldRefusal = scenario.startsWith("old") || scenario === "mixed 401";
    const refusalStatus = scenario.endsWith("404") ? 404 : 403;
    const deny = () => {
      if (scenario.endsWith("404")) {
        control.missingRevision = true;
      } else {
        denyRevisionRead(fixture, namespace, { id: revisionId });
      }
    };
    if (oldRefusal) {
      deny();
    }
    const delivered: number[] = [];
    page.on("response", (response) => {
      if (response.url() === url) {
        delivered.push(response.status());
      }
    });
    for (const [index, target] of [url, agentUrl, `${agentUrl}/revisions*`].entries()) {
      let first = true;
      await page.route(target, async (route) => {
        if (!first) {
          await route.continue();
          return;
        }
        first = false;
        // Obtain the real denial before expiring sessions. The same read batch
        // then contains both 403 and 401; authentication must take precedence.
        if (scenario === "mixed 401" && index !== 0) {
          await captured[0]!.promise;
          expireSessions(fixture);
        }
        const response = await route.fetch();
        let expected = 200;
        if (index === 0 && oldRefusal) {
          expected = refusalStatus;
        } else if (scenario === "mixed 401" && index !== 0) {
          expected = 401;
        }
        assert.equal(response.status(), expected);
        const body = await response.json();
        if (expected !== 200) {
          assert.ok(body.error.code);
        } else if (index === 0) {
          assert.equal(body.data.status, "succeeded");
        }
        captured[index]!.resolve();
        await release.promise;
        await route.fulfill({ response });
      });
    }
    await activity.getByRole("button", { name: "Refresh deployment" }).click();
    await Promise.all(captured.map((item) => item.promise));
    if (scenario === "navigation") {
      await page.getByRole("link", { name: "Agents", exact: true }).click();
    } else if (scenario !== "mixed 401") {
      if (oldRefusal) {
        control.missingRevision = false;
        if (scenario.endsWith("403")) {
          fixture.policy.restrictions.pop();
        }
      } else {
        deny();
      }
      const response = page.waitForResponse(url);
      await card.getByRole("button", { name: "Refresh record" }).press("Enter");
      assert.equal((await response).status(), oldRefusal ? 200 : refusalStatus);
      // Wait for the selected response handler before delivering the older batch.
      await card.getByRole("button", { name: "Refresh record", exact: true }).waitFor();
    }
    release.resolve();
    await waitForIdleFetches(page);
    if (scenario === "mixed 401") {
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    } else if (scenario === "navigation") {
      assert.equal(new URL(page.url()).pathname, "/console/agents");
      assert.equal(await activity.count(), 0);
    } else {
      assert.doesNotMatch(await card.innerText(), /Recorded outcome:/);
      assert.doesNotMatch(await activity.innerText(), /Recorded status:/);
      assert.deepEqual(delivered, oldRefusal ? [200, refusalStatus] : [refusalStatus, 200]);
    }
    t.diagnostic(JSON.stringify({ scenario, delivered }));
  });
}
