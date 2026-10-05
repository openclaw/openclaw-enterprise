import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { apiRequests, login, newPage, pathRequests } from "./console-agents-browser-helpers.mjs";
import {
  agentProvisionPostRequests,
  createModelCredentialSecret,
  openAdvancedSettings,
} from "./console-agents-test-support.mjs";

// The production Kubernetes Drivers, built without a cluster client. The Compute Driver
// advertises dedicated provisioning through the real /installation route. Provisioning
// needs exact Configuration create and inspect, which only the Kubernetes Configuration
// Driver implements; its validation refuses inline model credentials. Admission refuses
// this request before any cluster call or provisioning record.
function provisioningDrivers() {
  const computeDriver = Object.assign(createTestKubernetesComputeDriver("console-provisioning"), {
    // createNamespace({ ready: true }) runs Namespace lifecycle; readiness is the cluster
    // boundary.
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
  });
  const configurationDriver = new KubernetesConfigurationDriver(
    { authentication: { mode: "inCluster" } },
    { id: "console-provisioning-configuration" },
  );
  return { computeDriver, configurationDriver };
}

test("Dedicated Agent provisioning shows the API's 400 message for an inline model credential", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision inline credential", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provisioned inline credential");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, `model-secret-${randomUUID()}`);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  await openAdvancedSettings(page);
  // A pasted provider key is a value, not the Secret reference the field requires.
  const sentinel = `synthetic-inline-key-${randomUUID()}`;
  const configuration = page.getByLabel("Configuration JSON");
  const edited = JSON.parse(await configuration.inputValue());
  edited.models = {
    ...edited.models,
    providers: { ...edited.models?.providers, openai: { apiKey: sentinel } },
  };
  await configuration.fill(JSON.stringify(edited, null, 2));
  const rejected = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  // Create Agent stays disabled until the real Installation capabilities are read, so
  // the click waits until the submit routes to provisioning.
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await rejected;
  assert.equal(response.status(), 400);
  const { error, meta } = await response.json();
  // The API's own sentence names the field to fix; the console shows it unchanged.
  assert.match(error.message, /\/models\/providers\/openai\/apiKey/);
  const feedback = page.getByRole("alert").filter({ hasText: meta.requestId });
  await feedback.waitFor();
  assert.equal(await feedback.textContent(), `${error.message} Request ID: ${meta.requestId}`);
  // Only the editor holds the key; the explanation never repeats it.
  assert.equal((await feedback.textContent()).includes(sentinel), false);
  // The refusal came from provisioning admission: no draft-path writes, one request.
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/configurations`).length,
    0,
  );
  // A 400 means the request was never admitted, so the form unlocks for a fix.
  assert.equal(await configuration.isDisabled(), false);
});

test("Dedicated Agent provisioning names a Namespace that is not ready", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision not ready", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Provisioned before ready");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, `model-secret-${randomUUID()}`);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  // The API's answer while the Namespace is provisioning.
  const provisionUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/provision`;
  await page.route(provisionUrl, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "NAMESPACE_NOT_READY",
              message: "The requested Namespace is not ready.",
            },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
          }),
        })
      : route.fallback(),
  );
  const rejected = page.waitForResponse(
    (response) => response.url() === provisionUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await rejected).status(), 409);
  const feedback = page
    .getByRole("alert")
    .filter({ hasText: "req_00000000-0000-4000-8000-000000000409" });
  await feedback.waitFor();
  assert.equal(
    await feedback.textContent(),
    "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes (on Kubernetes installs, after an operator grants the tenant RoleBindings). Request ID: req_00000000-0000-4000-8000-000000000409",
  );
});

test("Agent name counts characters, as the API does, not UTF-16 code units", async (t) => {
  const fixture = await createConsoleAppFixture(t, provisioningDrivers());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent name length", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, `model-secret-${randomUUID()}`);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const name = page.getByLabel("Agent name");
  // Only the writes a submit makes. Once a credential is selected, the form also prefetches
  // the plugin catalog with a read-only POST .../agents/plugins after a 300 ms debounce,
  // which can land at any point in this test.
  const writePaths = new Set(
    ["agents", "agents/provision", "configurations"].map(
      (path) => `/namespaces/${namespace.id}/${path}`,
    ),
  );
  const agentPosts = () =>
    requests.filter((request) => request.method === "POST" && writePaths.has(request.path));
  // 200 emoji are 200 characters, the API's limit, but 400 UTF-16 code units.
  const longest = "\u{1F600}".repeat(200);
  const tooLong = `${longest}\u{1F600}`;
  // Typed, not filled: maxlength=200 stopped typing at 100 emoji.
  await name.pressSequentially(longest);
  assert.equal(await name.inputValue(), longest);
  assert.equal(await name.evaluate((input) => input.validity.valid), true);

  await name.fill(tooLong);
  assert.equal(
    await name.evaluate((input) => input.validationMessage),
    "Use at most 200 characters.",
  );
  // A restored draft sets the name without an input event; submit checks it too.
  await name.evaluate((input, value) => {
    input.setCustomValidity("");
    input.value = value;
  }, tooLong);
  // Create Agent stays disabled until capabilities are read; the click then submits.
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal(
    await name.evaluate((input) => input.validationMessage),
    "Use at most 200 characters.",
  );
  assert.equal(agentPosts().length, 0);

  // An edit clears the refusal, and 200 characters are sent as typed.
  await name.fill(longest);
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision`,
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await sent).postDataJSON().name, longest);
});
