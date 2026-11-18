import { createHash, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { isAbsolute, normalize } from "node:path";

export const CONTROLLED_INFERENCE_MARKER = "openclaw-strands-controlled-inference-v1";

/** 32 random bytes in unpadded base64url, minted once per execution by the paired Driver. */
export const EXECUTION_BEARER = /^[A-Za-z0-9_-]{43}$/;

/**
 * Box injects GitHub auth itself and asks OCE for
 * each request through its request-time credential source. Stock `gh` reads `GITHUB_TOKEN` and
 * sends `Authorization: token <value>`, so Box swaps its placeholder there. Stock Git sends no
 * credential on its first request and waits for a 401, which a placeholder-only route would
 * refuse, so the `github.com` route asks the source for every request and attaches
 * `x-access-token:<token>` as Basic auth. Neither variable ever holds a token.
 */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const GITHUB_GIT_CREDENTIAL_ENV = "OCE_GITHUB_GIT_CREDENTIAL";
export const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
const GITHUB_METHODS: Readonly<Record<(typeof GITHUB_HOSTS)[number], readonly string[]>> = {
  "github.com": ["GET", "POST"],
  "api.github.com": ["GET", "POST", "PATCH", "PUT", "DELETE"],
};

/**
 * The `[gateway]` key that names one PEM file of extra upstream roots, in the Box fork's cleaned
 * takeover of strands-agents/box#147 (`feature/gateway-upstream-ca-file`). Stock Box v0.2.2
 * refuses it. Box applies those roots gateway-wide.
 */
export const BOX_UPSTREAM_CA_KEY = "upstream_ca_file";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CA_BYTES = 65_536;
const MAX_CA_CERTIFICATES = 8;
const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----/g;

/** The one extra upstream CA bundle for a Box execution, verified and held in memory at load. */
export interface UpstreamCa {
  readonly sha256: string;
  readonly pem: string;
}

/**
 * The Gateway route a native hook command calls for each relay, below the workspace node's
 * Gateway path (Compute renders `<endpoint>/node/__openclaw__/native-hook/<relayId>`).
 */
export const NATIVE_HOOK_ROUTE = "/__openclaw__/native-hook/";

export interface EgressRoute {
  readonly kind: "workspace-node" | "controlled-inference" | "native-hook";
  readonly url: string;
  readonly address: string;
  /** The route opts in to the execution's upstream CA bundle by naming its digest. */
  readonly caSha256?: string;
}

/**
 * The native hook route of a workspace node route: same Gateway name, port and pinned address,
 * the hook prefix below the node path. The host derives it; it is never configured separately.
 */
export function nativeHookRoute(workspaceNode: EgressRoute, caSha256?: string): EgressRoute {
  if (workspaceNode.kind !== "workspace-node") throw new Error("invalid_fixed_egress");
  const node = new URL(workspaceNode.url);
  const url = `https://${node.host}${node.pathname.replace(/\/$/, "")}${NATIVE_HOOK_ROUTE}`;
  exactRoute(url, workspaceNode.address, "native-hook");
  return {
    kind: "native-hook",
    url,
    address: workspaceNode.address,
    ...(caSha256 === undefined ? {} : { caSha256 }),
  };
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

/**
 * A model base path: `/v1`, optionally below a fixed prefix (`/openai/v1`), as Compute accepts an
 * OpenAI-compatible base URL. No trailing slash, no empty or dot segments.
 */
export const MODEL_BASE_PATH = /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*\/v1$/;

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
      : kind === "native-hook"
        ? parsed.protocol !== "https:" || !parsed.pathname.endsWith(`/node${NATIVE_HOOK_ROUTE}`)
        : parsed.protocol !== "https:" || !MODEL_BASE_PATH.test(parsed.pathname))
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
    if (route.kind === "native-hook") {
      // One relay per request: POST to exactly one `codex-<id>` segment below the prefix (Box
      // judges the canonical path, without the query). The Gateway checks the relay's token.
      const relay = JSON.stringify(`${url.pathname}codex-*`);
      const nested = JSON.stringify(`${url.pathname}codex-*/*`);
      text.push(
        'permit (principal, action == Box::Action::"http:request", resource)',
        `when { ${condition} && context.input.method == "POST" && context.input.path like ${relay} && !(context.input.path like ${nested}) && context.input.intercepted == true };`,
      );
      continue;
    }
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
 * The public GitHub hosts over TLS against Box's own roots (and any upstream CA bundle). Box
 * resolves them itself. These rules bound host, port, method and interception; OCE decides each
 * request that passes them, through the credential source.
 */
export function githubPolicy(): string {
  const text = ["// GitHub: Box asks OCE for each request's credential (source://oce)."];
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

/** One request-time credential source for this execution: Box's Unix socket and bearer variable. */
export interface CredentialSourceConfig {
  readonly socket: string;
  readonly bearerEnv: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

/**
 * The `[gateway.credential_source.oce]` table and the two Box credential routes that name it.
 * The tables name a socket and variables, never a credential: the workload sees only placeholders,
 * and `box run` holds only the source bearer.
 */
export function githubCredentials(source: CredentialSourceConfig): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    "[gateway.credential_source.oce]",
    `endpoint = ${quote(`unix://${source.socket}`)}`,
    `bearer = ${quote(`env://${source.bearerEnv}`)}`,
    `timeout_ms = ${source.timeoutMs}`,
    `max_body_bytes = ${source.maxBodyBytes}`,
    "",
    "[egress.github-git]",
    'destinations = ["github.com"]',
    'secret.ref = "source://oce"',
    `secret.env = ${quote(GITHUB_GIT_CREDENTIAL_ENV)}`,
    'secret.placement = "basic_auth"',
    'secret.inject = "always"',
    "",
    "[egress.github-api]",
    'destinations = ["api.github.com"]',
    'secret.ref = "source://oce"',
    `secret.env = ${quote(GITHUB_TOKEN_ENV)}`,
    'secret.placement = "header"',
    'secret.header = "Authorization"',
    'secret.prefix = "token "',
    'secret.inject = "phantom"',
    "",
  ].join("\n");
}

/** The workload variable that holds Box's model placeholder; Codex logs in with it. */
export const MODEL_KEY_ENV = "OPENAI_API_KEY";

/** The model route's request-time source: its own socket, the same bearer, Box's 16 MiB cap. */
export interface ModelSourceConfig extends CredentialSourceConfig {
  /** The route's `POST` path, below its base path: `/v1/responses`. */
  readonly path: string;
}

/**
 * The `[gateway.credential_source.oce-model]` table and the one Box credential route that names
 * it: the configured model route, narrowed to its `POST <base>/responses` path. Box puts a
 * placeholder in `OPENAI_API_KEY`, asks the host for the key of each request that carries it, and
 * sends the answer as the bearer. The table names a socket and a variable, never a key.
 */
export function modelCredentials(route: EgressRoute, source: ModelSourceConfig): string {
  if (route.kind !== "controlled-inference") throw new Error("invalid_model_route");
  const url = exactRoute(route.url, route.address, route.kind);
  const quote = (value: string) => JSON.stringify(value);
  const destination = `${url.hostname}${url.port === "" ? "" : `:${url.port}`}${source.path}`;
  return [
    "[gateway.credential_source.oce-model]",
    `endpoint = ${quote(`unix://${source.socket}`)}`,
    `bearer = ${quote(`env://${source.bearerEnv}`)}`,
    `timeout_ms = ${source.timeoutMs}`,
    `max_body_bytes = ${source.maxBodyBytes}`,
    "",
    "[egress.oce-model]",
    `destinations = [${quote(destination)}]`,
    'secret.ref = "source://oce-model"',
    `secret.env = ${quote(MODEL_KEY_ENV)}`,
    'secret.placement = "header"',
    'secret.header = "Authorization"',
    'secret.prefix = "Bearer "',
    'secret.inject = "phantom"',
    "",
  ].join("\n");
}
