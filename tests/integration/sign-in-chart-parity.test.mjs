import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clientAddressConfiguration,
  githubLoginConfiguration,
  humanLoginConfiguration,
  resolveClientAddress,
} from "../../apps/controller/src/auth/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import {
  chartRefusal,
  chartTooling,
  deploymentEnv,
  renderChart,
  repository,
  signInSettings,
  trustedProxyNotice,
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

// Each proxy preset the chart offers, as operators set it, and what the API must read.
const presets = {
  none: { values: {}, env: {}, parsed: undefined },
  "ingress-nginx": {
    values: {
      "api.trustedProxy.preset": "ingress-nginx",
      "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
    },
    env: {
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16",
      OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx",
    },
    parsed: { header: "x-forwarded-for", proxy: "10.42.7.1" },
  },
  aws: {
    values: {
      "api.trustedProxy.preset": "aws",
      "api.trustedProxy.cidrs[0]": "10.0.0.0/16",
      "api.trustedProxy.cidrs[1]": "fd00:10::/64",
    },
    env: {
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/16,fd00:10::/64",
      OCC_AUTH_TRUSTED_PROXY_PRESET: "aws",
    },
    parsed: { header: "x-forwarded-for", proxy: "fd00:10::5" },
  },
  generic: {
    values: {
      "api.trustedProxy.preset": "generic",
      "api.trustedProxy.cidrs[0]": "192.168.10.0/24",
      "api.trustedProxy.clientAddressHeader": "X-Real-IP",
    },
    env: {
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "192.168.10.0/24",
      OCC_AUTH_TRUSTED_PROXY_PRESET: "generic",
      OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip",
    },
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

// Runs the actual API entrypoint with the rendered settings. Its database is unreachable,
// so accepted settings end at PERSISTENCE_UNAVAILABLE, after configuration parsing and
// composition checks; refused settings end earlier with another startup code.
async function startupCode(directory, settings) {
  const environment = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: join(directory, "installation.yaml"),
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
    OCC_HOST: "192.0.2.10",
    OCC_PORT: "8080",
    ...settings,
  };
  if (environment.OCC_GATEWAY_API_KEY_PATH !== undefined) {
    // The chart mounts the gateway key Secret here; the test supplies a private file.
    environment.OCC_GATEWAY_API_KEY_PATH = join(directory, "gateway-key");
  }
  const stderr = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["apps/controller/src/server.mjs"],
      { cwd: repository, env: environment, timeout: 20_000 },
      (_error, _stdout, output) => resolve(output),
    );
  });
  const diagnostic = stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .find(({ event }) => event === "startup-error");
  assert.ok(diagnostic, stderr);
  return diagnostic.code;
}

// Runs `check` over `cases` with at most one start per CPU at a time: each case starts the API
// in a child process with a 20 s deadline, and starting them all at once on a small runner
// pushes the last ones past it.
async function eachBounded(cases, check) {
  const queue = [...cases];
  const workers = Math.min(Math.max(2, availableParallelism()), queue.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        await check(queue.shift());
      }
    }),
  );
}

async function startupDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "occ-sign-in-chart-parity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "installation.yaml"),
    JSON.stringify(createInstallationDriverConfiguration()),
  );
  await writeFile(join(directory, "gateway-key"), "occ_chart_parity_gateway_key", { mode: 0o600 });
  return directory;
}

test(
  "the API accepts exactly the sign-in settings the chart renders for every proxy preset, with and without GitHub",
  tooling,
  async (t) => {
    const directory = await startupDirectory(t);
    const cases = [];
    for (const [preset, proxy] of Object.entries(presets)) {
      for (const githubEnabled of [false, true]) {
        cases.push({ preset, proxy, githubEnabled });
      }
    }
    await Promise.all(
      cases.map(async ({ preset, proxy, githubEnabled }) => {
        const label = `${preset}, GitHub ${githubEnabled ? "on" : "off"}`;
        const objects = await renderChart({
          ...proxy.values,
          ...(githubEnabled ? githubUpgradeValues(recoveryUserId) : {}),
        });
        const rendered = signInSettings(deploymentEnv(objects, "api"));
        assert.deepEqual(
          rendered,
          {
            ...(githubEnabled ? githubUpgradeSettings(recoveryUserId) : defaultInstallSettings),
            ...proxy.env,
          },
          label,
        );
        // Reuse these renders to cover the example install's egress and Secret
        // placement: only the API receives sign-in and trusted-proxy settings.
        assert.deepEqual(
          objects
            .filter(({ kind }) => kind === "NetworkPolicy")
            .map(
              ({ metadata }) => /-api-(github|google|oidc)-login-egress$/.exec(metadata.name)?.[1],
            )
            .filter(Boolean)
            .sort(),
          githubEnabled ? ["github"] : [],
          label,
        );
        assert.ok(
          !deploymentEnv(objects, "worker").some(({ name }) =>
            /^OCC_AUTH_(GITHUB_|GOOGLE_|OIDC_|TRUSTED_PROXY_|CLIENT_IP_HEADER)/.test(name),
          ),
          label,
        );
        const environment = resolveSecrets(rendered);
        const github = githubLoginConfiguration(environment);
        assert.deepEqual(
          github,
          githubEnabled
            ? {
                clientId: secrets["occ-github-login/client-id"],
                clientSecret: secrets["occ-github-login/client-secret"],
                recoveryUserId,
              }
            : undefined,
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
        assert.equal(await startupCode(directory, environment), "PERSISTENCE_UNAVAILABLE", label);
      }),
    );
  },
);

test(
  "the API accepts exactly the Google sign-in settings the chart renders, alone and with GitHub",
  tooling,
  async (t) => {
    const directory = await startupDirectory(t);
    const domains = ["example.com", "corp.example.org"];
    const google = {
      clientId: secrets["occ-google-login/client-id"],
      clientSecret: secrets["occ-google-login/client-secret"],
      recoveryUserId,
    };
    const cases = [
      {
        label: "Google only",
        values: googleUpgradeValues(recoveryUserId),
        settings: googleUpgradeSettings(recoveryUserId),
        parsed: { google: { ...google, allowedDomains: [] } },
        egress: ["google"],
      },
      {
        label: "Google only, hosted domains",
        values: googleUpgradeValues(recoveryUserId, domains),
        settings: googleUpgradeSettings(recoveryUserId, domains),
        parsed: { google: { ...google, allowedDomains: domains } },
        egress: ["google"],
      },
      {
        label: "GitHub and Google",
        values: { ...githubUpgradeValues(recoveryUserId), ...googleUpgradeValues(recoveryUserId) },
        settings: {
          ...githubUpgradeSettings(recoveryUserId),
          ...googleUpgradeSettings(recoveryUserId),
        },
        parsed: {
          github: {
            clientId: secrets["occ-github-login/client-id"],
            clientSecret: secrets["occ-github-login/client-secret"],
            recoveryUserId,
          },
          google: { ...google, allowedDomains: [] },
        },
        egress: ["github", "google"],
      },
      {
        label: "GitHub and Google, recovery-only password sign-in",
        values: {
          ...githubUpgradeValues(recoveryUserId),
          ...googleUpgradeValues(recoveryUserId),
          "auth.passwordSignIn": "recovery-only",
        },
        settings: {
          ...githubUpgradeSettings(recoveryUserId),
          ...googleUpgradeSettings(recoveryUserId),
          OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
        },
        parsed: {
          github: {
            clientId: secrets["occ-github-login/client-id"],
            clientSecret: secrets["occ-github-login/client-secret"],
            recoveryUserId,
          },
          google: { ...google, allowedDomains: [] },
          passwordSignIn: "recovery-only",
        },
        egress: ["github", "google"],
      },
      {
        // The default is not rendered: the API reads an absent setting as "all".
        label: "Google, password sign-in for every account",
        values: { ...googleUpgradeValues(recoveryUserId), "auth.passwordSignIn": "all" },
        settings: googleUpgradeSettings(recoveryUserId),
        parsed: { google: { ...google, allowedDomains: [] } },
        egress: ["google"],
      },
    ];
    await Promise.all(
      cases.map(async ({ label, values, settings, parsed, egress }) => {
        const objects = await renderChart(values);
        const rendered = signInSettings(deploymentEnv(objects, "api"));
        assert.deepEqual(rendered, settings, label);
        assert.deepEqual(
          objects
            .filter(({ kind }) => kind === "NetworkPolicy")
            .map(
              ({ metadata }) => /-api-(github|google|oidc)-login-egress$/.exec(metadata.name)?.[1],
            )
            .filter(Boolean)
            .sort(),
          egress,
          label,
        );
        assert.ok(
          !deploymentEnv(objects, "worker").some(({ name }) =>
            /^OCC_AUTH_(GITHUB|GOOGLE|OIDC)_/.test(name),
          ),
          label,
        );
        const environment = resolveSecrets(rendered);
        assert.deepEqual(humanLoginConfiguration(environment), parsed, label);
        assert.equal(await startupCode(directory, environment), "PERSISTENCE_UNAVAILABLE", label);
      }),
    );
  },
);

test(
  "the API accepts exactly the OIDC sign-in settings the chart renders, alone and with GitHub and Google",
  tooling,
  async (t) => {
    const directory = await startupDirectory(t);
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
    const cases = [
      {
        label: "OIDC only",
        values: oidcUpgradeValues(recoveryUserId),
        settings: oidcUpgradeSettings(recoveryUserId),
        parsed: { oidc },
        egress: ["oidc"],
      },
      {
        label: "OIDC only, basic token auth and a label",
        values: oidcUpgradeValues(recoveryUserId, keycloak, extra),
        settings: oidcUpgradeSettings(recoveryUserId, keycloak, extra),
        parsed: { oidc: { ...oidc, ...keycloak, ...extra } },
        egress: ["oidc"],
      },
      {
        // The default token method is not rendered: the API reads its absence as post.
        label: "OIDC, explicit default token auth",
        values: oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, {
          tokenAuth: "client_secret_post",
        }),
        settings: oidcUpgradeSettings(recoveryUserId),
        parsed: { oidc },
        egress: ["oidc"],
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
          github: {
            clientId: secrets["occ-github-login/client-id"],
            clientSecret: secrets["occ-github-login/client-secret"],
            recoveryUserId,
          },
          google: {
            clientId: secrets["occ-google-login/client-id"],
            clientSecret: secrets["occ-google-login/client-secret"],
            allowedDomains: [],
            recoveryUserId,
          },
          oidc,
          passwordSignIn: "recovery-only",
        },
        egress: ["github", "google", "oidc"],
      },
    ];
    await Promise.all(
      cases.map(async ({ label, values, settings, parsed, egress }) => {
        const objects = await renderChart(values);
        const rendered = signInSettings(deploymentEnv(objects, "api"));
        assert.deepEqual(rendered, settings, label);
        const policies = objects.filter(({ kind }) => kind === "NetworkPolicy");
        assert.deepEqual(
          policies
            .map(
              ({ metadata }) => /-api-(github|google|oidc)-login-egress$/.exec(metadata.name)?.[1],
            )
            .filter(Boolean)
            .sort(),
          egress,
          label,
        );
        // The default OIDC egress is any address except link-local, on TCP 443 only.
        const oidcEgress = policies.find(({ metadata }) =>
          metadata.name.endsWith("-api-oidc-login-egress"),
        );
        assert.deepEqual(
          oidcEgress.spec.egress,
          [
            {
              to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }],
              ports: [{ protocol: "TCP", port: 443 }],
            },
          ],
          label,
        );
        assert.ok(
          !deploymentEnv(objects, "worker").some(({ name }) => /^OCC_AUTH_OIDC_/.test(name)),
          label,
        );
        const environment = resolveSecrets(rendered);
        assert.deepEqual(humanLoginConfiguration(environment), parsed, label);
        assert.equal(await startupCode(directory, environment), "PERSISTENCE_UNAVAILABLE", label);
      }),
    );
    const narrowed = await renderChart({
      ...oidcUpgradeValues(recoveryUserId),
      "auth.oidc.egressCidrs[0]": "198.51.100.0/24",
    });
    assert.deepEqual(
      narrowed.find(({ metadata }) => metadata.name.endsWith("-api-oidc-login-egress")).spec
        .egress[0].to,
      [{ ipBlock: { cidr: "198.51.100.0/24" } }],
    );
  },
);

const githubOn = { "auth.github.enabled": "true", "auth.recoveryUserId": recoveryUserId };
const googleOn = { "auth.google.enabled": "true", "auth.recoveryUserId": recoveryUserId };
const invalid = [
  {
    name: "generic preset without a header",
    values: { "api.trustedProxy.preset": "generic", "api.trustedProxy.cidrs[0]": "10.42.0.0/16" },
    chart: /generic requires api\.trustedProxy\.clientAddressHeader/,
    env: { OCC_AUTH_TRUSTED_PROXY_PRESET: "generic", OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16" },
    parser: /generic trusted proxy preset requires OCC_AUTH_CLIENT_IP_HEADER/,
  },
  {
    name: "preset without proxy CIDRs",
    values: { "api.trustedProxy.preset": "aws" },
    chart: /preset aws requires api\.trustedProxy\.cidrs/,
    env: { OCC_AUTH_TRUSTED_PROXY_PRESET: "aws" },
    parser: /require OCC_AUTH_TRUSTED_PROXY_CIDRS/,
  },
  {
    name: "unknown preset",
    values: { "api.trustedProxy.preset": "cloudflare", "api.trustedProxy.cidrs[0]": "10.0.0.0/8" },
    chart: /must be empty, ingress-nginx, aws, or generic/,
    env: {
      OCC_AUTH_TRUSTED_PROXY_PRESET: "cloudflare",
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
    },
    parser: /must be one of ingress-nginx, aws, generic/,
  },
  {
    name: "a proxy CIDR that trusts every address",
    values: {
      "api.trustedProxy.preset": "ingress-nginx",
      "api.trustedProxy.cidrs[0]": "0.0.0.0/0",
    },
    chart: /nonzero prefix/,
    env: {
      OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx",
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "0.0.0.0/0",
    },
    parser: /must not trust every address/,
  },
  {
    name: "an invalid proxy address",
    values: { "api.trustedProxy.preset": "aws", "api.trustedProxy.cidrs[0]": "300.1.1.0/24" },
    chart: /invalid IPv4 address/,
    env: { OCC_AUTH_TRUSTED_PROXY_PRESET: "aws", OCC_AUTH_TRUSTED_PROXY_CIDRS: "300.1.1.0/24" },
    parser: /invalid CIDR/,
  },
  {
    name: "a credential header as the client address",
    values: {
      "api.trustedProxy.preset": "generic",
      "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
      "api.trustedProxy.clientAddressHeader": "Cookie",
    },
    chart: /clientAddressHeader cannot be cookie/,
    env: {
      OCC_AUTH_TRUSTED_PROXY_PRESET: "generic",
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16",
      OCC_AUTH_CLIENT_IP_HEADER: "cookie",
    },
    parser: /must not be cookie/,
  },
  {
    name: "a named preset with another header",
    values: {
      "api.trustedProxy.preset": "aws",
      "api.trustedProxy.cidrs[0]": "10.0.0.0/16",
      "api.trustedProxy.clientAddressHeader": "x-real-ip",
    },
    chart: /preset aws reads x-forwarded-for/,
    env: {
      OCC_AUTH_TRUSTED_PROXY_PRESET: "aws",
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/16",
      OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip",
    },
    parser: /aws trusted proxy preset reads x-forwarded-for/,
  },
  {
    name: "GitHub without a recovery user",
    values: { "auth.github.enabled": "true", "agentNativeAdmin.enabled": "false" },
    chart: /auth\.github\.enabled requires auth\.recoveryUserId/,
    github: true,
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
  {
    // The parsers accept both; composition refuses the combination before any database work.
    name: "GitHub with shared-cookie native administration",
    values: githubOn,
    chart: /auth\.github requires agentNativeAdmin\.enabled: false/,
    github: true,
    env: {
      OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
      OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
    },
  },
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
    values: { ...githubOn, "agentNativeAdmin.enabled": "false", "auth.passwordSignIn": "none" },
    chart: /auth\.passwordSignIn must be all or recovery-only/,
    github: true,
    env: { OCC_AUTH_PASSWORD_SIGN_IN: "none" },
    parser: /OCC_AUTH_PASSWORD_SIGN_IN must be all or recovery-only/,
  },
  {
    name: "Google without a recovery user",
    values: { "auth.google.enabled": "true", "agentNativeAdmin.enabled": "false" },
    chart: /auth\.google\.enabled requires auth\.recoveryUserId/,
    google: true,
    env: { OCC_AUTH_GITHUB_RECOVERY_USER_ID: undefined },
    parser: /Google sign-in requires client ID, client secret and recovery user ID/,
  },
  {
    // As for GitHub, composition refuses the combination before any database work.
    name: "Google with shared-cookie native administration",
    values: googleOn,
    chart: /auth\.google requires agentNativeAdmin\.enabled: false/,
    google: true,
    env: {
      OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
      OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
    },
  },
  {
    name: "Google with a hosted domain that is not a DNS name",
    values: {
      ...googleOn,
      "agentNativeAdmin.enabled": "false",
      "auth.google.allowedDomains[0]": "example.com/admin",
    },
    chart: /auth\.google\.allowedDomains requires DNS domain names/,
    google: true,
    env: { OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: "example.com/admin" },
    parser: /OCC_AUTH_GOOGLE_ALLOWED_DOMAINS must be a comma-separated list of DNS domain names/,
  },
  {
    name: "OIDC without a recovery user",
    values: { ...oidcUpgradeValues(""), "auth.recoveryUserId": "" },
    chart: /auth\.oidc\.enabled requires auth\.recoveryUserId/,
    oidc: true,
    env: { OCC_AUTH_GITHUB_RECOVERY_USER_ID: undefined },
    parser: /OIDC sign-in requires its provider settings and a recovery user ID/,
  },
  {
    name: "OIDC without a token URL",
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.tokenUrl": "" },
    chart: /auth\.oidc\.tokenUrl must be an https URL on port 443 on the issuer's host/,
    oidc: true,
    env: { OCC_AUTH_OIDC_TOKEN_URL: "" },
    parser: /OIDC sign-in requires issuer, authorization URL, token URL/,
  },
  ...[
    ["an HTTP issuer", "issuer", "http://tenant.idp.example.test/"],
    ["an issuer on another port", "issuer", "https://tenant.idp.example.test:8443/"],
    // The URL parser drops `:443`, but `iss` is compared with the configured string.
    ["an issuer with an explicit port 443", "issuer", "https://tenant.idp.example.test:443/"],
    ["an IP-address issuer", "issuer", "https://203.0.113.10/"],
    ["an issuer with a query", "issuer", "https://tenant.idp.example.test/?t=1"],
  ].map(([name, key, value]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), [`auth.oidc.${key}`]: value },
    chart: /auth\.oidc\.issuer must be an https URL on port 443 with a DNS host name/,
    oidc: true,
    env: { OCC_AUTH_OIDC_ISSUER: value },
    parser: /OCC_AUTH_OIDC_ISSUER must be an https URL/,
  })),
  ...[
    [
      "an off-host token URL",
      "tokenUrl",
      "OCC_AUTH_OIDC_TOKEN_URL",
      "https://evil.example.test/token",
    ],
    [
      "userinfo in the JWKS URL",
      "jwksUrl",
      "OCC_AUTH_OIDC_JWKS_URL",
      "https://u@tenant.idp.example.test/jwks",
    ],
    [
      "a fragment in the authorization URL",
      "authorizationUrl",
      "OCC_AUTH_OIDC_AUTHORIZATION_URL",
      "https://tenant.idp.example.test/authorize#x",
    ],
    [
      "an HTTP JWKS URL",
      "jwksUrl",
      "OCC_AUTH_OIDC_JWKS_URL",
      "http://tenant.idp.example.test/jwks",
    ],
  ].map(([name, key, variable, value]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), [`auth.oidc.${key}`]: value },
    chart: new RegExp(`auth\\.oidc\\.${key} must be an https URL on port 443 on the issuer's host`),
    oidc: true,
    env: { [variable]: value },
    parser: new RegExp(`${variable} must be an https URL on port 443 on the issuer's host`),
  })),
  {
    name: "OIDC with an unknown token method",
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.tokenAuth": "private_key_jwt" },
    chart: /auth\.oidc\.tokenAuth must be client_secret_post or client_secret_basic/,
    oidc: true,
    env: { OCC_AUTH_OIDC_TOKEN_AUTH: "private_key_jwt" },
    parser: /OCC_AUTH_OIDC_TOKEN_AUTH must be client_secret_post or client_secret_basic/,
  },
  {
    name: "OIDC with an overlong label",
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.displayName": "x".repeat(41) },
    chart: /auth\.oidc\.displayName must be 1 to 40 printable characters/,
    oidc: true,
    env: { OCC_AUTH_OIDC_DISPLAY_NAME: "x".repeat(41) },
    parser: /OCC_AUTH_OIDC_DISPLAY_NAME must be 1 to 40 printable characters/,
  },
  {
    // As for GitHub, composition refuses the combination before any database work.
    name: "OIDC with shared-cookie native administration",
    values: { ...oidcUpgradeValues(recoveryUserId), "agentNativeAdmin.enabled": "true" },
    chart: /auth\.oidc requires agentNativeAdmin\.enabled: false/,
    oidc: true,
    env: {
      OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
      OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
    },
  },
];

test("values the chart refuses are settings the API also refuses", tooling, async (t) => {
  const directory = await startupDirectory(t);
  await eachBounded(invalid, async ({ name, values, chart, github, google, oidc, env, parser }) => {
    assert.match(await chartRefusal(values), chart, name);
    const environment = Object.fromEntries(
      Object.entries({
        ...resolveSecrets(
          github
            ? githubUpgradeSettings(recoveryUserId)
            : google
              ? googleUpgradeSettings(recoveryUserId)
              : oidc
                ? oidcUpgradeSettings(recoveryUserId)
                : defaultInstallSettings,
        ),
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
    assert.equal(await startupCode(directory, environment), "STARTUP_FAILED", name);
  });
});

// The chart is stricter than the API for one input: the API documents ingress-nginx as the
// default preset when only CIDRs are set, while the chart requires an explicit preset.
test(
  "proxy CIDRs without a preset are refused by the chart and default to ingress-nginx in the API",
  tooling,
  async () => {
    assert.match(
      await chartRefusal({ "api.trustedProxy.cidrs[0]": "10.42.0.0/16" }),
      /cidrs and clientAddressHeader require api\.trustedProxy\.preset/,
    );
    const parsed = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16" });
    assert.equal(parsed.preset, "ingress-nginx");
    assert.equal(parsed.header, "x-forwarded-for");
  },
);

// Secret placement and egress are chart concerns: the API only ever sees the resolved
// credentials, so these refusals have no parser counterpart.
test(
  "the chart refuses Google Secret and egress settings the API cannot observe",
  tooling,
  async () => {
    const google = { ...googleOn, "agentNativeAdmin.enabled": "false" };
    for (const [name, values, chart] of [
      [
        "the GitHub sign-in Secret",
        { ...google, ...githubOn, "auth.google.secretName": "occ-github-login" },
        /auth\.google credentials must use a dedicated Secret/,
      ],
      [
        "the Better Auth Secret",
        { ...google, "auth.google.secretName": "occ-auth" },
        /auth\.google credentials must use a dedicated Secret/,
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
        "an HTTP base URL",
        { ...google, "auth.baseUrl": "http://oce.example.internal" },
        /auth\.google requires an HTTPS auth\.baseUrl/,
      ],
    ]) {
      assert.match(await chartRefusal(values), chart, name);
    }
  },
);

test(
  "the chart refuses OIDC Secret and egress settings the API cannot observe",
  tooling,
  async () => {
    const oidc = oidcUpgradeValues(recoveryUserId);
    for (const [name, values, chart] of [
      [
        "the Google sign-in Secret",
        { ...oidc, ...googleOn, "auth.oidc.secretName": "occ-google-login" },
        /auth\.oidc credentials must use a dedicated Secret/,
      ],
      [
        "the GitHub sign-in Secret",
        { ...oidc, ...githubOn, "auth.oidc.secretName": "occ-github-login" },
        /auth\.oidc credentials must use a dedicated Secret/,
      ],
      [
        "the Better Auth Secret",
        { ...oidc, "auth.oidc.secretName": "occ-auth" },
        /auth\.oidc credentials must use a dedicated Secret/,
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
        "an HTTP base URL",
        { ...oidc, "auth.baseUrl": "http://oce.example.internal" },
        /auth\.oidc requires an HTTPS auth\.baseUrl/,
      ],
    ]) {
      assert.match(await chartRefusal(values), chart, name);
    }
  },
);

test(
  "install notes warn when sign-in is exposed without a trusted proxy, and never fail",
  tooling,
  async () => {
    const github = await trustedProxyNotice(githubUpgradeValues(recoveryUserId));
    assert.match(github, /^WARNING: api\.trustedProxy is not set\./);
    assert.match(github, /external sign-in\nstarts have no per-client limit/);
    const google = await trustedProxyNotice(googleUpgradeValues(recoveryUserId));
    assert.match(google, /^WARNING: api\.trustedProxy is not set\./);
    const oidc = await trustedProxyNotice(oidcUpgradeValues(recoveryUserId));
    assert.match(oidc, /^WARNING: api\.trustedProxy is not set\. With GitHub, Google or OIDC/);
    assert.match(
      await trustedProxyNotice(),
      /^NOTE: api\.trustedProxy is not set, so failed password sign-ins are limited per\nemail only/,
    );
    for (const { values } of Object.values(presets).filter(
      ({ values }) => values["api.trustedProxy.preset"],
    )) {
      assert.equal(
        await trustedProxyNotice({ ...githubUpgradeValues(recoveryUserId), ...values }),
        "",
      );
      assert.equal(await trustedProxyNotice(values), "");
    }
  },
);
