import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { normalizeServiceUrl } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { serviceTarget } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import type { buildEndpointInstallation } from "./sandbox-driver-installation-fixture.ts";

type EndpointConsumers = {
  grpc: (endpoint: string) => ReturnType<typeof normalizeServiceUrl>;
  service: (endpoint: string) => ReturnType<typeof serviceTarget>;
};

export async function verifyEndpointAdmission(
  t: TestContext,
  endpointInstallation: typeof buildEndpointInstallation,
  consumers: EndpointConsumers,
): Promise<void> {
  const throws = (parse: EndpointConsumers[keyof EndpointConsumers], endpoint: string) => {
    try {
      parse(endpoint);
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
  const failing = (endpoint: string) =>
    Object.entries(consumers)
      .filter(([, parse]) => throws(parse, endpoint))
      .map(([name]) => name);
  for (const [endpoint, admitted] of rows) {
    const configuration = endpointInstallation(endpoint);
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
      loadInstallationFile(t, endpointInstallation(endpoint)),
      /configuration\.endpoint IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
      endpoint,
    );
    assert.deepEqual(failing(endpoint).sort(), ["grpc", "service"], endpoint);
  }
}
