#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const profilesDir = resolve(repoRoot, "deploy/profiles");
const allowedProfiles = new Set(["openclaw", "codex"]);
const digestImage = /^[^@\s]+@sha256:[a-f0-9]{64}$/i;
const proxyUrl = /^https?:\/\/(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}:[1-9][0-9]{0,4}$/;
const dnsHostname =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

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
    return JSON.stringify(value);
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

function optionalPositiveInteger(source, path, diagnostics) {
  const value = source[path.at(-1)];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    diagnostics.errors.push(`${path.join(".")} must be a positive integer when supplied.`);
    return undefined;
  }
  return value;
}

function labelMap(source, path, diagnostics, { nonempty = true } = {}) {
  const value = source[path.at(-1)];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    diagnostics.errors.push(`${path.join(".")} must be an object of Kubernetes labels.`);
    return {};
  }
  if (nonempty && Object.keys(value).length === 0) {
    diagnostics.errors.push(`${path.join(".")} must contain at least one Kubernetes label.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length === 0) {
      diagnostics.errors.push(`${path.join(".")}.${key} must be a nonempty string.`);
    }
  }
  return value;
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

function isIpv4Cidr(value, requiredPrefix) {
  const [address, rawPrefix, extra] = value.split("/");
  if (extra !== undefined || rawPrefix === undefined || isIP(address) !== 4) {
    return false;
  }
  if (!/^[0-9]+$/.test(rawPrefix)) {
    return false;
  }
  const prefix = Number(rawPrefix);
  if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > 32) {
    return false;
  }
  return requiredPrefix === undefined || prefix === requiredPrefix;
}

function validateNativeAdminDomains(domain, sharedCookieDomain, diagnostics) {
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
}

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
      ),
      podLabels: labelMap(
        current,
        ["controlPlane", "apiClients", String(index), "podLabels"],
        diagnostics,
      ),
    };
  });
}

const recoveryUserIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const trustedProxyPresets = ["ingress-nginx", "aws", "generic"];
const passwordSignInPolicies = ["all", "recovery-only"];

function isCidr(value) {
  const [address, rawPrefix, extra] = value.split("/");
  const family = isIP(address ?? "");
  if (extra !== undefined || family === 0 || !/^[0-9]+$/.test(rawPrefix ?? "")) {
    return false;
  }
  const prefix = Number(rawPrefix);
  return prefix >= 1 && prefix <= (family === 4 ? 32 : 128);
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
  if (source.allowedDomains !== undefined) {
    rendered.allowedDomains = stringArray(source, [...path, "allowedDomains"], diagnostics, {
      validate: (value) => dnsHostname.test(value),
      description: "a lowercase DNS domain name such as example.com",
      nonempty: false,
    });
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

// The OIDC URLs as the chart and API accept them: https on 443, a DNS host, and no
// userinfo, query or fragment. Returns the lowercase host, or undefined.
function oidcEndpointHost(value) {
  if (/[?#]/.test(value)) {
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
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
    validate: (value) => oidcEndpointHost(value) !== undefined,
    description: "an https URL on port 443 with a DNS host name and no query or fragment",
  });
  rendered.issuer = issuer;
  const host = oidcEndpointHost(issuer);
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
  if (!authBaseUrl.startsWith("https://")) {
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
    description: "an IPv4 or IPv6 CIDR with a nonzero prefix",
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

function buildInput(rawInput, diagnostics) {
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
  closed(loggingCollector, "controlPlane.loggingCollector", ["enabled"], diagnostics);
  const github = section(controlPlane, "github", diagnostics, false);
  closed(
    github,
    "controlPlane.github",
    ["secretName", "clientIdKey", "clientSecretKey", "egressCidrs"],
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
  const releaseName = asString(controlPlane, ["controlPlane", "releaseName"], diagnostics);
  const namespace = asString(controlPlane, ["controlPlane", "namespace"], diagnostics);
  const clusterName = asString(controlPlane, ["controlPlane", "clusterName"], diagnostics);
  const controllerImage = asString(controlPlane, ["controlPlane", "controllerImage"], diagnostics, {
    pattern: digestImage,
    description: "an immutable image reference with a SHA-256 digest",
  });
  const runtimeImage = asString(runtime, ["runtime", "image"], diagnostics, {
    pattern: digestImage,
    description: "an immutable image reference with a SHA-256 digest",
  });
  const authBaseUrl = asString(controlPlane, ["controlPlane", "authBaseUrl"], diagnostics);
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
    validateNativeAdminDomains(agentNativeAdminDomain, sharedCookieDomain, diagnostics);
    agentNativeAdmin = { enabled: true, domain: agentNativeAdminDomain, sharedCookieDomain };
  }
  const envoyNamespace =
    optionalString(controlPlane, ["controlPlane", "envoyNamespace"], diagnostics) ??
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
      adminEmail: asString(controlPlane, ["controlPlane", "adminEmail"], diagnostics),
      password: {
        claimName: asString(
          controlPlane,
          ["controlPlane", "bootstrapPasswordClaimName"],
          diagnostics,
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
            ),
            caKey:
              optionalString(databaseCa, ["controlPlane", "databaseCa", "key"], diagnostics) ??
              "ca.pem",
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
                pattern: proxyUrl,
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
        : { nodeSelector: labelMap(controlPlane, ["controlPlane", "nodeSelector"], diagnostics) }),
    },
    dns: {
      namespace: asString(dns, ["controlPlane", "dns", "namespace"], diagnostics),
      podLabels: labelMap(dns, ["controlPlane", "dns", "podLabels"], diagnostics),
    },
    gatewayRouting: {
      enabled: true,
      gatewayClassName: asString(controlPlane, ["controlPlane", "gatewayClassName"], diagnostics),
      apiKeySecretName: asString(
        controlPlane,
        ["controlPlane", "gatewayApiKeySecretName"],
        diagnostics,
      ),
      envoyNamespace,
    },
    metrics: {
      enabled: true,
      ...(metrics.scraperNamespaceLabels === undefined
        ? {}
        : {
            scraperNamespaceLabels: labelMap(
              metrics,
              ["controlPlane", "metrics", "scraperNamespaceLabels"],
              diagnostics,
            ),
          }),
      ...(metrics.scraperPodLabels === undefined
        ? {}
        : {
            scraperPodLabels: labelMap(
              metrics,
              ["controlPlane", "metrics", "scraperPodLabels"],
              diagnostics,
            ),
          }),
    },
    logging: {
      collector: {
        enabled: asBoolean(
          loggingCollector,
          ["controlPlane", "loggingCollector", "enabled"],
          diagnostics,
          false,
        ),
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
            gatewayName: `${releaseName}-agent-gateways`.slice(0, 63).replace(/-$/, ""),
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
            nodeSelector: labelMap(runtime, ["runtime", "nodeSelector"], diagnostics),
            gatewayNodeSelector: labelMap(runtime, ["runtime", "gatewayNodeSelector"], diagnostics),
            transportSecretPrefix: asString(
              runtime,
              ["runtime", "transportSecretPrefix"],
              diagnostics,
            ),
            ...(profile.name === "codex"
              ? {
                  codexSeccompProfile: asString(
                    runtime,
                    ["runtime", "codexSeccompProfile"],
                    diagnostics,
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
                        pattern: proxyUrl,
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
          ),
          apiKeyPath: "/etc/openclaw/chatgpt/admin-key",
          credentialTtlSeconds:
            optionalPositiveInteger(
              managedServiceAccounts,
              ["codex", "managedServiceAccounts", "credentialTtlSeconds"],
              diagnostics,
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
      backendId: asString(repository, ["repository", "backendId"], diagnostics),
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
      serviceName: optionalString(repository, ["repository", "serviceName"], diagnostics),
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
        "ChatGPT service-account app connections configured outside OCE before Agents use chatgpt_service_account auth.",
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
