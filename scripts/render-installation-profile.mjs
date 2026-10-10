#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isKubernetesNamespaceName,
  isKubernetesResourceName,
} from "../apps/controller/src/drivers/compute/kubernetes/resource-name.ts";

import { isBackendId, isName, NAME_RULE } from "../packages/contracts/src/api/plain-text.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const profilesDir = resolve(repoRoot, "deploy/profiles");
const allowedProfiles = new Set(["openclaw", "codex"]);
const dnsSubdomain = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
// Kubernetes Service names are DNS-1035 labels. The chart refuses any other
// repositoryCredentials.serviceName.
const dns1035Label = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
// The rule for a Kubernetes resource name field, such as a GatewayClass or Secret name.
const resourceNameRule = {
  validate: isKubernetesResourceName,
  description: "a Kubernetes resource name of at most 253 characters",
};
const digestImage = /^[^@\s]+@sha256:[a-f0-9]{64}$/;
// The controller reference also feeds prepare-bootstrap-volume and the chart.
const controllerDigestImage = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
// The chart and Node's URL parser both refuse an octet above 255 and a port above 65535.
// The shape check alone still matches 192.0.2.999 and port 99999.
function isLiteralIpv4ProxyUrl(value) {
  const match =
    /^https?:\/\/((?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}):([1-9][0-9]{0,4})$/.exec(
      value,
    );
  if (!match) {
    return false;
  }
  if (match[1].split(".").some((octet) => Number(octet) > 255)) {
    return false;
  }
  const port = Number(match[2]);
  return Number.isInteger(port) && port <= 65535;
}
const dnsHostname =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// Google hosted domains in the shape the API's domainPattern and the chart accept after
// they trim and lowercase the entry. Preflight accepts only the trimmed, lowercase spelling.
// A DNS hostname whose last label starts with a digit, or a name longer than 253
// characters, is not one of those domains.
const googleHostedDomain =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// OCC's ChatGPT workspace rule (packages/occ/src/backends.ts WORKSPACE_ID). Startup
// refuses every other spelling, including a nil UUID.
const chatGptWorkspaceId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  process.stderr.write(`render-installation-profile: ${message}\n`);
  process.exit(1);
}

function usage() {
  return `Usage: node scripts/render-installation-profile.mjs --profile openclaw|codex \\
  --input <site-inputs.json> --out-dir <rendered-directory>

The renderer writes values.yaml, installation.yaml, and preflight.json. Missing
or invalid required inputs write preflight.json and exit nonzero.
`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        fail(`${arg} requires a value.\n\n${usage()}`);
      }
      return argv[index];
    };
    if (arg === "--profile") {
      parsed.profile = next();
    } else if (arg === "--input") {
      parsed.input = next();
    } else if (arg === "--out-dir") {
      parsed.outDir = next();
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      fail(`unsupported argument ${arg}.\n\n${usage()}`);
    }
  }
  if (!allowedProfiles.has(parsed.profile)) {
    fail("--profile must be one of: openclaw, codex.");
  }
  if (parsed.input === undefined) {
    fail("--input is required.");
  }
  if (parsed.outDir === undefined) {
    fail("--out-dir is required.");
  }
  return parsed;
}

function record(value, path, diagnostics) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    diagnostics.errors.push(`${path} must be an object.`);
    return {};
  }
  return value;
}

function closed(value, path, keys, diagnostics) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      diagnostics.errors.push(`${path}.${key} is not supported by installation profiles.`);
    }
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${label} ${path} is unavailable or invalid JSON.`);
  }
}

async function readProfile(name) {
  const diagnostics = { errors: [] };
  const profile = record(
    await readJson(resolve(profilesDir, `${name}.json`), `profile ${name}`),
    `profile ${name}`,
    diagnostics,
  );
  if (diagnostics.errors.length > 0) {
    fail(diagnostics.errors.join("\n"));
  }
  if (profile.name !== name) {
    fail(`profile ${name} must declare matching name.`);
  }
  if (profile.name === "default") {
    fail("default is not an installation profile.");
  }
  return profile;
}

function yamlScalar(value) {
  if (typeof value === "string") {
    if (value.length === 0) {
      return '""';
    }
    // Helm reads values with YAML 1.1 rules, where words such as no/on/y are
    // booleans and forms such as 1e3, 0x1f, 1:20, .inf and dates are numbers
    // or timestamps. Emit a plain scalar only when it cannot resolve to one of
    // those or start with an indicator (@, -, ., :); quote everything else.
    if (
      /^[A-Za-z0-9_./:@-]+$/.test(value) &&
      /^[A-Za-z_/]|^[0-9].*\//.test(value) &&
      !value.endsWith(":") &&
      !/^(?:y|n|yes|no|true|false|on|off|null)$/i.test(value)
    ) {
      return value;
    }
    // JSON escapes only C0 controls. Inside a double-quoted scalar Helm's YAML parser folds a
    // raw U+0085 into a space and refuses raw DEL, the other C1 controls, U+FFFE and U+FFFF.
    // U+2028, U+2029 and U+FEFF are YAML line-break and byte-order characters. Escape them
    // all so Helm reads the exact string preflight checked.
    return JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  fail(`cannot render unsupported scalar ${typeof value}.`);
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value
      .map((entry) => {
        if (typeof entry === "object" && entry !== null) {
          return `${pad}- ${toYaml(entry, indent + 2).trimStart()}`;
        }
        return `${pad}- ${yamlScalar(entry)}`;
      })
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) {
      return "{}";
    }
    return entries
      .map(([key, entry]) => {
        if (typeof entry === "object" && entry !== null) {
          const rendered = toYaml(entry, indent + 2);
          return `${pad}${yamlScalar(key)}:${rendered === "{}" || rendered === "[]" ? ` ${rendered}` : `\n${rendered}`}`;
        }
        return `${pad}${yamlScalar(key)}: ${yamlScalar(entry)}`;
      })
      .join("\n");
  }
  return yamlScalar(value);
}

function renderYaml(value) {
  return `${toYaml(value)}\n`;
}

async function writeYaml(path, value) {
  await writeFile(path, renderYaml(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The bootstrap Job trims, lowercases, then requires one @ and a dotted domain.
function administratorEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim().toLowerCase());
}

function asString(source, path, diagnostics, { pattern, validate, description } = {}) {
  const value = source[path.at(-1)];
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.errors.push(`${path.join(".")} must be a nonempty string.`);
    return "";
  }
  if (
    (pattern !== undefined && !pattern.test(value)) ||
    (validate !== undefined && !validate(value))
  ) {
    diagnostics.errors.push(`${path.join(".")} must be ${description}.`);
  }
  return value;
}

// URL parsing strips only C0 controls and spaces (U+0000 to U+0020) from the ends.
function stripUrlEdges(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return value.slice(start, end);
}

// The API and the bootstrap Job accept only an absolute HTTP(S) origin (validHttpBaseURL).
// Like the chart, this also refuses spellings URL parsing repairs: https:host, /. and /%2e,
// and other Unicode spaces or invisible characters at either end (NBSP, U+3000, U+FEFF,
// U+200B), which the API's parser keeps and mostly refuses. Both ends must be a letter, mark,
// number, punctuation or symbol, as in the chart. Inside, the chart also allows the joiners
// U+200C and U+200D that some IDN labels need, and refuses other spaces and invisible
// characters: the host parser refuses spaces, and drops tabs and most invisible characters.
// (URL parsing below refuses < and >, which the chart refuses explicitly.) Node's Unicode
// tables can be newer than Helm's, so a letter assigned since then passes here and fails in
// the chart; no realistic host uses one. Like both, it refuses a bare ? or # (https://host?),
// which parses to an empty query or fragment but would break the API's auth routes.
function httpOrigin(value) {
  const stripped = stripUrlEdges(value);
  if (
    /[?#]/.test(stripped) ||
    /^[^\p{L}\p{M}\p{N}\p{P}\p{S}]|[^\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(stripped) ||
    /[^\p{L}\p{M}\p{N}\p{P}\p{S}\u200c\u200d]/u.test(stripped) ||
    !/^https?:\/\/[^/?#]*\/?$/i.test(stripped)
  ) {
    return false;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    ipv4HostKept(value, url)
  );
}

// The same rule as the chart and OCC_AUTH_BASE_URL: a leading zero is octal, and
// hex, shorthand, a single integer or a trailing dot publish a different host.
function ipv4HostKept(raw, url) {
  if (isIP(url.hostname) !== 4) {
    return true;
  }
  const stripped = stripUrlEdges(raw);
  const written = /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(stripped)?.[1];
  return (
    written === url.hostname && /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(url.hostname)
  );
}

// KubernetesComputeDriver.validateCodexSeccompProfile. A localhost profile is a
// relative path: no absolute path or backslash, no empty, "." or ".." segment,
// and no segment named unconfined in any case.
function isCodexSeccompProfile(value) {
  if (isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((segment) => {
    return (
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment.toLowerCase() !== "unconfined"
    );
  });
}

function observabilityDestination(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(url.protocol) &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

// The chart refuses ".", "..", and any database.caKey that is not a basename.
function simpleBasename(value) {
  return value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

function validateDatabaseCaMount(values, diagnostics) {
  if (!values.database.caSecretName) {
    return;
  }
  // Profiles use the chart's bootstrap mount and private gateway CA, with no
  // executionCluster override. Match the active database-client mounts only.
  const reserved = new Set([
    "/etc/openclaw/installation",
    "/run/openclaw-worker",
    "/var/lib/openclaw/bootstrap",
    "/etc/openclaw/gateway-api-key",
    "/etc/openclaw/gateway-ca",
  ]);
  if (values.repositoryCredentials.enabled) {
    for (const path of [
      "/etc/openclaw/repository-registry",
      "/etc/openclaw/repository-ca",
      "/var/run/secrets/kubernetes.io/serviceaccount",
      "/run/openclaw/repository-control",
    ]) {
      reserved.add(path);
    }
  }
  if (values.backend?.chatgpt.enabled) {
    reserved.add("/etc/openclaw/chatgpt");
  }
  if (reserved.has(values.database.caMountPath)) {
    diagnostics.errors.push(
      "controlPlane.databaseCa.mountPath must be distinct from other active mounts in the production database clients.",
    );
  }
}

function optionalString(source, path, diagnostics, { pattern, validate, description } = {}) {
  const value = source[path.at(-1)];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.errors.push(`${path.join(".")} must be a nonempty string when supplied.`);
    return undefined;
  }
  if (
    (pattern !== undefined && !pattern.test(value)) ||
    (validate !== undefined && !validate(value))
  ) {
    diagnostics.errors.push(`${path.join(".")} must be ${description}.`);
  }
  return value;
}

function asBoolean(source, path, diagnostics, fallback = false) {
  const value = source[path.at(-1)];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    diagnostics.errors.push(`${path.join(".")} must be a boolean.`);
    return fallback;
  }
  return value;
}

function optionalPositiveInteger(source, path, diagnostics, { max } = {}) {
  const value = source[path.at(-1)];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    diagnostics.errors.push(
      max === undefined
        ? `${path.join(".")} must be a positive integer when supplied.`
        : `${path.join(".")} must be an integer from 1 through ${max} when supplied.`,
    );
    return undefined;
  }
  return value;
}

function labelMap(source, path, diagnostics) {
  const value = source[path.at(-1)];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    diagnostics.errors.push(`${path.join(".")} must be an object of Kubernetes labels.`);
    return {};
  }
  if (Object.keys(value).length === 0) {
    diagnostics.errors.push(`${path.join(".")} must contain at least one Kubernetes label.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      diagnostics.errors.push(`${path.join(".")}.${key} must be a string.`);
    }
  }
  return value;
}

const labelName = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

// Kubernetes label syntax: a name of at most 63 characters with an optional prefix, and a
// value that is empty or follows the name rule. `isPrefix` decides the prefix rule.
function labelSyntax(labels, path, diagnostics, isPrefix) {
  for (const [key, value] of Object.entries(labels)) {
    const parts = key.split("/");
    const name = parts.at(-1);
    const prefix = parts.length === 2 ? parts[0] : undefined;
    if (
      parts.length > 2 ||
      name.length > 63 ||
      labelName.exec(name)?.[0] !== name ||
      (prefix !== undefined && !isPrefix(prefix))
    ) {
      diagnostics.errors.push(`${path.join(".")} keys must be Kubernetes label keys.`);
    }
    if (
      typeof value === "string" &&
      value !== "" &&
      (value.length > 63 || labelName.exec(value)?.[0] !== value)
    ) {
      diagnostics.errors.push(`${path.join(".")} values must be Kubernetes label values.`);
    }
  }
  return labels;
}

// Kubernetes node selector labels: the chart and prepare-bootstrap-volume apply this rule to
// controlPlane.nodeSelector, and Kubernetes applies it to every Pod's nodeSelector, so the
// runtime selectors in Installation configuration follow it too. Kubernetes allows empty
// label values, as in `node-role.kubernetes.io/infra: ""`.
function nodeSelector(source, path, diagnostics) {
  const labels = labelMap(source, path, diagnostics);
  return labelSyntax(labels, path, diagnostics, isKubernetesResourceName);
}

// NetworkPolicy peer selectors (DNS, API clients, metrics scrapers). Compute's validatePeer
// applies this rule to every peer at startup, and Kubernetes to every NetworkPolicy: empty
// values are allowed and the key prefix is a DNS subdomain of at most 253 characters.
function peerSelector(source, path, diagnostics) {
  const labels = labelMap(source, path, diagnostics);
  return labelSyntax(labels, path, diagnostics, isKubernetesResourceName);
}

function stringArray(
  source,
  path,
  diagnostics,
  { pattern, validate, description, nonempty = true } = {},
) {
  const value = source[path.at(-1)];
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    diagnostics.errors.push(`${path.join(".")} must be a${nonempty ? " nonempty" : ""} list.`);
    return [];
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.errors.push(`${path.join(".")}[${index}] must be a nonempty string.`);
    } else if (
      (pattern !== undefined && !pattern.test(entry)) ||
      (validate !== undefined && !validate(entry))
    ) {
      diagnostics.errors.push(`${path.join(".")}[${index}] must be ${description}.`);
    }
  });
  return value;
}

// parseCidr accepts only "0" or a decimal prefix with no leading zero. Number("08") is 8,
// which would admit a prefix the API and the chart both refuse.
function decimalPrefix(rawPrefix) {
  if (!/^(0|[1-9][0-9]*)$/.test(rawPrefix ?? "")) {
    return Number.NaN;
  }
  return Number(rawPrefix);
}

function isIpv4Cidr(value, requiredPrefix) {
  const [address, rawPrefix, extra] = value.split("/");
  if (extra !== undefined || rawPrefix === undefined || isIP(address) !== 4) {
    return false;
  }
  const prefix = decimalPrefix(rawPrefix);
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > 32) {
    return false;
  }
  return requiredPrefix === undefined || prefix === requiredPrefix;
}

// The API refuses a public-suffix shared cookie domain at startup (normalizeSharedCookieDomain)
// with tldts and its bundled list. Resolve the controller's pinned copy so both use the same
// list without a new root dependency; load it only when native admin is configured.
function isPublicSuffix(hostname) {
  const require = createRequire(new URL("../apps/controller/package.json", import.meta.url));
  let tldts;
  try {
    tldts = require("tldts");
  } catch {
    return undefined;
  }
  const parsed = tldts.parse(hostname, { allowPrivateDomains: true, validateHostname: true });
  return parsed.isIp || parsed.domain === null || parsed.publicSuffix === hostname;
}

function validateNativeAdminDomains(domain, sharedCookieDomain, authBaseUrl, diagnostics) {
  const lowerDomain = domain.toLowerCase();
  const lowerSharedCookieDomain = sharedCookieDomain.toLowerCase();
  if (!dnsHostname.test(lowerDomain)) {
    diagnostics.errors.push(
      "controlPlane.agentNativeAdminDomain must be a DNS hostname without a wildcard, port, scheme, or path.",
    );
  }
  if (!dnsHostname.test(lowerSharedCookieDomain)) {
    diagnostics.errors.push(
      "controlPlane.sharedCookieDomain must be a DNS hostname without a wildcard, port, scheme, or path.",
    );
  } else {
    const publicSuffix = isPublicSuffix(lowerSharedCookieDomain);
    if (publicSuffix === undefined) {
      diagnostics.errors.push(
        "controlPlane.sharedCookieDomain needs the public suffix list: run pnpm install first.",
      );
    } else if (publicSuffix) {
      diagnostics.errors.push("controlPlane.sharedCookieDomain must not be a public suffix.");
    }
  }
  if (
    dnsHostname.test(lowerDomain) &&
    dnsHostname.test(lowerSharedCookieDomain) &&
    lowerDomain !== lowerSharedCookieDomain &&
    !lowerDomain.endsWith(`.${lowerSharedCookieDomain}`)
  ) {
    diagnostics.errors.push(
      "controlPlane.agentNativeAdminDomain must be inside controlPlane.sharedCookieDomain.",
    );
  }
  // The API refuses these at startup: shared session cookies are secure-only, and the
  // console host must be inside their parent.
  let baseUrl;
  try {
    baseUrl = new URL(authBaseUrl);
  } catch {
    // asString already reported it as not an absolute HTTP(S) origin.
    return;
  }
  if (baseUrl.protocol !== "https:") {
    diagnostics.errors.push("controlPlane.authBaseUrl must use HTTPS with native admin.");
  } else if (dnsHostname.test(lowerSharedCookieDomain)) {
    const host = baseUrl.hostname.replace(/\.$/, "");
    if (host !== lowerSharedCookieDomain && !host.endsWith(`.${lowerSharedCookieDomain}`)) {
      diagnostics.errors.push(
        "controlPlane.authBaseUrl host must be inside controlPlane.sharedCookieDomain.",
      );
    }
  }
}

// A Kubernetes Namespace name: a DNS label of at most 63 characters. The chart selects API
// client and DNS peers by kubernetes.io/metadata.name, which only ever holds such a name.
const namespaceRule = {
  validate: isKubernetesNamespaceName,
  description: "a Kubernetes namespace name (a DNS label of at most 63 characters)",
};

function clientSelectors(source, diagnostics) {
  if (!Array.isArray(source.apiClients) || source.apiClients.length === 0) {
    diagnostics.errors.push("controlPlane.apiClients must be a nonempty list.");
    return [];
  }
  return source.apiClients.map((client, index) => {
    const current = record(client, `controlPlane.apiClients[${index}]`, diagnostics);
    closed(current, `controlPlane.apiClients[${index}]`, ["namespace", "podLabels"], diagnostics);
    return {
      namespace: asString(
        current,
        ["controlPlane", "apiClients", String(index), "namespace"],
        diagnostics,
        namespaceRule,
      ),
      podLabels: peerSelector(
        current,
        ["controlPlane", "apiClients", String(index), "podLabels"],
        diagnostics,
      ),
    };
  });
}

const recoveryUserIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const githubOrganization = /^[a-z0-9][a-z0-9-]{0,38}$/;
const githubTeam = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_-]{0,99}$/;
const trustedProxyPresets = ["ingress-nginx", "aws", "generic"];
const passwordSignInPolicies = ["all", "recovery-only"];

// Ported from the API's trusted-proxy parser (apps/controller/src/auth/client-address.ts
// ipv6Groups and parseCidr), which the chart mirrors. Expands an address isIP accepted.
function ipv6Groups(address) {
  const hex = address.replace(/\d+\.\d+\.\d+\.\d+$/, (tail) => {
    const octets = tail.split(".").map(Number);
    return `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  });
  const [head, tail] = hex.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

// A trusted proxy CIDR as the API and the chart accept it. The chart refuses zone IDs,
// which isIP accepts. An IPv4-mapped address (::ffff:0:0/96) is an IPv4 address to the API,
// so its prefix is 1 through 32. Any other IPv6 range that contains all of ::ffff:0:0/96
// would trust every IPv4 peer, because BlockList matches IPv4 peers against it.
function isCidr(value) {
  const [address, rawPrefix, extra] = value.split("/");
  const family = isIP(address ?? "");
  if (extra !== undefined || family === 0 || address.includes("%")) {
    return false;
  }
  const prefix = decimalPrefix(rawPrefix);
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > (family === 4 ? 32 : 128)) {
    return false;
  }
  if (family === 4) {
    return true;
  }
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return prefix <= 32;
  }
  const coversIpv4 =
    prefix <= 96 &&
    groups.slice(0, 6).every((group, index) => {
      const shift = 16 - Math.min(16, Math.max(0, prefix - index * 16));
      const mappedGroup = index === 5 ? 0xffff : 0;
      return group >> shift === mappedGroup >> shift;
    });
  return !coversIpv4;
}

function signInProvider(source, name, diagnostics) {
  const path = ["controlPlane", name];
  const rendered = { enabled: true };
  for (const key of ["secretName", "clientIdKey", "clientSecretKey"]) {
    const value = optionalString(source, [...path, key], diagnostics);
    if (value !== undefined) {
      rendered[key] = value;
    }
  }
  // Omitted keys retain these chart defaults; a one-key override can collide too.
  if ((rendered.clientIdKey ?? "client-id") === (rendered.clientSecretKey ?? "client-secret")) {
    diagnostics.errors.push(
      `controlPlane.${name} client ID and client secret must use different Secret keys.`,
    );
  }
  if (source.allowedDomains !== undefined) {
    rendered.allowedDomains = stringArray(source, [...path, "allowedDomains"], diagnostics, {
      validate: (value) => googleHostedDomain.test(value),
      description:
        "a lowercase DNS domain name of at most 253 characters whose last label starts with a letter, such as example.com",
      nonempty: false,
    });
  }
  // GitHub's organization and team allowlist (RFC-0061), as the chart and API accept it.
  if (source.allowedOrgs !== undefined) {
    rendered.allowedOrgs = stringArray(source, [...path, "allowedOrgs"], diagnostics, {
      validate: (value) => githubOrganization.test(value),
      description: "a lowercase GitHub organization login such as acme",
      nonempty: false,
    });
  }
  if (source.allowedTeams !== undefined) {
    rendered.allowedTeams = stringArray(source, [...path, "allowedTeams"], diagnostics, {
      validate: (value) => githubTeam.test(value),
      description: "a lowercase org/team-slug entry such as acme/platform",
      nonempty: false,
    });
  }
  if ((rendered.allowedOrgs?.length ?? 0) + (rendered.allowedTeams?.length ?? 0) > 10) {
    diagnostics.errors.push(
      "controlPlane.github.allowedOrgs and allowedTeams list at most 10 entries together.",
    );
  }
  if (source.egressCidrs !== undefined) {
    rendered.egressCidrs = stringArray(source, [...path, "egressCidrs"], diagnostics, {
      validate: isIpv4Cidr,
      description: "an IPv4 CIDR with a prefix from 1 through 32",
      nonempty: false,
    });
  }
  return rendered;
}

// The chart's OIDC URL pattern: https, a DNS host spelled in ASCII, an optional :443, and a
// path without a query or fragment.
const oidcEndpoint =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::443)?(?:\/[^?#]*)?$/i;

// The OIDC URLs as both the chart and the API accept them: https on 443, a DNS host, and no
// userinfo, query or fragment. Like both, it checks the value after JavaScript's trim, which
// the API applies. URL parsing repairs spellings the chart refuses (a tab or a percent-escape
// in the host, an IDN host, backslashes), so the chart's pattern applies too, and an issuer
// must not name a port. Returns the lowercase host, or undefined.
function oidcEndpointHost(value, { issuer = false } = {}) {
  const trimmed = value.trim();
  const match = oidcEndpoint.exec(trimmed);
  if (match === null || match[1].length > 253 || (issuer && /^https:\/\/[^/]*:/i.test(trimmed))) {
    return undefined;
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 &&
    dnsHostname.test(url.hostname)
    ? url.hostname
    : undefined;
}

function renderOidc(source, diagnostics) {
  const path = ["controlPlane", "oidc"];
  const rendered = signInProvider(source, "oidc", diagnostics);
  const issuer = asString(source, [...path, "issuer"], diagnostics, {
    validate: (value) => oidcEndpointHost(value, { issuer: true }) !== undefined,
    description:
      "an https URL on port 443 with a DNS host name and no query or fragment, written without a port",
  });
  rendered.issuer = issuer;
  const host = oidcEndpointHost(issuer, { issuer: true });
  for (const key of ["authorizationUrl", "tokenUrl", "jwksUrl"]) {
    rendered[key] = asString(source, [...path, key], diagnostics, {
      validate: (value) => host === undefined || oidcEndpointHost(value) === host,
      description: "an https URL on port 443 on the issuer's host, with no query or fragment",
    });
  }
  const tokenAuth = optionalString(source, [...path, "tokenAuth"], diagnostics, {
    validate: (value) => ["client_secret_post", "client_secret_basic"].includes(value),
    description: "client_secret_post or client_secret_basic",
  });
  if (tokenAuth !== undefined) {
    rendered.tokenAuth = tokenAuth;
  }
  const displayName = optionalString(source, [...path, "displayName"], diagnostics, {
    validate: (value) => /^[^\p{C}\p{Zl}\p{Zp}]{1,40}$/u.test(value.trim()),
    description: "1 to 40 printable characters",
  });
  if (displayName !== undefined) {
    rendered.displayName = displayName;
  }
  return rendered;
}

// Mirrors the chart's auth.github/auth.google/auth.oidc checks. Activation is one-way, so every
// profile rerender after activation must keep rendering these values.
function renderExternalSignIn(controlPlane, github, google, oidc, authBaseUrl, diagnostics) {
  // The scheme as URL parsing reads it, like the API: HTTPS:// and surrounding spaces pass.
  if (!URL.canParse(authBaseUrl) || new URL(authBaseUrl).protocol !== "https:") {
    diagnostics.errors.push("controlPlane.authBaseUrl must use HTTPS with external sign-in.");
  }
  for (const key of ["agentNativeAdminDomain", "sharedCookieDomain"]) {
    if (controlPlane[key] !== undefined) {
      diagnostics.errors.push(
        `controlPlane.${key} is not consumed with external sign-in: GitHub, Google and OIDC sign-in disable native admin.`,
      );
    }
  }
  let recoveryUserId;
  if (controlPlane.recoveryUserId === undefined) {
    diagnostics.errors.push(
      "controlPlane.recoveryUserId is required with controlPlane.github, controlPlane.google or controlPlane.oidc.",
    );
  } else {
    recoveryUserId = asString(controlPlane, ["controlPlane", "recoveryUserId"], diagnostics, {
      pattern: recoveryUserIdPattern,
      description: "the existing local password administrator's user ID",
    });
  }
  const passwordSignIn = optionalString(
    controlPlane,
    ["controlPlane", "passwordSignIn"],
    diagnostics,
    {
      validate: (value) => passwordSignInPolicies.includes(value),
      description: passwordSignInPolicies.join(" or "),
    },
  );
  return {
    recoveryUserId,
    ...(passwordSignIn === undefined ? {} : { passwordSignIn }),
    ...(controlPlane.github === undefined
      ? {}
      : { github: signInProvider(github, "github", diagnostics) }),
    ...(controlPlane.google === undefined
      ? {}
      : { google: signInProvider(google, "google", diagnostics) }),
    ...(controlPlane.oidc === undefined ? {} : { oidc: renderOidc(oidc, diagnostics) }),
  };
}

function renderTrustedProxy(source, diagnostics) {
  const path = ["controlPlane", "trustedProxy"];
  const preset = asString(source, [...path, "preset"], diagnostics, {
    validate: (value) => trustedProxyPresets.includes(value),
    description: trustedProxyPresets.join(", or "),
  });
  const cidrs = stringArray(source, [...path, "cidrs"], diagnostics, {
    validate: isCidr,
    description:
      "an IPv4 or IPv6 CIDR with a nonzero prefix, no zone ID, a prefix of 1 through 32 for an IPv4-mapped address, and not covering every IPv4 address",
  });
  const clientAddressHeader = optionalString(
    source,
    [...path, "clientAddressHeader"],
    diagnostics,
    {
      pattern: /^[a-z0-9][a-z0-9-]{0,63}$/,
      description: "a single lowercase HTTP header name of at most 64 characters",
    },
  );
  if (preset === "generic" && clientAddressHeader === undefined) {
    diagnostics.errors.push(
      "controlPlane.trustedProxy.clientAddressHeader is required for the generic preset.",
    );
  }
  if (
    preset !== "generic" &&
    clientAddressHeader !== undefined &&
    clientAddressHeader !== "x-forwarded-for"
  ) {
    diagnostics.errors.push(
      `controlPlane.trustedProxy preset ${preset} reads x-forwarded-for; use the generic preset for ${clientAddressHeader}.`,
    );
  }
  return {
    preset,
    cidrs,
    ...(clientAddressHeader === undefined ? {} : { clientAddressHeader }),
  };
}

function section(source, key, diagnostics, required = true) {
  const value = source[key];
  if (value === undefined) {
    if (required) {
      diagnostics.errors.push(`${key} is required.`);
    }
    return {};
  }
  return record(value, key, diagnostics);
}

// YAML has no escape for a lone UTF-16 surrogate, so Helm cannot parse a values.yaml that
// carries one and no consumer accepts it.
function wellFormedText(value, path, diagnostics) {
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      diagnostics.errors.push(`${path} must be well-formed Unicode text.`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => wellFormedText(entry, `${path}[${index}]`, diagnostics));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const keyPath = path === "" ? key : `${path}.${key}`;
      if (!key.isWellFormed()) {
        diagnostics.errors.push(`${path || "input"} keys must be well-formed Unicode text.`);
      }
      wellFormedText(entry, keyPath, diagnostics);
    }
  }
}

function buildInput(rawInput, diagnostics) {
  wellFormedText(rawInput, "", diagnostics);
  const input = record(rawInput, "input", diagnostics);
  closed(
    input,
    "input",
    ["controlPlane", "runtime", "channels", "codex", "repository", "presets"],
    diagnostics,
  );
  const controlPlane = section(input, "controlPlane", diagnostics);
  const runtime = section(input, "runtime", diagnostics);
  const channels = section(input, "channels", diagnostics, false);
  const codex = section(input, "codex", diagnostics, false);
  const repository = section(input, "repository", diagnostics, false);
  const presets = section(input, "presets", diagnostics, false);
  closed(presets, "presets", ["files"], diagnostics);
  closed(
    controlPlane,
    "controlPlane",
    [
      "releaseName",
      "namespace",
      "clusterName",
      "controllerImage",
      "authBaseUrl",
      "adminEmail",
      "bootstrapPasswordClaimName",
      "apiClients",
      "databaseCidrs",
      "clusterCidrs",
      "dns",
      "gatewayClassName",
      "gatewayApiKeySecretName",
      "agentNativeAdminDomain",
      "sharedCookieDomain",
      "gatewayTrustedProxyCidrs",
      "pluginStatusProxySourceCidrs",
      "nodeSelector",
      "envoyNamespace",
      "metrics",
      "databaseCa",
      "loggingCollector",
      "observabilityUrl",
      "recoveryUserId",
      "passwordSignIn",
      "github",
      "google",
      "oidc",
      "trustedProxy",
    ],
    diagnostics,
  );
  closed(
    runtime,
    "runtime",
    [
      "image",
      "gatewayStorageClassName",
      "nodeSelector",
      "gatewayNodeSelector",
      "transportSecretPrefix",
      "codexSeccompProfile",
    ],
    diagnostics,
  );
  closed(
    channels,
    "channels",
    ["runtimeProxyUrl", "directoryProxyUrl", "managedSlackProxy"],
    diagnostics,
  );
  closed(codex, "codex", ["managedServiceAccounts", "modelDiscoveryCidrs"], diagnostics);
  closed(
    repository,
    "repository",
    [
      "enabled",
      "image",
      "backendId",
      "registryConfigMapName",
      "serviceConfigSecretName",
      "appKeySecretName",
      "tlsSecretName",
      "publicCaSecretName",
      "serviceName",
      "upstreamCidrs",
    ],
    diagnostics,
  );

  const dns = section(controlPlane, "dns", diagnostics);
  closed(dns, "controlPlane.dns", ["namespace", "podLabels"], diagnostics);
  const metrics = section(controlPlane, "metrics", diagnostics, false);
  closed(
    metrics,
    "controlPlane.metrics",
    ["scraperNamespaceLabels", "scraperPodLabels"],
    diagnostics,
  );
  const databaseCa = section(controlPlane, "databaseCa", diagnostics, false);
  closed(databaseCa, "controlPlane.databaseCa", ["secretName", "key", "mountPath"], diagnostics);
  const loggingCollector = section(controlPlane, "loggingCollector", diagnostics, false);
  closed(loggingCollector, "controlPlane.loggingCollector", ["enabled", "exporter"], diagnostics);
  const github = section(controlPlane, "github", diagnostics, false);
  closed(
    github,
    "controlPlane.github",
    ["secretName", "clientIdKey", "clientSecretKey", "allowedOrgs", "allowedTeams", "egressCidrs"],
    diagnostics,
  );
  const google = section(controlPlane, "google", diagnostics, false);
  closed(
    google,
    "controlPlane.google",
    ["secretName", "clientIdKey", "clientSecretKey", "allowedDomains", "egressCidrs"],
    diagnostics,
  );
  const oidc = section(controlPlane, "oidc", diagnostics, false);
  closed(
    oidc,
    "controlPlane.oidc",
    [
      "issuer",
      "authorizationUrl",
      "tokenUrl",
      "jwksUrl",
      "secretName",
      "clientIdKey",
      "clientSecretKey",
      "tokenAuth",
      "displayName",
      "egressCidrs",
    ],
    diagnostics,
  );
  const trustedProxy = section(controlPlane, "trustedProxy", diagnostics, false);
  closed(
    trustedProxy,
    "controlPlane.trustedProxy",
    ["preset", "cidrs", "clientAddressHeader"],
    diagnostics,
  );
  const managedServiceAccounts = section(codex, "managedServiceAccounts", diagnostics, false);
  closed(
    managedServiceAccounts,
    "codex.managedServiceAccounts",
    ["workspaceId", "adminSecretName", "adminSecretKey", "providerCidr", "credentialTtlSeconds"],
    diagnostics,
  );

  return {
    controlPlane,
    runtime,
    channels,
    codex,
    repository,
    dns,
    metrics,
    databaseCa,
    loggingCollector,
    managedServiceAccounts,
    presets,
    github,
    google,
    oidc,
    trustedProxy,
  };
}

// The installation, database and auth Secrets the profile leaves at the chart defaults, and
// the default sign-in Secret of each provider.
const chartSecrets = {
  installation: "occ-installation-startup",
  database: "occ-database",
  auth: "occ-auth",
};
const signInSecretDefaults = {
  github: "occ-github-login",
  google: "occ-google-login",
  oidc: "occ-oidc-login",
};
// The chart's default Gateway name (openclaw.gatewayRouting.gatewayName): the profile
// never sets gatewayRouting.gatewayName, so Compute's routing must use this exact name.
function chartGatewayName(releaseName) {
  return `${releaseName}-agent-gateways`.slice(0, 63).replace(/-$/, "");
}
// The Secrets the chart generates for gateway routing when gatewayRouting.tlsSecretName is
// unset, as the profile leaves it: the leaf certificate (openclaw.gatewayRouting.tlsSecretName)
// and the root CA (openclaw.gatewayRouting.rootSecretName, named after the hashed Gateway).
function chartGatewaySecretNames(releaseName, namespace) {
  const gatewayName = chartGatewayName(releaseName);
  const routeLabel = sha256Hex(`${namespace}/${gatewayName}`).slice(0, 12);
  return {
    tls: `${gatewayName}-tls`.slice(0, 63).replace(/-$/, ""),
    root: `occ-gateway-${routeLabel}-root`,
  };
}
// The chart's dedicated-Secret rule (openclaw.validate), in the chart's order: each Secret the
// profile names must differ from the chart's own and generated Secrets and from every Secret
// listed before it. cert-manager writes the generated Gateway Secrets, and Envoy Gateway accepts
// every entry of the gateway API key Secret as a client key (findings 1044, 1046, 1048). The
// enabled log collector's config and exporter Secrets stay at the chart defaults (finding 1054).
// The public CA settings may share one Secret with each other, as the chart allows (finding 1059).
const chartCollectorSecretNames = ["occ-otel-collector-config", "occ-otel-collector-exporter"];
function dedicatedSecrets(values, releaseName, namespace, diagnostics) {
  const generated = chartGatewaySecretNames(releaseName, namespace);
  const holders = new Map([
    ...Object.entries(chartSecrets).map(([role, name]) => [
      name,
      `${name} is also the chart's ${role} Secret`,
    ]),
    [generated.tls, `the chart generates ${generated.tls} for the Gateway TLS certificate`],
    [generated.root, `the chart generates ${generated.root} for the Gateway root CA`],
    ...(values.logging.collector.enabled ? chartCollectorSecretNames : []).map((name) => [
      name,
      `the chart's log collector uses ${name}`,
    ]),
  ]);
  const repository = values.repositoryCredentials;
  const fields = [
    ...(values.backend?.chatgpt?.enabled
      ? [["codex.managedServiceAccounts.adminSecretName", values.backend.chatgpt.secretName]]
      : []),
    ["controlPlane.databaseCa.secretName", values.database.caSecretName, "ca"],
    ["controlPlane.gatewayApiKeySecretName", values.gatewayRouting.apiKeySecretName],
    ...Object.entries(signInSecretDefaults)
      .filter(([name]) => values.auth[name] !== undefined)
      .map(([name, fallback]) => [
        `controlPlane.${name}.secretName`,
        values.auth[name].secretName ?? fallback,
      ]),
    ...(repository.enabled
      ? [
          ...["serviceConfigSecretName", "appKeySecretName", "tlsSecretName"].map((key) => [
            `repository.${key}`,
            repository[key],
          ]),
          ["repository.publicCaSecretName", repository.publicCaSecretName, "ca"],
        ]
      : []),
  ];
  const groups = new Map();
  for (const [field, name, group] of fields) {
    if (!name) {
      continue;
    }
    const holder = holders.get(name);
    if (holder === undefined) {
      holders.set(name, `${name} is also ${field}`);
      groups.set(name, group);
    } else if (group === undefined || groups.get(name) !== group) {
      diagnostics.errors.push(`${field} must name a dedicated Secret; ${holder}.`);
    }
  }
}

// The chart's collector egress (logging.collector.exporter): one approved exporter or proxy
// IPv4 host as a /32, or paired in-cluster selectors, and an optional TCP port (the chart
// defaults to 443). The chart refuses an enabled collector without one (finding 1047).
function collectorExporter(loggingCollector, enabled, diagnostics) {
  const path = ["controlPlane", "loggingCollector", "exporter"];
  if (loggingCollector.exporter === undefined) {
    if (enabled) {
      diagnostics.errors.push(
        `${path.join(".")} is required with enabled: true; set cidr to the one approved exporter or proxy IPv4 host as a /32, or namespaceLabels and podLabels for an in-cluster exporter.`,
      );
    }
    return undefined;
  }
  const exporter = loggingCollector.exporter;
  if (typeof exporter !== "object" || exporter === null || Array.isArray(exporter)) {
    diagnostics.errors.push(`${path.join(".")} must be an object.`);
    return undefined;
  }
  closed(exporter, path.join("."), ["cidr", "port", "namespaceLabels", "podLabels"], diagnostics);
  if (!enabled) {
    diagnostics.errors.push(
      `${path.join(".")} requires controlPlane.loggingCollector.enabled: true.`,
    );
  }
  const rendered = {};
  const cidr = optionalString(exporter, [...path, "cidr"], diagnostics, {
    validate: (value) => isIpv4Cidr(value, 32),
    description: "one approved exporter or proxy IPv4 host with /32, such as 203.0.113.10/32",
  });
  const selectors = exporter.namespaceLabels !== undefined || exporter.podLabels !== undefined;
  if (selectors) {
    if (exporter.namespaceLabels === undefined || exporter.podLabels === undefined) {
      diagnostics.errors.push(`${path.join(".")} requires both namespaceLabels and podLabels.`);
    } else {
      rendered.namespaceLabels = peerSelector(exporter, [...path, "namespaceLabels"], diagnostics);
      rendered.podLabels = peerSelector(exporter, [...path, "podLabels"], diagnostics);
    }
  }
  if (cidr !== undefined && selectors) {
    diagnostics.errors.push(
      `${path.join(".")} requires either cidr or namespaceLabels and podLabels, not both.`,
    );
  } else if (cidr === undefined && !selectors) {
    diagnostics.errors.push(`${path.join(".")} requires cidr or namespaceLabels and podLabels.`);
  }
  if (cidr !== undefined) {
    rendered.cidr = cidr;
  }
  const port = optionalPositiveInteger(exporter, [...path, "port"], diagnostics, { max: 65535 });
  if (port !== undefined) {
    rendered.port = port;
  }
  return rendered;
}

function buildRendered(profile, parsed, diagnostics) {
  const {
    controlPlane,
    runtime,
    channels,
    codex,
    repository,
    dns,
    metrics,
    databaseCa,
    loggingCollector,
    managedServiceAccounts,
    presets,
    github,
    google,
    oidc,
    trustedProxy,
  } = parsed;
  const releaseName = asString(controlPlane, ["controlPlane", "releaseName"], diagnostics, {
    validate: (value) => value.length <= 53 && dnsSubdomain.test(value),
    description: "a valid Helm release name of at most 53 characters",
  });
  const namespace = asString(
    controlPlane,
    ["controlPlane", "namespace"],
    diagnostics,
    namespaceRule,
  );
  // The bootstrap Job applies isName to installation.name, and the chart mirrors that rule.
  const clusterName = asString(controlPlane, ["controlPlane", "clusterName"], diagnostics, {
    validate: isName,
    description: NAME_RULE,
  });
  const controllerImage = asString(controlPlane, ["controlPlane", "controllerImage"], diagnostics, {
    pattern: controllerDigestImage,
    description: "an immutable image reference with a SHA-256 digest",
  });
  const runtimeImage = asString(runtime, ["runtime", "image"], diagnostics, {
    pattern: digestImage,
    description: "an immutable image reference with a SHA-256 digest",
  });
  const authBaseUrl = asString(controlPlane, ["controlPlane", "authBaseUrl"], diagnostics, {
    validate: httpOrigin,
    description: "an absolute HTTP(S) origin URL without a path, query, fragment, or user info",
  });
  const externalSignIn =
    controlPlane.github !== undefined ||
    controlPlane.google !== undefined ||
    controlPlane.oidc !== undefined;
  const signIn = externalSignIn
    ? renderExternalSignIn(controlPlane, github, google, oidc, authBaseUrl, diagnostics)
    : {};
  // Without a trusted proxy the API sees the ingress as every browser's address. Existing
  // source-preserving setups (such as an NLB) stay valid, so this warns rather than fails.
  if (controlPlane.trustedProxy === undefined) {
    diagnostics.warnings.push(
      externalSignIn
        ? "controlPlane.trustedProxy is not set: failed password sign-ins are limited per email only, and external sign-in starts have no per-client limit, because every browser behind a proxy shares its address. Set it unless the API sees each client's own address."
        : "controlPlane.trustedProxy is not set: failed password sign-ins are limited per email only, with no per-client-address limit. Set it when a proxy fronts the API.",
    );
  }
  if (!externalSignIn && controlPlane.recoveryUserId !== undefined) {
    diagnostics.errors.push(
      "controlPlane.recoveryUserId requires controlPlane.github, controlPlane.google or controlPlane.oidc.",
    );
  }
  if (!externalSignIn && controlPlane.passwordSignIn !== undefined) {
    diagnostics.errors.push(
      "controlPlane.passwordSignIn requires controlPlane.github, controlPlane.google or controlPlane.oidc.",
    );
  }
  // Helm refuses native admin with external sign-in (host-only cookies only).
  let agentNativeAdmin = { enabled: false };
  if (!externalSignIn) {
    const agentNativeAdminDomain = asString(
      controlPlane,
      ["controlPlane", "agentNativeAdminDomain"],
      diagnostics,
    );
    const sharedCookieDomain = asString(
      controlPlane,
      ["controlPlane", "sharedCookieDomain"],
      diagnostics,
    );
    validateNativeAdminDomains(
      agentNativeAdminDomain,
      sharedCookieDomain,
      authBaseUrl,
      diagnostics,
    );
    // The API lowercases both at startup; the chart accepts only lowercase.
    agentNativeAdmin = {
      enabled: true,
      domain: agentNativeAdminDomain.toLowerCase(),
      sharedCookieDomain: sharedCookieDomain.toLowerCase(),
    };
  }
  const envoyNamespace =
    optionalString(controlPlane, ["controlPlane", "envoyNamespace"], diagnostics, namespaceRule) ??
    "envoy-gateway-system";
  const repositoryEnabled = asBoolean(repository, ["repository", "enabled"], diagnostics, false);
  const managedSlackProxyEnabled = asBoolean(
    channels,
    ["channels", "managedSlackProxy"],
    diagnostics,
  );
  const managedSlackProxyHost = `openclaw-enterprise-slack-proxy.${namespace}.svc`;
  if (profile.name === "openclaw" && Object.keys(codex).length > 0) {
    diagnostics.errors.push("codex inputs are only consumed by the codex profile.");
  }
  if (profile.name === "openclaw" && runtime.codexSeccompProfile !== undefined) {
    diagnostics.errors.push("runtime.codexSeccompProfile is only consumed by the codex profile.");
  }
  if (!repositoryEnabled && Object.keys(repository).some((key) => key !== "enabled")) {
    diagnostics.errors.push(
      "repository fields other than enabled are only consumed when repository.enabled is true.",
    );
  }
  if (managedSlackProxyEnabled && channels.directoryProxyUrl !== undefined) {
    diagnostics.errors.push(
      "channels.directoryProxyUrl is not consumed when channels.managedSlackProxy enables the chart-managed Slack proxy.",
    );
  }
  if (managedSlackProxyEnabled && channels.runtimeProxyUrl !== undefined) {
    diagnostics.errors.push(
      "channels.runtimeProxyUrl is not consumed when channels.managedSlackProxy enables the chart-managed Slack proxy.",
    );
  }
  if (
    codex.managedServiceAccounts !== undefined &&
    Object.keys(managedServiceAccounts).length === 0
  ) {
    diagnostics.errors.push(
      "codex.managedServiceAccounts must include managed Backend inputs when supplied.",
    );
  }
  if ((metrics.scraperNamespaceLabels === undefined) !== (metrics.scraperPodLabels === undefined)) {
    diagnostics.errors.push(
      "controlPlane.metrics requires both scraperNamespaceLabels and scraperPodLabels, or neither.",
    );
  }

  // Same rule the controller applies to Installation observability.url at startup.
  const observabilityUrl = optionalString(
    controlPlane,
    ["controlPlane", "observabilityUrl"],
    diagnostics,
    {
      validate: observabilityDestination,
      description: "an absolute HTTP or HTTPS URL without credentials or a fragment",
    },
  );

  const collectorEnabled = asBoolean(
    loggingCollector,
    ["controlPlane", "loggingCollector", "enabled"],
    diagnostics,
    false,
  );
  const collectorExporterValues = collectorExporter(
    loggingCollector,
    collectorEnabled,
    diagnostics,
  );

  const values = {
    images: {
      controller: controllerImage,
    },
    installation: {
      name: clusterName,
    },
    auth: {
      baseUrl: authBaseUrl,
      ...signIn,
    },
    agentNativeAdmin,
    bootstrap: {
      adminEmail: asString(controlPlane, ["controlPlane", "adminEmail"], diagnostics, {
        validate: administratorEmail,
        description: "a valid administrator email",
      }),
      password: {
        claimName: asString(
          controlPlane,
          ["controlPlane", "bootstrapPasswordClaimName"],
          diagnostics,
          {
            validate: isKubernetesResourceName,
            description: "a PVC name: a DNS subdomain of at most 253 characters",
          },
        ),
      },
    },
    database: {
      cidrs: stringArray(controlPlane, ["controlPlane", "databaseCidrs"], diagnostics, {
        validate: (value) => isIpv4Cidr(value, 32),
        description: "an IPv4 /32 CIDR",
      }),
      ...(Object.keys(databaseCa).length === 0
        ? {}
        : {
            caSecretName: asString(
              databaseCa,
              ["controlPlane", "databaseCa", "secretName"],
              diagnostics,
              resourceNameRule,
            ),
            caKey:
              optionalString(databaseCa, ["controlPlane", "databaseCa", "key"], diagnostics, {
                validate: simpleBasename,
                description: "a simple basename",
              }) ?? "ca.pem",
            caMountPath:
              optionalString(
                databaseCa,
                ["controlPlane", "databaseCa", "mountPath"],
                diagnostics,
              ) ?? "/etc/openclaw/database-ca",
          }),
    },
    api: {
      clients: clientSelectors(controlPlane, diagnostics),
      ...(managedSlackProxyEnabled || channels.directoryProxyUrl === undefined
        ? {}
        : {
            channelDirectoryProxyUrl: asString(
              channels,
              ["channels", "directoryProxyUrl"],
              diagnostics,
              {
                validate: isLiteralIpv4ProxyUrl,
                description: "an HTTP(S) literal IPv4 endpoint with an explicit port",
              },
            ),
          }),
      modelDiscoveryCidrs:
        profile.name === "codex"
          ? stringArray(codex, ["codex", "modelDiscoveryCidrs"], diagnostics, {
              validate: (value) => isIpv4Cidr(value, 32),
              description: "an IPv4 /32 CIDR",
              nonempty: false,
            })
          : [],
      ...(controlPlane.trustedProxy === undefined
        ? {}
        : { trustedProxy: renderTrustedProxy(trustedProxy, diagnostics) }),
    },
    cluster: {
      cidrs: stringArray(controlPlane, ["controlPlane", "clusterCidrs"], diagnostics, {
        validate: (value) => isIpv4Cidr(value, 32),
        description: "an IPv4 /32 CIDR",
      }),
    },
    controlPlane: {
      ...(controlPlane.nodeSelector === undefined
        ? {}
        : {
            nodeSelector: nodeSelector(controlPlane, ["controlPlane", "nodeSelector"], diagnostics),
          }),
    },
    dns: {
      namespace: asString(dns, ["controlPlane", "dns", "namespace"], diagnostics, namespaceRule),
      podLabels: peerSelector(dns, ["controlPlane", "dns", "podLabels"], diagnostics),
    },
    gatewayRouting: {
      enabled: true,
      gatewayClassName: asString(
        controlPlane,
        ["controlPlane", "gatewayClassName"],
        diagnostics,
        resourceNameRule,
      ),
      apiKeySecretName: asString(
        controlPlane,
        ["controlPlane", "gatewayApiKeySecretName"],
        diagnostics,
        resourceNameRule,
      ),
      envoyNamespace,
    },
    metrics: {
      enabled: true,
      ...(metrics.scraperNamespaceLabels === undefined
        ? {}
        : {
            scraperNamespaceLabels: peerSelector(
              metrics,
              ["controlPlane", "metrics", "scraperNamespaceLabels"],
              diagnostics,
            ),
          }),
      ...(metrics.scraperPodLabels === undefined
        ? {}
        : {
            scraperPodLabels: peerSelector(
              metrics,
              ["controlPlane", "metrics", "scraperPodLabels"],
              diagnostics,
            ),
          }),
    },
    logging: {
      collector: {
        enabled: collectorEnabled,
        ...(collectorExporterValues === undefined ? {} : { exporter: collectorExporterValues }),
      },
    },
    repositoryCredentials: {
      enabled: repositoryEnabled,
    },
    ...(managedSlackProxyEnabled
      ? {
          slackProxy: {
            enabled: true,
          },
        }
      : {}),
  };

  const installation = {
    occ: {
      cluster: clusterName,
    },
    ...(observabilityUrl === undefined ? {} : { observability: { url: observabilityUrl } }),
    backend: [],
    presets: {
      includeDefaults: true,
      ...(presets.files === undefined
        ? {}
        : { files: stringArray(presets, ["presets", "files"], diagnostics, { nonempty: false }) }),
    },
    drivers: {
      plugin: profile.installation.drivers.plugin,
      configuration: {
        id: "config-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
        },
      },
      iam: {
        id: "native-iam",
        configuration: {},
      },
      compute: {
        id: "compute-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
          images: {
            gateway: runtimeImage,
            agent: runtimeImage,
            requireImmutableDigest: true,
          },
          resources: {
            // Tenant runtimes may burst to four cores; 100m requests keep the
            // scheduling reservation unchanged. Memory requests cover measured
            // use between turns, so the scheduler places Agents by what they
            // actually hold; limits cover measured peaks.
            // Gateways, embedded or dedicated, held 1.2-1.6 GiB between turns
            // and peaked at 1.8-2.2 GiB; a dedicated Codex Gateway serving native
            // admin chat was OOM-killed at 2Gi on its first coding turn.
            gateway: {
              requests: { cpu: "100m", memory: "1792Mi" },
              limits: { cpu: "4", memory: "3Gi" },
            },
            // A Codex Harness held 0.45-0.57 GiB between turns and peaked at
            // 1 GiB running a test suite and 1.9 GiB running tsc; lint, tsc and
            // tests together were OOM-killed at 2Gi, and the same turn reached a
            // 4Gi limit (memory.peak 4096 MiB, about 3.2 GiB anonymous) and
            // survived only by page-cache reclaim; the limit reserves no node
            // memory, so raising it leaves scheduling unchanged.
            agent: {
              requests: { cpu: "100m", memory: "768Mi" },
              limits: { cpu: "4", memory: "6Gi" },
            },
            namespace: {
              quota: { pods: "10" },
              containerDefaults: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "4", memory: "2Gi" },
              },
            },
          },
          network: {
            dns: {
              namespace: values.dns.namespace,
              podLabels: values.dns.podLabels,
            },
            gatewayPort: 8080,
            gatewayTrustedProxyCidrs: stringArray(
              controlPlane,
              ["controlPlane", "gatewayTrustedProxyCidrs"],
              diagnostics,
              { validate: isIpv4Cidr, description: "an IPv4 CIDR" },
            ),
            pluginStatusProxySourceCidrs: stringArray(
              controlPlane,
              ["controlPlane", "pluginStatusProxySourceCidrs"],
              diagnostics,
              { validate: isIpv4Cidr, description: "an IPv4 CIDR" },
            ),
          },
          gatewayRouting: {
            gatewayName: chartGatewayName(releaseName),
            gatewayNamespace: namespace,
            envoyNamespace,
          },
          servicePrincipalCredentials: {
            mode: "projectedServiceAccountToken",
            audience: "openclaw-enterprise",
            expirationSeconds: 900,
          },
          runtime: {
            gatewayStorageClassName: asString(
              runtime,
              ["runtime", "gatewayStorageClassName"],
              diagnostics,
            ),
            nodeSelector: nodeSelector(runtime, ["runtime", "nodeSelector"], diagnostics),
            gatewayNodeSelector: nodeSelector(
              runtime,
              ["runtime", "gatewayNodeSelector"],
              diagnostics,
            ),
            transportSecretPrefix: asString(
              runtime,
              ["runtime", "transportSecretPrefix"],
              diagnostics,
              {
                validate: (value) =>
                  value.length + 13 <= 253 && dnsSubdomain.test(`${value}-${"a".repeat(12)}`),
                description:
                  "a prefix producing a DNS-safe Secret name of at most 253 characters with its 12-character suffix",
              },
            ),
            ...(profile.name === "codex"
              ? {
                  codexSeccompProfile: asString(
                    runtime,
                    ["runtime", "codexSeccompProfile"],
                    diagnostics,
                    {
                      validate: isCodexSeccompProfile,
                      description:
                        "a relative localhost profile path without traversal or unconfined mode",
                    },
                  ),
                }
              : {}),
            ...(managedSlackProxyEnabled
              ? {
                  channels: {
                    proxyUrl: `http://${managedSlackProxyHost}:3128`,
                    managedProxy: {
                      hostname: managedSlackProxyHost,
                      namespace,
                      podLabels: {
                        "app.kubernetes.io/name": "openclaw-enterprise",
                        "app.kubernetes.io/instance": releaseName,
                        "app.kubernetes.io/component": "slack-proxy",
                      },
                      port: 3128,
                    },
                  },
                }
              : channels.runtimeProxyUrl === undefined
                ? {}
                : {
                    channels: {
                      proxyUrl: asString(channels, ["channels", "runtimeProxyUrl"], diagnostics, {
                        validate: isLiteralIpv4ProxyUrl,
                        description: "an HTTP(S) literal IPv4 endpoint with an explicit port",
                      }),
                    },
                  }),
          },
        },
      },
      secret: {
        id: "secret-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
        },
      },
    },
  };

  if (profile.name === "codex") {
    if (Object.keys(managedServiceAccounts).length > 0) {
      const serviceAccountDriverId = "chatgpt-service-accounts";
      values.backend = {
        chatgpt: {
          enabled: true,
          secretName: asString(
            managedServiceAccounts,
            ["codex", "managedServiceAccounts", "adminSecretName"],
            diagnostics,
          ),
          key:
            optionalString(
              managedServiceAccounts,
              ["codex", "managedServiceAccounts", "adminSecretKey"],
              diagnostics,
            ) ?? "admin-key",
          providerCidr: asString(
            managedServiceAccounts,
            ["codex", "managedServiceAccounts", "providerCidr"],
            diagnostics,
            { validate: (value) => isIpv4Cidr(value, 32), description: "an IPv4 /32 CIDR" },
          ),
        },
      };
      installation.backend.push({
        id: "chatgpt-primary",
        type: "chatgpt",
        configuration: {
          workspaceId: asString(
            managedServiceAccounts,
            ["codex", "managedServiceAccounts", "workspaceId"],
            diagnostics,
            {
              pattern: chatGptWorkspaceId,
              description:
                "a UUID the controller accepts for a ChatGPT workspace (version 1-8, variant 8, 9, a, or b)",
            },
          ),
          apiKeyPath: "/etc/openclaw/chatgpt/admin-key",
          credentialTtlSeconds:
            optionalPositiveInteger(
              managedServiceAccounts,
              ["codex", "managedServiceAccounts", "credentialTtlSeconds"],
              diagnostics,
              // packages/occ validateBackendDefinitions refuses a larger lifetime.
              { max: 2_592_000 },
            ) ?? 2_592_000,
        },
        drivers: {
          service_account: serviceAccountDriverId,
        },
      });
      installation.drivers.service_account = {
        id: serviceAccountDriverId,
        configuration: {},
      };
    }
  }

  if (repositoryEnabled) {
    const repoDriverId = "repository-credentials";
    values.repositoryCredentials = {
      enabled: true,
      image: asString(repository, ["repository", "image"], diagnostics, {
        pattern: digestImage,
        description: "an immutable image reference with a SHA-256 digest",
      }),
      // Installation startup checks a GitHub Backend ID with isBackendId, then bounds it to
      // 200 UTF-16 code units for repository bindings; the chart checks both.
      backendId: asString(repository, ["repository", "backendId"], diagnostics, {
        validate: (value) => isBackendId(value) && value.length <= 200,
        description: `a Backend ID: ${NAME_RULE}, and at most 200 UTF-16 code units`,
      }),
      registryConfigMapName: asString(
        repository,
        ["repository", "registryConfigMapName"],
        diagnostics,
      ),
      serviceConfigSecretName: asString(
        repository,
        ["repository", "serviceConfigSecretName"],
        diagnostics,
      ),
      appKeySecretName: asString(repository, ["repository", "appKeySecretName"], diagnostics),
      tlsSecretName: asString(repository, ["repository", "tlsSecretName"], diagnostics),
      publicCaSecretName: asString(repository, ["repository", "publicCaSecretName"], diagnostics),
      serviceName: optionalString(repository, ["repository", "serviceName"], diagnostics, {
        validate: (value) => value.length <= 63 && dns1035Label.test(value),
        description: "a Kubernetes Service DNS-1035 label of at most 63 characters",
      }),
      upstreamCidrs: stringArray(repository, ["repository", "upstreamCidrs"], diagnostics, {
        validate: isIpv4Cidr,
        description: "an IPv4 CIDR",
      }),
    };
    installation.backend.push({
      id: values.repositoryCredentials.backendId,
      type: "github",
      configuration: {
        registryPath: "/etc/openclaw/repository-registry/registry.json",
      },
      drivers: {
        repo: repoDriverId,
      },
    });
    installation.drivers.repo = {
      id: repoDriverId,
      configuration: {
        controlSocket: "/run/openclaw/repository-control/private/control.sock",
        sessionDurationSeconds: 86_400,
        publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
      },
    };
    installation.drivers.compute.configuration.network.repositoryCredentials = {
      namespace,
      podLabels: {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": releaseName,
        "app.kubernetes.io/component": "worker",
      },
      port: 8443,
    };
  }

  dedicatedSecrets(values, releaseName, namespace, diagnostics);
  validateDatabaseCaMount(values, diagnostics);

  diagnostics.prerequisites.push(
    "Default ReadWriteOnce storage class available for dedicated Codex workspace claims.",
    "Envoy Gateway and cert-manager installed before applying gatewayRouting values.",
  );
  if (agentNativeAdmin.enabled) {
    diagnostics.prerequisites.push(
      "Wildcard DNS and TLS configured for the native admin domain and shared cookie parent.",
    );
  } else {
    diagnostics.prerequisites.push(
      "External sign-in Secrets created, and controlPlane.recoveryUserId read from a verified password administrator's session, before the first helm upgrade that renders them.",
    );
    if (signIn.passwordSignIn === "recovery-only") {
      diagnostics.prerequisites.push(
        "A GitHub, Google or OIDC identity attached to every ordinary account before the helm upgrade that renders passwordSignIn: recovery-only; accounts without one cannot sign in until an administrator attaches it.",
      );
    }
  }
  if (profile.name === "codex") {
    diagnostics.prerequisites.push(
      "Configured Codex seccomp profile installed and verified on every node selected by runtime.nodeSelector.",
      "Hosted discovery and codex_pat runtime tokens stored later as Namespace Secrets or entered in the Console; the renderer does not create or verify those credentials.",
    );
    if (Object.keys(managedServiceAccounts).length === 0) {
      diagnostics.warnings.push(
        "Managed ChatGPT service-account issuance is not configured; Codex Agents must use an existing codex_pat token until backend provisioning is supplied and verified.",
      );
    } else {
      diagnostics.prerequisites.push(
        "ChatGPT service-account app connections configured outside OCE before Agents select a managed ServiceAccount as their codex_pat source.",
      );
      diagnostics.warnings.push(
        "Managed ChatGPT service-account issuance is wired but remains unverified until a live admin credential flow is qualified.",
      );
    }
  }
  if (
    channels.runtimeProxyUrl !== undefined ||
    channels.directoryProxyUrl !== undefined ||
    managedSlackProxyEnabled
  ) {
    diagnostics.prerequisites.push(
      "Slack consumers remain inactive until Agent channel configuration and credentials are supplied.",
    );
  }
  if (managedSlackProxyEnabled) {
    diagnostics.prerequisites.push(
      "The managed Slack proxy permits Slack hostnames on HTTPS and public IPv4 egress, excluding private and reserved ranges.",
    );
    diagnostics.nextSteps.push(
      `The managed Slack proxy Service is openclaw-enterprise-slack-proxy.${namespace}.svc:3128; keep Agent Slack channel consumers disabled until credentials and channel policy are configured.`,
    );
  }
  if (repositoryEnabled) {
    diagnostics.warnings.push(
      "Repository support is optional. Active repository sessions are not restored after broker loss. Sessions lost without confirmed disposal remain unresolved and can fail affected revisions; a new authorized revision does not settle old cleanup obligations.",
    );
    diagnostics.nextSteps.push(
      "After the first bootstrap creates Namespace IDs, create the repository registry ConfigMap and then rerender/apply the repository-enabled inputs.",
    );
  }

  diagnostics.nextSteps.push(
    `Create or update the ${namespace}/occ-installation-startup Secret from installation.yaml.`,
    `Run helm upgrade --install ${releaseName} deploy/helm/openclaw-enterprise --namespace ${namespace} --values values.yaml.`,
    "Retrieve the bootstrap service key from the protected bootstrap PVC and verify authenticated OCC access.",
  );

  return { values, installation };
}

async function writePreflight(outDir, profile, diagnostics, output = {}) {
  const preflight = {
    ok: diagnostics.errors.length === 0,
    profile,
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
    prerequisites: diagnostics.prerequisites,
    nextSteps: diagnostics.nextSteps,
    outputs: output,
  };
  await writeFile(resolve(outDir, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`);
  return preflight;
}

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.outDir);
await mkdir(outDir, { recursive: true });
const output = {
  values: resolve(outDir, "values.yaml"),
  installation: resolve(outDir, "installation.yaml"),
  preflight: resolve(outDir, "preflight.json"),
};
// A failed rerender must not expose artifacts or a success report from a prior run.
await Promise.all(Object.values(output).map((path) => rm(path, { force: true })));
const diagnostics = { errors: [], warnings: [], prerequisites: [], nextSteps: [] };
const [profile, rawInput] = await Promise.all([
  readProfile(args.profile),
  readJson(resolve(args.input), "input"),
]);
const parsed = buildInput(rawInput, diagnostics);
const { values, installation } = buildRendered(profile, parsed, diagnostics);

if (diagnostics.errors.length === 0) {
  const installationYaml = renderYaml(installation);
  values.controlPlane = {
    ...(values.controlPlane ?? {}),
    installationChecksum: sha256Hex(installationYaml),
  };
  await Promise.all([
    writeYaml(output.values, values),
    writeFile(output.installation, installationYaml),
  ]);
}
const preflight = await writePreflight(
  outDir,
  profile.name,
  diagnostics,
  diagnostics.errors.length === 0 ? output : { preflight: output.preflight },
);
process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
if (!preflight.ok) {
  process.exit(1);
}
