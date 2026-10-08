import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clientAddressConfiguration,
  createControllerAuth,
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

test("the API accepts exactly the GitHub allowlist the chart renders", tooling, async () => {
  const objects = await renderChart({
    ...githubUpgradeValues(recoveryUserId),
    "auth.github.allowedOrgs[0]": "Acme",
    "auth.github.allowedOrgs[1]": "acme-labs",
    "auth.github.allowedTeams[0]": "other/platform_team",
  });
  const rendered = signInSettings(deploymentEnv(objects, "api"));
  assert.deepEqual(rendered, {
    ...githubUpgradeSettings(recoveryUserId),
    OCC_AUTH_GITHUB_ALLOWED_ORGS: "Acme,acme-labs",
    OCC_AUTH_GITHUB_ALLOWED_TEAMS: "other/platform_team",
  });
  assert.deepEqual(githubLoginConfiguration(resolveSecrets(rendered)), {
    clientId: secrets["occ-github-login/client-id"],
    clientSecret: secrets["occ-github-login/client-secret"],
    recoveryUserId,
    allowedOrgs: ["acme", "acme-labs"],
    allowedTeams: ["other/platform_team"],
  });
  assert.ok(
    !deploymentEnv(objects, "worker").some(({ name }) => name.startsWith("OCC_AUTH_GITHUB_")),
  );
});

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
    // The API trims each URL with JavaScript's trim (ASCII whitespace, Unicode spaces, U+2028,
    // U+2029 and U+FEFF) before its checks, and so does the chart. The env keeps the value as
    // written, and the API reads the trimmed one.
    const padded = {
      issuer: ` \u000b${fixtureOidcIssuer.issuer}\f `,
      authorizationUrl: `\t${fixtureOidcIssuer.authorizationUrl}\u00a0`,
      tokenUrl: `\u3000${fixtureOidcIssuer.tokenUrl}\ufeff`,
      jwksUrl: `\u2028${fixtureOidcIssuer.jwksUrl}\u2003 `,
    };
    // An issuer without a path ends at its host, so trailing padding there must be trimmed too.
    const bare = {
      issuer: "https://sso.example.com",
      authorizationUrl: "https://sso.example.com/authorize",
      tokenUrl: "https://sso.example.com/token",
      jwksUrl: "https://sso.example.com/jwks",
    };
    const paddedBare = { ...bare, issuer: `${bare.issuer}\ufeff\u2029` };
    const cases = [
      {
        label: "OIDC, URLs padded with whitespace the API trims",
        values: oidcUpgradeValues(recoveryUserId, padded),
        settings: oidcUpgradeSettings(recoveryUserId, padded),
        parsed: { oidc },
        egress: ["oidc"],
      },
      {
        label: "OIDC, an issuer without a path, padded with whitespace the API trims",
        values: oidcUpgradeValues(recoveryUserId, paddedBare),
        settings: oidcUpgradeSettings(recoveryUserId, paddedBare),
        parsed: { oidc: { ...oidc, ...bare } },
        egress: ["oidc"],
      },
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
        // Every default sign-in egress is any address except link-local, on TCP 443 only.
        for (const provider of egress) {
          const providerEgress = policies.find(({ metadata }) =>
            metadata.name.endsWith(`-api-${provider}-login-egress`),
          );
          assert.deepEqual(
            providerEgress.spec.egress,
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
          !deploymentEnv(objects, "worker").some(({ name }) => /^OCC_AUTH_OIDC_/.test(name)),
          label,
        );
        const environment = resolveSecrets(rendered);
        assert.deepEqual(humanLoginConfiguration(environment), parsed, label);
        assert.equal(await startupCode(directory, environment), "PERSISTENCE_UNAVAILABLE", label);
      }),
    );
    // A listed CIDR replaces the default, link-local included, for each provider.
    const narrowed = await renderChart({
      ...githubUpgradeValues(recoveryUserId),
      ...googleUpgradeValues(recoveryUserId),
      ...oidcUpgradeValues(recoveryUserId),
      "auth.github.egressCidrs[0]": "140.82.112.0/20",
      "auth.google.egressCidrs[0]": "169.254.10.0/24",
      "auth.oidc.egressCidrs[0]": "198.51.100.0/24",
    });
    for (const [provider, cidr] of [
      ["github", "140.82.112.0/20"],
      ["google", "169.254.10.0/24"],
      ["oidc", "198.51.100.0/24"],
    ]) {
      assert.deepEqual(
        narrowed.find(({ metadata }) => metadata.name.endsWith(`-api-${provider}-login-egress`))
          .spec.egress[0].to,
        [{ ipBlock: { cidr } }],
        provider,
      );
    }
  },
);

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

test(
  "trusted-proxy CIDR parity preserves mapped hosts and bounded IPv6 ranges",
  tooling,
  async () => {
    // One render validates every accepted entry; parse its emitted entries individually
    // so another trusted subnet cannot conceal an entry that trusts every IPv4 peer.
    const objects = await renderChart({
      "api.trustedProxy.preset": "ingress-nginx",
      ...Object.fromEntries(
        trustedProxyCidrs.accepted.map(([cidr], index) => [
          `api.trustedProxy.cidrs[${index}]`,
          cidr,
        ]),
      ),
    });
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
  // IPv6 prefixes covering the mapped range would otherwise let every IPv4
  // socket peer supply the header used for sign-in rate limiting.
  ...trustedProxyCidrs.catchAll.map((cidr) => ({
    name: `a trusted-proxy IPv6 CIDR covering every IPv4 address: ${cidr}`,
    values: { "api.trustedProxy.preset": "ingress-nginx", "api.trustedProxy.cidrs[0]": cidr },
    chart: /must not trust every address/,
    env: { OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx", OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr },
    parser: /must not trust every address/,
  })),
  ...trustedProxyCidrs.invalidMappedPrefix.map((cidr) => ({
    name: `a trusted-proxy mapped IPv4 address with an IPv6 prefix: ${cidr}`,
    values: { "api.trustedProxy.preset": "ingress-nginx", "api.trustedProxy.cidrs[0]": cidr },
    chart: /prefix must be 1 through 32/,
    env: { OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx", OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr },
    parser: /IPv4-mapped address, whose prefix must be 1 through 32/,
  })),
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
    code: "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
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
    name: "GitHub with an allowed organization that is not a login",
    values: {
      ...githubOn,
      "agentNativeAdmin.enabled": "false",
      "auth.github.allowedOrgs[0]": "acme/platform",
    },
    chart: /auth\.github\.allowedOrgs requires GitHub organization logins/,
    github: true,
    env: { OCC_AUTH_GITHUB_ALLOWED_ORGS: "acme/platform" },
    parser:
      /OCC_AUTH_GITHUB_ALLOWED_ORGS must be a comma-separated list of GitHub organization logins/,
  },
  {
    name: "GitHub with an allowed team without its organization",
    values: {
      ...githubOn,
      "agentNativeAdmin.enabled": "false",
      "auth.github.allowedTeams[0]": "platform",
    },
    chart: /auth\.github\.allowedTeams requires org\/team-slug entries/,
    github: true,
    env: { OCC_AUTH_GITHUB_ALLOWED_TEAMS: "platform" },
    parser:
      /OCC_AUTH_GITHUB_ALLOWED_TEAMS must be a comma-separated list of org\/team-slug entries/,
  },
  {
    name: "GitHub with more than ten allowlist entries",
    values: {
      ...githubOn,
      "agentNativeAdmin.enabled": "false",
      ...Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [
          `auth.github.allowedOrgs[${index}]`,
          `org${index}`,
        ]),
      ),
    },
    chart:
      /auth\.github\.allowedOrgs and auth\.github\.allowedTeams list at most 10 entries together/,
    github: true,
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
  {
    name: "an allowed GitHub organization that is not a login, without GitHub sign-in",
    values: { "auth.github.allowedOrgs[0]": "acme/platform" },
    chart: /auth\.github\.allowedOrgs requires GitHub organization logins/,
    env: { OCC_AUTH_GITHUB_ALLOWED_ORGS: "acme/platform" },
    parser:
      /OCC_AUTH_GITHUB_ALLOWED_ORGS must be a comma-separated list of GitHub organization logins/,
  },
  {
    name: "an allowed GitHub team without its organization, without GitHub sign-in",
    values: { "auth.github.allowedTeams[0]": "platform" },
    chart: /auth\.github\.allowedTeams requires org\/team-slug entries/,
    env: { OCC_AUTH_GITHUB_ALLOWED_TEAMS: "platform" },
    parser:
      /OCC_AUTH_GITHUB_ALLOWED_TEAMS must be a comma-separated list of org\/team-slug entries/,
  },
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
    code: "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
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
    // JavaScript's trim keeps U+0085, though Go's TrimSpace strips it.
    ["an issuer padded with U+0085", "issuer", "\u0085https://tenant.idp.example.test/"],
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
    code: "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
    env: {
      OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
      OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
      OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
    },
  },
];

// Refusals with a named startup code; every other entry stops with STARTUP_FAILED.
const startupCodes = new Map(invalid.flatMap(({ name, code }) => (code ? [[name, code]] : [])));

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
    assert.equal(
      await startupCode(directory, environment),
      startupCodes.get(name) ?? "STARTUP_FAILED",
      name,
    );
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
        "an empty-string egress list",
        { ...google, "auth.google.egressCidrs": "" },
        /auth\.google\.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set \[\] in a values file or with --set-json,/,
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
        "an empty-string egress list",
        { ...oidc, "auth.oidc.egressCidrs": "" },
        /auth\.oidc\.egressCidrs must be a list of IPv4 CIDRs; leave it unset, or set \[\] in a values file or with --set-json,/,
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

test("a null optional sign-in map renders like an absent one", tooling, async () => {
  // `auth.github: null` (or `--set auth.github=null`) deletes the map's defaults. The chart
  // must then render the password-only install without a trusted proxy, as validation and
  // the install notes already assume, instead of failing with a template nil pointer.
  for (const key of ["auth.github", "auth.google", "auth.oidc", "api.trustedProxy"]) {
    const objects = await renderChart({ [key]: "null" });
    assert.deepEqual(signInSettings(deploymentEnv(objects, "api")), defaultInstallSettings, key);
    assert.equal(
      objects.filter(
        ({ kind, metadata }) => kind === "NetworkPolicy" && /-login-egress$/.test(metadata.name),
      ).length,
      0,
      key,
    );
  }
});

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
  for (const [baseUrl, chart, api] of [
    [
      "https://console.example.com",
      /agentNativeAdmin\.sharedCookieDomain must contain the auth\.baseUrl host/,
      /OCC_AUTH_COOKIE_DOMAIN must contain the OCC_AUTH_BASE_URL host/,
    ],
    [
      "https://console-oce.example.com",
      /agentNativeAdmin\.sharedCookieDomain must contain the auth\.baseUrl host/,
      /OCC_AUTH_COOKIE_DOMAIN must contain the OCC_AUTH_BASE_URL host/,
    ],
    [
      "http://console.oce.example.com",
      /agentNativeAdmin\.enabled requires an HTTPS auth\.baseUrl/,
      /OCC_AUTH_COOKIE_DOMAIN requires secure HTTPS session cookies/,
    ],
  ]) {
    assert.match(await chartRefusal({ ...nativeAdmin, "auth.baseUrl": baseUrl }), chart, baseUrl);
    assert.throws(apiRefusal(baseUrl), api, baseUrl);
  }
  for (const baseUrl of [
    "https://oce.example.com",
    "https://Console.OCE.example.com",
    "https://console.oce.example.com.",
    "https://console.oce.example.com:8443",
    " https://console.oce.example.com ",
  ]) {
    // The API's cookie checks pass; it stops later, at the Installation it was not given.
    assert.throws(apiRefusal(baseUrl), /Better Auth issuer requires an Installation/, baseUrl);
    const objects = await renderChart({ ...nativeAdmin, "auth.baseUrl": baseUrl });
    assert.ok(
      deploymentEnv(objects, "api").some(
        ({ name, value }) => name === "OCC_AUTH_BASE_URL" && value === baseUrl,
      ),
      baseUrl,
    );
  }
});

// The bootstrap Job's own check, run as the chart's Job runs it (NODE_ENV=production). Its
// database is unreachable, so an accepted base URL ends at PERSISTENCE_UNAVAILABLE.
async function jobCode(baseUrl) {
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/bootstrap-installation.mjs"],
      {
        cwd: repository,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
          OCC_AUTH_SECRET: secrets["occ-auth/secret"],
          OCC_AUTH_BASE_URL: baseUrl,
          OCC_BOOTSTRAP_ADMIN_EMAIL: "admin@oce.example.internal",
        },
        timeout: 20_000,
      },
      (error, _stdout, output) => resolve({ killed: error?.killed === true, output }),
    );
  });
  assert.ok(!result.killed, `the bootstrap Job timed out for ${JSON.stringify(baseUrl)}`);
  const failure = result.output
    .split("\n")
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line))
    .find(({ event }) => event === "installation.bootstrap-failed");
  assert.ok(failure, result.output);
  return failure.code;
}

// The API refuses an auth base URL that is not an absolute HTTP(S) origin: server.mjs parses
// OCC_AUTH_BASE_URL, and createControllerAuth (validHttpBaseURL, which the bootstrap Job also
// runs before it) refuses the rest, both as AUTH_BASE_URL_INVALID. The bootstrap Job also
// refuses plain HTTP unless the host is 127.0.0.1 or localhost. The chart refuses the same
// values at render time and still renders every origin both accept. Native admin is off, so
// only the origin checks apply.
test(
  "the chart refuses auth base URLs the API or the bootstrap Job refuses",
  tooling,
  async (t) => {
    const directory = await startupDirectory(t);
    const values = { "agentNativeAdmin.enabled": "false" };
    const environment = resolveSecrets(
      signInSettings(deploymentEnv(await renderChart(values), "api")),
    );
    // server.mjs's normalization, then createControllerAuth. Without an Installation, accepted
    // settings stop right after its base URL checks.
    const apiAccepts = (baseUrl) => {
      let normalized;
      try {
        normalized = new URL(baseUrl).toString().replace(/\/$/, "");
      } catch {
        return false;
      }
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
      ...[
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
        "console.oce.example.internal",
        "//console.oce.example.internal",
        "ftp://console.oce.example.internal",
        "https://console.oce.example.internal:65536",
        "https://",
        "http://localhost/occ",
      ].map((baseUrl) => ({ baseUrl, chart: notOrigin, api: false, job: false })),
      ...[
        "https://console.oce.example.internal",
        "https://console.oce.example.internal/",
        "https://console.oce.example.internal:8443",
        "https://console.oce.example.internal:0443/",
        "https://console.oce.example.internal:65535",
        "HTTPS://Console.OCE.example.internal",
        "https://console.oce.example.internal.",
        " https://console.oce.example.internal ",
        "https://192.0.2.10",
        "https://[2001:db8::10]:8443",
        "https://localhost",
        "http://127.0.0.1",
        "http://127.0.0.1:8080/",
        "http://localhost:8080",
        "HTTP://LocalHost:8080",
        " http://localhost ",
        "https://bücher.oce.example.internal",
        "https://console.例え.テスト",
      ].map((baseUrl) => ({ baseUrl, chart: undefined, api: true, job: true })),
      // URL parsing strips only C0 controls and spaces from the ends, so other Unicode spaces
      // and invisible characters there reach the parser, which refuses them in the scheme or a
      // host. The chart refuses them all; it is deliberately stricter for U+FEFF and U+200B at
      // the end, which the host parser drops. A trailing unassigned code point (U+0378), which
      // RE2's \p{C} does not cover, is refused too.
      {
        baseUrl: "https://console.oce.example.internal\u0378",
        chart: unicodeEdge,
        api: false,
        job: false,
      },
      ...[
        ["\u00a0", false],
        ["\u2003", false],
        ["\u3000", false],
        ["\ufeff", true],
        ["\u200b", true],
      ].flatMap(([space, trailingAccepted]) =>
        [
          [`${space}https://console.oce.example.internal`, false],
          [`https://console.oce.example.internal${space}`, trailingAccepted],
          [` ${space}https://console.oce.example.internal${space} `, false],
        ].map(([baseUrl, accepted]) => ({
          baseUrl,
          chart: unicodeEdge,
          api: accepted,
          job: accepted,
        })),
      ),
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
        ["\ufeff", true],
        ["\u200b", true],
        ["\u00ad", true],
      ].map(([space, accepted]) => ({
        baseUrl: `https://console${space}.oce.example.internal`,
        chart: unicodeInside,
        api: accepted,
        job: accepted,
      })),
      // The host parser maps compatibility characters first and refuses those that map to a
      // forbidden host code point (full-width ? # / @, ?? from U+2047) or that UTS #46 disallows
      // (U+2488 maps to "1.", U+FFFD). Go's URL parser keeps them. A sample here; the next test
      // checks the chart's whole list against Node.
      ...["\uff1f", "\uff03", "\uff0f", "\uff20", "\ufe56", "\u2047", "\u2488", "\ufffd"].map(
        (character) => ({
          baseUrl: `https://console${character}.oce.example.internal`,
          chart: compatibility,
          api: false,
          job: false,
        }),
      ),
      ...[
        "https://\u0646\u0627\u0645\u0647\u200c\u0627\u06cc.oce.example.internal",
        "https://\u0915\u094d\u200d\u0937.oce.example.internal",
      ].map((baseUrl) => ({ baseUrl, chart: undefined, api: true, job: true })),
      // The API serves plain HTTP anywhere, but the bootstrap Job refuses it off loopback.
      ...[
        "http://console.oce.example.internal",
        "HTTP://console.oce.example.internal",
        "http://192.0.2.10:8080",
        "http://127.0.0.2",
        "http://[::1]:8080",
        "http://localhost.",
        "http://localhost.oce.example.internal",
      ].map((baseUrl) => ({ baseUrl, chart: plainHttp, api: true, job: false })),
      // Deliberately stricter: Node repairs these degenerate spellings into an origin, or
      // reads another IPv4 spelling (shorthand, octal, hex, trailing dot) as 127.0.0.1.
      ...[
        ["https:console.oce.example.internal", notOrigin],
        ["https://console.oce.example.internal/.", notOrigin],
        ["https://console.oce.example.internal/%2e", notOrigin],
        ["http://127.1", plainHttp],
        ["http://2130706433", plainHttp],
        ["http://0177.0.0.1", plainHttp],
        ["http://127.0.0.1.", plainHttp],
      ].map(([baseUrl, chart]) => ({ baseUrl, chart, api: true, job: true })),
    ];
    await eachBounded(cases, async ({ baseUrl, chart, api, job }) => {
      const label = JSON.stringify(baseUrl);
      assert.equal(apiAccepts(baseUrl), api, label);
      assert.equal(
        await jobCode(baseUrl),
        job ? "PERSISTENCE_UNAVAILABLE" : "AUTH_BASE_URL_INVALID",
        label,
      );
      if (chart !== undefined) {
        assert.match(await chartRefusal({ ...values, "auth.baseUrl": baseUrl }), chart, label);
        return;
      }
      const objects = await renderChart({ ...values, "auth.baseUrl": baseUrl });
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
      // The real entrypoint gets past configuration with the rendered value.
      assert.equal(
        await startupCode(directory, { ...environment, OCC_AUTH_BASE_URL: baseUrl }),
        "PERSISTENCE_UNAVAILABLE",
        label,
      );
    });
    // The entrypoint's own code for a value it cannot parse.
    assert.equal(
      await startupCode(directory, {
        ...environment,
        OCC_AUTH_BASE_URL: "console.oce.example.internal",
      }),
      "AUTH_BASE_URL_INVALID",
    );
  },
);

// The chart refuses a listed set of compatibility characters ($baseUrlHostRefused) that the API's
// URL parser refuses in a host. This re-derives the list from Node: of the non-ASCII letters,
// marks, numbers, punctuation and symbols (what the chart's other Unicode checks let through),
// exactly those that URL parsing refuses in every host context tried are listed. The contexts
// put Latin, Arabic, Hebrew and virama neighbours on each side, in every label position, so a
// character refused only by the Bidi or joiner rules, or at a label start, is never listed.
// The refusals follow the IDNA tables of Node's URL parser (ada), so a Node upgrade can change
// them; this test then names the code points to add or remove. JavaScript's Unicode tables can be
// newer than Go's: a listed code point that Go's RE2 reads as unassigned is refused by the chart's
// earlier check instead, which is harmless.
test("the chart lists exactly the compatibility characters the API's URL parser refuses in a host", async () => {
  const helpers = await readFile(
    join(repository, "deploy/helm/openclaw-enterprise/templates/_helpers.tpl"),
    "utf8",
  );
  const [, source] = helpers.match(/\$baseUrlHostRefused := "(\[[^"]+\])"/) ?? [];
  assert.ok(source, "_helpers.tpl defines $baseUrlHostRefused");
  const listed = new RegExp(source.replaceAll("\\\\x{", "\\u{"), "u");
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
        const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
        (isListed ? extra : missing).push(hex);
      }
    }
  }
  assert.ok(count > 0, "the list matches no letter, mark, number, punctuation or symbol");
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});

// The chart's sign-in checks read the scheme as URL parsing does, like the API: an uppercase
// HTTPS origin, or one with surrounding spaces, passes for GitHub, Google and OIDC. Plain HTTP
// stays refused even on loopback, where the bootstrap Job would accept it. The API also requires
// HTTPS for production external sign-in, but only after its database opens, so only the chart's
// refusal is checked here.
test("external sign-in accepts the HTTPS spellings the API accepts", tooling, async (t) => {
  const directory = await startupDirectory(t);
  const cases = [];
  for (const [provider, values, settings] of [
    ["GitHub", githubUpgradeValues(recoveryUserId), githubUpgradeSettings(recoveryUserId)],
    ["Google", googleUpgradeValues(recoveryUserId), googleUpgradeSettings(recoveryUserId)],
    ["OIDC", oidcUpgradeValues(recoveryUserId), oidcUpgradeSettings(recoveryUserId)],
  ]) {
    assert.match(
      await chartRefusal({ ...values, "auth.baseUrl": "http://localhost:8080" }),
      new RegExp(`auth\\.${provider.toLowerCase()} requires an HTTPS auth\\.baseUrl`),
      provider,
    );
    for (const baseUrl of [
      "HTTPS://Console.OCE.example.internal",
      " https://console.oce.example.internal ",
    ]) {
      cases.push({ label: `${provider} ${JSON.stringify(baseUrl)}`, values, settings, baseUrl });
    }
  }
  await eachBounded(cases, async ({ label, values, settings, baseUrl }) => {
    const rendered = signInSettings(
      deploymentEnv(await renderChart({ ...values, "auth.baseUrl": baseUrl }), "api"),
    );
    assert.deepEqual(rendered, { ...settings, OCC_AUTH_BASE_URL: baseUrl }, label);
    assert.equal(await jobCode(baseUrl), "PERSISTENCE_UNAVAILABLE", label);
    assert.equal(
      await startupCode(directory, resolveSecrets(rendered)),
      "PERSISTENCE_UNAVAILABLE",
      label,
    );
  });
});
