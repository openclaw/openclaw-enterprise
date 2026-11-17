import assert from "node:assert/strict";
import { oidcEnrollmentPolicy } from "../../apps/controller/src/auth/oidc-enrollment.ts";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";
import { baseInput, codexInput, externalSignInInput } from "./profile-renderer-inputs.ts";
import {
  repository,
  helmSkip,
  loadYaml,
  helmTemplate,
  render,
  renderCli,
  renderError,
  profileFailure,
  readPreflight,
  assertPreflightFailure,
  propertyAt,
  objectAt,
} from "./profile-renderer-fixture.ts";

// A plain checkout must emit preflight diagnostics when shared-session validation
// dependencies are missing. Copy the renderer sources without node_modules outside
// the repository.
function checkoutWithoutDependencies() {
  const root = mkdtempSync(join(tmpdir(), "oce-profile-checkout-"));
  const sources = [
    "package.json",
    "scripts/render-installation-profile.ts",
    "scripts/lib/prepared-repository-installation.ts",
    "deploy/profiles",
    "apps/controller/package.json",
    "apps/controller/src",
    ...readdirSync(join(repository, "packages"))
      // Skip leftovers of a branch switch, such as a directory holding only node_modules.
      .filter((name) => existsSync(join(repository, "packages", name, "package.json")))
      .flatMap((name) => [`packages/${name}/package.json`, `packages/${name}/src`]),
  ];
  for (const source of sources) {
    cpSync(join(repository, source), join(root, source), {
      recursive: true,
      filter: (path) => !path.split(sep).includes("node_modules"),
    });
  }
  return root;
}

export function registerSignInCases(): void {
  test(
    "profiles carry external sign-in and trusted proxy settings through rerenders",
    { skip: helmSkip },
    async () => {
      const trustedProxy = { preset: "ingress-nginx", cidrs: ["10.42.0.0/16"] };
      const googleDefault = await render("openclaw", externalSignInInput({ trustedProxy }));
      assert.equal(googleDefault.summary.ok, true);
      // Google native browser access remains unsupported.
      assert.match(googleDefault.values, /agentNativeAdmin:\n {2}enabled: false\n/);
      assert.match(googleDefault.values, /recoveryUserId: recovery-admin_1/);
      assert.match(
        googleDefault.values,
        /google:\n {4}enabled: true\n {4}egressCidrs:\n {6}- 140\.82\.112\.0\/20/,
      );
      assert.match(googleDefault.values, /trustedProxy:\n {4}preset: ingress-nginx/);
      assert.doesNotMatch(googleDefault.preflight.warnings.join("\n"), /trustedProxy is not set/);
      assert.doesNotMatch(googleDefault.preflight.prerequisites.join("\n"), /native admin domain/);
      const manifests = helmTemplate(googleDefault);
      assert.match(manifests, /name: OCC_AUTH_GOOGLE_CLIENT_ID/);
      assert.match(manifests, /name: OCC_AUTH_RECOVERY_USER_ID\n\s+value: "recovery-admin_1"/);
      assert.match(manifests, /name: OCC_AUTH_TRUSTED_PROXY_CIDRS\n\s+value: "10\.42\.0\.0\/16"/);
      assert.doesNotMatch(manifests, /OCC_AUTH_GOOGLE_ALLOWED_/);
      // The API reads the scheme as URL parsing does, so an uppercase HTTPS origin is valid.
      const uppercase = await render(
        "openclaw",
        externalSignInInput({ trustedProxy, authBaseUrl: "HTTPS://Console.OCE.example.internal" }),
      );
      assert.equal(uppercase.summary.ok, true, uppercase.preflight.errors.join("\n"));
      assert.match(
        helmTemplate(uppercase),
        /name: OCC_AUTH_BASE_URL\n\s+value: "HTTPS:\/\/Console\.OCE\.example\.internal"/,
      );
      // Password sign-in stays open to every account unless recovery-only is chosen.
      assert.doesNotMatch(googleDefault.values, /passwordSignIn/);
      assert.doesNotMatch(manifests, /OCC_AUTH_PASSWORD_SIGN_IN/);
      assert.doesNotMatch(googleDefault.preflight.prerequisites.join("\n"), /identity attached/);
      const recoveryOnly = await render(
        "openclaw",
        externalSignInInput({ trustedProxy, passwordSignIn: "recovery-only" }),
      );
      assert.equal(recoveryOnly.summary.ok, true);
      assert.match(recoveryOnly.values, /passwordSignIn: recovery-only/);
      assert.match(
        recoveryOnly.preflight.prerequisites.join("\n"),
        /Google or OIDC identity attached to every ordinary account/,
      );
      assert.match(
        helmTemplate(recoveryOnly),
        /name: OCC_AUTH_PASSWORD_SIGN_IN\n\s+value: recovery-only/,
      );

      const google = await render(
        "codex",
        codexInput({
          controlPlane: externalSignInInput({
            google: { allowedDomains: ["example.com"] },
          }).controlPlane,
        }),
      );
      assert.equal(google.summary.ok, true);
      assert.match(
        google.values,
        /google:\n {4}enabled: true\n {4}allowedDomains:\n {6}- example\.com/,
      );
      assert.doesNotMatch(google.values, /github:/);
      assert.match(helmTemplate(google), /name: OCC_AUTH_GOOGLE_ALLOWED_DOMAINS/);

      const oidc = await render(
        "openclaw",
        externalSignInInput({
          google: undefined,
          oidc: {
            issuer: "https://sso.example.com/realms/acme",
            authorizationUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/auth",
            tokenUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/token",
            jwksUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/certs",
            tokenAuth: "client_secret_basic",
            displayName: "Acme SSO",
            egressCidrs: ["198.51.100.0/24"],
          },
        }),
      );
      assert.equal(oidc.summary.ok, true, oidc.preflight.errors.join("\n"));
      assert.match(oidc.values, /oidc:\n {4}enabled: true\n/);
      assert.match(oidc.values, /agentNativeAdmin:\n {2}enabled: true\n/);
      assert.match(oidc.values, /issuer: https:\/\/sso\.example\.com\/realms\/acme\n/);
      assert.doesNotMatch(oidc.values, /google:/);
      const oidcManifests = helmTemplate(oidc);
      assert.match(
        oidcManifests,
        /name: OCC_AUTH_OIDC_ISSUER\n\s+value: "https:\/\/sso\.example\.com\/realms\/acme"/,
      );
      assert.match(
        oidcManifests,
        /name: OCC_AUTH_OIDC_TOKEN_AUTH\n\s+value: "client_secret_basic"/,
      );
      assert.match(oidcManifests, /name: OCC_AUTH_OIDC_DISPLAY_NAME\n\s+value: "Acme SSO"/);
      assert.match(oidcManifests, /name: openclaw-enterprise-api-oidc-login-egress/);
      for (const requireVerifiedEmail of [undefined, true, false, null, "false"]) {
        const input = externalSignInInput({
          google: undefined,
          oidc: {
            issuer: "https://sso.example.com/realms/acme",
            authorizationUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/auth",
            tokenUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/token",
            jwksUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/certs",
            enrollment: {
              admission: { groupsClaim: "groups", anyOf: ["members"] },
              createAccount: { enabled: true, role: null, requireVerifiedEmail },
            },
          },
        });
        if (requireVerifiedEmail === null || typeof requireVerifiedEmail === "string") {
          await assert.rejects(
            () => render("openclaw", input),
            /requireVerifiedEmail must be a boolean/,
          );
        } else {
          const enrolled = await render("openclaw", input);
          assert.equal(enrolled.summary.ok, true, enrolled.preflight.errors.join("\n"));
          assert.equal(
            oidcEnrollmentPolicy(
              propertyAt(loadYaml(enrolled.values), "auth", "oidc", "enrollment"),
            ).createAccount.requireVerifiedEmail,
            requireVerifiedEmail ?? true,
          );
          objectAt(input.controlPlane, "oidc", "enrollment").createAccount = {
            requireVerifiedEmail,
          };
          const admissionOnly = await render("openclaw", input);
          const disabled = oidcEnrollmentPolicy(
            propertyAt(loadYaml(admissionOnly.values), "auth", "oidc", "enrollment"),
          ).createAccount;
          assert.equal(disabled.enabled, false);
          assert.equal(disabled.requireVerifiedEmail, requireVerifiedEmail ?? true);
        }
      }
      // The API trims each OIDC URL with JavaScript's trim before its checks, and so do the chart
      // and the renderer, which keep the value as written.
      const padded = await render(
        "openclaw",
        externalSignInInput({
          google: undefined,
          oidc: {
            issuer: " https://sso.example.com/realms/acme ",
            authorizationUrl: "\thttps://sso.example.com/realms/acme/protocol/openid-connect/auth",
            tokenUrl:
              "\u00a0https://sso.example.com/realms/acme/protocol/openid-connect/token\ufeff",
            jwksUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/certs\u3000",
          },
        }),
      );
      assert.equal(padded.summary.ok, true, padded.preflight.errors.join("\n"));
      assert.match(
        helmTemplate(padded),
        /name: OCC_AUTH_OIDC_ISSUER\n\s+value: " https:\/\/sso\.example\.com\/realms\/acme "/,
      );

      // Password-only installs behind ingress-nginx keep native admin and still trust the proxy.
      const nativeAdmin = await render(
        "openclaw",
        baseInput({ controlPlane: { ...baseInput().controlPlane, trustedProxy } }),
      );
      assert.match(nativeAdmin.values, /agentNativeAdmin:\n {2}enabled: true/);
      assert.match(helmTemplate(nativeAdmin), /name: OCC_AUTH_TRUSTED_PROXY_PRESET/);
    },
  );

  test("profiles require the public suffix list for shared browser sessions", async (t) => {
    const root = checkoutWithoutDependencies();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const input of [baseInput(), externalSignInInput()]) {
      const directory = temporaryDirectorySync(t, "oce-profile-shared-session-");
      const error = await renderError(() => renderCli("openclaw", input, directory, root));
      assert.match(
        profileFailure(error).output,
        /Shared browser sessions need the public suffix list: run pnpm install first\./,
      );
      const preflight = readPreflight(directory);
      assert.equal(preflight.ok, false);
      assert.equal(existsSync(join(directory, "values.yaml")), false);
    }
  });

  test("preflight warns, without failing, when no trusted proxy is set", async () => {
    const googleDefault = await render("openclaw", externalSignInInput());
    assert.equal(googleDefault.summary.ok, true);
    assert.match(
      googleDefault.preflight.warnings.join("\n"),
      /controlPlane\.trustedProxy is not set: .*external sign-in starts have no per-client limit/,
    );
    assert.match(
      googleDefault.preflight.warnings.join("\n"),
      /trustedProxy is not set: .*Behind an HTTP proxy, API calls fail with 403 until it is set\./,
    );
    assert.doesNotMatch(googleDefault.values, /trustedProxy:/);
    const password = await render("openclaw", baseInput());
    assert.equal(password.summary.ok, true);
    assert.match(
      password.preflight.warnings.join("\n"),
      /controlPlane\.trustedProxy is not set: failed password sign-ins are limited per email only/,
    );
    assert.match(
      password.preflight.warnings.join("\n"),
      /trustedProxy is not set: failed password .*Behind an HTTP proxy, API calls fail with 403 until it is set\./,
    );
  });

  test("preflight rejects external sign-in Secret names Kubernetes refuses", async () => {
    const oidc = {
      issuer: "https://tenant.idp.example.test/",
      authorizationUrl: "https://tenant.idp.example.test/authorize",
      tokenUrl: "https://tenant.idp.example.test/oauth/token",
      jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
    };
    for (const [provider, signIn] of [
      ["google", { google: { secretName: "Bad_Name" } }],
      ["oidc", { google: undefined, oidc: { ...oidc, secretName: "Bad_Name" } }],
    ] as const) {
      await assertPreflightFailure(
        "openclaw",
        externalSignInInput(signIn),
        new RegExp(`controlPlane\\.${provider}\\.secretName must be a Kubernetes resource name`),
      );
    }
    for (const signIn of [
      { google: { secretName: "google.login-v2" } },
      { google: undefined, oidc: { ...oidc, secretName: "oidc.login-v2" } },
    ]) {
      assert.equal((await render("openclaw", externalSignInInput(signIn))).summary.ok, true);
    }
  });

  test("preflight rejects external sign-in and trusted proxy inputs Helm would reject", async () => {
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ github: {} }),
      /controlPlane.github was removed/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ recoveryUserId: undefined }),
      /controlPlane.recoveryUserId is required with controlPlane.google or controlPlane.oidc/,
    );
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, recoveryUserId: "admin" } }),
      /controlPlane.recoveryUserId requires controlPlane.google or controlPlane.oidc/,
    );
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, passwordSignIn: "recovery-only" } }),
      /controlPlane.passwordSignIn requires controlPlane.google or controlPlane.oidc/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ passwordSignIn: "none" }),
      /controlPlane.passwordSignIn must be all or recovery-only/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ sharedCookieDomain: "oce.example.internal" }),
      /controlPlane.sharedCookieDomain is not supported/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ authBaseUrl: "http://console.oce.example.internal" }),
      /controlPlane.authBaseUrl must use HTTPS with external sign-in/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ google: { clientSecret: "inline" } }),
      /controlPlane.google.clientSecret is not supported/,
    );
    for (const [provider, key, value] of [
      ["google", "clientIdKey", "bad/key"],
      ["google", "clientSecretKey", "."],
      ["google", "clientSecretKey", "a".repeat(254)],
      ["google", "clientIdKey", "..client-id"],
      ["oidc", "clientIdKey", "bad/key"],
      ["oidc", "clientSecretKey", "..client-secret"],
    ] as const) {
      await assertPreflightFailure(
        "openclaw",
        externalSignInInput({
          google: undefined,
          [provider]:
            provider === "oidc"
              ? {
                  issuer: "https://tenant.idp.example.test/",
                  authorizationUrl: "https://tenant.idp.example.test/authorize",
                  tokenUrl: "https://tenant.idp.example.test/oauth/token",
                  jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
                  [key]: value,
                }
              : { [key]: value },
        }),
        new RegExp(`controlPlane\\.${provider}\\.${key} must be a Kubernetes Secret key`),
      );
    }
    for (const signIn of [
      { google: { clientIdKey: ".hidden" } },
      { google: { clientSecretKey: "a".repeat(253) } },
    ]) {
      assert.equal((await render("openclaw", externalSignInInput(signIn))).summary.ok, true);
    }
    const oidc = {
      issuer: "https://tenant.idp.example.test/",
      authorizationUrl: "https://tenant.idp.example.test/authorize",
      tokenUrl: "https://tenant.idp.example.test/oauth/token",
      jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
    };
    for (const [override, message] of [
      [
        { issuer: "http://tenant.idp.example.test/" },
        /controlPlane.oidc.issuer must be an https URL/,
      ],
      [{ issuer: "https://203.0.113.10/" }, /controlPlane.oidc.issuer must be an https URL/],
      // Like the chart and the API: an explicit port on the issuer, and a value padded with
      // U+0085, which JavaScript's trim keeps.
      [
        { issuer: "https://tenant.idp.example.test:443/" },
        /controlPlane.oidc.issuer must be an https URL/,
      ],
      [
        { issuer: "\u0085https://tenant.idp.example.test/" },
        /controlPlane.oidc.issuer must be an https URL/,
      ],
      // Like the chart, though URL parsing repairs these into the issuer's host: a tab or a
      // percent-escape in the host, backslashes, and a host that is not spelled in ASCII.
      ...[
        "https://tenant.idp.exam\tple.test/",
        "https://tenant.idp.example.%74est/",
        "https:\\\\tenant.idp.example.test\\",
        "https://tenant.idp.examplé.test/",
        // A host longer than 253 characters.
        `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.test/`,
      ].map((issuer): [Record<string, unknown>, RegExp] => [
        { issuer },
        /controlPlane.oidc.issuer must be an https URL/,
      ]),
      [
        { tokenUrl: "https://tenant.idp.exam\tple.test/oauth/token" },
        /controlPlane.oidc.tokenUrl must be an https URL on port 443 on the issuer's host/,
      ],
      [
        { tokenUrl: "https://other.example.test/token" },
        /controlPlane.oidc.tokenUrl must be an https URL on port 443 on the issuer's host/,
      ],
      [
        { jwksUrl: "https://tenant.idp.example.test:8443/jwks" },
        /controlPlane.oidc.jwksUrl must be an https URL on port 443 on the issuer's host/,
      ],
      [
        { authorizationUrl: "https://tenant.idp.example.test/authorize?x=1" },
        /controlPlane.oidc.authorizationUrl must be an https URL/,
      ],
      [{ tokenAuth: "private_key_jwt" }, /controlPlane.oidc.tokenAuth must be client_secret_post/],
      [{ displayName: "x".repeat(41) }, /controlPlane.oidc.displayName must be 1 to 40/],
      [{ discoveryUrl: "https://tenant.idp.example.test/" }, /controlPlane.oidc.discoveryUrl/],
    ] satisfies [Record<string, unknown>, RegExp][]) {
      await assertPreflightFailure(
        "openclaw",
        externalSignInInput({ google: undefined, oidc: { ...oidc, ...override } }),
        message,
      );
    }
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ google: undefined, oidc: { ...oidc, jwksUrl: undefined } }),
      /controlPlane.oidc.jwksUrl must be a nonempty string/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ trustedProxy: { preset: "generic", cidrs: ["10.42.0.0/16"] } }),
      /controlPlane.trustedProxy.clientAddressHeader is required for the generic preset/,
    );
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ trustedProxy: { preset: "ingress-nginx", cidrs: ["0.0.0.0/0"] } }),
      /controlPlane.trustedProxy.cidrs\[0\] must be/,
    );
  });

  test("profiles refuse installation names the chart and the bootstrap Job refuse", async () => {
    const accepted = await render(
      "openclaw",
      baseInput({
        controlPlane: { ...baseInput().controlPlane, clusterName: "n".repeat(200) },
      }),
    );
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    assert.match(accepted.values, /name: n{200}\n/);
    for (const clusterName of [" profile", `${"n".repeat(201)}`, "bad\nname", "\uD800"]) {
      await assertPreflightFailure(
        "openclaw",
        baseInput({ controlPlane: { ...baseInput().controlPlane, clusterName } }),
        /controlPlane.clusterName must be 1 to 200 characters/,
      );
    }
  });
}
