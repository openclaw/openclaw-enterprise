import { randomUUID } from "node:crypto";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

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
const principal = authFixture.seed.principal;
const state = {
  identities: [principal],
  groups: [],
  memberships: [],
  roles: authFixture.seed.roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
  bindings: [
    {
      id: "binding-admin",
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: authFixture.seed.roles[0].id,
    },
  ],
  restrictions: [],
};
const iamDriver = new NativeIAMDriver(
  { loadNativeIAMState: async () => state },
  { id: "iam-shipped-discovery" },
);
const auditSink = new InMemoryAuditSink();
let controller;
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

async function inject(method, pathname, body) {
  const result = await app.inject({
    method,
    url: pathname,
    headers: {
      ...authenticatedHeaders(session),
      host: "console.oce.localhost",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    remoteAddress: "127.0.0.1",
  });
  const parsed = result.statusCode === 204 ? undefined : JSON.parse(result.body);
  if (result.statusCode >= 400) {
    throw new Error(`${method} ${pathname} failed with ${result.statusCode}`);
  }
  return parsed;
}

await inject("POST", "/installation/bootstrap", { name: "Shipped discovery installation" });
const namespace = await inject("POST", "/namespaces", { name: "shipped-discovery" });
await controller.handleNamespaceLifecycle(principal.id, namespace.data.id, "ready");

console.log(
  JSON.stringify({
    event: "controller.ready",
    pid: process.pid,
    port: address.port,
    namespaceId: namespace.data.id,
    fetch: "node-undici",
    cookie: session.cookie,
  }),
);
