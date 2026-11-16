import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NamespaceResponse } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

export interface ControllerReady {
  event: "controller.ready";
  pid: number;
  port: number;
  namespaceId: string;
  fetch: "node-undici";
  cookie: string;
}

// Shipped HTTP application in its own process. global fetch is left untouched;
// Node's proxy environment sends provider calls to the catalog process.
if (!String(fetch).includes("internal/deps/undici/undici")) {
  throw new Error("Controller fetch is not Node's built-in undici fetch.");
}

const installationId = "ins_3033697e-6397-4cc6-9b04-8ec17af78cf1";
const authFixture = await createTestAuthPrincipal({
  installationId,
  email: `admin-${randomUUID()}@example.com`,
  password: `generated-password-${randomUUID()}`,
  name: "Model Discovery Administrator",
});
const { principal, roles, bindings } = authFixture.seed;
const state: NativeIAMState = {
  identities: [principal],
  groups: [],
  memberships: [],
  roles,
  bindings,
  restrictions: [],
};
const iamDriver = new NativeIAMDriver(
  { loadNativeIAMState: async () => state },
  { id: "iam-shipped-discovery" },
);
const auditSink = new InMemoryAuditSink();
let controller: OpenClawController | undefined;
const native = createTestKubernetesComputeDriver("compute-model-discovery");
const app = createFastifyApp({
  createController(installation) {
    controller = new OpenClawController(installation, {
      state: new InMemoryPlatformState({ auditSink }),
      recordOperations: false,
    });
    return controller;
  },
  iamDriver,
  computeDriver: {
    ...createReadyComputeDriver("compute-shipped-discovery"),
    discoverHarnessModels: native.discoverHarnessModels,
  },
  configurationDriver: createTestConfigurationDriver({ id: "configuration-shipped-discovery" }),
  secretDriver: createTestSecretDriver({ id: "secret-shipped-discovery" }),
  resolveHarness: resolveApprovedHarness,
  auditSink,
  development: {
    enabled: true,
    installationId,
    browserOrigin: "https://console.oce.localhost",
  },
  auth: authFixture.auth,
});

await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") {
  throw new Error("Controller did not bind.");
}
const session = await signInToControllerApp(app, authFixture);

async function post(pathname: string, body: object) {
  const result = await app.inject({
    method: "POST",
    url: pathname,
    headers: {
      ...authenticatedHeaders(session),
      host: "console.oce.localhost",
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
    remoteAddress: "127.0.0.1",
  });
  assert.equal(result.statusCode, 201, `POST ${pathname} did not create the resource`);
  return result.body;
}

await post("/installation/bootstrap", { name: "Shipped discovery installation" });
const namespace: unknown = JSON.parse(await post("/namespaces", { name: "shipped-discovery" }));
assert.ok(Check(NamespaceResponse, namespace), "Controller must return a Namespace response");
assert.ok(controller, "Installation bootstrap must create the controller");
await controller.handleNamespaceLifecycle(principal.id, namespace.data.id, "ready");

const ready: ControllerReady = {
  event: "controller.ready",
  pid: process.pid,
  port: address.port,
  namespaceId: namespace.data.id,
  fetch: "node-undici",
  cookie: session.cookie,
};
console.log(JSON.stringify(ready));
