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
import type { Backend, Namespace } from "../../packages/contracts/src/index.ts";
import type * as Grpc from "../../apps/controller/node_modules/@grpc/grpc-js/build/src/index.js";
import type * as ProtoLoader from "../../apps/controller/node_modules/@grpc/proto-loader/build/src/index.js";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { createServer } from "node:http";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { fileURLToPath } from "node:url";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { signedLeaf } from "../helpers/certificates.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const accessToken = "at-plugin-discovery-private-fixture";
const pluginId = "codex-plugin:knowledge@openai-curated-remote";
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
  type PeerCall = { role: string; request: unknown };
  const observed: PeerCall[] = [];
  const peerErrors: unknown[] = [];
  let providerName = name;
  // Hold the actual operator RPC at the verified peer, after observing its identity.
  let holdExport: ((finish: () => void) => void) | undefined;
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
        const finish = () => callback(null, reply());
        if (role === "operator" && holdExport) {
          holdExport(finish);
        } else {
          finish();
        }
      } catch (error) {
        peerErrors.push(error);
        callback({
          code: grpc.status.PERMISSION_DENIED,
          message: "Unexpected source reader call",
        });
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
  fixture.controller.installPluginDrivers([new CodexPluginDriver()]);
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
  const agent = await fixture.createAgent(
    namespace.id,
    "Source reader Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    },
  );
  const identities: NativeIAMState["identities"][number][] = fixture.policy.identities;
  identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: namespace.id,
    agentId: agent.id,
  });
  const actor = await fixture.createAccountWithPolicy("source-reader-editor", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "source-reader-editor-role",
      namespaceId: namespace.id,
      permissions: { agent: ["read", "update"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const session = await fixture.signIn(actor.credentials);
  const sourceBindings = [actor.principal.id, agent.servicePrincipalId].map((principalId) => {
    const bindingId = `source-reader-binding-${principalId}`;
    grantRole(fixture.policy, principalId, {
      id: `source-reader-operator-${principalId}`,
      bindingId,
      namespaceId: namespace.id,
      permissions: { credential_source: ["operate"] },
      resource: credentialSource,
    });
    const binding = fixture.policy.bindings.find(({ id }) => id === bindingId);
    assert.ok(binding);
    return binding;
  });
  const savedPath = `/namespaces/${namespace.id}/agents/${agent.id}/plugins`;
  const savedRequest = () => fixture.request("POST", savedPath, { session, body: {} });

  // Exercise the production hosted serializer and real socket I/O. Only the exact
  // catalog URL is redirected; no credential, policy, or response method is mocked.
  const catalogPath = "/backend-api/ps/plugins/list?scope=GLOBAL&limit=20";
  let catalogCalls = 0;
  const catalogErrors: unknown[] = [];
  const catalog = createServer((request, response) => {
    catalogCalls += 1;
    try {
      assert.equal(request.method, "GET");
      assert.equal(request.url, catalogPath);
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
      assert.equal(request.headers["chatgpt-account-id"], "synthetic-account");
      assert.equal(request.headers["oai-product-sku"], "codex");
      assert.equal(request.headers["x-openai-fedramp"], undefined);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          plugins: [
            {
              id: remoteId,
              name: "knowledge",
              scope: "GLOBAL",
              status: "ENABLED",
              installation_policy: "AVAILABLE",
              release: {
                display_name: "Knowledge",
                description: "Search shared knowledge.",
                interface: {},
                app_ids: ["app_knowledge"],
                skills: [],
                requires_local_executor: false,
              },
            },
          ],
          pagination: { next_page_token: "second-page" },
        }),
      );
    } catch (error) {
      catalogErrors.push(error);
      response.writeHead(500).end();
    }
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        catalog.close((error) => (error ? reject(error) : resolve()));
        catalog.closeAllConnections();
      }),
  );
  await new Promise<void>((resolve, reject) => {
    catalog.once("error", reject);
    catalog.listen(0, "127.0.0.1", resolve);
  });
  const catalogAddress = catalog.address();
  const appAddress = fixture.app.server.address();
  assert.ok(catalogAddress && typeof catalogAddress !== "string");
  assert.ok(appAddress && typeof appAddress !== "string");
  const appOrigin = `http://127.0.0.1:${appAddress.port}`;
  const catalogUrl = `http://127.0.0.1:${catalogAddress.port}${catalogPath}`;
  const originalFetch = globalThis.fetch;
  const rejectedFetches: string[] = [];
  const redirectCatalogFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `https://chatgpt.com${catalogPath}` && method === "GET") {
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      assert.equal(init.redirect, "error");
      return originalFetch(catalogUrl, init);
    }
    if ((url === appOrigin + path || url === appOrigin + savedPath) && method === "POST") {
      return originalFetch(input, init);
    }
    rejectedFetches.push(`${method} ${url}`);
    throw new Error("Unexpected source-reader fixture transport");
  };
  t.mock.method(globalThis, "fetch", redirectCatalogFetch);
  // Agent creation may itself inspect the provider; the proof starts here.
  observed.length = 0;
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
  assert.equal(catalogCalls, 1);
  assert.deepEqual(allowed.data.plugins, [catalogEntry]);
  assert.equal(allowed.data.nextCursor, "second-page");
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
  assert.equal(catalogCalls, 1, "a rejected lookup must not reach the plugin catalog");
  providerName = name;

  const remove = (binding: (typeof sourceBindings)[number]) => {
    const index = fixture.policy.bindings.indexOf(binding);
    assert.notEqual(index, -1);
    fixture.policy.bindings.splice(index, 1);
  };
  const callerBinding = sourceBindings[0]!;
  remove(callerBinding);
  const beforeDenied = observed.length;
  const beforeDeniedCatalog = catalogCalls;
  try {
    const missingGrant = await savedRequest();
    assert.equal(missingGrant.status, 403, JSON.stringify(missingGrant.body));
    assert.equal(observed.length, beforeDenied, "denial must precede metadata and export");
    assert.equal(catalogCalls, beforeDeniedCatalog);
    t.diagnostic(
      `Missing caller grant: HTTP ${missingGrant.status}; new OpenShell calls=${observed.length - beforeDenied}; new catalog requests=${catalogCalls - beforeDeniedCatalog}`,
    );
  } finally {
    fixture.policy.bindings.push(callerBinding);
  }

  // Both withdrawals occur while one authenticated operator export is in progress.
  // The retained-grant control uses exactly the same barrier and saved Agent.
  for (const binding of [undefined, ...sourceBindings, undefined]) {
    const before: number = observed.length;
    const beforeCatalog: number = catalogCalls;
    let release: (() => void) | undefined;
    let entered!: () => void;
    const atPeer = new Promise<void>((resolve) => {
      entered = resolve;
    });
    holdExport = (finish) => {
      assert.equal(release, undefined, "only one export may be held");
      release = finish;
      entered();
    };
    const pending = savedRequest();
    // Consume a possible rejection even if the peer-entry deadline wins.
    pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removed = false;
    try {
      await Promise.race([
        atPeer,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("operator export did not arrive")), 5000);
        }),
      ]);
      clearTimeout(timer);
      assert.deepEqual(observed.slice(before), [metadataObservation, exportObservation]);
      assert.equal(catalogCalls, beforeCatalog, "held export has not reached the catalog");
      if (binding) {
        remove(binding);
        removed = true;
      }
      holdExport = undefined;
      release!(); // Yield the synthetic token even after withdrawal.
      release = undefined;
      const result = await pending;
      assert.equal(result.status, binding ? 403 : 200, JSON.stringify(result.body));
      assert.equal(catalogCalls, beforeCatalog + (binding ? 0 : 1));
      const peerCalls: PeerCall[] = observed.slice(before);
      assert.deepEqual(peerCalls, [metadataObservation, exportObservation]);
      const scenario = !binding
        ? "Retained authority"
        : binding === callerBinding
          ? "Caller grant withdrawn during export"
          : "Agent grant withdrawn during export";
      t.diagnostic(
        `${scenario}: HTTP ${result.status}; metadata=${peerCalls.filter(({ role }) => role === "ordinary").length}; export=${peerCalls.filter(({ role }) => role === "operator").length}; new catalog requests=${catalogCalls - beforeCatalog}`,
      );
      if (!binding) {
        assert.deepEqual(result.data.plugins, [catalogEntry]);
        assert.equal(result.data.nextCursor, "second-page");
      }
      assert.equal(JSON.stringify(result.body).includes(accessToken), false);
    } finally {
      clearTimeout(timer);
      holdExport = undefined;
      release?.();
      await pending.catch(() => {});
      if (removed) {
        fixture.policy.bindings.push(binding!);
      }
    }
  }
  assert.equal(catalogCalls, 3, "draft and both retained-grant saved requests reach the server");
  assert.deepEqual(peerErrors, []);
  assert.deepEqual(catalogErrors, []);
  assert.deepEqual(rejectedFetches, []);
  assert.equal(JSON.stringify(auditSink.events).includes(accessToken), false);
});
