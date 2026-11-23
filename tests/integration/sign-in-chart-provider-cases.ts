import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientAddressConfiguration,
  humanLoginConfiguration,
  resolveClientAddress,
} from "../../apps/controller/src/auth/index.ts";
import { assertSecretMount, deploymentEnv, signInSettings } from "../helpers/sign-in-chart.ts";
import {
  defaultInstallSettings,
  fixtureOidcIssuer,
  googleUpgradeSettings,
  googleUpgradeValues,
  oidcUpgradeSettings,
  oidcUpgradeValues,
} from "../helpers/production-sign-in.mjs";
import {
  type AcceptedSignInCase,
  acceptsEach,
  googleParsed,
  recoveryUserId,
  render,
  renders,
  resolveSecrets,
  secrets,
  settle,
  startsUp,
  tooling,
} from "./sign-in-chart-parity-fixture.ts";
import { presets } from "./sign-in-chart-proxy-egress-cases.ts";

export function registerProviderCases() {
  test(
    "the API accepts exactly the sign-in settings the chart renders for every proxy preset, with and without Google",
    tooling,
    async () => {
      const cases = Object.entries(presets).flatMap(([preset, proxy]) =>
        [false, true].map((googleEnabled) => ({ preset, proxy, googleEnabled })),
      );
      await settle(
        cases.map(async ({ preset, proxy, googleEnabled }) => {
          const label = `${preset}, Google ${googleEnabled ? "on" : "off"}`;
          // Reuse these renders to cover the example install's egress and Secret
          // placement: only the API receives sign-in and trusted-proxy settings.
          const environment = await renders(
            label,
            { ...proxy.values, ...(googleEnabled ? googleUpgradeValues(recoveryUserId) : {}) },
            {
              ...(googleEnabled ? googleUpgradeSettings(recoveryUserId) : defaultInstallSettings),
              ...proxy.env,
            },
          );
          assert.deepEqual(
            humanLoginConfiguration(environment).google,
            googleEnabled ? googleParsed : undefined,
            label,
          );
          const clientAddress = clientAddressConfiguration(environment);
          if (proxy.parsed === undefined) {
            assert.equal(clientAddress, undefined, label);
          } else {
            assert.ok(clientAddress, label);
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

  test(
    "the API accepts sign-in values padded by U+FEFF, which Go trim keeps",
    tooling,
    async () => {
      // Go's TrimSpace keeps U+FEFF, so the chart used to refuse these. JavaScript's trim drops
      // it, and the chart now uses that trim. The rendered env keeps the character.
      const domain = "\uFEFFexample.com";
      const displayName = "\uFEFFContinue";
      const objects = await render({
        ...googleUpgradeValues(recoveryUserId),
        ...oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, { displayName }),
        "auth.google.allowedDomains[0]": domain,
      });
      const rendered = signInSettings(deploymentEnv(objects, "api"));
      assert.equal(rendered.OCC_AUTH_GOOGLE_ALLOWED_DOMAINS, domain);
      assert.equal(rendered.OCC_AUTH_OIDC_DISPLAY_NAME, displayName);
      const environment = resolveSecrets(rendered);
      const parsed = humanLoginConfiguration(environment);
      assert.ok(parsed.google && parsed.oidc);
      assert.deepEqual(parsed.google.allowedDomains, ["example.com"]);
      assert.equal(parsed.oidc.displayName, "Continue");
      await startsUp(environment);
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
      const environment = resolveSecrets(rendered);
      const { oidc } = humanLoginConfiguration(environment);
      assert.ok(oidc);
      assert.equal(oidc.displayName, "single sign-on");
      await startsUp(environment);
    },
  );

  test(
    "the API accepts exactly the Google sign-in settings the chart renders, with hosted domains",
    tooling,
    async () => {
      const domains = ["example.com", "corp.example.org"];
      await acceptsEach([
        {
          label: "Google only",
          values: googleUpgradeValues(recoveryUserId),
          settings: googleUpgradeSettings(recoveryUserId),
          parsed: { google: googleParsed },
        },
        {
          label: "Google only, hosted domains",
          values: googleUpgradeValues(recoveryUserId, domains),
          settings: googleUpgradeSettings(recoveryUserId, domains),
          parsed: { google: { ...googleParsed, allowedDomains: domains } },
        },
        {
          // The default is not rendered: the API reads an absent setting as "all".
          label: "Google, password sign-in for every account",
          values: { ...googleUpgradeValues(recoveryUserId), "auth.passwordSignIn": "all" },
          settings: googleUpgradeSettings(recoveryUserId),
          parsed: { google: googleParsed },
        },
      ]);
    },
  );

  test(
    "the API accepts exactly the OIDC sign-in settings the chart renders, alone and with Google",
    tooling,
    async () => {
      const oidc: NonNullable<AcceptedSignInCase["parsed"]["oidc"]> = {
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
      const split = {
        issuer: "https://accounts.idp.example.test",
        authorizationUrl: "https://accounts.idp.example.test/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.idp.example.test/token",
        jwksUrl: "https://www.idp.example.test/oauth2/v3/certs",
      };
      const extra = { tokenAuth: "client_secret_basic", displayName: "Acme SSO" } as const;
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
      const oidcOnly = (
        label: string,
        parsed: NonNullable<AcceptedSignInCase["parsed"]["oidc"]>,
        issuer: Parameters<typeof oidcUpgradeSettings>[1] = fixtureOidcIssuer,
        extra?: Parameters<typeof oidcUpgradeSettings>[2],
      ): AcceptedSignInCase => ({
        label,
        values: oidcUpgradeValues(recoveryUserId, issuer, extra),
        settings: oidcUpgradeSettings(recoveryUserId, issuer, extra),
        parsed: { oidc: parsed },
      });
      // The mounted file path must match the value the selected container reads.
      const placement = render({
        ...oidcUpgradeValues(recoveryUserId),
        "installation.secretName": "parity-installation",
        "installation.key": "parity-startup.yaml",
        "gatewayRouting.apiKeySecretName": "parity-gateway",
        "auth.oidc.secretName": "parity-oidc",
        "auth.oidc.clientIdKey": "parity-client-id",
        "auth.oidc.clientSecretKey": "parity-client-secret",
      }).then((objects) => {
        for (const component of ["api", "worker"] as const) {
          assertSecretMount(objects, component, {
            volume: "installation-startup",
            secret: "parity-installation",
            key: "parity-startup.yaml",
            itemPath: "installation.yaml",
            mountPath: "/etc/openclaw/installation",
            variable: "OCC_CONFIG_PATH",
          });
          assertSecretMount(objects, component, {
            volume: "gateway-api-key",
            secret: "parity-gateway",
            key: "occ",
            itemPath: "key",
            mountPath: "/etc/openclaw/gateway-api-key",
            variable: "OCC_GATEWAY_API_KEY_PATH",
          });
        }
        const credentials = deploymentEnv(objects, "api").filter(({ name }) =>
          /^OCC_AUTH_OIDC_CLIENT_(ID|SECRET)$/.test(name),
        );
        assert.deepEqual(credentials, [
          {
            name: "OCC_AUTH_OIDC_CLIENT_ID",
            valueFrom: { secretKeyRef: { name: "parity-oidc", key: "parity-client-id" } },
          },
          {
            name: "OCC_AUTH_OIDC_CLIENT_SECRET",
            valueFrom: { secretKeyRef: { name: "parity-oidc", key: "parity-client-secret" } },
          },
        ]);
        assert.ok(
          !deploymentEnv(objects, "worker").some(({ name }) => name.startsWith("OCC_AUTH_OIDC_")),
        );
      });
      await settle([
        placement,
        acceptsEach([
          oidcOnly("OIDC, URLs padded with whitespace the API trims", oidc, padded),
          oidcOnly(
            "OIDC, an issuer without a path, padded with whitespace the API trims",
            { ...oidc, ...bare },
            paddedBare,
          ),
          oidcOnly("OIDC only", oidc),
          oidcOnly(
            "OIDC with independently configured endpoint hosts",
            { ...oidc, ...split },
            split,
          ),
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
            label: "Google and OIDC, recovery-only password sign-in",
            values: {
              ...googleUpgradeValues(recoveryUserId),
              ...oidcUpgradeValues(recoveryUserId),
              "auth.passwordSignIn": "recovery-only",
            },
            settings: {
              ...googleUpgradeSettings(recoveryUserId),
              ...oidcUpgradeSettings(recoveryUserId),
              OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only",
            },
            parsed: {
              google: googleParsed,
              oidc,
              passwordSignIn: "recovery-only",
            },
          },
        ]),
      ]);
    },
  );
}
