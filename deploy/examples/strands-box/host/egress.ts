import { createHash, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { isAbsolute, normalize } from "node:path";

export const CONTROLLED_INFERENCE_MARKER = "openclaw-strands-controlled-inference-v1";

/** 32 random bytes in unpadded base64url, minted once per execution by the paired Driver. */
export const EXECUTION_BEARER = /^[A-Za-z0-9_-]{43}$/;

/**
 * STAGE_A_PROTOTYPE (strands-gh design note, section 2): Box itself injects the GitHub App
 * installation token that OCE's Token Service minted. Stock `gh` reads `GITHUB_TOKEN` and
 * sends `Authorization: token <value>`, so Box swaps its placeholder there. Stock Git sends no
 * credential on its first request and waits for a 401, which a placeholder-only route would
 * refuse, so the `github.com` route attaches `x-access-token:<token>` as Basic auth to every
 * request. Neither route asks OCE per request; see the accepted gaps in KNOWN-GAPS.md.
 */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const GITHUB_GIT_CREDENTIAL_ENV = "OCE_GITHUB_GIT_CREDENTIAL";
export const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
/** What OCE's material check accepts for an installation token value. */
export const GITHUB_TOKEN_VALUE = /^[A-Za-z0-9_.-]{8,512}$/;
const GITHUB_METHODS: Readonly<Record<(typeof GITHUB_HOSTS)[number], readonly string[]>> = {
  "github.com": ["GET", "POST"],
  "api.github.com": ["GET", "POST", "PATCH", "PUT", "DELETE"],
};

/**
 * The top-level box.toml key that names one PEM file of extra upstream roots, as proposed in
 * strands-agents/box#147. Stock Box v0.2.2 refuses it. Box applies those roots gateway-wide.
 */
export const BOX_UPSTREAM_CA_KEY = "upstream-ca-file";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CA_BYTES = 65_536;
const MAX_CA_CERTIFICATES = 8;
const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----/g;

/** The one extra upstream CA bundle for a Box execution, verified and held in memory at load. */
export interface UpstreamCa {
  readonly sha256: string;
  readonly pem: string;
}

export interface EgressRoute {
  readonly kind: "workspace-node" | "controlled-inference";
  readonly url: string;
  readonly address: string;
  /** The route opts in to the execution's upstream CA bundle by naming its digest. */
  readonly caSha256?: string;
}

/** The nonsecret route identity that the Driver, the operator approval and the host compare. */
export interface RouteView {
  readonly url: string;
  readonly address: string;
  readonly caSha256?: string;
}

export function privateIPv4(address: string): boolean {
  return isIPv4(address) && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address);
}

/** An operator DNS name: at least two LDH labels, no trailing dot, not an address spelling. */
export function operatorDnsName(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    hostname.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/^[0-9]+$/.test(labels.at(-1)!) &&
    labels.at(-1) !== "localhost"
  );
}

function exactRoute(url: string, address: string, kind: EgressRoute["kind"]): URL {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  if (
    !privateIPv4(address) ||
    (isIPv4(hostname) ? hostname !== address : !operatorDnsName(hostname)) ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(parsed.pathname) ||
    url !== parsed.toString() ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (kind === "workspace-node"
      ? parsed.protocol !== "wss:"
      : parsed.protocol !== "https:" || parsed.pathname !== "/v1")
  ) {
    throw new Error("invalid_fixed_egress");
  }
  return parsed;
}

export function loadUpstreamCa(value: unknown): UpstreamCa {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "file,sha256" ||
    !("file" in value) ||
    !("sha256" in value) ||
    typeof value.file !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    !isAbsolute(value.file) ||
    normalize(value.file) !== value.file
  )
    throw new Error("invalid_upstream_ca");
  const file = value.file;
  const expected = value.sha256;
  const link = lstatSync(file);
  if (!link.isFile()) throw new Error("invalid_upstream_ca");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.ino !== link.ino ||
      stat.dev !== link.dev ||
      stat.size > MAX_CA_BYTES ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    )
      throw new Error("invalid_upstream_ca");
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  if (bytes.length > MAX_CA_BYTES) throw new Error("invalid_upstream_ca");
  // The digest names the exact operator-reviewed bytes; any other file is a mismatch.
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("upstream_ca_mismatch");
  const pem = bytes.toString("utf8");
  const certificates = pem.match(CERTIFICATE);
  if (
    certificates === null ||
    certificates.length > MAX_CA_CERTIFICATES ||
    pem.replace(CERTIFICATE, "").trim() !== "" ||
    !certificates.every((certificate) => {
      try {
        return new X509Certificate(certificate).ca;
      } catch {
        return false;
      }
    })
  )
    throw new Error("invalid_upstream_ca");
  return { sha256: expected, pem };
}

export function parseRoute(value: unknown, kind: EgressRoute["kind"]): EgressRoute {
  const keys =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort().join(",")
      : "";
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (keys !== "address,url" && keys !== "address,caSha256,url") ||
    !("url" in value) ||
    !("address" in value) ||
    typeof value.url !== "string" ||
    typeof value.address !== "string" ||
    ("caSha256" in value && (typeof value.caSha256 !== "string" || !SHA256.test(value.caSha256)))
  )
    throw new Error("invalid_fixed_egress");
  const url = exactRoute(value.url, value.address, kind);
  const caSha256 = "caSha256" in value ? (value.caSha256 as string) : undefined;
  return {
    kind,
    url: url.toString(),
    address: value.address,
    ...(caSha256 === undefined ? {} : { caSha256 }),
  };
}

export function routeView(route: EgressRoute): RouteView {
  return {
    url: route.url,
    address: route.address,
    ...(route.caSha256 === undefined ? {} : { caSha256: route.caSha256 }),
  };
}

/** True only for the exact route view, with no extra or missing fields. */
export function sameRouteView(value: unknown, route: EgressRoute): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = routeView(route);
  const supplied = value as Record<string, unknown>;
  return (
    Object.keys(supplied).sort().join(",") === Object.keys(expected).sort().join(",") &&
    supplied.url === expected.url &&
    supplied.address === expected.address &&
    supplied.caSha256 === expected.caSha256
  );
}

type Lookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>;

/**
 * Refuse before start when this host resolves the operator name to anything but the pinned
 * address. This is an early, operator-readable check; Box's own pinned-address policy below
 * is the enforcement, because Box resolves the name again in its trusted process.
 */
export async function assertPinnedResolution(
  route: EgressRoute,
  resolve: Lookup = lookup as unknown as Lookup,
  timeoutMs = 2_000,
): Promise<void> {
  const hostname = new URL(route.url).hostname;
  if (isIPv4(hostname)) return;
  let answers: readonly { address: string; family: number }[];
  let timer: NodeJS.Timeout | undefined;
  try {
    // The control socket answers within seconds; a slow resolver refuses instead of waiting.
    answers = await Promise.race([
      resolve(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } catch {
    throw new Error("egress_name_unresolved");
  } finally {
    clearTimeout(timer);
  }
  if (
    answers.length === 0 ||
    !answers.every(({ address, family }) => family === 4 && address === route.address)
  )
    throw new Error("egress_name_not_pinned");
}

/**
 * Box adds the extra roots to its trust for every upstream it dials, not per route. So the host
 * holds one bundle per Box execution, and every route Box will dial must opt in by naming that
 * bundle's digest: one route that does not (such as an inline workspace node carrying the pairing
 * code) refuses the whole bundle. A route kind opts in by declaring `caSha256` in its route.
 */
export function assertUpstreamCaScope(
  ca: UpstreamCa | undefined,
  routes: readonly EgressRoute[],
): void {
  for (const route of routes) {
    if (ca === undefined) {
      if (route.caSha256 !== undefined) throw new Error("upstream_ca_not_configured");
    } else if (route.caSha256 === undefined) {
      throw new Error("upstream_ca_route_not_declared");
    } else if (route.caSha256 !== ca.sha256) {
      throw new Error("upstream_ca_digest_mismatch");
    }
  }
}

/** The verified PEM bytes for the Box build's upstream CA key, after the scope check. */
export function upstreamCaPem(
  ca: UpstreamCa | undefined,
  routes: readonly EgressRoute[],
): string | undefined {
  assertUpstreamCaScope(ca, routes);
  return ca === undefined || routes.length === 0 ? undefined : `${ca.pem.trim()}\n`;
}

// Box's own egress policy checks hostname+port before DNS and the exact IP
// after resolution. The request rule narrows method and canonical path. These
// rules inject no credential and do not bypass Box's upstream TLS checks.
export function policy(routes: readonly EgressRoute[], github = false): string {
  const text = [
    "// Default deny; only these installed, credential-free destinations are eligible.",
  ];
  if (github) text.push(githubPolicy());
  for (const route of routes) {
    const url = exactRoute(route.url, route.address, route.kind);
    const port = url.port || "443";
    const condition = `context.input.host == ${JSON.stringify(url.hostname)} && context.input.port == ${port}`;
    const ws = route.kind === "workspace-node";
    const requests: readonly (readonly [string, string])[] = [
      [ws ? "GET" : "POST", ws ? url.pathname : `${url.pathname}/responses`],
    ];
    text.push(
      'permit (principal, action == Box::Action::"net:connect", resource)',
      `when { ${condition} && !(context.input has ip6) && (!(context.input has ip4) || (context.input has ip4 && context.input.ip4 == ${JSON.stringify(route.address)})) };`,
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
 * STAGE_A_PROTOTYPE: the public GitHub hosts over TLS against Box's own roots. Box resolves them
 * itself; OCE authorizes nothing per request here, so the rules only bound host, port, method and
 * interception. The listener is the real GitHub.
 */
export function githubPolicy(): string {
  const text = [
    "// STAGE_A_PROTOTYPE: GitHub, with the OCE-minted installation token Box injects.",
  ];
  for (const host of GITHUB_HOSTS) {
    const condition = `context.input.host == ${JSON.stringify(host)} && context.input.port == 443`;
    const methods = GITHUB_METHODS[host].map((method) => `context.input.method == "${method}"`);
    text.push(
      'permit (principal, action == Box::Action::"net:connect", resource)',
      `when { ${condition} };`,
      'permit (principal, action == Box::Action::"http:request", resource)',
      `when { ${condition} && (${methods.join(" || ")}) && context.input.intercepted == true };`,
    );
  }
  return text.join("\n");
}

/**
 * STAGE_A_PROTOTYPE: the two Box credential routes. `box run` reads both values from its own
 * environment once at start; the workload sees only placeholders. The tables name variables,
 * never the token.
 */
export function githubCredentials(): string {
  return [
    "[egress.github-git]",
    'destinations = ["github.com"]',
    `secret.ref = "env://${GITHUB_GIT_CREDENTIAL_ENV}"`,
    'secret.placement = "basic_auth"',
    'secret.inject = "always"',
    "",
    "[egress.github-api]",
    'destinations = ["api.github.com"]',
    `secret.ref = "env://${GITHUB_TOKEN_ENV}"`,
    'secret.placement = "header"',
    'secret.header = "Authorization"',
    'secret.prefix = "token "',
    'secret.inject = "phantom"',
    "",
  ].join("\n");
}

/** The `box run` environment that carries one installation token for both routes. */
export function githubCredentialEnvironment(token: string): Record<string, string> {
  if (!GITHUB_TOKEN_VALUE.test(token)) throw new Error("invalid_github_material");
  return {
    [GITHUB_TOKEN_ENV]: token,
    [GITHUB_GIT_CREDENTIAL_ENV]: `x-access-token:${token}`,
  };
}
