import assert from "node:assert/strict";
import { managedMcpInstalls } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import {
  assertNoManagedMcpRouteOverlap,
  managedMcpNetwork,
  managedMcpProviderEndpoint,
} from "../../apps/controller/src/drivers/sandbox/openshell-managed-mcp-policy.ts";

export function verifyManagedMcpProjection(): void {
  const bundled = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");
  assert.ok(bundled);
  const endpoint = { host: "mcp.tools.example", port: 8443, path: "/api/mcp" };
  const install = {
    ...bundled,
    runtimeName: "inventory",
    endpoint,
    url: `https://${endpoint.host}:${endpoint.port}${endpoint.path}`,
    mcpVersions: ["2025-11-25"],
  };
  const provider = managedMcpProviderEndpoint(install);
  const network = managedMcpNetwork(install, ["read_inventory"]);
  assert.deepEqual(provider, {
    ...endpoint,
    protocol: "mcp",
    mcp: { strict_tool_names: true, versions: ["2025-11-25"] },
    rules: [{ allow: { method: "ping" } }],
  });
  assert.equal(network.name, "oce-inventory-mcp");
  assert.deepEqual(network.binaries, [{ path: "/usr/local/bin/node" }]);
  assert.deepEqual(network.endpoints, [
    {
      host: endpoint.host,
      ports: [endpoint.port],
      path: endpoint.path,
      protocol: "mcp",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      mcp: provider.mcp,
      rules: [
        { allow: { method: "ping" } },
        { allow: { method: "initialize" } },
        { allow: { method: "notifications/initialized" } },
        { allow: { method: "tools/list" } },
        { allow: { method: "tools/call", params: { name: { glob: "read_inventory" } } } },
      ],
    },
  ]);
  assert.doesNotThrow(() =>
    assertNoManagedMcpRouteOverlap(overlappingPolicy(network, 443), install, [network.name]),
  );
  assert.throws(
    () =>
      assertNoManagedMcpRouteOverlap(overlappingPolicy(network, endpoint.port), install, [
        network.name,
      ]),
    /overlaps the credentialed managed MCP endpoint/,
  );
}

function overlappingPolicy(network: ReturnType<typeof managedMcpNetwork>, port: number) {
  return {
    [network.name]: network,
    other: { endpoints: [{ host: "*.tools.example", ports: [port] }] },
  };
}
