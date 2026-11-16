import { isIPv4 } from "node:net";

export const CONTROLLED_INFERENCE_MARKER = "openclaw-strands-controlled-inference-v1";

/** Box gives the workload a placeholder in this variable and swaps in the real bearer. */
export const REPOSITORY_SENDER_BEARER_ENV = "OCE_REPOSITORY_SENDER_BEARER";
/** 32 random bytes in unpadded base64url, minted once per execution by the paired Driver. */
export const REPOSITORY_SENDER_BEARER = /^[A-Za-z0-9_-]{43}$/;
/** The only requests the fixed-repository sender serves; Box's canonical path drops the query. */
export const REPOSITORY_SENDER_REQUESTS = [
  ["GET", "/repository.git/info/refs"],
  ["POST", "/repository.git/git-upload-pack"],
  ["POST", "/repository.git/git-receive-pack"],
  ["POST", "/draft-pull"],
] as const;

export interface EgressRoute {
  readonly kind: "workspace-node" | "controlled-inference" | "repository-sender";
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
      : kind === "repository-sender"
        ? url.protocol !== "https:" || url.pathname !== "/"
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
    const requests: readonly (readonly [string, string])[] =
      exact.kind === "repository-sender"
        ? REPOSITORY_SENDER_REQUESTS
        : [
            [
              ws ? "GET" : "POST",
              ws ? url.pathname : `${url.pathname.replace(/\/$/, "")}/responses`,
            ],
          ];
    text.push(
      'permit (principal, action == Box::Action::"net:connect", resource)',
      `when { ${condition} && !(context.input has ip6) && (!(context.input has ip4) || (context.input has ip4 && context.input.ip4 == ${JSON.stringify(exact.address)})) };`,
    );
    for (const [method, path] of requests) {
      text.push(
        'permit (principal, action == Box::Action::"http:request", resource)',
        `when { ${condition} && context.input.method == "${method}" && context.input.path == ${JSON.stringify(path)} && context.input.intercepted == true };`,
      );
    }
  }
  return `${text.join("\n")}\n`;
}

/**
 * The Box phantom credential route for the repository sender. `box run` reads the bearer from
 * its own environment once at start; the workload, tools and MCP servers see a placeholder,
 * and Box adds the real value only over intercepted TLS to this exact host and port.
 */
export function repositorySenderCredential(route: EgressRoute): string {
  const exact = parseRoute({ url: route.url, address: route.address }, "repository-sender");
  if (route.kind !== "repository-sender") throw new Error("invalid_fixed_egress");
  const url = new URL(exact.url);
  return [
    "[egress.repository-sender]",
    `destinations = [${JSON.stringify(`${url.hostname}:${url.port || "443"}`)}]`,
    `secret.ref = "env://${REPOSITORY_SENDER_BEARER_ENV}"`,
    'secret.placement = "header"',
    'secret.header = "Authorization"',
    'secret.prefix = "Bearer "',
    'secret.inject = "phantom"',
    "",
  ].join("\n");
}
