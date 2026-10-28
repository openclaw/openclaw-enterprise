import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import type {
  PlatformReadView,
  PlatformStateStore,
} from "../../packages/occ/src/state/platform-state.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
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
                control.unavailable = false;
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
  const fixture = await createConsoleAppFixture(t, { recordOperations: true, wrapState });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Keyboard activity", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Keyboard reader", nativeValues("reader"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  revisionId = revision.id;
  workKey = `agent_revision:${revisionId}:reconcile`;
  cleanupKey = `agent_revision:${revisionId}:repository_cleanup:retire:${createHash("sha256").update(revisionId, "utf8").digest("hex")}`;
  const url = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`;
  return { fixture, namespace, agent, revisionId, url, control };
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(
    `deployment activity preserves reading position and reveals final refusal at ${viewport.width}`,
    { timeout: 60_000 },
    async (t) => {
      const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
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
      type Outcome = "queued" | "running" | "succeeded" | 503 | 404;
      async function received(pending: ReturnType<typeof next>, expected: Outcome) {
        const response = await pending;
        assert.equal(response.status(), typeof expected === "number" ? expected : 200);
        const body = await response.json();
        if (typeof expected === "number") {
          assert.equal(body.data, undefined, "failed reads do not return a private record");
          assert.equal(body.error.code, expected === 503 ? "DEPENDENCY_UNAVAILABLE" : "NOT_FOUND");
          await region
            .getByText(
              expected === 503
                ? "Service unavailable. The read could not be completed. Try again."
                : "Resource unavailable in this Namespace. Check the ID and your access.",
              { exact: true },
            )
            .waitFor({ state: "attached" });
          assert.equal(await region.locator(".deployment-outcome").count(), 0);
          const card = page.locator(".version-deployment-record");
          await card
            .getByText(
              expected === 503
                ? "Service unavailable. The read could not be completed. Try again."
                : "Resource unavailable in this Namespace. Check the ID and your access.",
              { exact: true },
            )
            .waitFor();
          assert.doesNotMatch(
            await card.innerText(),
            /Recorded outcome:|No persisted startup failure/,
          );
          assert.equal(
            await page.getByRole("alert").count(),
            1,
            "one visible alert outside or inside the fold",
          );
          await page
            .getByRole("region", { name: "Agent state at a glance" })
            .getByText("Recorded deployment status could not be read.", { exact: true })
            .waitFor();
        } else {
          assert.equal(body.data.deploymentId, revisionId);
          assert.equal(body.data.namespaceId, namespace.id);
          assert.equal(body.data.agentId, agent.id);
          assert.equal(body.data.status, expected);
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
        await received(response, expected);
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
      control.unavailable = true;
      await poll(503);
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
      assert.deepEqual(responses, [200, 503, 404]);
      await page.clock.runFor(2 * DEPLOYMENT_POLL_MS);
      assert.equal(responses.length, 3, "final refusal stops automatic polling");
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
        control.unavailable = true;
        await poll(503);
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
      // A human-triggered repeated transient error still needs a visible result.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await isOpen()) {
          await details.locator("summary").click();
        }
        control.unavailable = true;
        const failed = next();
        await refresh.click();
        await received(failed, 503);
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
  const { fixture, namespace, agent, revisionId, url, control } = await deploymentFixture(t);
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
        .getByText("Service unavailable. The read could not be completed. Try again.", {
          exact: true,
        })
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
  control.unavailable = true;
  await poll(null);
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
