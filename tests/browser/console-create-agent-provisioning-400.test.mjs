import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
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

async function modelSourceFixture(t, options = {}, gatewayMethods = {}) {
  const drivers = provisioningDrivers();
  drivers.computeDriver.resolveSandboxNamespace = async (namespace) => namespace;
  const fixture = await createConsoleAppFixture(t, { ...drivers, ...options });
  await fixture.bootstrap();
  const calls = [];
  const removals = [];
  const gateway = {
    id: "console-credential-gateway",
    capability: "credential_gateway",
    implementation: "test-model-source",
    async listSourceTypes() {
      return [
        {
          type: "openai",
          config: [],
          secrets: [{ name: "api_key", required: true }],
          rotation: "none",
          harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
        },
      ];
    },
    async registerSource(context, input) {
      calls.push({ sourceId: context.source.id, input });
      return gatewayMethods.registerSource
        ? gatewayMethods.registerSource(context, input, calls.length)
        : { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async updateSource() {
      assert.fail("these cases do not update a source");
    },
    async rotateSource() {
      assert.fail("these cases do not rotate a source");
    },
    async attachForRevision() {
      assert.fail("these cases do not deploy a Sandbox");
    },
    async attachmentStatus() {
      assert.fail("these cases do not deploy a Sandbox");
    },
    async withdraw() {
      assert.fail("these cases do not withdraw a source");
    },
    async removeSource(context) {
      removals.push(context.source.id);
    },
  };
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  return { fixture, calls, removals };
}

async function openModelSourceForm(t, fixture, namespace, harness = "codex") {
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption(harness);
  if (harness === "openclaw") {
    await page.locator(".launch-runtime:not([open]) > summary").click();
    await page.getByLabel("Execution mode").selectOption("dedicated");
  }
  await page.getByLabel("Agent name").fill("Source-backed " + harness);
  const secret = await createModelCredentialSecret(page, "synthetic-source-model-key-" + harness);
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  return { page, secret };
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

test("The pinned runtime lets the Console request dedicated OpenClaw provisioning", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    ...provisioningDrivers(),
    sandboxDriver: {
      id: "console-native-sandbox",
      capability: "sandbox",
      implementation: "console-native",
      facets: ["networking", "filesystem", "process"],
      async provisionHarness() {
        assert.fail("provisioning admission must leave effects to the worker");
      },
      async cleanup() {},
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pinned native deployment", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.locator(".launch-runtime:not([open]) > summary").click();
  const mode = page.getByLabel("Execution mode");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), false);
  await mode.selectOption("dedicated");
  await page.getByLabel("Agent name").fill("Dedicated native from Console");
  await createModelCredentialSecret(page, "synthetic-native-model-key");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const sent = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await sent;
  // This fixture has no transactional provisioning queue. The request reaches
  // the real provisioning route; admission and deployment have separate coverage.
  assert.equal(response.status(), 503);
  assert.equal((await response.json()).error.code, "DEPENDENCY_UNAVAILABLE");
  const payload = response.request().postDataJSON();
  assert.equal(payload.executionMode, "dedicated");
  assert.equal(payload.configuration.values.agents.defaults.model, "openai/gpt-5");
  // Packaged Kubernetes proof separately verifies queued work and deployment.
  // No draft writes or external provisioning effects occur in this fixture.
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents`).length, 0);
});

test("Credential Gateway creation registers the same model source for both dedicated harnesses", async (t) => {
  for (const harness of ["openclaw", "codex"]) {
    await t.test(harness, async (t) => {
      const { fixture, calls } = await modelSourceFixture(
        t,
        {},
        {
          registerSource(_context, _input, attempt) {
            // A terminal failure is cleaned up by the actual registration owner.
            return harness === "openclaw" && attempt === 1
              ? { state: "failed" }
              : { state: "ready" };
          },
        },
      );
      const namespace = await fixture.createNamespace("Console model source " + harness, {
        ready: true,
      });
      const { page, secret } = await openModelSourceForm(t, fixture, namespace, harness);
      const requests = apiRequests(page, fixture.origin);
      const sentinel = "synthetic-source-model-key-" + harness;
      // Lose only the registration response. The real owner records the source first;
      // checking it must recover that exact registration, never create another copy.
      const sourceUrl = `${fixture.origin}/namespaces/${namespace.id}/credential-sources`;
      await page.route(sourceUrl, async (route) => {
        if (route.request().method() !== "POST") {
          return route.fallback();
        }
        const response = await route.fetch();
        if (response.status() === 503) {
          return route.fulfill({ response });
        }
        assert.equal(response.status(), 201);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "Synthetic lost registration reply.",
            },
          }),
        });
      });
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      if (harness === "openclaw") {
        await page.getByRole("button", { name: "Check credential registration" }).click();
        await page
          .getByText(
            "No credential registration is visible. Select Create Agent to retry the same registration.",
            { exact: true },
          )
          .waitFor();
        await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      }
      await page.getByRole("button", { name: "Check credential registration" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
        true,
      );
      assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
      await page.getByRole("button", { name: "Check credential registration" }).click();
      await page
        .getByText("Credential Source is ready. Select Create Agent to continue.", { exact: true })
        .waitFor();
      const sent = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith("/agents/provision"),
      );
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      const response = await sent;
      assert.equal(response.status(), 503); // This fixture has no durable provisioning queue.
      const payload = response.request().postDataJSON();
      assert.deepEqual(payload.harnessAuth, {
        method: "credential_source",
        sourceId: calls.at(-1).sourceId,
      });
      assert.equal(payload.executionMode, "dedicated");
      assert.equal(calls.length, harness === "openclaw" ? 2 : 1);
      assert.deepEqual(calls.at(-1).input.secrets, { api_key: sentinel });
      const registrations = pathRequests(
        requests,
        "POST",
        `/namespaces/${namespace.id}/credential-sources`,
      );
      assert.equal(registrations.length, calls.length);
      for (const registration of registrations) {
        assert.deepEqual(registration.body, registrations[0].body);
        assert.deepEqual(registration.body.secrets, { api_key: secret.ref });
      }
      assert.equal(JSON.stringify(payload).includes(sentinel), false);
      assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents`).length, 0);
    });
  }
});

test("Credential registration recovers a ready source after a same-name retry conflicts", async (t) => {
  const { fixture, calls } = await modelSourceFixture(t);
  const namespace = await fixture.createNamespace("Delayed source registration", { ready: true });
  const { page } = await openModelSourceForm(t, fixture, namespace);
  const requests = apiRequests(page, fixture.origin);
  const sourcePath = `/namespaces/${namespace.id}/credential-sources`;
  const sourceUrl = fixture.origin + sourcePath;
  let delayedRegistration;
  await page.route(sourceUrl, async (route) => {
    if (route.request().method() !== "POST" || delayedRegistration) {
      return route.fallback();
    }
    // The transport loses the response before the original request reaches OCC.
    // Its exact body will arrive after the operator checks the currently empty list.
    delayedRegistration = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Synthetic delayed registration." },
      }),
    });
  });
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Check credential registration" }).click();
  await page
    .getByText(
      "No credential registration is visible. Select Create Agent to retry the same registration.",
      { exact: true },
    )
    .waitFor();
  // Complete the earlier real API request between the empty read and the explicit retry.
  // Namespace/name uniqueness must reject the retry before another gateway registration.
  const registered = await fixture.request("POST", sourcePath, { body: delayedRegistration });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const conflict = page.waitForResponse(
    (response) => response.url() === sourceUrl && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await page.getByRole("button", { name: "Check credential registration" }).click();
  await page
    .getByText("Credential Source is ready. Select Create Agent to continue.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Remove failed credential registration" }).isVisible(),
    false,
  );
  const provision = page.waitForResponse(
    (response) =>
      response.url().endsWith("/agents/provision") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await provision;
  assert.equal(response.status(), 503); // The fixture has no durable provisioning queue.
  assert.deepEqual(response.request().postDataJSON().harnessAuth, {
    method: "credential_source",
    sourceId: registered.data.id,
  });
  assert.equal(calls.length, 1);
  const retries = pathRequests(requests, "POST", sourcePath);
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[0].body, retries[1].body);
});

test("Credential registration removal preserves the safety fence and retries the exact source", async (t) => {
  let now = Date.now();
  const { fixture, calls, removals } = await modelSourceFixture(
    t,
    { now: () => new Date(now) },
    {
      registerSource(_context, _input, attempt) {
        if (attempt === 1) {
          throw new Error("Synthetic uncertain gateway outcome.");
        }
        return { state: "ready" };
      },
    },
  );
  const namespace = await fixture.createNamespace("Source removal recovery", { ready: true });
  const { page, secret } = await openModelSourceForm(t, fixture, namespace, "openclaw");
  const requests = apiRequests(page, fixture.origin);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Check credential registration" }).click();
  const remove = page.getByRole("button", { name: "Remove failed credential registration" });
  await remove.waitFor();
  const sourceId = calls[0].sourceId;
  const sourcePath = `/namespaces/${namespace.id}/credential-sources/${sourceId}`;
  const deleted = () =>
    page.waitForResponse(
      (response) =>
        response.url() === fixture.origin + sourcePath && response.request().method() === "DELETE",
    );
  const first = deleted();
  await remove.click();
  assert.equal((await first).status(), 503);
  // The real owner already removed the copy, but keeps the deleting record to
  // fence late registration effects. The Console must retain the same cleanup handle.
  const fenced = await fixture.request("GET", sourcePath);
  assert.equal(fenced.status, 200, JSON.stringify(fenced.body));
  assert.equal(fenced.data.state, "deleting");
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  await page.getByText(/Retry removal when the Credential Gateway is available/).waitFor();
  now += 70_001;
  const second = deleted();
  await remove.click();
  assert.equal((await second).status(), 204);
  await page
    .getByText(
      "Failed credential registration removed. Select Create Agent to retry with the saved model Secret.",
      { exact: true },
    )
    .waitFor();
  const retry = page.waitForResponse(
    (response) =>
      response.url().endsWith("/agents/provision") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await retry;
  assert.equal(response.status(), 503); // The fixture has no durable provisioning queue.
  assert.deepEqual(response.request().postDataJSON().harnessAuth, {
    method: "credential_source",
    sourceId: calls[1].sourceId,
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].sourceId, sourceId);
  assert.deepEqual(calls[0].input, calls[1].input);
  assert.deepEqual(removals, [sourceId, sourceId, sourceId]); // Initial abandonment, then both DELETEs.
  assert.equal(pathRequests(requests, "DELETE", sourcePath).length, 2);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/credential-sources`)[1].body
      .secrets,
    { api_key: secret.ref },
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets/${secret.id}`)).status,
    200,
  );
});

test("Agent Credentials saves its existing model source without replacing the binding", async (t) => {
  const { fixture } = await modelSourceFixture(t, {
    configurationDriver: undefined,
    filesystemConfiguration: true,
  });
  const namespace = await fixture.createNamespace("Saved Source authentication", { ready: true });
  const secret = await fixture.createSecret(
    namespace.id,
    "Source model key",
    "synthetic-retained-source-key",
  );
  const source = await fixture.request("POST", `/namespaces/${namespace.id}/credential-sources`, {
    body: { name: "Agent model source", type: "openai", secrets: { api_key: secret.ref } },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const configuration = await fixture.createConfiguration(
    namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5"),
  );
  const harnessAuth = { method: "credential_source", sourceId: source.data.id };
  const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Retained model Source",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth,
      credentialSources: [{ sourceId: source.data.id }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agentPath = `/namespaces/${namespace.id}/agents/${created.data.id}`;
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${created.data.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  const method = page.getByLabel("Authentication source", { exact: true });
  await method.waitFor();
  assert.equal(await method.inputValue(), "credential_source");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + agentPath && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON().harnessAuth, harnessAuth);
  const current = await fixture.request("GET", agentPath);
  assert.deepEqual(current.data.harnessAuth, harnessAuth);
  assert.deepEqual(current.data.credentialSources, [{ sourceId: source.data.id }]);
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
