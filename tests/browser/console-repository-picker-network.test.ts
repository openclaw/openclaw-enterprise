import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import type { GitHubRepositoryRegistration } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import type { RepositoryOptionListResponse } from "../../packages/contracts/src/api/resources.ts";
import { login, newPage, repositoryCheckbox } from "./console-agents-browser-helpers.mjs";
import { createRepositoryLaunchFixture } from "./console-agents-test-support.mjs";

// Advance through the former polling delays and wait for a real browser response after each.
async function passDescriptionWindow(page: Page) {
  for (const milliseconds of [300, 2_100]) {
    await page.clock.runFor(milliseconds);
    await page.evaluate(async () => {
      const response = await fetch("/console/favicon-16.png?repository-network-sentinel", {
        cache: "no-store",
      });
      await response.arrayBuffer();
    });
  }
}

test("repository selection and access edits send no descriptionRefs during the polling window", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(
    t,
    (namespaceId: string): GitHubRepositoryRegistration[] => [
      {
        repositoryRef: "application",
        repositoryId: "789",
        repository: "example/application",
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
      },
    ],
  );
  const { page }: { page: Page } = await newPage(t, fixture);
  const path = `/namespaces/${namespace.id}/agents/repository-options`;
  const obsoleteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === fixture.origin && url.searchParams.has("descriptionRefs")) {
      obsoleteRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    }
  });
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1_000);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  // The launch page does not load repository choices until the form is opened.
  // Observe the response and click together so either failure is handled immediately.
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === fixture.origin &&
        url.pathname === path &&
        url.search === "" &&
        response.request().method() === "GET"
      );
    }),
    page.getByRole("button", { name: "Start without Preset" }).click(),
  ]);
  assert.equal(response.status(), 200);
  const envelope: RepositoryOptionListResponse = await response.json();
  assert.deepEqual(
    envelope.data.map((option) => option.repositoryRef),
    ["application"],
  );
  const choice = repositoryCheckbox(page, "example/application");
  await choice.waitFor({ state: "visible" });
  assert.equal(await choice.isEnabled(), true);
  await passDescriptionWindow(page);
  assert.deepEqual(obsoleteRequests, [], "visible choices must not start description polling");

  await choice.check();
  assert.equal(await choice.isChecked(), true);
  await page.getByRole("button", { name: "Access for example/application", exact: true }).click();
  await page.locator("#repository-inherit-application").uncheck();
  await page.locator("#repository-override-application-git-read").check();
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-override-application-git-read").isChecked(), true);
  await passDescriptionWindow(page);
  assert.deepEqual(
    obsoleteRequests,
    [],
    "selection and access edits must not restart description polling",
  );
});
