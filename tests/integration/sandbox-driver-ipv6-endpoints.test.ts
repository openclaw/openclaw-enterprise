import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { buildEndpointInstallation } from "./sandbox-driver-installation-fixture.ts";

type HealthResponse = { status: string };

test("OpenShell startup admits bracketed IPv6 endpoints the native gRPC consumer can reach", async (t) => {
  const proto = await loader.load(
    join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
    { keepCase: true, enums: String },
  );
  const server = new grpc.Server();
  let healthCalls = 0;
  server.addService(openShellService(grpc.loadPackageDefinition(proto)), {
    Health(
      _call: Grpc.ServerUnaryCall<Record<string, never>, HealthResponse>,
      callback: Grpc.sendUnaryData<HealthResponse>,
    ) {
      healthCalls += 1;
      callback(null, { status: "SERVICE_STATUS_HEALTHY" });
    },
  });
  // A real IPv6 listener and the native SDK establish address compatibility, not live OpenShell.
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("[::1]:0", grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  t.after(() => new Promise<void>((resolve) => server.tryShutdown(() => resolve())));
  for (const endpoint of [`[::1]:${port}`, `http://[::1]:${port}`]) {
    const runtime = await loadInstallationFile(t, buildEndpointInstallation(endpoint));
    assert.ok(runtime);
    const definition = runtime.installation.backend[0];
    assert.ok(definition?.type === "openshell");
    const backend = createOpenShellBackend(definition);
    try {
      await backend.client.clientForNamespace("ipv6-tenant").health(AbortSignal.timeout(2000));
    } finally {
      backend.client.close();
    }
  }
  assert.equal(healthCalls, 2);
  for (const endpoint of [
    "[::1]:0",
    "[::1]:65536",
    "[::1]:999999",
    "[not-an-ip]:8080",
    "[127.0.0.1]:8080",
    "[::1:8080",
    "::1]:8080",
    "[::1]:8080/",
    "[::1]:8080?query",
  ]) {
    await assert.rejects(
      loadInstallationFile(t, buildEndpointInstallation(endpoint)),
      /configuration.endpoint must be host:port or an http or https origin/,
      endpoint,
    );
  }
  // Node's isIP accepts a zoned literal, but WHATWG URL (the http:// form and the service
  // transport) refuses it, so both forms refuse a zone ID with one reason.
  for (const endpoint of [
    "[fe80::1%eth0]:8080",
    "http://[fe80::1%eth0]:8080",
    "http://[fe80::1%25eth0]:8080",
    "https://[fe80::1%eth0]:8443",
    "[::1%]:8080",
  ]) {
    await assert.rejects(
      loadInstallationFile(t, buildEndpointInstallation(endpoint)),
      /configuration\.endpoint must not include an IPv6 zone ID/,
      endpoint,
    );
  }
  for (const endpoint of [
    "gateway.example.test:8080",
    "127.0.0.1:8080",
    "http://gateway.example.test",
    "http://127.0.0.1:80",
  ]) {
    await loadInstallationFile(t, buildEndpointInstallation(endpoint));
  }
});
