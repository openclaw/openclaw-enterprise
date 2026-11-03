import { isDeepStrictEqual } from "node:util";

import { asRecord } from "@openclaw-enterprise/utils";

/** Render only from the independently validated, Agent-owned setup binding. */
export function workspaceNodeNetworkPolicy(
  binding: Readonly<{ host: string; port: number; path: string; tls: boolean }>,
): Record<string, unknown> {
  // WSS remains end to end with the Gateway route, which pins its own CA.
  const endpoint = binding.tls
    ? {
        host: binding.host,
        ports: [binding.port],
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      }
    : {
        host: binding.host,
        ports: [binding.port],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_FULL",
        path: binding.path,
      };
  return {
    "workspace-node-enrollment": {
      name: "workspace-node-enrollment",
      binaries: [{ path: "/usr/local/bin/node" }],
      endpoints: [endpoint],
    },
  };
}

/** The proxy receives this exact auxiliary name only through trusted Sandbox output. */
export function assertBoundedWorkspaceNodeRule(value: unknown): void {
  const rule = asRecord(value);
  const endpoint =
    Array.isArray(rule?.endpoints) && rule.endpoints.length === 1
      ? asRecord(rule.endpoints[0])
      : undefined;
  const keys =
    endpoint?.tls === "NETWORK_TLS_MODE_SKIP"
      ? ["enforcement", "host", "ports", "tls"]
      : ["access", "enforcement", "host", "path", "ports", "protocol"];
  if (
    !rule ||
    !isDeepStrictEqual(Object.keys(rule).sort(), ["binaries", "endpoints", "name"]) ||
    rule.name !== "workspace-node-enrollment" ||
    !isDeepStrictEqual(rule.binaries, [{ path: "/usr/local/bin/node" }]) ||
    !endpoint ||
    !isDeepStrictEqual(Object.keys(endpoint).sort(), keys) ||
    typeof endpoint.host !== "string" ||
    endpoint.host.length === 0 ||
    /[\s/*?#@]/.test(endpoint.host) ||
    !Array.isArray(endpoint.ports) ||
    endpoint.ports.length !== 1 ||
    !Number.isInteger(endpoint.ports[0]) ||
    endpoint.ports[0] < 1 ||
    endpoint.ports[0] > 65535 ||
    endpoint.enforcement !== "NETWORK_ENFORCEMENT_MODE_ENFORCE" ||
    (endpoint.tls !== "NETWORK_TLS_MODE_SKIP" &&
      (endpoint.protocol !== "rest" ||
        endpoint.access !== "NETWORK_ACCESS_PRESET_FULL" ||
        typeof endpoint.path !== "string" ||
        !endpoint.path.startsWith("/") ||
        /[\s?#]/.test(endpoint.path)))
  ) {
    throw new Error("The trusted Sandbox workspace enrollment rule is outside its bounded shape.");
  }
}
