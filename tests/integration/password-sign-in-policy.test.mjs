import assert from "node:assert/strict";
import test from "node:test";
import {
  humanLoginConfiguration,
  passwordSignInPolicy,
} from "../../apps/controller/src/auth/index.ts";

const github = {
  OCC_AUTH_GITHUB_CLIENT_ID: "policy-client-id",
  OCC_AUTH_GITHUB_CLIENT_SECRET: "policy-client-secret",
  OCC_AUTH_GITHUB_RECOVERY_USER_ID: "policy-recovery-user",
};
const google = {
  OCC_AUTH_GOOGLE_CLIENT_ID: "policy.apps.googleusercontent.com",
  OCC_AUTH_GOOGLE_CLIENT_SECRET: "policy-google-secret",
  OCC_AUTH_GITHUB_RECOVERY_USER_ID: "policy-recovery-user",
};
const oidc = {
  OCC_AUTH_OIDC_ISSUER: "https://idp.example.com/realms/policy",
  OCC_AUTH_OIDC_AUTHORIZATION_URL: "https://idp.example.com/realms/policy/auth",
  OCC_AUTH_OIDC_TOKEN_URL: "https://idp.example.com/realms/policy/token",
  OCC_AUTH_OIDC_JWKS_URL: "https://idp.example.com/realms/policy/certs",
  OCC_AUTH_OIDC_CLIENT_ID: "policy-oidc-client",
  OCC_AUTH_OIDC_CLIENT_SECRET: "policy-oidc-secret",
  OCC_AUTH_GITHUB_RECOVERY_USER_ID: "policy-recovery-user",
};

test("password sign-in defaults to every account and accepts only all or recovery-only", () => {
  assert.equal(passwordSignInPolicy({}), "all");
  assert.equal(passwordSignInPolicy({ OCC_AUTH_PASSWORD_SIGN_IN: "" }), "all");
  assert.equal(passwordSignInPolicy({ OCC_AUTH_PASSWORD_SIGN_IN: "all" }), "all");
  assert.equal(
    passwordSignInPolicy({ OCC_AUTH_PASSWORD_SIGN_IN: " recovery-only " }),
    "recovery-only",
  );
  for (const value of ["none", "Recovery-Only", "recovery", "false"]) {
    assert.throws(
      () => passwordSignInPolicy({ OCC_AUTH_PASSWORD_SIGN_IN: value }),
      /OCC_AUTH_PASSWORD_SIGN_IN must be all or recovery-only/,
      value,
    );
  }
});

test("recovery-only password sign-in requires GitHub, Google or OIDC sign-in", () => {
  // Without a provider it would leave only the recovery account able to sign in.
  assert.throws(
    () => humanLoginConfiguration({ OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" }),
    /OCC_AUTH_PASSWORD_SIGN_IN=recovery-only requires GitHub, Google or OIDC sign-in/,
  );
  assert.deepEqual(humanLoginConfiguration({ OCC_AUTH_PASSWORD_SIGN_IN: "all" }), {});
  for (const environment of [github, google, oidc, { ...github, ...google, ...oidc }]) {
    const all = humanLoginConfiguration(environment);
    assert.equal(all.passwordSignIn, undefined, "the default is not carried");
    assert.equal(
      humanLoginConfiguration({ ...environment, OCC_AUTH_PASSWORD_SIGN_IN: "recovery-only" })
        .passwordSignIn,
      "recovery-only",
    );
  }
});
