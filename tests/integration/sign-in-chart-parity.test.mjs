import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { startApi, startupFailureFields } from "../../apps/controller/src/api-startup.mjs";
import {
  refuseRewrittenIpv4Host,
  refuseWrittenUserinfo,
} from "../../apps/controller/src/auth/configuration.ts";
import {
  clientAddressConfiguration,
  createControllerAuth,
  githubLoginConfiguration,
  humanLoginConfiguration,
  resolveClientAddress,
} from "../../apps/controller/src/auth/index.ts";
import {
  bootstrapConfiguration,
  bootstrapFailureCode,
} from "../../scripts/lib/bootstrap-configuration.mjs";
import { settled as settle } from "../helpers/child-processes.mjs";
import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import {
  chartRefusal,
  chartTooling,
  deploymentEnv,
  renderChart,
  repository,
  signInSettings,
  trustedProxyNoticeRenderer,
} from "../helpers/sign-in-chart.mjs";
import {
  defaultInstallSettings,
  githubUpgradeSettings,
  githubUpgradeValues,
  fixtureOidcIssuer,
  googleUpgradeSettings,
  googleUpgradeValues,
  oidcUpgradeSettings,
  oidcUpgradeValues,
} from "../helpers/production-sign-in.mjs";

const tooling = await chartTooling();
const recoveryUserId = "Pq7rS2tU9vW4xY1z";
const secrets = {
  "occ-auth/secret": "chart-parity-auth-secret-at-least-32-characters",
  "occ-github-login/client-id": "chart-parity-client-id",
  "occ-github-login/client-secret": "chart-parity-client-secret",
  "occ-google-login/client-id": "chart-parity-google-client-id.apps.googleusercontent.com",
  "occ-google-login/client-secret": "chart-parity-google-client-secret",
  "occ-oidc-login/client-id": "chart-parity-oidc-client-id",
  "occ-oidc-login/client-secret": "chart-parity-oidc-client-secret",
};
// What the API parses from the rendered GitHub and Google sign-in settings.
const githubParsed = {
  clientId: secrets["occ-github-login/client-id"],
  clientSecret: secrets["occ-github-login/client-secret"],
  recoveryUserId,
};
const googleParsed = {
  clientId: secrets["occ-google-login/client-id"],
  clientSecret: secrets["occ-google-login/client-secret"],
  allowedDomains: [],
  recoveryUserId,
};

// A trusted-proxy preset as operators set it, and the API settings the chart renders for it.
function trustedProxy(preset, cidrs = [], header) {
  return {
    values: {
      "api.trustedProxy.preset": preset,
      ...Object.fromEntries(cidrs.map((cidr, index) => [`api.trustedProxy.cidrs[${index}]`, cidr])),
      ...(header === undefined ? {} : { "api.trustedProxy.clientAddressHeader": header }),
    },
    env: {
      OCC_AUTH_TRUSTED_PROXY_PRESET: preset,
      ...(cidrs.length === 0 ? {} : { OCC_AUTH_TRUSTED_PROXY_CIDRS: cidrs.join(",") }),
      ...(header === undefined ? {} : { OCC_AUTH_CLIENT_IP_HEADER: header.toLowerCase() }),
    },
  };
}

// Each proxy preset the chart offers, as operators set it, and what the API must read.
const presets = {
  none: { values: {}, env: {}, parsed: undefined },
  "ingress-nginx": {
    ...trustedProxy("ingress-nginx", ["10.42.0.0/16"]),
    parsed: { header: "x-forwarded-for", proxy: "10.42.7.1" },
  },
  aws: {
    ...trustedProxy("aws", ["10.0.0.0/16", "fd00:10::/64"]),
    parsed: { header: "x-forwarded-for", proxy: "fd00:10::5" },
  },
  generic: {
    ...trustedProxy("generic", ["192.168.10.0/24"], "X-Real-IP"),
    parsed: { header: "x-real-ip", proxy: "192.168.10.9" },
  },
};

function resolveSecrets(settings) {
  return Object.fromEntries(
    Object.entries(settings).map(([name, value]) => [
      name,
      typeof value === "string"
        ? value
        : secrets[`${value.secretKeyRef.name}/${value.secretKeyRef.key}`],
    ]),
  );
}

// At most one child process per CPU (and at least two) across the whole file; a render holds
// one slot for helm and then yq, and an entrypoint start holds one until it exits.
const slots = Math.max(2, availableParallelism());
const waiting = [];
let running = 0;
async function limited(task) {
  if (running < slots) {
    running += 1;
  } else {
    await new Promise((resolve) => waiting.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      running -= 1;
    }
  }
}
const render = (values) => limited(() => renderChart(values));
const refusal = (values) => limited(() => chartRefusal(values));

// One workspace for every API start: the Installation file, the gateway key the chart mounts,
// and the chart copy that renders the install notes.
const directory = await mkdtemp(join(tmpdir(), "occ-sign-in-chart-parity-"));
await writeFile(
  join(directory, "installation.yaml"),
  JSON.stringify(createInstallationDriverConfiguration()),
);
await writeFile(join(directory, "gateway-key"), "occ_chart_parity_gateway_key", { mode: 0o600 });
const noticeRenderer = trustedProxyNoticeRenderer(directory);
const notice = (values) => limited(() => noticeRenderer(values));

const unreachableDatabase = "postgresql://127.0.0.1:1/occ";
const definedOnly = (env) =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));

// The API Pod's environment with the rendered settings, in production with an unreachable
// database.
function apiEnvironment(settings) {
  return definedOnly({
    NODE_ENV: "production",
    OCC_DATABASE_URL: unreachableDatabase,
    OCC_CONFIG_PATH: join(directory, "installation.yaml"),
    OCC_HOST: "192.0.2.10",
    OCC_PORT: "8080",
    ...settings,
    // The chart mounts the gateway key Secret here; the test supplies a private file.
    ...(settings.OCC_GATEWAY_API_KEY_PATH === undefined
      ? {}
      : { OCC_GATEWAY_API_KEY_PATH: join(directory, "gateway-key") }),
  });
}

// The bootstrap Job's environment, as the chart's Job runs it (NODE_ENV=production).
function jobEnvironment(baseUrl) {
  return {
    NODE_ENV: "production",
    OCC_DATABASE_URL: unreachableDatabase,
    OCC_AUTH_SECRET: secrets["occ-auth/secret"],
    OCC_AUTH_BASE_URL: baseUrl,
    OCC_BOOTSTRAP_ADMIN_EMAIL: "admin@oce.example.internal",
  };
}

// Runs the API's startup in process: startApi, which server.mjs runs with process.env. Its
// database is unreachable, so accepted settings end at PERSISTENCE_UNAVAILABLE, after
// configuration parsing, Driver loading and composition checks; refused settings end earlier
// with another startup code.
async function startupCode(settings) {
  try {
    await startApi(apiEnvironment(settings));
  } catch (error) {
    return startupFailureFields(error).code;
  }
  assert.fail("the API started without a database");
}

// The bootstrap Job's own check of its settings, in process: bootstrapConfiguration, which the
// Job runs before it opens the database. Undefined when the Job accepts `baseUrl`, else the
// code it fails with.
function jobRefusal(baseUrl) {
  try {
    bootstrapConfiguration("production", jobEnvironment(baseUrl));
  } catch (error) {
    return bootstrapFailureCode(error);
  }
  return undefined;
}

// Runs a Node entrypoint with exactly `env`, requires it to exit with status 1, and returns the
// code of its structured `event` line. The deadline only stops a hung start: these few starts
// share the file's CPUs with its renders.
async function entrypointCode(script, event, env) {
  const { killed, status, output } = await limited(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [script],
          {
            cwd: repository,
            env: { PATH: process.env.PATH, ...compileCacheEnvironment, ...env },
            timeout: 60_000,
          },
          (error, _stdout, stderr) =>
            resolve({ killed: error?.killed === true, status: error?.code ?? 0, output: stderr }),
        );
      }),
  );
  // execFile also kills on its output limit, far above what these entrypoints print.
  assert.ok(!killed, `${script} timed out for OCC_AUTH_BASE_URL ${env.OCC_AUTH_BASE_URL}`);
  assert.equal(status, 1, output);
  const diagnostic = output
    .split("\n")
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line))
    .find((line) => line.event === event);
  assert.ok(diagnostic, output);
  return diagnostic.code;
}

async function startsUp(environment, label) {
  assert.equal(await startupCode(environment), "PERSISTENCE_UNAVAILABLE", label);
}

const loginEgress = (objects) =>
  objects
    .filter(({ kind }) => kind === "NetworkPolicy")
    .map(({ metadata }) => /-api-(github|google|oidc)-login-egress$/.exec(metadata.name)?.[1])
    .filter(Boolean)
    .sort();

// Renders `values` and checks what the chart gives the API: exactly `settings`, a default
// login egress per listed provider (any address except link-local, on TCP 443 only), and no
// sign-in or trusted-proxy setting for the worker. Returns the API's env.
async function renders(label, values, settings, egress) {
  const objects = await render(values);
  const rendered = signInSettings(deploymentEnv(objects, "api"));
  assert.deepEqual(rendered, settings, label);
  assert.deepEqual(loginEgress(objects), egress, label);
  for (const provider of egress) {
    assert.deepEqual(
      objects.find(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" && metadata.name.endsWith(`-api-${provider}-login-egress`),
      ).spec.egress,
      [
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
      `${label}: ${provider}`,
    );
  }
  assert.ok(
    !deploymentEnv(objects, "worker").some(({ name }) =>
      /^OCC_AUTH_(GITHUB_|GOOGLE_|OIDC_|TRUSTED_PROXY_|CLIENT_IP_HEADER)/.test(name),
    ),
    label,
  );
  return resolveSecrets(rendered);
}

// Each accepted case renders as `settings`, parses as `parsed` and starts the API.
function acceptsEach(cases) {
  return settle(
    cases.map(async ({ label, values, settings, parsed, egress }) => {
      const environment = await renders(label, values, settings, egress);
      assert.deepEqual(humanLoginConfiguration(environment), parsed, label);
      await startsUp(environment, label);
    }),
  );
}

const githubOn = { "auth.github.enabled": "true", "auth.recoveryUserId": recoveryUserId };
const googleOn = { "auth.google.enabled": "true", "auth.recoveryUserId": recoveryUserId };

// Treat mapped spellings as IPv4 before interpreting their prefix. The /1 examples
// deliberately use the upper IPv4 half, so none can legitimately trust 8.8.8.8.
const trustedProxyCidrs = {
  accepted: [
    ["10.0.0.0/8", "10.1.2.3"],
    ["8.0.0.0/8", "8.8.8.8"],
    ["::1/128", "::1"],
    ["fd00:10::/64", "fd00:10::1"],
    ["2600:1f18::/40", "2600:1f18::1"],
    ["fe80::/10", "fe80::1"],
    ["::/81", "::1"],
    ["::/96", "::192.0.2.1"],
    ["::fffe:0:0/96", "::fffe:c000:201"],
    ["64:ff9b::/96", "64:ff9b::c000:201"],
    ["2002::/16", "2002:c000:201::1"],
    ["::ffff:192.0.2.1/1", "192.0.2.1"],
    ["::ffff:c000:201/1", "192.0.2.1"],
    ["::ffff:192.0.2.1/32", "192.0.2.1"],
    ["::FFFF:c000:201/32", "192.0.2.1"],
    ["0:0:0:0:0:ffff:192.0.2.1/32", "192.0.2.1"],
    ["0::ffff:1.2.3.4/32", "1.2.3.4"],
    ["::0:ffff:1.2.3.4/32", "1.2.3.4"],
    ["0000:0000:0000:0000:0000:FFFF:C000:0201/32", "192.0.2.1"],
  ],
  catchAll: ["::/1", "::/8", "::/80", "::8000:0:0/81", "::fffe:0:0/95"],
  invalidMappedPrefix: [
    "::ffff:0:0/96",
    "::FFFF:c000:201/33",
    "0:0:0:0:0:ffff:192.0.2.1/96",
    "0::ffff:1.2.3.4/128",
    "::0:ffff:1.2.3.4/33",
    "::ffff:192.0.2.1/33",
    "::FFFF:C000:0201/128",
  ],
};

// A GitHub allowlist entry the chart and the API both refuse, with or without GitHub sign-in.
const githubLists = {
  allowedOrgs: {
    variable: "OCC_AUTH_GITHUB_ALLOWED_ORGS",
    chart: /auth\.github\.allowedOrgs requires GitHub organization logins/,
    parser:
      /OCC_AUTH_GITHUB_ALLOWED_ORGS must be a comma-separated list of GitHub organization logins/,
  },
  allowedTeams: {
    variable: "OCC_AUTH_GITHUB_ALLOWED_TEAMS",
    chart: /auth\.github\.allowedTeams requires org\/team-slug entries/,
    parser:
      /OCC_AUTH_GITHUB_ALLOWED_TEAMS must be a comma-separated list of org\/team-slug entries/,
  },
};
function githubListEntry(name, list, value, { signIn = false } = {}) {
  const { variable, chart, parser } = githubLists[list];
  const values = { [`auth.github.${list}[0]`]: value };
  return {
    name,
    values: signIn ? { ...githubUpgradeValues(recoveryUserId), ...values } : values,
    chart,
    ...(signIn ? { base: "github" } : {}),
    env: { [variable]: value },
    parser,
  };
}

// The parsers accept both; composition refuses the combination before any database work.
const withNativeAdmin = (provider, values) => ({
  name: `${provider} with shared-cookie native administration`,
  values,
  chart: new RegExp(`auth\\.${provider.toLowerCase()} requires agentNativeAdmin\\.enabled: false`),
  base: provider.toLowerCase(),
  code: "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
  env: {
    OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
    OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
  },
});

// Values the chart refuses, the API env they stand for on top of `base`'s settings, and the
// parser's refusal; each stops the API with `code`, or STARTUP_FAILED.
const invalid = [
  {
    name: "generic preset without a header",
    ...trustedProxy("generic", ["10.42.0.0/16"]),
    chart: /generic requires api\.trustedProxy\.clientAddressHeader/,
    parser: /generic trusted proxy preset requires OCC_AUTH_CLIENT_IP_HEADER/,
  },
  {
    name: "preset without proxy CIDRs",
    ...trustedProxy("aws"),
    chart: /preset aws requires api\.trustedProxy\.cidrs/,
    parser: /require OCC_AUTH_TRUSTED_PROXY_CIDRS/,
  },
  {
    name: "unknown preset",
    ...trustedProxy("cloudflare", ["10.0.0.0/8"]),
    chart: /must be empty, ingress-nginx, aws, or generic/,
    parser: /must be one of ingress-nginx, aws, generic/,
  },
  {
    name: "a proxy CIDR that trusts every address",
    ...trustedProxy("ingress-nginx", ["0.0.0.0/0"]),
    chart: /nonzero prefix/,
    parser: /must not trust every address/,
  },
  // IPv6 prefixes covering the mapped range would otherwise let every IPv4
  // socket peer supply the header used for sign-in rate limiting.
  ...trustedProxyCidrs.catchAll.map((cidr) => ({
    name: `a trusted-proxy IPv6 CIDR covering every IPv4 address: ${cidr}`,
    ...trustedProxy("ingress-nginx", [cidr]),
    chart: /must not trust every address/,
    parser: /must not trust every address/,
  })),
  ...trustedProxyCidrs.invalidMappedPrefix.map((cidr) => ({
    name: `a trusted-proxy mapped IPv4 address with an IPv6 prefix: ${cidr}`,
    ...trustedProxy("ingress-nginx", [cidr]),
    chart: /prefix must be 1 through 32/,
    parser: /IPv4-mapped address, whose prefix must be 1 through 32/,
  })),
  {
    name: "an invalid proxy address",
    ...trustedProxy("aws", ["300.1.1.0/24"]),
    chart: /invalid IPv4 address/,
    parser: /invalid CIDR/,
  },
  {
    name: "a credential header as the client address",
    ...trustedProxy("generic", ["10.42.0.0/16"], "Cookie"),
    chart: /clientAddressHeader cannot be cookie/,
    parser: /must not be cookie/,
  },
  {
    name: "a named preset with another header",
    ...trustedProxy("aws", ["10.0.0.0/16"], "x-real-ip"),
    chart: /preset aws reads x-forwarded-for/,
    parser: /aws trusted proxy preset reads x-forwarded-for/,
  },
  {
    name: "GitHub without a recovery user",
    values: { "auth.github.enabled": "true", "agentNativeAdmin.enabled": "false" },
    chart: /auth\.github\.enabled requires auth\.recoveryUserId/,
    base: "github",
    env: { OCC_AUTH_GITHUB_RECOVERY_USER_ID: undefined },
    parser: /requires client ID, client secret and recovery user ID/,
  },
  {
    name: "a recovery user without GitHub, Google or OIDC",
    values: { "auth.recoveryUserId": recoveryUserId },
    chart:
      /auth\.recoveryUserId requires auth\.github\.enabled, auth\.google\.enabled or auth\.oidc\.enabled/,
    env: { OCC_AUTH_GITHUB_RECOVERY_USER_ID: recoveryUserId },
    parser: /requires client ID, client secret and recovery user ID/,
  },
  withNativeAdmin("GitHub", githubOn),
  {
    name: "recovery-only password sign-in without an external provider",
    values: { "auth.passwordSignIn": "recovery-only" },
    chart:
      /auth\.passwordSignIn: recovery-only requires auth\.github\.enabled, auth\.google\.enabled or auth\.oidc\.enabled/,
    env: { OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" },
    parser: /OCC_AUTH_PASSWORD_SIGN_IN=recovery-only requires GitHub, Google or OIDC sign-in/,
  },
  {
    name: "an unknown password sign-in policy",
    values: { ...githubUpgradeValues(recoveryUserId), "auth.passwordSignIn": "none" },
    chart: /auth\.passwordSignIn must be all or recovery-only/,
    base: "github",
    env: { OCC_AUTH_PASSWORD_SIGN_IN: "none" },
    parser: /OCC_AUTH_PASSWORD_SIGN_IN must be all or recovery-only/,
  },
  ...[
    ["an organization login padded by U+0085", "allowedOrgs", "\u0085acme"],
    // Go's lower maps U+0130 to i; JavaScript's toLowerCase maps it to i and U+0307.
    ["an organization login spelled with U+0130", "allowedOrgs", "\u0130bm"],
    ["a team slug spelled with U+0130", "allowedTeams", "acme/\u0130nfra"],
    ["an allowed organization that is not a login", "allowedOrgs", "acme/platform"],
    ["a team slug padded by U+0085", "allowedTeams", "\u0085acme/platform"],
    ["an allowed team without its organization", "allowedTeams", "platform"],
  ].map(([name, list, value]) =>
    githubListEntry(`GitHub with ${name}`, list, value, { signIn: true }),
  ),
  {
    name: "GitHub with more than ten allowlist entries",
    values: {
      ...githubUpgradeValues(recoveryUserId),
      ...Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [
          `auth.github.allowedOrgs[${index}]`,
          `org${index}`,
        ]),
      ),
    },
    chart:
      /auth\.github\.allowedOrgs and auth\.github\.allowedTeams list at most 10 entries together/,
    base: "github",
    env: {
      OCC_AUTH_GITHUB_ALLOWED_ORGS: Array.from({ length: 11 }, (_, index) => `org${index}`).join(
        ",",
      ),
    },
    parser: /list at most 10 entries together/,
  },
  // An allowlist without its provider is refused, never dropped: an operator who sets one
  // expects it to limit sign-in. Entries are checked first, as the API does.
  ...[
    ["organization", "auth.github.allowedOrgs[0]", "OCC_AUTH_GITHUB_ALLOWED_ORGS", "acme"],
    ["team", "auth.github.allowedTeams[0]", "OCC_AUTH_GITHUB_ALLOWED_TEAMS", "acme/platform"],
  ].map(([kind, key, variable, value]) => ({
    name: `an allowed GitHub ${kind} without GitHub sign-in`,
    values: { [key]: value },
    chart:
      /auth\.github\.allowedOrgs and auth\.github\.allowedTeams require auth\.github\.enabled: true/,
    env: { [variable]: value },
    parser: /requires client ID, client secret and recovery user ID/,
  })),
  githubListEntry(
    "an allowed GitHub organization that is not a login, without GitHub sign-in",
    "allowedOrgs",
    "acme/platform",
  ),
  githubListEntry(
    "an allowed GitHub team without its organization, without GitHub sign-in",
    "allowedTeams",
    "platform",
  ),
  {
    name: "an allowed Google domain without Google sign-in",
    values: { "auth.google.allowedDomains[0]": "example.com" },
    chart: /auth\.google\.allowedDomains requires auth\.google\.enabled: true/,
    env: { OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com" },
    parser: /Google sign-in requires both client ID and client secret/,
  },
  {
    name: "Google without a recovery user",
    values: { "auth.google.enabled": "true", "agentNativeAdmin.enabled": "false" },
    chart: /auth\.google\.enabled requires auth\.recoveryUserId/,
    base: "google",
    env: { OCC_AUTH_GITHUB_RECOVERY_USER_ID: undefined },
    parser: /Google sign-in requires client ID, client secret and recovery user ID/,
  },
  withNativeAdmin("Google", googleOn),
  ...[
    ["padded by U+0085", "\u0085example.com"],
    ["spelled with U+0130", "\u0130bm.com"],
    ["that is not a DNS name", "example.com/admin"],
  ].map(([name, domain]) => ({
    name: `Google with a hosted domain ${name}`,
    values: { ...googleUpgradeValues(recoveryUserId), "auth.google.allowedDomains[0]": domain },
    chart: /auth\.google\.allowedDomains requires DNS domain names/,
    base: "google",
    env: { OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: domain },
    parser: /OCC_AUTH_GOOGLE_ALLOWED_DOMAINS must be a comma-separated list of DNS domain names/,
  })),
  {
    name: "OIDC without a recovery user",
    values: { ...oidcUpgradeValues(""), "auth.recoveryUserId": "" },
    chart: /auth\.oidc\.enabled requires auth\.recoveryUserId/,
    base: "oidc",
    env: { OCC_AUTH_GITHUB_RECOVERY_USER_ID: undefined },
    parser: /OIDC sign-in requires its provider settings and a recovery user ID/,
  },
  {
    name: "OIDC without a token URL",
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.tokenUrl": "" },
    chart: /auth\.oidc\.tokenUrl must be an https URL on port 443 on the issuer's host/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_TOKEN_URL: "" },
    parser: /OIDC sign-in requires issuer, authorization URL, token URL/,
  },
  ...[
    ["an HTTP issuer", "http://tenant.idp.example.test/"],
    ["an issuer on another port", "https://tenant.idp.example.test:8443/"],
    // The URL parser drops `:443`, but `iss` is compared with the configured string.
    ["an issuer with an explicit port 443", "https://tenant.idp.example.test:443/"],
    ["an IP-address issuer", "https://203.0.113.10/"],
    ["an issuer with a query", "https://tenant.idp.example.test/?t=1"],
    // JavaScript's trim keeps U+0085, though Go's TrimSpace strips it.
    ["an issuer padded with U+0085", "\u0085https://tenant.idp.example.test/"],
  ].map(([name, value]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.issuer": value },
    chart: /auth\.oidc\.issuer must be an https URL on port 443 with a DNS host name/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_ISSUER: value },
    parser: /OCC_AUTH_OIDC_ISSUER must be an https URL/,
  })),
  ...[
    ["an off-host token URL", "tokenUrl", "TOKEN_URL", "https://evil.example.test/token"],
    ["userinfo in the JWKS URL", "jwksUrl", "JWKS_URL", "https://u@tenant.idp.example.test/jwks"],
    [
      "a fragment in the authorization URL",
      "authorizationUrl",
      "AUTHORIZATION_URL",
      "https://tenant.idp.example.test/authorize#x",
    ],
    ["an HTTP JWKS URL", "jwksUrl", "JWKS_URL", "http://tenant.idp.example.test/jwks"],
  ].map(([name, key, suffix, value]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), [`auth.oidc.${key}`]: value },
    chart: new RegExp(`auth\\.oidc\\.${key} must be an https URL on port 443 on the issuer's host`),
    base: "oidc",
    env: { [`OCC_AUTH_OIDC_${suffix}`]: value },
    parser: new RegExp(
      `OCC_AUTH_OIDC_${suffix} must be an https URL on port 443 on the issuer's host`,
    ),
  })),
  {
    name: "OIDC with an unknown token method",
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.tokenAuth": "private_key_jwt" },
    chart: /auth\.oidc\.tokenAuth must be client_secret_post or client_secret_basic/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_TOKEN_AUTH: "private_key_jwt" },
    parser: /OCC_AUTH_OIDC_TOKEN_AUTH must be client_secret_post or client_secret_basic/,
  },
  ...[
    ["a display name padded by U+0085", "\u0085Continue"],
    ["an overlong label", "x".repeat(41)],
  ].map(([name, displayName]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.displayName": displayName },
    chart: /auth\.oidc\.displayName must be 1 to 40 printable characters/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_DISPLAY_NAME: displayName },
    parser: /OCC_AUTH_OIDC_DISPLAY_NAME must be 1 to 40 printable characters/,
  })),
  withNativeAdmin("OIDC", {
    ...oidcUpgradeValues(recoveryUserId),
    "agentNativeAdmin.enabled": "true",
  }),
];
const baseSettings = {
  github: githubUpgradeSettings(recoveryUserId),
  google: googleUpgradeSettings(recoveryUserId),
  oidc: oidcUpgradeSettings(recoveryUserId),
};

// A pattern list the chart's _helpers.tpl defines, such as $baseUrlHostRefused, as a JavaScript
// regular expression.
let helpersSource;
async function helperPattern(name) {
  helpersSource ??= readFile(
    join(repository, "deploy/helm/openclaw-enterprise/templates/_helpers.tpl"),
    "utf8",
  );
  const helpers = await helpersSource;
  const [, source] = helpers.match(new RegExp(`\\$${name} := "(\\[[^"]+\\])"`)) ?? [];
  assert.ok(source, `_helpers.tpl defines $${name}`);
  return new RegExp(source.replaceAll("\\\\x{", "\\u{"), "u");
}
const codePointName = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

// Base URL cases: `chart` is the refusal (or undefined when it renders), `api` and `job` whether
// the API and the bootstrap Job accept the URL.
const urls = (list, chart, { api, job = api }) =>
  list.map((baseUrl) => ({ baseUrl, chart, api, job }));

// Secret placement and egress are chart concerns: the API only ever sees the resolved
// credentials, so these refusals have no parser counterpart.
const chartOnly = (provider, cases) =>
  settle(
    cases.map(async ([name, values, chart]) => {
      assert.match(await refusal(values), chart, `${provider}: ${name}`);
    }),
  );
const emptyEgress = (provider) =>
  new RegExp(
    `auth\\.${provider}\\.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set \\[\\] in a values file or with --set-json,`,
  );

describe("sign-in chart parity", { concurrency: true }, () => {
  after(() => rm(directory, { recursive: true, force: true }));

  test(
    "the API accepts exactly the sign-in settings the chart renders for every proxy preset, with and without GitHub",
    tooling,
    async () => {
      const cases = Object.entries(presets).flatMap(([preset, proxy]) =>
        [false, true].map((githubEnabled) => ({ preset, proxy, githubEnabled })),
      );
      await settle(
        cases.map(async ({ preset, proxy, githubEnabled }) => {
          const label = `${preset}, GitHub ${githubEnabled ? "on" : "off"}`;
          // Reuse these renders to cover the example install's egress and Secret
          // placement: only the API receives sign-in and trusted-proxy settings.
          const environment = await renders(
            label,
            { ...proxy.values, ...(githubEnabled ? githubUpgradeValues(recoveryUserId) : {}) },
            {
              ...(githubEnabled ? githubUpgradeSettings(recoveryUserId) : defaultInstallSettings),
              ...proxy.env,
            },
            githubEnabled ? ["github"] : [],
          );
          assert.deepEqual(
            githubLoginConfiguration(environment),
            githubEnabled ? githubParsed : undefined,
            label,
          );
          const clientAddress = clientAddressConfiguration(environment);
          if (proxy.parsed === undefined) {
            assert.equal(clientAddress, undefined, label);
          } else {
            assert.equal(clientAddress.preset, preset, label);
            assert.equal(clientAddress.header, proxy.parsed.header, label);
            // The header the chart names is the one read, and only from a listed proxy.
            assert.equal(
              resolveClientAddress(clientAddress, proxy.parsed.proxy, "203.0.113.7"),
              "203.0.113.7",
              label,
            );
            assert.equal(
              resolveClientAddress(clientAddress, "198.51.100.3", "203.0.113.7"),
              "198.51.100.3",
              label,
            );
          }
          await startsUp(environment, label);
        }),
      );
    },
  );

  test("the API accepts exactly the GitHub allowlist the chart renders", tooling, async () => {
    const environment = await renders(
      "GitHub allowlist",
      {
        ...githubUpgradeValues(recoveryUserId),
        "auth.github.allowedOrgs[0]": "Acme",
        "auth.github.allowedOrgs[1]": "acme-labs",
        "auth.github.allowedTeams[0]": "other/platform_team",
      },
      {
        ...githubUpgradeSettings(recoveryUserId),
        OCC_AUTH_GITHUB_ALLOWED_ORGS: "Acme,acme-labs",
        OCC_AUTH_GITHUB_ALLOWED_TEAMS: "other/platform_team",
      },
      ["github"],
    );
    assert.deepEqual(githubLoginConfiguration(environment), {
      ...githubParsed,
      allowedOrgs: ["acme", "acme-labs"],
      allowedTeams: ["other/platform_team"],
    });
  });

  test(
    "the API accepts sign-in values padded by U+FEFF, which Go trim keeps",
    tooling,
    async () => {
      // Go's TrimSpace keeps U+FEFF, so the chart used to refuse these. JavaScript's trim drops
      // it, and the chart now uses that trim. The rendered env keeps the character.
      const org = "\uFEFFacme";
      const team = "\uFEFFacme/platform";
      const domain = "\uFEFFexample.com";
      const displayName = "\uFEFFContinue";
      const objects = await render({
        ...githubUpgradeValues(recoveryUserId),
        ...googleUpgradeValues(recoveryUserId),
        ...oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, { displayName }),
        "auth.github.allowedOrgs[0]": org,
        "auth.github.allowedTeams[0]": team,
        "auth.google.allowedDomains[0]": domain,
      });
      const rendered = signInSettings(deploymentEnv(objects, "api"));
      assert.equal(rendered.OCC_AUTH_GITHUB_ALLOWED_ORGS, org);
      assert.equal(rendered.OCC_AUTH_GITHUB_ALLOWED_TEAMS, team);
      assert.equal(rendered.OCC_AUTH_GOOGLE_ALLOWED_DOMAINS, domain);
      assert.equal(rendered.OCC_AUTH_OIDC_DISPLAY_NAME, displayName);
      const parsed = humanLoginConfiguration(resolveSecrets(rendered));
      assert.deepEqual(parsed.github.allowedOrgs, ["acme"]);
      assert.deepEqual(parsed.github.allowedTeams, ["acme/platform"]);
      assert.deepEqual(parsed.google.allowedDomains, ["example.com"]);
      assert.equal(parsed.oidc.displayName, "Continue");
      await startsUp(resolveSecrets(rendered));
    },
  );

  // The API trims the OIDC display name and uses its default label when nothing is left, so the
  // chart renders a blank one instead of refusing it.
  test(
    "a blank OIDC display name renders and the API uses its default label",
    tooling,
    async () => {
      const displayName = "\u3000\u00a0";
      const objects = await render(
        oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, { displayName }),
      );
      const rendered = signInSettings(deploymentEnv(objects, "api"));
      assert.equal(rendered.OCC_AUTH_OIDC_DISPLAY_NAME, displayName);
      assert.equal(
        humanLoginConfiguration(resolveSecrets(rendered)).oidc.displayName,
        "single sign-on",
      );
      await startsUp(resolveSecrets(rendered));
    },
  );

  test(
    "the API accepts exactly the Google sign-in settings the chart renders, alone and with GitHub",
    tooling,
    async () => {
      const domains = ["example.com", "corp.example.org"];
      const both = {
        ...githubUpgradeValues(recoveryUserId),
        ...googleUpgradeValues(recoveryUserId),
      };
      const bothSettings = {
        ...githubUpgradeSettings(recoveryUserId),
        ...googleUpgradeSettings(recoveryUserId),
      };
      await acceptsEach([
        {
          label: "Google only",
          values: googleUpgradeValues(recoveryUserId),
          settings: googleUpgradeSettings(recoveryUserId),
          parsed: { google: googleParsed },
          egress: ["google"],
        },
        {
          label: "Google only, hosted domains",
          values: googleUpgradeValues(recoveryUserId, domains),
          settings: googleUpgradeSettings(recoveryUserId, domains),
          parsed: { google: { ...googleParsed, allowedDomains: domains } },
          egress: ["google"],
        },
        {
          label: "GitHub and Google",
          values: both,
          settings: bothSettings,
          parsed: { github: githubParsed, google: googleParsed },
          egress: ["github", "google"],
        },
        {
          label: "GitHub and Google, recovery-only password sign-in",
          values: { ...both, "auth.passwordSignIn": "recovery-only" },
          settings: { ...bothSettings, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" },
          parsed: { github: githubParsed, google: googleParsed, passwordSignIn: "recovery-only" },
          egress: ["github", "google"],
        },
        {
          // The default is not rendered: the API reads an absent setting as "all".
          label: "Google, password sign-in for every account",
          values: { ...googleUpgradeValues(recoveryUserId), "auth.passwordSignIn": "all" },
          settings: googleUpgradeSettings(recoveryUserId),
          parsed: { google: googleParsed },
          egress: ["google"],
        },
      ]);
    },
  );

  test(
    "the API accepts exactly the OIDC sign-in settings the chart renders, alone and with GitHub and Google",
    tooling,
    async () => {
      const oidc = {
        ...fixtureOidcIssuer,
        clientId: secrets["occ-oidc-login/client-id"],
        clientSecret: secrets["occ-oidc-login/client-secret"],
        tokenAuth: "client_secret_post",
        displayName: "single sign-on",
        recoveryUserId,
      };
      const keycloak = {
        issuer: "https://sso.example.com/realms/acme",
        authorizationUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/auth",
        tokenUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/token",
        jwksUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/certs",
      };
      const extra = { tokenAuth: "client_secret_basic", displayName: "Acme SSO" };
      // The API trims each URL with JavaScript's trim (ASCII whitespace, Unicode spaces, U+2028,
      // U+2029 and U+FEFF) before its checks, and so does the chart. The env keeps the value as
      // written, and the API reads the trimmed one.
      const padded = {
        issuer: ` \u000b${fixtureOidcIssuer.issuer}\f `,
        authorizationUrl: `\t${fixtureOidcIssuer.authorizationUrl}\u00a0`,
        tokenUrl: `\u3000${fixtureOidcIssuer.tokenUrl}\uFEFF`,
        jwksUrl: `\u2028${fixtureOidcIssuer.jwksUrl}\u2003 `,
      };
      // An issuer without a path ends at its host, so trailing padding there must be trimmed too.
      const bare = {
        issuer: "https://sso.example.com",
        authorizationUrl: "https://sso.example.com/authorize",
        tokenUrl: "https://sso.example.com/token",
        jwksUrl: "https://sso.example.com/jwks",
      };
      const paddedBare = { ...bare, issuer: `${bare.issuer}\uFEFF\u2029` };
      const oidcOnly = (label, parsed, ...issuerAndExtra) => ({
        label,
        values: oidcUpgradeValues(recoveryUserId, ...issuerAndExtra),
        settings: oidcUpgradeSettings(recoveryUserId, ...issuerAndExtra),
        parsed: { oidc: parsed },
        egress: ["oidc"],
      });
      // A listed CIDR replaces the default, link-local included, for each provider.
      const narrowed = render({
        ...githubUpgradeValues(recoveryUserId),
        ...googleUpgradeValues(recoveryUserId),
        ...oidcUpgradeValues(recoveryUserId),
        "auth.github.egressCidrs[0]": "140.82.112.0/20",
        "auth.google.egressCidrs[0]": "169.254.10.0/24",
        "auth.oidc.egressCidrs[0]": "198.51.100.0/24",
      }).then((objects) => {
        for (const [provider, cidr] of [
          ["github", "140.82.112.0/20"],
          ["google", "169.254.10.0/24"],
          ["oidc", "198.51.100.0/24"],
        ]) {
          assert.deepEqual(
            objects.find(({ metadata }) => metadata.name.endsWith(`-api-${provider}-login-egress`))
              .spec.egress[0].to,
            [{ ipBlock: { cidr } }],
            provider,
          );
        }
      });
      await settle([
        narrowed,
        acceptsEach([
          oidcOnly("OIDC, URLs padded with whitespace the API trims", oidc, padded),
          oidcOnly(
            "OIDC, an issuer without a path, padded with whitespace the API trims",
            { ...oidc, ...bare },
            paddedBare,
          ),
          oidcOnly("OIDC only", oidc),
          oidcOnly(
            "OIDC only, basic token auth and a label",
            { ...oidc, ...keycloak, ...extra },
            keycloak,
            extra,
          ),
          {
            // The default token method is not rendered: the API reads its absence as post.
            ...oidcOnly("OIDC, explicit default token auth", oidc, fixtureOidcIssuer, {
              tokenAuth: "client_secret_post",
            }),
            settings: oidcUpgradeSettings(recoveryUserId),
          },
          {
            label: "GitHub, Google and OIDC, recovery-only password sign-in",
            values: {
              ...githubUpgradeValues(recoveryUserId),
              ...googleUpgradeValues(recoveryUserId),
              ...oidcUpgradeValues(recoveryUserId),
              "auth.passwordSignIn": "recovery-only",
            },
            settings: {
              ...githubUpgradeSettings(recoveryUserId),
              ...googleUpgradeSettings(recoveryUserId),
              ...oidcUpgradeSettings(recoveryUserId),
              OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
            },
            parsed: {
              github: githubParsed,
              google: googleParsed,
              oidc,
              passwordSignIn: "recovery-only",
            },
            egress: ["github", "google", "oidc"],
          },
        ]),
      ]);
    },
  );

  test(
    "trusted-proxy CIDR parity preserves mapped hosts and bounded IPv6 ranges",
    tooling,
    async () => {
      // One render validates every accepted entry; parse its emitted entries individually
      // so another trusted subnet cannot conceal an entry that trusts every IPv4 peer.
      const objects = await render(
        trustedProxy(
          "ingress-nginx",
          trustedProxyCidrs.accepted.map(([cidr]) => cidr),
        ).values,
      );
      const rendered = signInSettings(deploymentEnv(objects, "api"));
      const cidrs = rendered.OCC_AUTH_TRUSTED_PROXY_CIDRS.split(",");
      assert.deepEqual(
        cidrs,
        trustedProxyCidrs.accepted.map(([cidr]) => cidr),
      );
      for (const [index, cidr] of cidrs.entries()) {
        const config = clientAddressConfiguration({
          ...rendered,
          OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr,
        });
        assert.equal(config.trusts(trustedProxyCidrs.accepted[index][1]), true, cidr);
        assert.equal(config.trusts("8.8.8.8"), cidr === "8.0.0.0/8", cidr);
      }
    },
  );

  test("values the chart refuses are settings the API also refuses", tooling, async () => {
    await settle(
      invalid.map(async ({ name, values, chart, base, env, parser, code }) => {
        const environment = Object.fromEntries(
          Object.entries({
            ...resolveSecrets(baseSettings[base] ?? defaultInstallSettings),
            ...env,
          }).filter(([, value]) => value !== undefined),
        );
        if (parser !== undefined) {
          assert.throws(
            () => {
              humanLoginConfiguration(environment);
              clientAddressConfiguration(environment);
            },
            parser,
            name,
          );
        }
        const [refused, startup] = await settle([refusal(values), startupCode(environment)]);
        assert.match(refused, chart, name);
        assert.equal(startup, code ?? "STARTUP_FAILED", name);
      }),
    );
  });

  // The checks above run the API's and the bootstrap Job's startup in process. These start the
  // real entrypoints, as the API Pod and the Job run them, with settings each accepts and
  // refuses, and require the codes those in-process checks report for the same settings.
  test("the API and bootstrap entrypoints exit with the codes their in-process startup reports", async () => {
    const everyProvider = resolveSecrets({
      ...githubUpgradeSettings(recoveryUserId),
      ...googleUpgradeSettings(recoveryUserId),
      ...oidcUpgradeSettings(recoveryUserId),
      OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
    });
    const nativeAdmin = withNativeAdmin("GitHub", githubOn);
    const api = [
      // Past configuration, Driver loading and composition, to the database.
      [everyProvider, "PERSISTENCE_UNAVAILABLE"],
      // Refused by configuration, and by composition before any database work.
      [{ ...everyProvider, OCC_AUTH_BASE_URL: "https://192.168.010.001" }, "AUTH_BASE_URL_INVALID"],
      [
        { ...resolveSecrets(baseSettings[nativeAdmin.base]), ...nativeAdmin.env },
        "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
      ],
    ].map(async ([settings, code]) => {
      const label = `API ${code}`;
      assert.equal(await startupCode(settings), code, label);
      assert.equal(
        await entrypointCode(
          "apps/controller/src/server.mjs",
          "startup-error",
          apiEnvironment(settings),
        ),
        code,
        label,
      );
    });
    const job = [
      ["https://console.oce.example.internal", undefined, "PERSISTENCE_UNAVAILABLE"],
      ["http://console.oce.example.internal", "AUTH_BASE_URL_INVALID", "AUTH_BASE_URL_INVALID"],
    ].map(async ([baseUrl, refused, code]) => {
      assert.equal(jobRefusal(baseUrl), refused, baseUrl);
      assert.equal(
        await entrypointCode(
          "scripts/bootstrap-installation.mjs",
          "installation.bootstrap-failed",
          jobEnvironment(baseUrl),
        ),
        code,
        baseUrl,
      );
    });
    await settle([...api, ...job]);
  });

  // The chart is stricter than the API for one input: the API documents ingress-nginx as the
  // default preset when only CIDRs are set, while the chart requires an explicit preset.
  test(
    "proxy CIDRs without a preset are refused by the chart and default to ingress-nginx in the API",
    tooling,
    async () => {
      assert.match(
        await refusal({ "api.trustedProxy.cidrs[0]": "10.42.0.0/16" }),
        /cidrs and clientAddressHeader require api\.trustedProxy\.preset/,
      );
      const parsed = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16" });
      assert.equal(parsed.preset, "ingress-nginx");
      assert.equal(parsed.header, "x-forwarded-for");
    },
  );

  test(
    "the chart refuses Google Secret and egress settings the API cannot observe",
    tooling,
    async () => {
      const google = googleUpgradeValues(recoveryUserId);
      await chartOnly("google", [
        [
          "the GitHub sign-in Secret",
          { ...google, ...githubOn, "auth.google.secretName": "occ-github-login" },
          /auth\.google\.secretName must name a dedicated Secret/,
        ],
        [
          "the Better Auth Secret",
          { ...google, "auth.google.secretName": "occ-auth" },
          /auth\.google\.secretName must name a dedicated Secret/,
        ],
        [
          "one key for client ID and secret",
          { ...google, "auth.google.clientSecretKey": "client-id" },
          /auth\.google client ID and client secret must use different Secret keys/,
        ],
        [
          "a hostname egress",
          { ...google, "auth.google.egressCidrs[0]": "accounts.google.com" },
          /auth\.google\.egressCidrs requires explicit IPv4 CIDRs/,
        ],
        [
          "an invalid egress address",
          { ...google, "auth.google.egressCidrs[0]": "142.250.300.0/24" },
          /auth\.google\.egressCidrs contains an invalid IPv4 address/,
        ],
        [
          "a /0 egress entry",
          { ...google, "auth.google.egressCidrs[0]": "0.0.0.0/0" },
          /auth\.google\.egressCidrs requires explicit IPv4 CIDRs/,
        ],
        [
          "an empty-string egress list",
          { ...google, "auth.google.egressCidrs": "" },
          emptyEgress("google"),
        ],
        [
          "an empty-string domain allowlist",
          { ...google, "auth.google.allowedDomains": "" },
          /auth\.google\.allowedDomains must be a list of DNS domain names/,
        ],
        [
          "an HTTP base URL",
          { ...google, "auth.baseUrl": "http://oce.example.internal" },
          /auth\.google requires an HTTPS auth\.baseUrl/,
        ],
      ]);
    },
  );

  test(
    "the chart refuses OIDC Secret and egress settings the API cannot observe",
    tooling,
    async () => {
      const oidc = oidcUpgradeValues(recoveryUserId);
      await chartOnly("oidc", [
        [
          "the Google sign-in Secret",
          { ...oidc, ...googleOn, "auth.oidc.secretName": "occ-google-login" },
          /auth\.oidc\.secretName must name a dedicated Secret/,
        ],
        [
          "the GitHub sign-in Secret",
          { ...oidc, ...githubOn, "auth.oidc.secretName": "occ-github-login" },
          /auth\.oidc\.secretName must name a dedicated Secret/,
        ],
        [
          "the Better Auth Secret",
          { ...oidc, "auth.oidc.secretName": "occ-auth" },
          /auth\.oidc\.secretName must name a dedicated Secret/,
        ],
        [
          "one key for client ID and secret",
          { ...oidc, "auth.oidc.clientSecretKey": "client-id" },
          /auth\.oidc client ID and client secret must use different Secret keys/,
        ],
        [
          "a hostname egress",
          { ...oidc, "auth.oidc.egressCidrs[0]": "tenant.idp.example.test" },
          /auth\.oidc\.egressCidrs requires explicit IPv4 CIDRs/,
        ],
        [
          "a /0 egress entry",
          { ...oidc, "auth.oidc.egressCidrs[0]": "0.0.0.0/0" },
          /auth\.oidc\.egressCidrs requires explicit IPv4 CIDRs/,
        ],
        [
          "an empty-string egress list",
          { ...oidc, "auth.oidc.egressCidrs": "" },
          emptyEgress("oidc"),
        ],
        [
          "an HTTP base URL",
          { ...oidc, "auth.baseUrl": "http://oce.example.internal" },
          /auth\.oidc requires an HTTPS auth\.baseUrl/,
        ],
      ]);
    },
  );

  test(
    "install notes warn when sign-in is exposed without a trusted proxy, and never fail",
    tooling,
    async () => {
      const proxied = Object.values(presets).filter(
        ({ values }) => values["api.trustedProxy.preset"],
      );
      const [github, google, oidc, none, ...quiet] = await settle([
        notice(githubUpgradeValues(recoveryUserId)),
        notice(googleUpgradeValues(recoveryUserId)),
        notice(oidcUpgradeValues(recoveryUserId)),
        notice(),
        ...proxied.flatMap(({ values }) => [
          notice({ ...githubUpgradeValues(recoveryUserId), ...values }),
          notice(values),
        ]),
      ]);
      assert.match(github, /^WARNING: api\.trustedProxy is not set\./);
      assert.match(github, /external sign-in\nstarts have no per-client limit/);
      assert.match(google, /^WARNING: api\.trustedProxy is not set\./);
      assert.match(oidc, /^WARNING: api\.trustedProxy is not set\. With GitHub, Google or OIDC/);
      assert.match(oidc, /Behind an HTTP\nproxy, API calls fail with 403 until it is set\.$/);
      assert.match(
        none,
        /^NOTE: api\.trustedProxy is not set, so failed password sign-ins are limited per\nemail only/,
      );
      assert.match(none, /Behind an HTTP proxy, API calls fail with 403 until it\nis set\.$/);
      assert.equal(quiet.length, proxied.length * 2);
      for (const text of quiet) {
        assert.equal(text, "");
      }
    },
  );

  test("a null optional sign-in map renders like an absent one", tooling, async () => {
    // `auth.github: null` (or `--set auth.github=null`) deletes the map's defaults. The chart
    // must then render the password-only install without a trusted proxy, as validation and
    // the install notes already assume, instead of failing with a template nil pointer.
    await settle(
      ["auth.github", "auth.google", "auth.oidc", "api.trustedProxy"].map(async (key) => {
        const objects = await render({ [key]: "null" });
        assert.deepEqual(
          signInSettings(deploymentEnv(objects, "api")),
          defaultInstallSettings,
          key,
        );
        assert.equal(
          objects.filter(
            ({ kind, metadata }) =>
              kind === "NetworkPolicy" && /-login-egress$/.test(metadata.name),
          ).length,
          0,
          key,
        );
      }),
    );
  });

  test(
    "the chart tells the API whether a sign-in egress rule opens HTTPS to any address",
    tooling,
    async () => {
      // Production names a missing Slack proxy for an unanswered Slack check only when API
      // egress is closed; an open sign-in rule can reach Slack directly (finding 2533). The chart
      // reports open exactly when it renders a login egress rule to 0.0.0.0/0, from any provider.
      const github = githubUpgradeValues(recoveryUserId);
      const google = googleUpgradeValues(recoveryUserId);
      const oidc = oidcUpgradeValues(recoveryUserId);
      const narrowed = (provider) => ({ [`auth.${provider}.egressCidrs[0]`]: "203.0.113.0/24" });
      const flag = "OCC_API_HTTPS_EGRESS_OPEN";
      await settle(
        [
          ["password only", {}, "false"],
          ["null GitHub map", { "auth.github": "null" }, "false"],
          ["GitHub", github, "true"],
          ["GitHub narrowed", { ...github, ...narrowed("github") }, "false"],
          ["Google", google, "true"],
          ["Google narrowed", { ...google, ...narrowed("google") }, "false"],
          ["OIDC", oidc, "true"],
          ["OIDC narrowed", { ...oidc, ...narrowed("oidc") }, "false"],
          ["GitHub narrowed, Google open", { ...github, ...narrowed("github"), ...google }, "true"],
        ].map(async ([label, values, open]) => {
          const objects = await render(values);
          assert.deepEqual(
            deploymentEnv(objects, "api").filter(({ name }) => name === flag),
            [{ name: flag, value: open }],
            label,
          );
          const anyAddress = objects.some(
            ({ kind, metadata, spec }) =>
              kind === "NetworkPolicy" &&
              /-api-(github|google|oidc)-login-egress$/.test(metadata.name) &&
              spec.egress.some(({ to }) => to.some(({ ipBlock }) => ipBlock?.cidr === "0.0.0.0/0")),
          );
          assert.equal(String(anyAddress), open, label);
          assert.ok(!deploymentEnv(objects, "worker").some(({ name }) => name === flag), label);
        }),
      );
      // The API accepts the rendered value and refuses anything but true or false.
      const environment = await renders(
        "GitHub egress flag",
        github,
        githubUpgradeSettings(recoveryUserId),
        ["github"],
      );
      const [accepted, refused] = await settle([
        startupCode({ ...environment, [flag]: "true" }),
        startupCode({ ...environment, [flag]: "open" }),
      ]);
      assert.equal(accepted, "PERSISTENCE_UNAVAILABLE");
      assert.equal(refused, "STARTUP_FAILED");
    },
  );

  // With native admin, the API refuses at startup a console origin outside the shared cookie
  // parent, or one without HTTPS (createControllerAuth, before any database read). The chart
  // refuses the same values at render time, and still renders what the API accepts.
  test("the chart refuses native admin base URLs the API refuses at startup", tooling, async () => {
    const nativeAdmin = {
      "gatewayRouting.enabled": "true",
      "gatewayRouting.gatewayClassName": "private-envoy-gateway",
      "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
      "agentNativeAdmin.enabled": "true",
      "agentNativeAdmin.domain": "agents.oce.example.com",
      "agentNativeAdmin.sharedCookieDomain": "oce.example.com",
    };
    const apiRefusal = (baseUrl) => () =>
      createControllerAuth({
        mode: "production",
        secret: "s".repeat(32),
        baseURL: new URL(baseUrl).toString().replace(/\/$/, ""),
        sharedCookieDomain: "oce.example.com",
      });
    const outsideParent = [
      /agentNativeAdmin\.sharedCookieDomain must contain the auth\.baseUrl host/,
      /OCC_AUTH_COOKIE_DOMAIN must contain the OCC_AUTH_BASE_URL host/,
    ];
    const refused = [
      ["https://console.example.com", ...outsideParent],
      ["https://console-oce.example.com", ...outsideParent],
      [
        "http://console.oce.example.com",
        /agentNativeAdmin\.enabled requires an HTTPS auth\.baseUrl/,
        /OCC_AUTH_COOKIE_DOMAIN requires secure HTTPS session cookies/,
      ],
    ].map(async ([baseUrl, chart, api]) => {
      assert.throws(apiRefusal(baseUrl), api, baseUrl);
      assert.match(await refusal({ ...nativeAdmin, "auth.baseUrl": baseUrl }), chart, baseUrl);
    });
    const accepted = [
      "https://oce.example.com",
      "https://Console.OCE.example.com",
      "https://console.oce.example.com.",
      "https://console.oce.example.com:8443",
      " https://console.oce.example.com ",
    ].map(async (baseUrl) => {
      // The API's cookie checks pass; it stops later, at the Installation it was not given.
      assert.throws(apiRefusal(baseUrl), /Better Auth issuer requires an Installation/, baseUrl);
      const objects = await render({ ...nativeAdmin, "auth.baseUrl": baseUrl });
      assert.ok(
        deploymentEnv(objects, "api").some(
          ({ name, value }) => name === "OCC_AUTH_BASE_URL" && value === baseUrl,
        ),
        baseUrl,
      );
    });
    await settle([...refused, ...accepted]);
  });

  // The API refuses an auth base URL that is not an absolute HTTP(S) origin: startApi parses
  // OCC_AUTH_BASE_URL, and createControllerAuth (validHttpBaseURL, which the bootstrap Job also
  // runs before it) refuses the rest, both as AUTH_BASE_URL_INVALID. The bootstrap Job also
  // refuses plain HTTP unless the host is 127.0.0.1 or localhost. The chart refuses the same
  // values at render time and still renders every origin both accept. Native admin is off, so
  // only the origin checks apply.
  test(
    "the chart refuses auth base URLs the API or the bootstrap Job refuses",
    tooling,
    async () => {
      const values = { "agentNativeAdmin.enabled": "false" };
      const environment = resolveSecrets(
        signInSettings(deploymentEnv(await render(values), "api")),
      );
      // startApi's normalization, then createControllerAuth. Without an Installation, accepted
      // settings stop right after its base URL checks.
      const apiAccepts = (baseUrl) => {
        let parsed;
        try {
          parsed = new URL(baseUrl);
        } catch {
          return false;
        }
        try {
          refuseWrittenUserinfo("OCC_AUTH_BASE_URL", baseUrl);
        } catch (error) {
          assert.match(error.message, /^OCC_AUTH_BASE_URL must not contain user info/);
          return false;
        }
        try {
          refuseRewrittenIpv4Host("OCC_AUTH_BASE_URL", baseUrl, parsed);
        } catch (error) {
          assert.match(
            error.message,
            /^OCC_AUTH_BASE_URL IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
          );
          return false;
        }
        const normalized = parsed.toString().replace(/\/$/, "");
        try {
          createControllerAuth({ mode: "production", secret: "s".repeat(32), baseURL: normalized });
        } catch (error) {
          if (/Better Auth issuer requires an Installation/.test(error.message)) {
            return true;
          }
          assert.match(error.message, /^OCC_AUTH_BASE_URL must be an absolute HTTP origin URL\.$/);
          return false;
        }
        assert.fail(`createControllerAuth accepted ${baseUrl} without an Installation`);
      };
      const notOrigin = /auth\.baseUrl must be an absolute HTTP\(S\) origin/;
      const plainHttp = /auth\.baseUrl must use HTTPS unless its host is 127\.0\.0\.1 or localhost/;
      const unicodeEdge =
        /auth\.baseUrl must not begin or end with Unicode spaces or invisible characters/;
      const unicodeInside = /auth\.baseUrl must not contain spaces, invisible characters, < or >/;
      const compatibility = /auth\.baseUrl must not contain compatibility characters/;
      const cases = [
        ...urls(
          [
            "https://console.oce.example.internal/occ",
            "https://console.oce.example.internal/occ/",
            "https://console.oce.example.internal?next=1",
            "https://console.oce.example.internal/?next=1",
            "https://console.oce.example.internal#console",
            // An empty query or fragment parses as none, but survives serialization
            // (https://host/?), which would move Better Auth's routes under /?/auth.
            "https://console.oce.example.internal?",
            "https://console.oce.example.internal/?",
            "https://console.oce.example.internal#",
            "https://console.oce.example.internal/#",
            " https://console.oce.example.internal? ",
            "https://admin@console.oce.example.internal",
            "https://admin:secret@console.oce.example.internal",
            "https://:secret@console.oce.example.internal",
            // Node drops an empty user info and publishes the host alone; Go keeps it.
            "https://@console.oce.example.internal",
            "https://:@console.oce.example.internal",
            "https:@console.oce.example.internal",
            "console.oce.example.internal",
            "//console.oce.example.internal",
            "ftp://console.oce.example.internal",
            "https://console.oce.example.internal:65536",
            // Go keeps everything before the last colon in the host name and accepts an IPv6 zone
            // ID; Node refuses both.
            "https://console.oce.example.internal:80:1",
            "https://192.0.2.10:80:1",
            "https://[fe80::1%25eth0]",
            "https://",
            "http://localhost/occ",
          ],
          notOrigin,
          { api: false },
        ),
        ...urls(
          [
            "https://console.oce.example.internal",
            "https://console.oce.example.internal/",
            "https://console.oce.example.internal:8443",
            "https://console.oce.example.internal:0443/",
            "https://console.oce.example.internal:65535",
            "HTTPS://Console.OCE.example.internal",
            "https://console.oce.example.internal.",
            " https://console.oce.example.internal ",
            "https://192.0.2.10",
            // A bare 0x, a full-width digit, or an ideographic dot inside a DNS name is not an
            // IPv4 host. Node keeps the name (mapping the borrowed characters) and the chart
            // must render it.
            "https://0x.example.com",
            "https://console\u3002example.com",
            "https://\uFF11\uFF12\uFF17.example.com",
            "https://192.168.10.1",
            "https://10.0.0.1",
            "https://[2001:db8::10]:8443",
            "https://localhost",
            "http://127.0.0.1",
            "http://127.0.0.1:8080/",
            "http://localhost:8080",
            "HTTP://LocalHost:8080",
            " http://localhost ",
            "https://bücher.oce.example.internal",
            "https://console.例え.テスト",
            // Only the last label decides whether a host is IPv4, after the parser maps
            // compatibility characters (⑩ becomes 10, so this label is 10x).
            "https://192.0.2.10.example.com",
            "https://example.\u2469x",
            // Helm reads http://[::1] as hostname ::1, which the bootstrap Job admits.
            "http://[::1]:8080",
          ],
          undefined,
          { api: true },
        ),
        // URL parsing strips only C0 controls and spaces from the ends, so other Unicode spaces
        // and invisible characters there reach the parser, which refuses them in the scheme or
        // a host. The chart refuses them all; it is deliberately stricter for U+FEFF and U+200B
        // at the end, which the host parser drops. A trailing unassigned code point (U+0378),
        // which RE2's \p{C} does not cover, is refused too.
        ...urls(["https://console.oce.example.internal\u0378"], unicodeEdge, { api: false }),
        ...[
          ["\u00a0", false],
          ["\u2003", false],
          ["\u3000", false],
          ["\uFEFF", true],
          ["\u200b", true],
        ].flatMap(([space, trailingAccepted]) => [
          ...urls([`${space}https://console.oce.example.internal`], unicodeEdge, { api: false }),
          ...urls([`https://console.oce.example.internal${space}`], unicodeEdge, {
            api: trailingAccepted,
          }),
          ...urls([` ${space}https://console.oce.example.internal${space} `], unicodeEdge, {
            api: false,
          }),
        ]),
        // Inside the host, the parser refuses spaces, < and >, and drops tabs and most invisible
        // characters. The chart refuses them all (deliberately stricter for the dropped ones),
        // but keeps the joiners U+200C and U+200D that some IDN labels need.
        ...[
          [" ", false],
          ["\u00a0", false],
          ["\u2003", false],
          ["\u3000", false],
          ["\u2028", false],
          // Go's URL parser keeps these, but the API's refuses them.
          ["<", false],
          [">", false],
          ["\t", true],
          ["\uFEFF", true],
          ["\u200b", true],
          ["\u00ad", true],
        ].flatMap(([space, accepted]) =>
          urls([`https://console${space}.oce.example.internal`], unicodeInside, { api: accepted }),
        ),
        // Both parsers percent-decode the host, so the chart checks the decoded name too.
        ...urls(
          ["%C2%A0", "%E3%80%80"].map((space) => `https://console${space}.oce.example.internal`),
          unicodeInside,
          { api: false },
        ),
        // The host parser maps compatibility characters first and refuses those that map to a
        // forbidden host code point (full-width ? # / @, ?? from U+2047) or that UTS #46
        // disallows (U+2488 maps to "1.", U+FFFD). Go's URL parser keeps them. A sample here;
        // the next test checks the chart's whole list against Node.
        ...urls(
          [
            "https://console%EF%BC%9F.oce.example.internal",
            ...["\uff1f", "\uff03", "\uff0f", "\uff20", "\ufe56", "\u2047", "\u2488", "\ufffd"].map(
              (character) => `https://console${character}.oce.example.internal`,
            ),
          ],
          compatibility,
          { api: false },
        ),
        ...urls(
          [
            "https://\u0646\u0627\u0645\u0647\u200c\u0627\u06cc.oce.example.internal",
            "https://\u0915\u094d\u200d\u0937.oce.example.internal",
          ],
          undefined,
          { api: true },
        ),
        // The API serves plain HTTP anywhere, but the bootstrap Job refuses it off loopback.
        ...urls(
          [
            "http://console.oce.example.internal",
            "HTTP://console.oce.example.internal",
            "http://192.0.2.10:8080",
            "http://127.0.0.2",
            "http://localhost.",
            "http://localhost.oce.example.internal",
          ],
          plainHttp,
          { api: true, job: false },
        ),
        // Node repairs these degenerate spellings into an origin. They are not IPv4 hosts.
        ...urls(
          [
            "https:console.oce.example.internal",
            "https://console.oce.example.internal/.",
            "https://console.oce.example.internal/%2e",
          ],
          notOrigin,
          { api: true },
        ),
        // A leading zero is octal (192.168.010.001 publishes 192.168.8.1). Hex, including a
        // bare 0x (which is 0), shorthand, a single integer and a trailing dot also publish
        // a different host. The parser first maps compatibility digits, letters and dots
        // (１２７.0.0.1, ①②⑦.0.0.1, 𝟏𝟐𝟕.0.0.1 and 127。0。0。1 publish 127.0.0.1; ０ｘ７ｆ is
        // 0x7f) and drops variation selectors. A host whose last label is then a number but
        // that is not IPv4 (example.123, foo.1.) does not parse at all. The chart, the API
        // and the bootstrap Job all refuse those spellings.
        ...urls(
          [
            "https://192.168.010.001",
            "https://192.168.001.010",
            "https://010.0.0.1",
            "https://127.1",
            "https://0x7f.0.0.1",
            "https://0x",
            "https://0x.0.0.1",
            "https://2130706433",
            "http://127.1",
            "http://2130706433",
            "http://0177.0.0.1",
            "http://127.0.0.1.",
            "https://\uFF11\uFF12\uFF17.0.0.1",
            "https://127\u30020\u30020\u30021",
            "https://127\uFF0E0\uFF0E0\uFF0E1",
            "https://127\uFF610\uFF610\uFF611",
            "https://\u2460\u2461\u2466.0.0.1",
            "https://\u{1D7CF}\u{1D7D0}\u{1D7D5}.0.0.1",
            "https://\u00B9\u00B2\u2077.0.0.1",
            "https://\u2081\u2082\u2087.0.0.1",
            "https://\u{1FBF1}\u{1FBF2}\u{1FBF7}.0.0.1",
            "https://10.0.0.\u2460",
            "https://\u2469.0.0.1",
            "https://\u24EA.0.0.0",
            "https://\uFF10\uFF58\uFF17\uFF46.0.0.1",
            "https://0x\u33C8.0.0.1",
            "https://127.0.0.1\uFE0F",
            "https://example.123",
            "https://example.0x",
            "https://foo.1.",
            "https://1e3.0.0.1",
            "https://b\u00fccher.1",
            "https://example.\u2460",
          ],
          /auth\.baseUrl IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
          { api: false },
        ),
      ];
      // The bootstrap Job, then the chart; a rendered value also starts the API.
      const checks = cases.map(async ({ baseUrl, chart, api, job }) => {
        const label = JSON.stringify(baseUrl);
        assert.equal(apiAccepts(baseUrl), api, label);
        assert.equal(jobRefusal(baseUrl), job ? undefined : "AUTH_BASE_URL_INVALID", label);
        if (chart !== undefined) {
          assert.match(await refusal({ ...values, "auth.baseUrl": baseUrl }), chart, label);
          return;
        }
        const objects = await render({ ...values, "auth.baseUrl": baseUrl });
        const bootstrap = objects
          .filter(({ kind }) => kind === "Job")
          .flatMap(({ spec }) => spec.template.spec.containers)
          .find(({ name }) => name === "bootstrap");
        for (const [workload, env] of [
          ["api", deploymentEnv(objects, "api")],
          ["bootstrap", bootstrap.env],
        ]) {
          assert.ok(
            env.some(({ name, value }) => name === "OCC_AUTH_BASE_URL" && value === baseUrl),
            `${label} ${workload}`,
          );
        }
        // The API's startup gets past configuration with the rendered value.
        await startsUp({ ...environment, OCC_AUTH_BASE_URL: baseUrl }, label);
      });
      // The API startup's own code for a value it cannot parse, and its own refusals of a
      // rewritten IPv4 host and an empty user info: apiAccepts copies refuseRewrittenIpv4Host
      // and refuseWrittenUserinfo, and the cases above start the API only for values the chart
      // renders, so deleting a call in api-startup.mjs leaves the rest of this test green.
      const ownRefusals = [
        "console.oce.example.internal",
        "https://192.168.010.001",
        "https://@console.oce.example.internal",
      ].map(async (baseUrl) =>
        assert.equal(
          await startupCode({ ...environment, OCC_AUTH_BASE_URL: baseUrl }),
          "AUTH_BASE_URL_INVALID",
          baseUrl,
        ),
      );
      await settle([...checks, ...ownRefusals]);
    },
  );

  // The chart refuses a listed set of compatibility characters ($baseUrlHostRefused) that the
  // API's URL parser refuses in a host. This re-derives the list from Node: of the non-ASCII
  // letters, marks, numbers, punctuation and symbols (what the chart's other Unicode checks let
  // through), exactly those that URL parsing refuses in every host context tried are listed. The
  // contexts put Latin, Arabic, Hebrew and virama neighbours on each side, in every label
  // position, so a character refused only by the Bidi or joiner rules, or at a label start, is
  // never listed. The refusals follow the IDNA tables of Node's URL parser (ada), so a Node
  // upgrade can change them; this test then names the code points to add or remove.
  // JavaScript's Unicode tables can be newer than Go's: a listed code point that Go's RE2 reads
  // as unassigned is refused by the chart's earlier check instead, which is harmless.
  test("the chart lists exactly the compatibility characters the API's URL parser refuses in a host", async () => {
    const listed = await helperPattern("baseUrlHostRefused");
    const parses = (host) => URL.canParse(`https://${host}`);
    const labels = (character) =>
      ["", "a", "\u0627", "\u05d0", "\u0915\u094d"].flatMap((before) =>
        ["", "a", "\u0627", "\u05d0"].map((after) => `${before}${character}${after}`),
      );
    const refusedEverywhere = (character) =>
      !labels(character).some((label) =>
        [label, `${label}.example`, `example.${label}`, `${label}.\u0627`].some(parses),
      );
    const missing = [];
    const extra = [];
    let count = 0;
    // Surrogates are category Cs, so the property test skips them.
    for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint++) {
      const character = String.fromCodePoint(codePoint);
      if (/[\p{L}\p{M}\p{N}\p{P}\p{S}]/u.test(character)) {
        const isListed = listed.test(character);
        count += isListed ? 1 : 0;
        if (refusedEverywhere(character) !== isListed) {
          (isListed ? extra : missing).push(codePointName(codePoint));
        }
      }
    }
    assert.ok(count > 0, "the list matches no letter, mark, number, punctuation or symbol");
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });

  // Before deciding whether a host is IPv4, the API's URL parser maps compatibility characters
  // (UTS #46). The chart lists the ones that become ASCII the IPv4 check reads: dropped
  // characters, dots, a zero, other digit runs, x, and hex letter runs. This re-derives each
  // list from Node by parsing the character between two letters. A Node upgrade can change
  // them; this test then names the code points to add or remove.
  test("the chart maps exactly the characters the API's URL parser maps to IPv4 syntax", async () => {
    const classes = {
      ipv4Ignored: (mapped) => mapped === "",
      ipv4Dots: (mapped) => mapped === ".",
      ipv4Zeros: (mapped) => mapped === "0",
      ipv4Digits: (mapped) => /^[0-9]+$/.test(mapped) && mapped !== "0",
      ipv4X: (mapped) => mapped === "x",
      ipv4Hex: (mapped) => /^[0-9a-f]*[a-f][0-9a-f]*$/.test(mapped),
    };
    const names = Object.keys(classes);
    const patterns = await Promise.all(names.map(helperPattern));
    const listed = Object.fromEntries(names.map((name, index) => [name, patterns[index]]));
    const differences = Object.fromEntries(names.map((name) => [name, []]));
    for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint++) {
      const character = String.fromCodePoint(codePoint);
      // What the chart's earlier checks let through. Surrogates are category Cs.
      if (!/[\p{L}\p{M}\p{N}\p{P}\p{S}\u200c\u200d]/u.test(character)) {
        continue;
      }
      let mapped;
      try {
        const { hostname } = new URL(`https://q${character}q.example`);
        mapped = /^q([ -~]*)q\.example$/.exec(hostname)?.[1];
      } catch {
        mapped = undefined;
      }
      for (const [name, matches] of Object.entries(classes)) {
        if ((mapped !== undefined && matches(mapped)) !== listed[name].test(character)) {
          differences[name].push(codePointName(codePoint));
        }
      }
    }
    assert.ok(listed.ipv4Digits.test("\u2460"), "the digit list matches U+2460");
    assert.deepEqual(differences, Object.fromEntries(names.map((name) => [name, []])));
  });

  // The chart's sign-in checks read the scheme as URL parsing does, like the API: an uppercase
  // HTTPS origin, or one with surrounding spaces, passes for GitHub, Google and OIDC. Plain HTTP
  // stays refused even on loopback, where the bootstrap Job would accept it. The API also
  // requires HTTPS for production external sign-in, but only after its database opens, so only
  // the chart's refusal is checked here.
  test("external sign-in accepts the HTTPS spellings the API accepts", tooling, async () => {
    const providers = [
      ["GitHub", githubUpgradeValues(recoveryUserId), githubUpgradeSettings(recoveryUserId)],
      ["Google", googleUpgradeValues(recoveryUserId), googleUpgradeSettings(recoveryUserId)],
      ["OIDC", oidcUpgradeValues(recoveryUserId), oidcUpgradeSettings(recoveryUserId)],
    ];
    const refusals = providers.map(async ([provider, values]) =>
      assert.match(
        await refusal({ ...values, "auth.baseUrl": "http://localhost:8080" }),
        new RegExp(`auth\\.${provider.toLowerCase()} requires an HTTPS auth\\.baseUrl`),
        provider,
      ),
    );
    const accepted = providers.flatMap(([provider, values, settings]) =>
      ["HTTPS://Console.OCE.example.internal", " https://console.oce.example.internal "].map(
        async (baseUrl) => {
          const label = `${provider} ${JSON.stringify(baseUrl)}`;
          assert.equal(jobRefusal(baseUrl), undefined, label);
          const objects = await render({ ...values, "auth.baseUrl": baseUrl });
          const rendered = signInSettings(deploymentEnv(objects, "api"));
          assert.deepEqual(rendered, { ...settings, OCC_AUTH_BASE_URL: baseUrl }, label);
          await startsUp(resolveSecrets(rendered), label);
        },
      ),
    );
    await settle([...refusals, ...accepted]);
  });
});
