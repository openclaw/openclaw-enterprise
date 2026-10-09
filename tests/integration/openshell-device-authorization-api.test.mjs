import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

test("Console device login persists the actual OpenShell OAuth catalog source and returns device instructions", async (t) => {
  const providers = new Map();
  const client = {
    async getProviderProfile() {},
    async importProviderProfile() {},
    async createProvider(input) {
      providers.set(input.name, { ...input, config: {}, resourceVersion: "1" });
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
  };
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    {
      backend: {
        drivers: { credential_gateway: "credential-gateway-openshell" },
        client: { clientForNamespace: () => client },
      },
    },
  );
  const compute = createTestKubernetesComputeDriver("openshell-device-api-compute");
  Object.assign(compute, {
    // Infrastructure placement is simulated. Fastify, IAM, OCC source validation/storage,
    // the OpenShell Driver catalog/registration, and device response parsing remain real.
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: "oauth-api-fixture" };
    },
  });
  const fixture = await createConsoleAppFixture(t, {
    computeDriver: compute,
    secretDriver: createTestSecretDriver(),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OAuth API proof", { ready: true });
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") {
      return originalFetch(url, init);
    }
    assert.equal(url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
    assert.equal(init.method, "POST");
    return Response.json({
      device_auth_id: "synthetic-device-handle",
      user_code: "TEST-CODE",
      interval: "5",
    });
  });
  const response = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/device-authorizations`,
    { body: { harnessId: "codex" } },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.data.status, "pending");
  assert.equal(response.data.userCode, "TEST-CODE");
  assert.equal(response.data.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(JSON.stringify(response.body).includes("synthetic-device-handle"), false);
  const sources = await fixture.request("GET", `/namespaces/${namespace.id}/credential-sources`);
  assert.equal(sources.status, 200);
  assert.equal(sources.data.length, 1);
  assert.equal(sources.data[0].type, "codex-oauth");
  assert.equal(providers.size, 1, "the persisted source reached the real Driver registration path");
});
