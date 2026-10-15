import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { detailUrl, login, nativeValues, newPage } from "./console-agents-browser-helpers.mjs";

test("Deployment activity appears once with its recorded status, not as an empty panel first", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Activity layout", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Layout Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let releaseStatus;
  const statusHeld = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  let statusReads = 0;
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    async (route) => {
      statusReads += 1;
      await statusHeld;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId: revision.id,
            namespaceId: namespace.id,
            agentId: agent.id,
            status: "running",
            error: null,
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_test_activity_layout" },
        }),
      });
    },
  );
  t.after(() => releaseStatus());
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  // The version list has loaded and the newest version's status read is in flight.
  await summary.getByText("Reading recorded deployment status.").waitFor();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  assert.ok(statusReads > 0);

  const activity = page.locator(".deployment-status");
  assert.equal(await activity.count(), 1);
  const placeholder = await activity.boundingBox();
  // The loading placeholder stays in place: no second, taller empty panel pushes the
  // sharing panel and version tabs down before the status arrives (they then move once).
  assert.equal(await activity.getByText("Loading the most recent visible deployment…").count(), 1);
  assert.equal(await activity.getByText("Deployment status has not loaded.").count(), 0);
  assert.equal(await activity.getByRole("button", { name: /Refresh/ }).count(), 0);
  await page.waitForTimeout(300);
  assert.deepEqual(await activity.boundingBox(), placeholder);

  releaseStatus();
  await activity.getByText("Recorded status: running").waitFor();
  await activity.getByRole("button", { name: "Refresh deployment" }).waitFor();
  await summary.getByText("Recorded status: running").waitFor();
  assert.equal(await page.locator(".deployment-status").count(), 1);
});
