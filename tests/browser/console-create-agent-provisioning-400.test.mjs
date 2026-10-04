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
