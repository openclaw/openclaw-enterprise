import {
  OpenShellGateway,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { bindOpenShellPluginSourceReader } from "../../apps/controller/src/composition/openshell-plugin-source-reader.ts";
import {
  CODEX_ACCESS_TOKEN_ENV,
  CODEX_ACCOUNT_CONFIG,
  CODEX_OAUTH_TYPE,
} from "../../apps/controller/src/drivers/credential-refresh/codex-device-authorization.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { Backend, Namespace, PluginDriver } from "../../packages/contracts/src/index.ts";
import type * as Grpc from "../../apps/controller/node_modules/@grpc/grpc-js/build/src/index.js";
import type * as ProtoLoader from "../../apps/controller/node_modules/@grpc/proto-loader/build/src/index.js";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { signedLeaf } from "../helpers/certificates.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const accessToken = "at-plugin-discovery-private-fixture";
const pluginId = "codex-plugin:knowledge@openai-remote";
const remoteId = "remote-knowledge";
const catalogEntry = {
  id: pluginId,
  remoteId,
  name: "Knowledge",
  description: "Search shared knowledge.",
  available: true,
  tools: null,
};
test("OpenShell source discovery uses the selected Backend reader with no Gateway callback", async (t) => {
  assert.equal("withSourceToken" in OpenShellCredentialGatewayDriver.prototype, false);
  const id = "open-shell-source-gateway";
  const sourceId = "cs_" + randomUUID();
  const name = openShellProviderName(sourceId);
  // Both production clients use verified TLS. The protocol peer expects a distinct
  // certificate on the ordinary metadata and operator export calls.
  const tls = await harnessTlsFixture(t);
  const leaf = (role: string) =>
    signedLeaf(tls.directory, tls.authority, {
      name: role,
      commonName: "source-reader-" + role,
      usage: "clientAuth",
      subjectAltName: undefined,
      keyPem: undefined,
    });
  const ordinary = await leaf("ordinary");
  const operator = await leaf("operator");
  assert.notEqual(
    new X509Certificate(ordinary.cert).fingerprint256,
    new X509Certificate(operator.cert).fingerprint256,
  );
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const proto = fileURLToPath(
    new URL(
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      import.meta.url,
    ),
  );
  const grpc: typeof Grpc = require("@grpc/grpc-js");
  const loader: typeof ProtoLoader = require("@grpc/proto-loader");
  const definition = loader.loadSync(proto, { keepCase: true });
  const server = new grpc.Server();
  t.after(() => server.forceShutdown());
  const observed: { role: string; request: unknown }[] = [];
  const peerErrors: unknown[] = [];
  let providerName = name;
  const receive = (
    role: string,
    identity: { cert: string },
    reply: () => object,
  ): Grpc.handleUnaryCall<object, object> => {
    const fingerprint = new X509Certificate(identity.cert).fingerprint256;
    return (call, callback) => {
      try {
        const auth = call.getAuthContext();
        assert.equal(auth.transportSecurityType, "ssl");
        assert.equal(auth.sslPeerCertificate?.fingerprint256, fingerprint);
        observed.push({ role, request: call.request });
        callback(null, reply());
      } catch (error) {
        peerErrors.push(error);
        callback({ code: grpc.status.PERMISSION_DENIED, message: "Unexpected source reader call" });
      }
    };
  };
  // Dynamic protobuf loading exposes a package tree; only this service is used.
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    openshell: { v1: { OpenShell: { service: Grpc.ServiceDefinition } } };
  };
  server.addService(loaded.openshell.v1.OpenShell.service, {
    GetProvider: receive("ordinary", ordinary, () => ({
      provider: {
        metadata: {
          name: providerName,
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/credential-source-id": sourceId,
          },
        },
        type: name,
        config: {
          [CODEX_ACCOUNT_CONFIG]: JSON.stringify({
            accountId: "synthetic-account",
            planType: "synthetic-plan",
            isFedramp: false,
          }),
        },
      },
    })),
    GetProviderCredentials: receive("operator", operator, () => ({
      credentials: { [CODEX_ACCESS_TOKEN_ENV]: { value: accessToken } },
    })),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createSsl(
        Buffer.from(tls.caBundle),
        [{ private_key: Buffer.from(tls.key), cert_chain: Buffer.from(tls.cert) }],
        true,
      ),
      (error, bound) => (error ? reject(error) : resolve(bound)),
    ),
  );
  const client = new OpenShellGateway({
    endpoint: `https://localhost:${port}`,
    rootCertificatePath: tls.rootCertificatePath,
    auth: {
      mode: "mtls",
      certificatePath: ordinary.certPath,
      privateKeyPath: ordinary.keyPath,
    },
    operatorTls: { certificatePath: operator.certPath, privateKeyPath: operator.keyPath },
    requestTimeoutMs: 5000,
  });
  t.after(() => client.close());
  const backend: Backend<OpenShellGateway> = {
    id: "source-reader-backend",
    drivers: { credential_gateway: id },
    client,
  };
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/bin/true"] },
    { id, backend },
  );
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  const fixture = await createConsoleAppFixture(t, {
    state,
    auditSink,
    secretDriver: createTestSecretDriver(),
    credentialGatewayDriver: gateway,
    pluginSourceReader: bindOpenShellPluginSourceReader(backend, gateway),
    async resolveSandboxNamespace(namespace: Readonly<Namespace>) {
      return { ...namespace, name: "reader-fixture" };
    },
    sandboxDriver: {
      id: "bundled-source-reader-sandbox",
      capability: "sandbox",
      implementation: "test-admission-only",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Plugin discovery", { ready: true });
  const path = `/namespaces/${namespace.id}/agents/plugins`;
  const calls: Parameters<NonNullable<PluginDriver["discoverCatalog"]>>[0][] = [];
  const policies = new CodexPluginDriver();
  // Only the external catalog is controlled; retain the production policy implementation.
  const driver: PluginDriver = {
    id: "plugin-discovery-test",
    harnessId: "codex",
    capability: "plugin",
    implementation: "test-plugin-catalog",
    policyCapabilities: policies.policyCapabilities,
    validatePolicies: policies.validatePolicies.bind(policies),
    async listCatalog() {
      throw new Error("Credential discovery must not use the runtime catalog.");
    },
    async discoverCatalog(input) {
      calls.push(input);
      return {
        plugins: input.cursor ? [] : [catalogEntry],
        nextCursor: input.cursor ? null : "second-page",
      };
    },
    async getCatalogPlugin() {
      return catalogEntry;
    },
  };
  fixture.controller.installPluginDrivers([driver]);
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver(gateway.capability, id);
  await state.transact((state) =>
    state.credentialSources.createCredentialSource({
      id: sourceId,
      namespaceId: namespace.id,
      name: "Retained source",
      type: CODEX_OAUTH_TYPE,
      ownerCapability: "credential_gateway",
      driverId: id,
      state: "ready",
      config: {},
      secrets: {},
      createdAt: new Date().toISOString(),
    }),
  );
  const credentialSource = {
    kind: "credential_source",
    id: sourceId,
    namespaceId: namespace.id,
  };
  const request = () =>
    fixture.request("POST", path, { body: { harnessId: "codex", credentialSource } });
  const allowed = await request();
  assert.deepEqual(peerErrors, []);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const metadataObservation = {
    role: "ordinary",
    request: { workspace_scope: { workspace: "reader-fixture" }, name },
  };
  const exportObservation = {
    role: "operator",
    request: {
      workspace_scope: { workspace: "reader-fixture" },
      name,
      credential_keys: [CODEX_ACCESS_TOKEN_ENV],
    },
  };
  assert.deepEqual(observed, [metadataObservation, exportObservation]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.accessToken, accessToken);
  assert.equal(JSON.stringify(allowed.body).includes(accessToken), false);

  providerName = openShellProviderName(randomUUID());
  const denied = await request();
  assert.notEqual(denied.status, 200);
  assert.equal(JSON.stringify(denied.body).includes(accessToken), false);
  assert.deepEqual(peerErrors, []);
  assert.deepEqual(
    observed,
    [metadataObservation, exportObservation, metadataObservation],
    "the mismatched returned name must stop discovery before a second export",
  );
  assert.equal(calls.length, 1, "a rejected lookup must not reach the plugin catalog");
});
