import { isIPv4 } from "node:net";

export const CONTROLLED_INFERENCE_MARKER = "openclaw-strands-controlled-inference-v1";

export interface EgressRoute {
  readonly kind: "workspace-node" | "controlled-inference";
  readonly url: string;
  readonly address: string;
}

export function parseRoute(value: unknown, kind: EgressRoute["kind"]): EgressRoute {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "address,url" ||
    !("url" in value) ||
    !("address" in value) ||
    typeof value.url !== "string" ||
    typeof value.address !== "string"
  )
    throw new Error("invalid_fixed_egress");
  const url = new URL(value.url);
  const hostname = url.hostname;
  const address = value.address;
  const ipv4Private =
    isIPv4(address) && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address);
  if (
    !ipv4Private ||
    (isIPv4(hostname) && hostname !== address) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname) ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname) ||
    value.url !== url.toString() ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (kind === "workspace-node"
      ? url.protocol !== "wss:"
      : url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "/v1")
  ) {
    throw new Error("invalid_fixed_egress");
  }
  return { kind, url: url.toString(), address };
}

// Box's own egress policy checks hostname+port before DNS and the exact IP
// after resolution. The request rule narrows method and canonical path. These
// rules inject no credential and do not bypass Box's upstream TLS checks.
export function policy(routes: readonly EgressRoute[]): string {
  const text = [
    "// Default deny; only these installed, credential-free destinations are eligible.",
  ];
  for (const route of routes) {
    const exact = parseRoute({ url: route.url, address: route.address }, route.kind);
    const url = new URL(exact.url);
    const port = url.port || "443";
    const condition = `context.input.host == ${JSON.stringify(url.hostname)} && context.input.port == ${port}`;
    const ws = exact.kind === "workspace-node";
    const path = ws ? url.pathname : `${url.pathname.replace(/\/$/, "")}/responses`;
    text.push(
      'permit (principal, action == Box::Action::"net:connect", resource)',
      `when { ${condition} && !(context.input has ip6) && (!(context.input has ip4) || (context.input has ip4 && context.input.ip4 == ${JSON.stringify(exact.address)})) };`,
      'permit (principal, action == Box::Action::"http:request", resource)',
      `when { ${condition} && context.input.method == "${ws ? "GET" : "POST"}" && context.input.path == ${JSON.stringify(path)} && context.input.intercepted == true };`,
    );
  }
  return `${text.join("\n")}\n`;
}
