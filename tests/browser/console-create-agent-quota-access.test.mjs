import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { fileBrowser, login, newPage } from "./console-agents-browser-helpers.mjs";
import {
  createModelCredentialSecret,
  routeInstallationProvisioning,
} from "./console-agents-test-support.mjs";

// Every test opens its own context in one Chromium per file.
const browser = fileBrowser();

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

// Create Agent shows a full Namespace Pod quota while the first deployment reports it, and shows
// generic progress again once the reader can no longer read that deployment (finding 1637). A
// denied read (403) loses access as surely as a missing one (404): the quota line must not stay.
test("Create Agent drops the Pod quota line when the deployment read is denied", async (t) => {
  const quotaFull =
    "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an administrator to raise the quota.";
  const fixture = await createConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pod quota denied", { ready: true });
  const { page } = await newPage(t, fixture, { browser });
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  const updatedAt = new Date().toISOString();
  const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
  const url = `/namespaces/${namespace.id}/agents/provision/work_quota_denied`;
  const agentId = "agt_00000000-0000-4000-8000-00000000b637";
  const revisionId = "rev_00000000-0000-4000-8000-00000000b637";
  const job = (status, extra = {}) => ({
    workId: "work_quota_denied",
    status,
    phase: "configuration",
    attemptCount: 1,
    updatedAt,
    url,
    ...extra,
  });
  const handedOff = { phase: "handoff", agentId, configurationId: "cfg_quota", revisionId };
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ data: { provisioning: job("queued") }, meta }),
    }),
  );
  // The job hands off its first deployment and polls it three times before failing.
  const reads = [
    job("running"),
    job("running", handedOff),
    job("running", handedOff),
    job("running", handedOff),
    job("failed", {
      ...handedOff,
      error: {
        code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
        message: "Agent provisioning could not complete.",
      },
    }),
  ];
  let read = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_quota_denied`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: reads[Math.min(read++, reads.length - 1)], meta }),
    }),
  );
  // The first deployment read names the quota; every later one is denied.
  let deploymentReads = 0;
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    (route) => {
      deploymentReads += 1;
      return route.fulfill(
        deploymentReads === 1
          ? {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                data: {
                  deploymentId: revisionId,
                  namespaceId: namespace.id,
                  agentId,
                  status: "queued",
                  error: null,
                  warnings: [],
                  progress: {
                    lastAttempt: {
                      at: updatedAt,
                      code: "NAMESPACE_POD_QUOTA_EXCEEDED",
                      message: quotaFull,
                    },
                    nextAttemptAt: updatedAt,
                  },
                },
                meta,
              }),
            }
          : {
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "FORBIDDEN",
                  message: "The exact platform operation was not authorized.",
                },
                meta,
              }),
            },
      );
    },
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Pod quota denied");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  await page.evaluate(() => {
    globalThis.provisioningWrites = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        if (record.target.nodeType === 1 && record.target.getAttribute("role") === "status") {
          const text = [...record.addedNodes].map((node) => node.textContent).join("");
          if (text.startsWith("Provisioning") || text.startsWith("The Namespace")) {
            globalThis.provisioningWrites.push(text);
          }
        }
      }
    }).observe(globalThis.document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.getByText("Provisioning failed.", { exact: true }).waitFor();
  assert.equal(read, reads.length);
  assert.equal(deploymentReads, 3);
  assert.deepEqual(await page.evaluate(() => globalThis.provisioningWrites), [
    "Provisioning request accepted.",
    "Provisioning queued…",
    "Provisioning Agent…",
    quotaFull,
    "Provisioning Agent…",
    "Provisioning failed.",
  ]);
});
