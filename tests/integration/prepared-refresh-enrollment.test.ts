import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  CredentialProviderDefinition,
  CredentialRefreshDriver,
  PreparedTokenIssuer,
  PreparedTokenGrant,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  type PlatformStateStore,
  type OpenClawController,
} from "../../packages/occ/src/index.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { openShellExchangeCapabilities } from "../../apps/controller/src/drivers/egress-proxy/openshell-exchange-capabilities.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

type Rotation = "refresh" | "external";
type SecretDriver = ReturnType<typeof createTestSecretDriver>;
type Effects = {
  configure: number;
  resolve: number;
  legacyConfigure: number;
  legacyRotate: number;
  sourceCreates: number;
};

function preparedOwner(rotation: Rotation, secretDriver: SecretDriver, calls: Effects) {
  const grant = (config: Readonly<Record<string, string>> = {}): PreparedTokenGrant => {
    assert.ok(config.agent_id);
    return {
      kind: "prepared_scope",
      isolationId: config.agent_id,
      scope: { resource: "artifact" },
    };
  };
  const provider: CredentialProviderDefinition = {
    ref: { id: "controlled-prepared", generation: 1 },
    schemaVersion: 1,
    sourceType: {
      type: "controlled-prepared",
      rotation,
      config: [{ name: "agent_id", required: true }],
      secrets: [{ name: "issuer", required: true }],
    },
    normalizeConfig: (config) => config,
    normalizeGrant: (_material, config) => grant(config),
    routes: () => [],
    classify: () => undefined,
    inject: () => [],
    credentialRejected: () => false,
    protectResponse: () => undefined,
  };
  const issuer: PreparedTokenIssuer = {
    tokenKind: "prepared_source",
    provider: provider.ref,
    issuerInput: "issuer",
    issuerAuthority: "controlled-issuer",
    admission: (config) => ({
      origin: "https://resource.example.test",
      schemaVersion: 4,
      grant: grant(config),
    }),
    sourceFromRoute: () => undefined,
    async configure(_source, secret) {
      calls.configure++;
      await secretDriver.withValue(secret, async () => {});
    },
    async ready() {
      return true;
    },
    async withdraw() {},
    async resolve() {
      calls.resolve++;
      return undefined;
    },
  };
  return { provider, issuer };
}

function registerPreparedPair(
  t: TestContext,
  controller: OpenClawController,
  provider: CredentialProviderDefinition,
) {
  const sandbox: SandboxDriver = {
    id: "sandbox",
    implementation: "openshell",
    capability: "sandbox",
    facets: ["networking"],
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    harnessResource: () => {
      throw new Error("No workload in enrollment test");
    },
    cleanup: async () => {},
  };
  const client = new (class extends GrpcOpenShellGatewayClient {
    override async getGatewayInfo() {
      return {
        gateway_version: "0.1.7",
        extensions: [
          {
            configured_name: "controlled",
            kind: 4,
            protocol_major: 1,
            required_capabilities: openShellExchangeCapabilities,
            supported_capabilities: openShellExchangeCapabilities,
          },
        ],
      };
    }
  })({ endpoint: "http://127.0.0.1:1" });
  t.after(() => client.close());
  const proxy = new OpenShellCredentialProxyDriver(
    { middlewareName: "controlled", authorityScope: "execution" },
    {
      id: "proxy",
      backend: {
        id: "backend",
        drivers: {},
        client: new OpenShellGateway({ serviceName: "openshell" }, { gatewayClient: client }),
      },
      sandbox,
      preparedProviders: [provider],
    },
  );
  controller.registerDriver(
    new InstalledDriver(
      { id: sandbox.id, implementation: "openshell", configuration: {} },
      { capabilities: { sandbox, credential_proxy: proxy } },
      { sandbox: sandbox.id, credential_proxy: proxy.id },
    ),
  );
  controller.selectDriver("sandbox", sandbox.id);
  controller.selectDriver("credential_proxy", proxy.id);
}

function legacyRefresh(calls: Effects): CredentialRefreshDriver {
  return {
    id: "refresh",
    implementation: "controlled",
    capability: "credential_refresh",
    async configureRefresh() {
      calls.legacyConfigure++;
      return { state: "ready" };
    },
    async rotate() {
      calls.legacyRotate++;
      return { state: "ready" };
    },
    async refreshStatus() {
      return { state: "ready" };
    },
    async removeRefresh() {},
  };
}

async function enrollmentFixture(t: TestContext, rotation: Rotation, refreshInstalled: boolean) {
  const calls: Effects = {
    configure: 0,
    resolve: 0,
    legacyConfigure: 0,
    legacyRotate: 0,
    sourceCreates: 0,
  };
  const secretDriver = createTestSecretDriver();
  const { provider, issuer } = preparedOwner(rotation, secretDriver, calls);
  const tokens = new TokenService();
  tokens.registerIssuer(issuer);
  const app = await createConsoleAppFixture(t, {
    secretDriver,
    preparedTokens: tokens,
    wrapState: (state: PlatformStateStore): PlatformStateStore => ({
      read: (work) => state.read(work),
      transact: (work) =>
        state.transact((unit) =>
          work({
            ...unit,
            credentialSources: {
              ...unit.credentialSources,
              createCredentialSource(input) {
                calls.sourceCreates++;
                return unit.credentialSources.createCredentialSource(input);
              },
            },
          }),
        ),
    }),
  });
  await app.bootstrap();
  const namespace = await app.createNamespace("prepared-enrollment", { ready: true });
  const agent = await app.createAgent(
    namespace.id,
    "prepared-agent",
    {},
    { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
  );
  const secret = await app.createSecret(namespace.id, "issuer", "synthetic-issuer-material");
  registerPreparedPair(t, app.controller, provider);
  if (refreshInstalled) {
    const refresh = legacyRefresh(calls);
    app.controller.registerDriver(refresh);
    app.controller.selectDriver("credential_refresh", refresh.id);
  }
  const path = `/namespaces/${namespace.id}/credential-sources`;
  const body = {
    name: "prepared-source",
    type: provider.sourceType.type,
    config: { agent_id: agent.id },
    secrets: { issuer: secret.ref },
  };
  const before = secretDriver.calls.length;
  return {
    app,
    namespace,
    path,
    body,
    async effects() {
      // Registration awaits configuration and minting; also observe the next event-loop turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const listed = await app.request("GET", path);
      assert.equal(listed.status, 200);
      return {
        ...calls,
        secretReads: secretDriver.calls
          .slice(before)
          .filter((call) => call.operation === "withValue").length,
        rows: listed.data.length,
      };
    },
  };
}

type EnrollmentFixture = Awaited<ReturnType<typeof enrollmentFixture>>;

async function assertAdmissionDiagnostics(f: EnrollmentFixture) {
  // Existing authentication, exact create authorization and schema diagnostics win first.
  const anonymous = await f.app.request("POST", f.path, { body: f.body, session: null });
  assert.equal(anonymous.status, 401);
  const reader = await f.app.createNamespaceMember("reader", f.namespace.id, [
    ["read", "credential_source"],
  ]);
  const readerSession = await f.app.signIn(reader.credentials);
  const forbidden = await f.app.request("POST", f.path, { body: f.body, session: readerSession });
  assert.equal(forbidden.status, 403);
  const malformed = await f.app.request("POST", f.path, { body: { ...f.body, config: {} } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_REQUEST");
  assert.deepEqual(malformed.body.error.details, [
    { path: "/config/agent_id", code: "INVALID_VALUE" },
  ]);
}

for (const refreshInstalled of [true, false]) {
  test(`prepared refresh enrollment refuses before effects (legacy Refresh ${refreshInstalled ? "installed" : "missing"})`, async (t) => {
    const f = await enrollmentFixture(t, "refresh", refreshInstalled);
    await assertAdmissionDiagnostics(f);
    const response = await f.app.request("POST", f.path, { body: f.body });
    const effects = await f.effects();
    assert.equal(response.status, 501, JSON.stringify({ response: response.body, effects }));
    assert.equal(response.body.error.code, "NOT_IMPLEMENTED");
    assert.equal(
      response.body.error.message,
      "This prepared issuer does not support on-demand rotation. Use a Credential Gateway-owned refresh source instead.",
    );
    assert.deepEqual(effects, {
      configure: 0,
      resolve: 0,
      legacyConfigure: 0,
      legacyRotate: 0,
      sourceCreates: 0,
      secretReads: 0,
      rows: 0,
    });
  });
}

test("non-refresh prepared enrollment uses only its issuer with legacy Refresh installed", async (t) => {
  const f = await enrollmentFixture(t, "external", true);
  const response = await f.app.request("POST", f.path, { body: f.body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.data.state, "ready");
  assert.equal(response.data.ownerCapability, "credential_proxy");
  assert.deepEqual(await f.effects(), {
    configure: 1,
    resolve: 0,
    legacyConfigure: 0,
    legacyRotate: 0,
    sourceCreates: 1,
    secretReads: 1,
    rows: 1,
  });
});
