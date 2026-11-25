import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

// Real TLS proves client identity and header separation; the RPC bodies below are
// controlled protocol fixtures.
async function wireCertificates(t) {
  const directory = await temporaryDirectory(t, "openshell-oauth-wire-");
  const ca = await certificateAuthority(directory, { caName: "OpenShell wire test CA", days: 1 });
  const server = await signedLeaf(directory, ca, {
    name: "server",
    commonName: "localhost",
    subjectAltName: "DNS:localhost,IP:127.0.0.1",
    days: 1,
  });
  const operator = await signedLeaf(directory, ca, {
    name: "operator",
    subject: "/CN=wire-client/OU=operator",
    usage: "clientAuth",
    days: 1,
  });
  // The gateway accepts ordinary bearer clients as well as authenticated operator
  // certificates on one endpoint; require a certificate only on the export RPC.
  const provider = new grpc.experimental.FileWatcherCertificateProvider({
    caCertificateFile: ca.caPath,
    certificateFile: server.certPath,
    privateKeyFile: server.keyPath,
    refreshIntervalMs: 60_000,
  });
  return {
    rootCertificatePath: ca.caPath,
    operatorTls: { certificatePath: operator.certPath, privateKeyPath: operator.keyPath },
    serverCredentials: grpc.experimental.createCertificateProviderServerCredentials(
      provider,
      provider,
      false,
    ),
    bearerPath: join(directory, "bearer"),
  };
}

test(
  "OpenShell Provider reads preserve Workspace scope and isolate operator credentials",
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
    const missingProvider = openShellProviderName("missing-source");
    const key = "CODEX_ACCESS_TOKEN";
    const expiry = new Date(Date.now() + 3_600_000);
    const expiryWire = { seconds: String(Math.floor(expiry.getTime() / 1000)), nanos: 0 };
    let current = "synthetic-access-first";
    let denyRead = false;
    let readResponse;
    let pendingRead = false;
    const received = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const status = {
      provider,
      credential_key: key,
      status: "refreshed",
      expiration_time: expiryWire,
    };
    const server = new grpc.Server();
    server.addService(OpenShell.service, {
      GetProviderRefreshStatus(call, callback) {
        assertBearer(call);
        assert.deepEqual(call.request.workspace_scope, { workspace });
        assert.equal(call.request.credential_key, key);
        if (call.request.provider === missingProvider) {
          callback({ code: grpc.status.NOT_FOUND });
          return;
        }
        assert.equal(call.request.provider, provider);
        callback(null, {
          credentials: [{ ...status, credential_key: "OTHER_TOKEN", status: "failed" }, status],
        });
      },
      GetProvider(call, callback) {
        assertBearer(call);
        assert.deepEqual(call.request, { workspace_scope: { workspace }, name: provider });
        callback(null, {
          provider: {
            type: provider,
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
    assert.equal(
      (await client.getProviderRefreshStatus(workspace, provider, key, signal)).status,
      "refreshed",
    );
    assert.equal(
      await client.getProviderRefreshStatus(workspace, missingProvider, key, signal),
      undefined,
    );

    const backend = createOpenShellBackend({
      id: "openshell",
      type: "openshell",
      configuration,
      drivers: { sandbox: "sandbox" },
    });
    t.after(() => backend.client.close());
    // Ordinary inventory and the operator export share an endpoint but use different identities.
    const listed = await backend.client
      .clientForNamespace(workspace)
      .getProvider(workspace, provider, signal);
    assert.equal(listed?.name, provider);
    assert.deepEqual(
      await backend.client
        .credentialClientForNamespace(workspace)
        .getProviderCredential(workspace, provider, key, signal),
      { value: current, expirationTime: `${expiry.toISOString().slice(0, 19)}.000000000Z` },
    );
    // Incoming IP-SAN transport must also carry the operator identity without SNI or bearer headers.
    const ipBackend = createOpenShellBackend({
      id: "openshell-ip",
      type: "openshell",
      configuration: { ...configuration, endpoint: `https://127.0.0.1:${port}` },
      drivers: { sandbox: "sandbox" },
    });
    t.after(() => ipBackend.client.close());
    const readCredential = (operationSignal = signal) =>
      backend.client
        .credentialClientForNamespace(workspace)
        .getProviderCredential(workspace, provider, key, operationSignal);
    assert.equal(
      (
        await ipBackend.client
          .credentialClientForNamespace(workspace)
          .getProviderCredential(workspace, provider, key, signal)
      ).value,
      current,
    );
    assert.equal((await readCredential()).value, "synthetic-access-first");
    // The fixture models an already-published replacement. A fresh RPC reads that value.
    current = "synthetic-access-replacement";
    assert.equal((await readCredential()).value, current);
    denyRead = true;
    await assert.rejects(readCredential(), (error) => {
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
      await assert.rejects(readCredential(), error);
    }
    readResponse = { [key]: { value: current } };
    const exported = await backend.client
      .credentialClientForNamespace(workspace)
      .getProviderCredential(workspace, provider, key, signal);
    assert.deepEqual(
      exported,
      { value: current },
      "credentials without declared expiry remain valid",
    );

    // Cancellation bounds a stalled credential read.
    pendingRead = true;
    const abort = new AbortController();
    const reason = new Error("credential discovery cancelled");
    const pending = readCredential(abort.signal);
    const rejection = assert.rejects(pending, (error) => error === reason);
    await received.promise;
    abort.abort(reason);
    await Promise.all([rejection, cancelled.promise]);
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
