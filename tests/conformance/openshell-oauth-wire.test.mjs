import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

// Real TLS proves client identity and header separation; the RPC bodies below are
// controlled protocol fixtures, not proof of OpenShell's refresh implementation.
async function wireCertificates(t) {
  const directory = await mkdtemp(join(tmpdir(), "openshell-oauth-wire-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = (name) => join(directory, name);
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=OpenShell wire test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.crt"),
  );
  for (const [name, subject, extensions] of [
    [
      "server",
      "/CN=localhost",
      "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    ["operator", "/CN=wire-client/OU=operator", "extendedKeyUsage=clientAuth"],
  ]) {
    openssl(
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      subject,
      "-keyout",
      path(`${name}.key`),
      "-out",
      path(`${name}.csr`),
    );
    await writeFile(path(`${name}.ext`), `basicConstraints=critical,CA:FALSE\n${extensions}\n`);
    openssl(
      "x509",
      "-req",
      "-in",
      path(`${name}.csr`),
      "-CA",
      path("ca.crt"),
      "-CAkey",
      path("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      path(`${name}.ext`),
      "-out",
      path(`${name}.crt`),
    );
  }
  // The gateway accepts ordinary bearer clients as well as authenticated operator
  // certificates on one endpoint; require a certificate only on the export RPC.
  const provider = new grpc.experimental.FileWatcherCertificateProvider({
    caCertificateFile: path("ca.crt"),
    certificateFile: path("server.crt"),
    privateKeyFile: path("server.key"),
    refreshIntervalMs: 60_000,
  });
  return {
    rootCertificatePath: path("ca.crt"),
    operatorTls: { certificatePath: path("operator.crt"), privateKeyPath: path("operator.key") },
    serverCredentials: grpc.experimental.createCertificateProviderServerCredentials(
      provider,
      provider,
      false,
    ),
    bearerPath: path("bearer"),
  };
}

test(
  "OpenShell OAuth RPCs preserve workspace/key scope and isolate operator credential reads",
  { timeout: 20_000 },
  async (t) => {
    const certificates = await wireCertificates(t);
    await writeFile(certificates.bearerPath, "synthetic-bearer");
    const assertBearer = (call) => {
      assert.deepEqual(call.metadata.get("authorization"), ["Bearer synthetic-bearer"]);
      assert.equal(call.getAuthContext().sslPeerCertificate, undefined);
    };
    const proto = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-oauth-poc-wire.proto"),
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true,
      },
    );
    const OpenShell = grpc.loadPackageDefinition(proto).openshell.v1.OpenShell;
    const workspace = "oauth-poc";
    const sourceId = "source-fixture";
    const provider = openShellProviderName(sourceId);
    const key = "CODEX_ACCESS_TOKEN";
    const expiry = new Date(Date.now() + 3_600_000);
    const expiryWire = { seconds: String(Math.floor(expiry.getTime() / 1000)), nanos: 0 };
    let current = "synthetic-access-first";
    let denyRead = false;
    let readResponse;
    let pendingRead = false;
    const received = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    let rotations = 0;
    const requests = [];
    const status = {
      provider,
      credential_key: key,
      status: "refreshed",
      expiration_time: expiryWire,
    };
    const server = new grpc.Server();
    server.addService(OpenShell.service, {
      ConfigureProviderRefresh(call, callback) {
        assertBearer(call);
        requests.push(call.request);
        callback(null, { status: { ...status, status: "configured" } });
      },
      RotateProviderCredential(call, callback) {
        assertBearer(call);
        assert.equal(call.request.workspace_scope.workspace, workspace);
        assert.equal(call.request.provider, provider);
        assert.equal(call.request.credential_key, key);
        rotations++;
        callback(null, { status });
      },
      GetProviderRefreshStatus(call, callback) {
        assertBearer(call);
        assert.equal(call.request.credential_key, key);
        callback(null, { credentials: [status] });
      },
      GetProvider(call, callback) {
        assertBearer(call);
        assert.equal(call.request.workspace_scope.workspace, workspace);
        callback(null, {
          provider: {
            type: "oce-codex-oauth",
            metadata: {
              name: provider,
              resource_version: "7",
              labels: {
                "app.kubernetes.io/managed-by": "openclaw-enterprise",
                "openclaw.dev/credential-source-id": sourceId,
              },
            },
            config: {
              "oce.codex.account": JSON.stringify({
                accountId: "account-fixture",
                planType: "plus",
              }),
            },
          },
        });
      },
      GetProviderCredentials(call, callback) {
        assert.equal(call.getAuthContext().sslPeerCertificate?.subject.OU, "operator");
        assert.deepEqual(call.metadata.get("authorization"), []);
        assert.deepEqual(call.request, {
          workspace_scope: { workspace },
          name: provider,
          credential_keys: [key],
        });
        if (pendingRead) {
          call.once("cancelled", () => cancelled.resolve());
          received.resolve();
          return;
        }
        if (denyRead) {
          callback({
            code: grpc.status.PERMISSION_DENIED,
            details: "synthetic-private-provider-error",
          });
        } else {
          callback(null, {
            credentials: readResponse ?? { [key]: { value: current, expiration_time: expiryWire } },
          });
        }
      },
    });
    const port = await new Promise((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", certificates.serverCredentials, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const configuration = {
      endpoint: `https://localhost:${port}`,
      auth: { mode: "bearerTokenFile", path: certificates.bearerPath },
      rootCertificatePath: certificates.rootCertificatePath,
      operatorTls: certificates.operatorTls,
    };
    const client = new GrpcOpenShellGatewayClient(configuration);
    t.after(() => {
      client.close();
      server.forceShutdown();
    });
    const signal = AbortSignal.timeout(10_000);
    await client.configureProviderRefresh(
      {
        workspace,
        provider,
        credentialKey: key,
        strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
        material: { client_id: "synthetic-client", refresh_token: "synthetic-refresh" },
        requestId: randomUUID(),
        expirationTime: expiry.toISOString(),
      },
      signal,
    );
    assert.equal(requests[0].strategy, "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN");
    assert.equal(requests[0].workspace_scope.workspace, workspace);
    assert.equal(requests[0].credential_key, key);
    assert.equal(requests[0].material.refresh_token, "synthetic-refresh");
    assert.equal(requests[0].expiration_time.seconds, String(Math.floor(expiry.getTime() / 1000)));
    await client.rotateProviderCredential(workspace, provider, key, randomUUID(), signal);
    assert.equal(
      (await client.getProviderRefreshStatus(workspace, provider, key, signal)).status,
      "refreshed",
    );

    const backend = createOpenShellBackend({
      id: "openshell",
      implementation: "openshell",
      configuration,
      drivers: {
        sandbox: "sandbox",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    });
    t.after(() => backend.client.close());
    assert.deepEqual(
      await backend.client
        .credentialClientForNamespace(workspace)
        .getProviderCredential(workspace, provider, key, signal),
      { value: current, expirationTime: `${expiry.toISOString().slice(0, 19)}.000000000Z` },
    );
    const driver = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/codex"] },
      { backend },
    );
    // Incoming IP-SAN transport must also carry the operator identity without SNI or bearer headers.
    const ipBackend = createOpenShellBackend({
      id: "openshell-ip",
      implementation: "openshell",
      configuration: { ...configuration, endpoint: `https://127.0.0.1:${port}` },
      drivers: {
        sandbox: "sandbox",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    });
    t.after(() => ipBackend.client.close());
    const ipDriver = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/codex"] },
      { backend: ipBackend },
    );
    const context = {
      signal,
      namespace: { id: "namespace", name: workspace },
      source: { id: sourceId, namespaceId: "namespace", driverId: driver.id, type: "codex-oauth" },
    };
    assert.equal(
      await ipDriver.withSourceToken(context, async ({ accessToken }) => accessToken),
      current,
    );
    const seen = [];
    const consume = async (token) => {
      seen.push(token);
      return "catalog-result";
    };
    assert.equal(await driver.withSourceToken(context, consume), "catalog-result");
    // The fake server represents an already-published replacement. This proves a fresh RPC read,
    // not OAuth rotation; the separate real-gateway test proves refresh and committed storage.
    current = "synthetic-access-replacement";
    await driver.withSourceToken(context, consume);
    assert.deepEqual(
      seen.map(({ accessToken }) => accessToken),
      ["synthetic-access-first", "synthetic-access-replacement"],
    );
    assert.equal(seen[1].accountId, "account-fixture");
    assert.equal(rotations, 1, "source reads leave refresh coordination to GetProviderCredentials");
    denyRead = true;
    await assert.rejects(driver.withSourceToken(context, consume), (error) => {
      assert.equal(error.grpcStatus, grpc.status.PERMISSION_DENIED);
      assert.match(error.message, /GetProviderCredentials failed/);
      assert.equal(error.message.includes("synthetic-private-provider-error"), false);
      return true;
    });
    denyRead = false;
    // Fail closed on unexpected selection, unusable values, and malformed declared expiry.
    // These are decoder/adapter checks; this fixture does not simulate gateway refresh decisions.
    for (const [credentials, error] of [
      [{}, /unexpected credential selection/],
      [{ OTHER_TOKEN: { value: "synthetic-unrequested" } }, /unexpected credential selection/],
      [
        { [key]: { value: current }, OTHER_TOKEN: { value: "synthetic-unrequested" } },
        /unexpected credential selection/,
      ],
      [{ [key]: {} }, /must be a nonempty string/],
      [{ [key]: { value: "" } }, /must be a nonempty string/],
      [
        { [key]: { value: current, expiration_time: { seconds: "1", nanos: -1 } } },
        /invalid credential expiration/,
      ],
      [{ [key]: { value: current, expiration_time: { seconds: "1" } } }, /expired/],
    ]) {
      readResponse = credentials;
      await assert.rejects(driver.withSourceToken(context, consume), error);
    }
    assert.equal(seen.length, 2, "denied and unusable values never reach plugin discovery");
    readResponse = { [key]: { value: current } };
    const exported = await backend.client
      .credentialClientForNamespace(workspace)
      .getProviderCredential(workspace, provider, key, signal);
    assert.deepEqual(
      exported,
      { value: current },
      "credentials without declared expiry remain valid",
    );

    // Cancellation still bounds a read that may be waiting on gateway-owned refresh.
    pendingRead = true;
    const abort = new AbortController();
    const reason = new Error("credential discovery cancelled");
    const pending = driver.withSourceToken({ ...context, signal: abort.signal }, consume);
    const rejection = assert.rejects(pending, (error) => error === reason);
    await received.promise;
    abort.abort(reason);
    await Promise.all([rejection, cancelled.promise]);
    assert.equal(seen.length, 2, "cancelled exports never reach plugin discovery");
  },
);

test("OpenShell mutual TLS rejects insecure endpoints and relative identity paths", () => {
  const options = {
    endpoint: "https://gateway.example.test:443",
    auth: { mode: "mutualTls", certificatePath: "/operator.crt", privateKeyPath: "/operator.key" },
  };
  for (const endpoint of ["http://gateway.example.test:80", "gateway.example.test:80"]) {
    assert.throws(() => new GrpcOpenShellGatewayClient({ ...options, endpoint }), /HTTPS/);
  }
  for (const path of ["certificatePath", "privateKeyPath"]) {
    assert.throws(
      () =>
        new GrpcOpenShellGatewayClient({
          ...options,
          auth: { ...options.auth, [path]: "relative" },
        }),
      /must be absolute/,
    );
  }
});
