import { isDeepStrictEqual } from "node:util";

import { asRecord } from "@openclaw-enterprise/utils";

export interface InspectedWorkspaceNodeRoute {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

const workspaceRuleName = "workspace-node-enrollment";
const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const workspaceNodePath = /^\/namespaces\/[A-Za-z0-9_-]+\/agents\/[A-Za-z0-9_-]+\/node$/;

export function workspaceNodePathFor(namespaceId: string, agentId: string): string {
  return "/namespaces/" + namespaceId + "/agents/" + agentId + "/node";
}

export function inspectedWorkspaceNodeRule({ host, port, path }: InspectedWorkspaceNodeRoute) {
  if (
    !dnsName.test(host) ||
    host.length > 253 ||
    /(?:^|[.])github[.]com$/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !workspaceNodePath.test(path)
  ) {
    throw new Error("Inspected Workspace requires an exact non-Git Gateway route.");
  }
  // The pinned Codex client appends codex- plus 40 hex characters and sends POST.
  const hook = path + "/__openclaw__/native-hook/codex-" + "[0123456789abcdef]".repeat(40);
  const enforcement = "NETWORK_ENFORCEMENT_MODE_ENFORCE";
  return {
    name: workspaceRuleName,
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [
      {
        host,
        ports: [port],
        protocol: "websocket",
        path,
        enforcement,
        rules: ["GET", "WEBSOCKET_TEXT"].map((method) => ({ allow: { method, path } })),
        deny_rules: [{ method: "HEAD", path }],
      },
      {
        host,
        ports: [port],
        protocol: "rest",
        path: hook,
        enforcement,
        rules: [{ allow: { method: "POST", path: hook } }],
      },
    ],
  };
}

/** The Setup Secret's owner and contents have already been checked by the Sandbox. */
export function inspectedWorkspaceNodeRoute(
  computeUrl: string,
  setup: Readonly<{ url: string; tlsFingerprint?: string }>,
  expectedPath: string,
): InspectedWorkspaceNodeRoute {
  const endpoint = new URL(computeUrl);
  if (
    computeUrl !== endpoint.href ||
    endpoint.href !== setup.url ||
    endpoint.protocol !== "wss:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== expectedPath ||
    setup.tlsFingerprint !== undefined
  ) {
    throw new Error("Workspace setup must match Compute's exact WSS route without a leaf pin.");
  }
  const route = {
    host: endpoint.hostname,
    port: Number(endpoint.port || 443),
    path: endpoint.pathname,
  };
  inspectedWorkspaceNodeRule(route);
  return Object.freeze(route);
}

// The existing Codex launcher gives the node its Gateway CA in preference to the
// inherited interception CA. Supply one bundle through that existing launch path.
export const inspectedWorkspaceNodeTrustPrelude = String.raw`{
  const { constants, openSync, fstatSync, readFileSync, closeSync } = require("node:fs");
  const { isAbsolute } = require("node:path");
  const { X509Certificate } = require("node:crypto");
  const interception = process.env.NODE_EXTRA_CA_CERTS;
  const gateway = process.env.OPENCLAW_NODE_CA_PATH;
  if (!interception || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Inspected Workspace requires the Sandbox CA and certificate verification.");
  }
  function readCa(file, required) {
    if (!isAbsolute(file)) throw new Error("Workspace CA path must be absolute.");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 65536) throw new Error("Workspace CA file is invalid.");
      const pem = readFileSync(fd, "utf8").trim();
      if (!pem && !required) return "";
      const pattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
      const certs = pem.match(pattern);
      if (!certs || pem.replace(pattern, "").trim() || !certs.every((cert) => new X509Certificate(cert).ca)) {
        throw new Error("Workspace CA bundle must contain only CA certificates.");
      }
      return pem;
    } finally {
      closeSync(fd);
    }
  }
  process.env.OPENCLAW_NODE_CA_PEM = [readCa(interception, true), gateway ? readCa(gateway, false) : ""]
    .filter(Boolean).join("\n");
}
`;

/** Render only from the independently validated, Agent-owned setup binding. */
export function workspaceNodeNetworkPolicy(
  binding: Readonly<InspectedWorkspaceNodeRoute & { tls: boolean; inspected?: true }>,
): Record<string, unknown> {
  if (binding.inspected === true) {
    return { [workspaceRuleName]: inspectedWorkspaceNodeRule(binding) };
  }
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
export function assertBoundedWorkspaceNodeRule(value: unknown, inspectedPath?: string): void {
  const rule = asRecord(value);
  if (inspectedPath !== undefined) {
    const endpoint = Array.isArray(rule?.endpoints) ? asRecord(rule.endpoints[0]) : undefined;
    const port = Array.isArray(endpoint?.ports) ? endpoint.ports[0] : undefined;
    if (
      typeof endpoint?.host !== "string" ||
      typeof port !== "number" ||
      !isDeepStrictEqual(
        rule,
        inspectedWorkspaceNodeRule({ host: endpoint.host, port, path: inspectedPath }),
      )
    ) {
      throw new Error("The trusted Sandbox Workspace rule differs from its inspected route.");
    }
    return;
  }
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
