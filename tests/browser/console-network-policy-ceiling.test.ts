import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "playwright";
import { createPolicyConsole } from "./console-sandbox-policy-fixture.ts";
import {
  apiRequests,
  detailUrl,
  expectNoHorizontalScroll,
  login,
  newPage,
} from "./console-agents-browser-helpers.ts";
import { responseTo } from "./console-action-helpers.ts";
import { restrict } from "../helpers/iam-grants.mjs";

const path = "/installation/sandbox-network-policy-ceiling";
const rule = {
  id: "python-docs",
  binary: "/usr/bin/python3.11",
  host: "docs.example.org",
  ports: [{ from: 443, to: 443 }],
};
const click = (section: Locator, name: string) =>
  section.getByRole("button", { name, exact: true }).click();
async function review(page: Page, section: Locator, origin: string) {
  const response = responseTo(page, "POST", `${origin}${path}/validate`);
  await click(section, "Review changes");
  assert.equal((await response).status(), 200);
}

// The production Console, Fastify routes, IAM and controller run with in-memory storage.
// Only explicitly lost HTTP responses below are intercepted; admission and saves stay real.
test("Settings reviews shared field errors and saves only the reviewed ceiling", async (t) => {
  const { fixture } = await createPolicyConsole(t, []);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `${fixture.origin}/console/settings`);
  const section = page.locator(".network-policy-ceiling");
  await section.getByText("No additional network access is delegated.", { exact: false }).waitFor();
  await click(section, "Add rule");
  await section
    .getByRole("textbox", { name: "Executable path", exact: true })
    .fill("/usr/../bin/python3.11");
  await section
    .getByRole("textbox", { name: "Destination hostname", exact: true })
    .fill("bad..example.org");
  await review(page, section, fixture.origin);
  await section.getByText("Check the network rules", { exact: true }).waitFor();
  assert.ok((await section.innerText()).includes("normalized absolute executable path"));
  assert.ok((await section.innerText()).includes("valid DNS host"));
  assert.equal(
    requests.filter((request) => request.path === path && request.method === "PUT").length,
    0,
  );
  await click(section, "Edit rule");
  assert.equal(
    await section.getByRole("textbox", { name: "Destination hostname", exact: true }).inputValue(),
    "bad..example.org",
  );
  await section.getByRole("textbox", { name: "Executable path", exact: true }).fill(rule.binary);
  await section.getByRole("textbox", { name: "Destination hostname", exact: true }).fill(rule.host);
  await review(page, section, fixture.origin);
  await section.getByRole("button", { name: "Save ceiling", exact: true }).waitFor();
  assert.equal(
    (await fixture.request("GET", path)).data.rules.length,
    0,
    "review grants no access and saves nothing",
  );
  const response = responseTo(page, "PUT", `${fixture.origin}${path}`);
  await click(section, "Save ceiling");
  assert.equal((await response).status(), 200);
  await section.getByText("Network policy ceiling saved", { exact: true }).waitFor();
  const saved = (await fixture.request("GET", path)).data;
  assert.equal(saved.version, 2);
  assert.equal(saved.rules[0].host, rule.host);
  await click(section, "Edit rule");
  const draftStatus = section.locator(".ceiling-actions [role=status]");
  const hostname = section.getByRole("textbox", { name: "Destination hostname", exact: true });
  const reviewButton = section.getByRole("button", { name: "Review changes", exact: true });
  assert.equal(await draftStatus.textContent(), "No unsaved changes");
  await hostname.fill("updated.example.org");
  assert.equal(await draftStatus.textContent(), "Unsaved changes");
  assert.equal(await reviewButton.isEnabled(), true);
  assert.equal(await hostname.evaluate((input) => input === document.activeElement), true);
  await hostname.fill(rule.host);
  assert.equal(await draftStatus.textContent(), "No unsaved changes");
  assert.equal(await reviewButton.isDisabled(), true);
  assert.equal(await hostname.evaluate((input) => input === document.activeElement), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
});

test("stale ceiling saves retain the draft and require a newer baseline and review", async (t) => {
  const { fixture } = await createPolicyConsole(t, [rule]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `${fixture.origin}/console/settings`);
  const section = page.locator(".network-policy-ceiling");
  await page.setViewportSize({ width: 390, height: 844 });
  const remove = section.getByRole("button", { name: "Remove rule", exact: true });
  await remove.waitFor();
  const bounds = await remove.boundingBox();
  assert.ok(
    bounds && bounds.width > 80 && bounds.height < 60,
    "phone rule actions remain readable without letter-by-letter wrapping",
  );
  await click(section, "Remove rule");
  await review(page, section, fixture.origin);
  await section.getByText("Clear the network policy ceiling", { exact: true }).waitFor();
  // Another real API caller commits after review but before this browser's explicit save.
  const newer = { ...rule, host: "newer.example.org" };
  assert.equal(
    (await fixture.request("PUT", path, { body: { expectedVersion: 1, rules: [newer] } })).status,
    200,
  );
  const response = responseTo(page, "PUT", `${fixture.origin}${path}`);
  await click(section, "Save ceiling");
  assert.equal((await response).status(), 409);
  await section.getByText("The saved ceiling changed", { exact: true }).waitFor();
  assert.equal(await section.getByRole("button", { name: "Save ceiling", exact: true }).count(), 0);
  await click(section, "Load current ceiling");
  await section.getByText("Current ceiling loaded", { exact: true }).waitFor();
  await review(page, section, fixture.origin);
  await section.getByText("Clear the network policy ceiling", { exact: true }).waitFor();
  await section.getByText("Current saved rules · Version 2", { exact: true }).click();
  assert.ok((await section.innerText()).includes(newer.host));
  await click(section, "Save ceiling");
  await section.getByText("Network policy ceiling saved", { exact: true }).waitFor();
  assert.deepEqual((await fixture.request("GET", path)).data.rules, []);
});

for (const committed of [true, false]) {
  test(`uncertain ceiling save ${committed ? "confirms its commit" : "requires an explicit reviewed retry"} without automatic PUT`, async (t) => {
    const { fixture } = await createPolicyConsole(t, [rule]);
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `${fixture.origin}/console/settings`);
    const section = page.locator(".network-policy-ceiling");
    await click(section, "Remove rule");
    await review(page, section, fixture.origin);
    await page.route(
      `${fixture.origin}${path}`,
      async (route) => {
        if (route.request().method() !== "PUT") {
          await route.continue();
          return;
        }
        if (committed) {
          assert.equal((await route.fetch()).status(), 200);
        }
        await route.abort("failed");
      },
      { times: 1 },
    );
    await click(section, "Save ceiling");
    await section.getByText("Save outcome unknown", { exact: true }).waitFor();
    assert.equal(
      await section.getByRole("button", { name: "Save ceiling", exact: true }).count(),
      0,
    );
    await click(section, "Inspect saved ceiling");
    await section
      .getByText(committed ? "Saved ceiling matches the proposal" : "Saved ceiling inspected", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      requests.filter((request) => request.path === path && request.method === "PUT").length,
      1,
    );
    if (!committed) {
      assert.equal((await fixture.request("GET", path)).data.version, 1);
      await click(section, "Use current version for review");
      await review(page, section, fixture.origin);
      await click(section, "Save ceiling");
      await section.getByText("Network policy ceiling saved", { exact: true }).waitFor();
      assert.equal(
        requests.filter((request) => request.path === path && request.method === "PUT").length,
        2,
      );
    }
    assert.deepEqual((await fixture.request("GET", path)).data.rules, []);
  });
}

test("Agent limits link needs known Installation administration and a refused Settings save hides mutation controls", async (t) => {
  const { fixture, namespace, agent } = await createPolicyConsole(t, [rule]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, undefined, "policy"));
  await page.getByRole("button", { name: "View network limits", exact: true }).click();
  const limits = page.getByRole("dialog", { name: "Network limits", exact: true });
  await limits
    .getByRole("link", { name: "Manage network policy ceiling in Settings", exact: true })
    .waitFor();
  await limits.getByRole("link").click();
  const section = page.locator(".network-policy-ceiling");
  await click(section, "Remove rule");
  await review(page, section, fixture.origin);
  restrict(fixture.policy, "administer", "installation");
  const response = responseTo(page, "PUT", `${fixture.origin}${path}`);
  await click(section, "Save ceiling");
  assert.equal((await response).status(), 403);
  await section.getByText("Installation administration required", { exact: true }).waitFor();
  assert.equal(await section.getByRole("button", { name: "Save ceiling", exact: true }).count(), 0);
  assert.equal(
    await section.getByRole("button", { name: "Review changes", exact: true }).count(),
    0,
  );
  assert.equal(await section.getByRole("button", { name: "Add rule", exact: true }).count(), 0);
  assert.ok((await section.innerText()).includes("Retained draft"));
  // A fresh permissions answer suppresses the admin Settings read and Agent limit link.
  const requests = apiRequests(page, fixture.origin);
  await page.reload();
  await page.getByRole("heading", { name: "Signed-in account", exact: true }).waitFor();
  assert.equal(await page.locator(".network-policy-ceiling").count(), 0);
  assert.equal(requests.filter((request) => request.path === path).length, 0);
  await page.goto(detailUrl(fixture, namespace.id, agent.id, undefined, "policy").href);
  await page.getByRole("button", { name: "View network limits", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog", { name: "Network limits", exact: true })
      .getByRole("link")
      .count(),
    0,
  );
});
