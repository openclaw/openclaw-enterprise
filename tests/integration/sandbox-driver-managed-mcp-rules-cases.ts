import assert from "node:assert/strict";
import type {
  managedMcpNetwork,
  managedMcpProviderEndpoint,
} from "../../apps/controller/src/drivers/sandbox/openshell-managed-mcp-policy.ts";

type ManagedMcpInstall = Parameters<typeof managedMcpProviderEndpoint>[0];

export function assertManagedMcpProjection({
  install,
  provider,
  network,
  checkOverlap,
}: {
  install: ManagedMcpInstall;
  provider: ReturnType<typeof managedMcpProviderEndpoint>;
  network: ReturnType<typeof managedMcpNetwork>;
  checkOverlap: (policies: ReturnType<typeof overlappingPolicy>) => void;
}): void {
  const { endpoint } = install;
  assert.deepEqual(provider, {
    ...endpoint,
    protocol: "mcp",
    mcp: { strict_tool_names: true, versions: ["2025-11-25"] },
    rules: [{ allow: { method: "ping" } }],
  });
  assert.equal(network.name, "oce-inventory-mcp");
  assert.deepEqual(network.binaries, [{ path: install.binaryPath }]);
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
  assert.doesNotThrow(() => checkOverlap(overlappingPolicy(network, 443)));
  assert.throws(
    () => checkOverlap(overlappingPolicy(network, endpoint.port)),
    /overlaps the credentialed managed MCP endpoint/,
  );
}

function overlappingPolicy(network: ReturnType<typeof managedMcpNetwork>, port: number) {
  return {
    [network.name]: network,
    other: { endpoints: [{ host: "*.tools.example", ports: [port] }] },
  };
}
