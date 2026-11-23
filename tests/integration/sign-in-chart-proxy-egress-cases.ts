import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createControllerAuth,
  clientAddressConfiguration,
  humanLoginConfiguration,
} from "../../apps/controller/src/auth/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import type { ChartValues } from "../helpers/production-chart-network-fixture.ts";
import { deploymentEnv, signInSettings } from "../helpers/sign-in-chart.ts";
import {
  defaultInstallSettings,
  googleUpgradeSettings,
  googleUpgradeValues,
  oidcUpgradeSettings,
  oidcUpgradeValues,
} from "../helpers/production-sign-in.mjs";
import {
  apiEnvironment,
  definedOnly,
  entrypointCode,
  jobEnvironment,
  jobRefusal,
  notice,
  recoveryUserId,
  refusal,
  render,
  resolveSecrets,
  settle,
  startsUp,
  startupCode,
  tooling,
} from "./sign-in-chart-parity-fixture.ts";

// A trusted-proxy preset as operators set it, and the API settings the chart renders for it.
function trustedProxy(preset: string, cidrs: string[] = [], header?: string) {
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
export const presets: Readonly<
  Record<
    string,
    {
      values: ChartValues;
      env: Readonly<Record<string, string>>;
      parsed: { header: string; proxy: string } | undefined;
    }
  >
> = {
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
  ] as const,
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

const googleWithNativeAdmin = {
  name: "Google with shared-cookie native administration",
  values: googleOn,
  chart: /auth\.google requires agentNativeAdmin\.enabled: false/,
  base: "google",
  code: "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
  env: {
    OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
  },
} as const;

// Values the chart refuses, the API env they stand for on top of `base`'s settings, and the
// parser's refusal; each stops the API with `code`, or STARTUP_FAILED.
type RefusedSignInCase = {
  name: string;
  values: ChartValues;
  chart: RegExp;
  env: NodeJS.ProcessEnv;
  base?: "google" | "oidc";
  parser?: RegExp;
  code?: string;
};

const invalid: readonly RefusedSignInCase[] = [
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
    name: "a recovery user without Google or OIDC",
    values: { "auth.recoveryUserId": recoveryUserId },
    chart: /auth\.recoveryUserId requires auth\.google\.enabled or auth\.oidc\.enabled/,
    env: { OCC_AUTH_RECOVERY_USER_ID: recoveryUserId },
    parser: /requires client ID, client secret and recovery user ID/,
  },
  {
    name: "recovery-only password sign-in without an external provider",
    values: { "auth.passwordSignIn": "recovery-only" },
    chart:
      /auth\.passwordSignIn: recovery-only requires auth\.google\.enabled or auth\.oidc\.enabled/,
    env: { OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" },
    parser: /OCC_AUTH_PASSWORD_SIGN_IN=recovery-only requires Google or OIDC sign-in/,
  },
  {
    name: "an unknown password sign-in policy",
    values: { ...googleUpgradeValues(recoveryUserId), "auth.passwordSignIn": "none" },
    chart: /auth\.passwordSignIn must be all or recovery-only/,
    base: "google",
    env: { OCC_AUTH_PASSWORD_SIGN_IN: "none" },
    parser: /OCC_AUTH_PASSWORD_SIGN_IN must be all or recovery-only/,
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
    base: "google",
    env: { OCC_AUTH_RECOVERY_USER_ID: undefined },
    parser: /Google sign-in requires client ID, client secret and recovery user ID/,
  },
  googleWithNativeAdmin,
  ...(
    [
      ["padded by U+0085", "\u0085example.com"],
      ["spelled with U+0130", "\u0130bm.com"],
      ["that is not a DNS name", "example.com/admin"],
    ] as const
  ).map<RefusedSignInCase>(([name, domain]) => ({
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
    env: { OCC_AUTH_RECOVERY_USER_ID: undefined },
    parser: /OIDC sign-in requires its provider settings and a recovery user ID/,
  },
  {
    name: "OIDC without a token URL",
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.tokenUrl": "" },
    chart: /auth\.oidc\.tokenUrl must be an https URL on port 443 with a DNS host name/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_TOKEN_URL: "" },
    parser: /OIDC sign-in requires issuer, authorization URL, token URL/,
  },
  ...(
    [
      ["an HTTP issuer", "http://tenant.idp.example.test/"],
      ["an issuer on another port", "https://tenant.idp.example.test:8443/"],
      // The URL parser drops `:443`, but `iss` is compared with the configured string.
      ["an issuer with an explicit port 443", "https://tenant.idp.example.test:443/"],
      ["an IP-address issuer", "https://203.0.113.10/"],
      ["an issuer with a query", "https://tenant.idp.example.test/?t=1"],
      // JavaScript's trim keeps U+0085, though Go's TrimSpace strips it.
      ["an issuer padded with U+0085", "\u0085https://tenant.idp.example.test/"],
    ] as const
  ).map<RefusedSignInCase>(([name, value]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.issuer": value },
    chart: /auth\.oidc\.issuer must be an https URL on port 443 with a DNS host name/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_ISSUER: value },
    parser: /OCC_AUTH_OIDC_ISSUER must be an https URL/,
  })),
  ...(
    [
      ["a link-local IP token URL", "tokenUrl", "TOKEN_URL", "https://169.254.169.254/token"],
      ["a Unicode-folded token host", "tokenUrl", "TOKEN_URL", "https://toKen.example.test/token"],
      ["a Unicode-folded JWKS host", "jwksUrl", "JWKS_URL", "https://ſso.example.test/jwks"],
      [
        "a Unicode-folded HTTPS scheme",
        "tokenUrl",
        "TOKEN_URL",
        "httpſ://oauth2.example.test/token",
      ],
      ["userinfo in the JWKS URL", "jwksUrl", "JWKS_URL", "https://u@tenant.idp.example.test/jwks"],
      [
        "a fragment in the authorization URL",
        "authorizationUrl",
        "AUTHORIZATION_URL",
        "https://tenant.idp.example.test/authorize#x",
      ],
      ["an HTTP JWKS URL", "jwksUrl", "JWKS_URL", "http://tenant.idp.example.test/jwks"],
    ] as const
  ).map<RefusedSignInCase>(([name, key, suffix, value]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), [`auth.oidc.${key}`]: value },
    chart: new RegExp(`auth\\.oidc\\.${key} must be an https URL on port 443 with a DNS host name`),
    base: "oidc",
    env: { [`OCC_AUTH_OIDC_${suffix}`]: value },
    parser: new RegExp(
      `OCC_AUTH_OIDC_${suffix} must be an https URL on port 443 with a DNS host name`,
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
  ...(
    [
      ["a display name padded by U+0085", "\u0085Continue"],
      ["an overlong label", "x".repeat(41)],
    ] as const
  ).map<RefusedSignInCase>(([name, displayName]) => ({
    name: `OIDC with ${name}`,
    values: { ...oidcUpgradeValues(recoveryUserId), "auth.oidc.displayName": displayName },
    chart: /auth\.oidc\.displayName must be 1 to 40 printable characters/,
    base: "oidc",
    env: { OCC_AUTH_OIDC_DISPLAY_NAME: displayName },
    parser: /OCC_AUTH_OIDC_DISPLAY_NAME must be 1 to 40 printable characters/,
  })),
];
const baseSettings = {
  google: googleUpgradeSettings(recoveryUserId),
  oidc: oidcUpgradeSettings(recoveryUserId),
};

// A pattern list the chart's _helpers.tpl defines, such as $baseUrlHostRefused, as a JavaScript
// Secret placement and egress are chart concerns: the API only ever sees the resolved
// credentials, so these refusals have no parser counterpart.
const chartOnly = (
  provider: string,
  cases: readonly [name: string, values: ChartValues, chart: RegExp][],
) =>
  settle(
    cases.map(async ([name, values, chart]) => {
      assert.match(await refusal(values), chart, `${provider}: ${name}`);
    }),
  );

export function registerProxyAndEgressCases() {
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
      const environment = resolveSecrets(rendered);
      const cidrList = environment.OCC_AUTH_TRUSTED_PROXY_CIDRS;
      assert.ok(cidrList, "The API must receive the trusted proxy CIDRs.");
      const cidrs = cidrList.split(",");
      assert.deepEqual(
        cidrs,
        trustedProxyCidrs.accepted.map(([cidr]) => cidr),
      );
      for (const [cidr, address] of trustedProxyCidrs.accepted) {
        const config = clientAddressConfiguration({
          ...environment,
          OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr,
        });
        assert.ok(config, cidr);
        assert.equal(config.trusts(address), true, cidr);
        assert.equal(config.trusts("8.8.8.8"), cidr === "8.0.0.0/8", cidr);
      }
    },
  );

  test("values the chart refuses are settings the API also refuses", tooling, async () => {
    await settle(
      invalid.map(async ({ name, values, chart, base, env, parser, code }) => {
        const environment = definedOnly({
          ...resolveSecrets(base === undefined ? defaultInstallSettings : baseSettings[base]),
          ...env,
        });
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
      ...googleUpgradeSettings(recoveryUserId),
      ...oidcUpgradeSettings(recoveryUserId),
      OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
    });
    const nativeAdmin = googleWithNativeAdmin;
    const redactedMarker = "chart-parity-synthetic-url-marker";
    const userinfoUrl = syntheticCredentialUrl({
      username: "parity",
      password: redactedMarker,
      host: "console.oce.example.internal",
    });
    const apiCases: readonly [settings: NodeJS.ProcessEnv, code: string][] = [
      // Past configuration, Driver loading and composition, to the database.
      [everyProvider, "PERSISTENCE_UNAVAILABLE"],
      // Refused by configuration, and by composition before any database work.
      [{ ...everyProvider, OCC_AUTH_BASE_URL: "https://192.168.010.001" }, "AUTH_BASE_URL_INVALID"],
      [{ ...everyProvider, OCC_AUTH_BASE_URL: userinfoUrl }, "AUTH_BASE_URL_INVALID"],
      [
        { ...resolveSecrets(baseSettings[nativeAdmin.base]), ...nativeAdmin.env },
        "EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED",
      ],
    ];
    const api = apiCases.map(async ([settings, code]) => {
      const label = `API ${code}`;
      assert.equal(await startupCode(settings), code, label);
      assert.equal(
        await entrypointCode(
          "apps/controller/src/server.mjs",
          "startup-error",
          apiEnvironment(settings),
          redactedMarker,
        ),
        code,
        label,
      );
    });
    const jobCases = [
      ["https://console.oce.example.internal", undefined, "PERSISTENCE_UNAVAILABLE"],
      ["http://console.oce.example.internal", "AUTH_BASE_URL_INVALID", "AUTH_BASE_URL_INVALID"],
      [userinfoUrl, "AUTH_BASE_URL_INVALID", "AUTH_BASE_URL_INVALID"],
    ] as const;
    const job = jobCases.map(async ([baseUrl, refused, code]) => {
      assert.equal(jobRefusal(baseUrl), refused, "Bootstrap configuration");
      assert.equal(
        await entrypointCode(
          "scripts/bootstrap-installation.mjs",
          "installation.bootstrap-failed",
          jobEnvironment(baseUrl),
          redactedMarker,
        ),
        code,
        "Bootstrap startup",
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
      assert.ok(parsed);
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
      const proxied = Object.values(presets).filter(({ parsed }) => parsed !== undefined);
      const [google, oidc, none, ...quiet] = await settle([
        notice(googleUpgradeValues(recoveryUserId)),
        notice(oidcUpgradeValues(recoveryUserId)),
        notice(),
        ...proxied.flatMap(({ values }) => [
          notice({ ...googleUpgradeValues(recoveryUserId), ...values }),
          notice(values),
        ]),
      ]);
      assert.match(google, /^WARNING: api\.trustedProxy is not set\./);
      assert.match(oidc, /^WARNING: api\.trustedProxy is not set\. With Google or OIDC/);
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
    // `auth.google: null` (or `--set auth.google=null`) deletes the map's defaults. The chart
    // must then render the password-only install without a trusted proxy, as validation and
    // the install notes already assume, instead of failing with a template nil pointer.
    await settle(
      ["auth.google", "auth.oidc", "api.trustedProxy"].map(async (key) => {
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
    "shared sessions derive DNS scope with native access enabled or disabled",
    tooling,
    async () => {
      for (const enabled of ["true", "false"]) {
        const values = {
          "agentNativeAdmin.enabled": enabled,
          "agentNativeAdmin.domain": "agents.oce.example.com",
        };
        for (const [baseUrl, domain] of [
          ["https://console.oce.example.com", "oce.example.com"],
          ["https://console.example.com", "example.com"],
          ["https://Console.OCE.example.com.", "oce.example.com"],
        ] as const) {
          const auth = createControllerAuth({
            mode: "production",
            installationId: "ins_cookie_scope",
            secret: "s".repeat(32),
            baseURL: new URL(baseUrl).origin,
            agentDomain: "agents.oce.example.com",
          });
          assert.equal(auth.sharedCookieDomain, domain);
          await render({ ...values, "auth.baseUrl": baseUrl });
        }
        for (const baseUrl of ["http://console.oce.example.com", "https://console.other.net"]) {
          assert.throws(
            () =>
              createControllerAuth({
                mode: "production",
                installationId: "ins_cookie_scope",
                secret: "s".repeat(32),
                baseURL: baseUrl,
                agentDomain: "agents.oce.example.com",
              }),
            { message: /OCC_AUTH_BASE_URL|Console and Agent hostnames/ },
          );
          assert.match(
            await refusal({ ...values, "auth.baseUrl": baseUrl }),
            /HTTPS for (?:shared )?browser sessions|must share a non-public DNS suffix/,
          );
        }
        assert.match(
          await refusal({ ...values, "agentNativeAdmin.sharedCookieDomain": "example.com" }),
          /sharedCookieDomain is no longer supported/,
        );
      }
      const oidc = { ...oidcUpgradeValues(recoveryUserId), "agentNativeAdmin.enabled": "true" };
      const settings = resolveSecrets(signInSettings(deploymentEnv(await render(oidc), "api")));
      await startsUp(settings, "OIDC and native browser access");
      assert.equal(
        await startupCode({ ...settings, OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal" }),
        "AUTH_BASE_URL_INVALID",
      );
    },
  );
}
