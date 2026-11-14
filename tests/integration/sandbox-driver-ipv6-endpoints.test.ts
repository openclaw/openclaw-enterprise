import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { normalizeServiceUrl } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { serviceTarget } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
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

test("OpenShell startup admits exactly the endpoints both consumers can parse and dial", async (t) => {
  // Each consumer parses the endpoint once per gateway call: the gRPC path through its
  // service URL normalization, the service transport through its connect target.
  const serviceUrl = "http://service.example.test/";
  const throws = (parse: () => unknown) => {
    try {
      parse();
      return false;
    } catch {
      return true;
    }
  };
  // [form, admitted]: one row per shape, each spelled bare, http:// and https:// where it applies.
  const rows: readonly (readonly [string, boolean])[] = [
    ["gateway.example.test:8080", true],
    ["gateway.example.test:1", true],
    ["gateway.example.test:65535", true],
    ["gateway.example.test:080", true],
    ["127.0.0.1:8080", true],
    ["192.168.1.1:8080", true],
    ["http://192.168.1.1:8080", true],
    ["[::1]:8080", true],
    ["gateway.example.test:0", false],
    ["gateway.example.test:00", false],
    ["gateway.example.test:65536", false],
    ["gateway.example.test:99999", false],
    ["1.2.3.999:8080", false],
    ["gate%way.example.test:8080", false],
    ["[::1]:0", false],
    ["[::1]:65536", false],
    ["gateway.example.test?x:8080", false],
    ["user@gateway.example.test:8080", false],
    // An empty userinfo hides a colon before the host.
    [":@gateway.example.test:8080", false],
    ["http://gateway.example.test", true],
    ["http://gateway.example.test:8080", true],
    ["http://[::1]:8080", true],
    ["http://gateway.example.test:0", false],
    ["http://gateway.example.test:65536", false],
    ["http://1.2.3.999:8080", false],
    ["http://gate%way.example.test:8080", false],
    // An origin carries no path.
    ["http://gateway.example.test:8080/grpc", false],
    ["https://gateway.example.test", true],
    ["https://gateway.example.test:8443", true],
    ["https://[::1]:8443", true],
    ["https://gateway.example.test:0", false],
    ["https://gateway.example.test:65536", false],
    ["https://1.2.3.999:8443", false],
  ];
  const failing = (endpoint: string) => {
    const failedConsumers: string[] = [];
    if (throws(() => normalizeServiceUrl(serviceUrl, endpoint))) {
      failedConsumers.push("grpc");
    }
    if (throws(() => serviceTarget({ endpoint, requestTimeoutMs: 1000 }, serviceUrl))) {
      failedConsumers.push("service");
    }
    return failedConsumers;
  };
  for (const [endpoint, admitted] of rows) {
    const configuration = buildEndpointInstallation(endpoint);
    const failedConsumers = failing(endpoint);
    if (admitted) {
      await loadInstallationFile(t, configuration);
      assert.deepEqual(failedConsumers, [], `${endpoint}: admitted but a consumer throws`);
    } else {
      await assert.rejects(
        loadInstallationFile(t, configuration),
        /configuration\.endpoint must be host:port or an http or https origin, with a port from 1 to 65535/,
        endpoint,
      );
    }
    // Startup never admits what either consumer would throw on at first use.
    if (failedConsumers.length > 0) {
      assert.equal(admitted, false, `${endpoint}: ${failedConsumers.join(", ")} throws`);
    }
  }
  for (const endpoint of [
    "http://192.168.1:8080",
    "192.168.1:8080",
    "2130706433:8080",
    "http://0177.0.0.1:8080",
    "http://127.1:8080",
  ]) {
    await assert.rejects(
      loadInstallationFile(t, buildEndpointInstallation(endpoint)),
      /configuration\.endpoint IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
      endpoint,
    );
    assert.deepEqual(failing(endpoint).sort(), ["grpc", "service"], endpoint);
  }
});
