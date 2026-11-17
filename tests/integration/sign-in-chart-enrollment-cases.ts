import assert from "node:assert/strict";
import { test } from "node:test";
import { humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import { deploymentEnv, signInSettings } from "../helpers/sign-in-chart.ts";
import type { ChartValues } from "../helpers/production-chart-network-fixture.ts";
import {
  fixtureOidcIssuer,
  googleUpgradeValues,
  oidcUpgradeValues,
} from "../helpers/production-sign-in.mjs";
import {
  recoveryUserId,
  refusal,
  render,
  resolveSecrets,
  startsUp,
  tooling,
} from "./sign-in-chart-parity-fixture.ts";

export function registerEnrollmentCases() {
  test(
    "OIDC enrollment survives Helm rendering and retired GitHub settings fail closed",
    tooling,
    async () => {
      const objects = await render(
        oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, {
          "enrollment.admission.groupsClaim": "groups",
          "enrollment.admission.anyOf[0]": "example:engineering",
          "enrollment.additionalScopes[0]": "groups",
          "enrollment.createAccount.enabled": "true",
          "enrollment.createAccount.role.id": "role_config_member",
          "enrollment.createAccount.role.scope": "all",
          "enrollment.groupIds[0]": "group_config_members",
        }),
      );
      const environment = resolveSecrets(signInSettings(deploymentEnv(objects, "api")));
      const { oidc } = humanLoginConfiguration(environment);
      assert.ok(oidc);
      assert.deepEqual(oidc.enrollment, {
        admission: { groupsClaim: "groups", anyOf: ["example:engineering"] },
        additionalScopes: ["groups"],
        createAccount: {
          enabled: true,
          role: { id: "role_config_member", scope: "all" },
          requireVerifiedEmail: true,
        },
        groupIds: ["group_config_members"],
      });
      assert.ok(
        !deploymentEnv(objects, "worker").some(({ name }) => name === "OCC_AUTH_OIDC_ENROLLMENT"),
      );
      for (const requireVerifiedEmail of [true, false]) {
        const rendered = await render(
          oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, {
            "enrollment.admission.groupsClaim": "groups",
            "enrollment.admission.anyOf[0]": "members",
            "enrollment.createAccount.enabled": "true",
            "enrollment.createAccount.role.id": "role_config_member",
            "enrollment.createAccount.role.scope": "all",
            "enrollment.createAccount.requireVerifiedEmail": String(requireVerifiedEmail),
          }),
        );
        const configured = humanLoginConfiguration(
          resolveSecrets(signInSettings(deploymentEnv(rendered, "api"))),
        );
        const createAccount = configured.oidc?.enrollment?.createAccount;
        assert.ok(createAccount, "Rendered OIDC enrollment must configure account creation.");
        assert.equal(createAccount.requireVerifiedEmail, requireVerifiedEmail);
      }
      assert.match(
        await refusal(
          oidcUpgradeValues(recoveryUserId, fixtureOidcIssuer, {
            "enrollment.admission.groupsClaim": "groups",
            "enrollment.admission.anyOf[0]": "members",
            "enrollment.createAccount.requireVerifiedEmail": "sometimes",
          }),
        ),
        /requireVerifiedEmail must be a boolean/,
      );
      for (const requireVerifiedEmail of [null, "true", 0, [], {}]) {
        assert.throws(
          () =>
            humanLoginConfiguration({
              ...environment,
              OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
                admission: { groupsClaim: "groups", anyOf: ["members"] },
                createAccount: { enabled: true, role: null, requireVerifiedEmail },
              }),
            }),
          /requireVerifiedEmail must be a boolean/,
        );
      }

      assert.match(await refusal({ "auth.github.enabled": "false" }), /auth.github was removed/);
      assert.match(
        await refusal({ "auth.oidc.enrollment.admission.groupsClaim": "groups" }),
        /requires auth.oidc.enabled/,
      );
      assert.throws(
        () => humanLoginConfiguration({ ...environment, OCC_AUTH_GITHUB_CLIENT_ID: "" }),
        /retired/,
      );
      for (const policy of [
        { admission: { groupsClaim: "groups", anyOf: [] } },
        {
          admission: { groupsClaim: "groups", anyOf: ["members"] },
          createAccount: { enabled: true },
        },
        { admission: { groupsClaim: "groups", anyOf: ["members"] }, emailClaim: "alternate_email" },
      ]) {
        assert.throws(
          () =>
            humanLoginConfiguration({
              ...environment,
              OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify(policy),
            }),
          { name: "Error", message: /^OIDC enrollment / },
        );
      }
    },
  );

  test(
    "chart host-only native admin is explicit and preserves guarded cookie scope",
    tooling,
    async () => {
      const values = {
        ...oidcUpgradeValues(recoveryUserId),
        "agentNativeAdmin.enabled": "true",
        "agentNativeAdmin.sessionMode": "host-only-exchange",
        "agentNativeAdmin.domain": "agents.oce.example.internal",
        "gatewayRouting.enabled": "true",
      };
      // Disabling the UI keeps the selected cookie boundary and its provider restrictions.
      for (const enabled of ["true", "false"]) {
        const selected = { ...values, "agentNativeAdmin.enabled": enabled };
        const objects = await render(selected);
        const settings = signInSettings(deploymentEnv(objects, "api"));
        assert.equal(settings.OCC_AGENT_NATIVE_ADMIN_SESSION_MODE, "host-only-exchange");
        assert.equal(settings.OCC_AUTH_COOKIE_DOMAIN, undefined);
        assert.equal(
          signInSettings(deploymentEnv(objects, "worker")).OCC_AGENT_NATIVE_ADMIN_SESSION_MODE,
          undefined,
        );
        await startsUp(resolveSecrets(settings), `host-only native admin ${enabled}`);
        const providers: readonly ChartValues[] = [
          { "auth.oidc.enabled": "false", "auth.recoveryUserId": "" },
          googleUpgradeValues(recoveryUserId),
        ];
        for (const provider of providers) {
          assert.match(
            await refusal({ ...selected, ...provider, "agentNativeAdmin.enabled": enabled }),
            enabled === "true" && provider["auth.google.enabled"] === "true"
              ? /auth.google requires agentNativeAdmin.enabled: false/
              : /host-only-exchange requires guarded OIDC sign-in without Google/,
          );
        }
      }
      const refusals: readonly [overrides: ChartValues, message: RegExp][] = [
        [{ "agentNativeAdmin.sessionMode": "unknown" }, /sessionMode must be/],
        [{ "agentNativeAdmin.sessionMode": "" }, /sessionMode must be/],
        [
          { "agentNativeAdmin.sharedCookieDomain": "example.com" },
          /sharedCookieDomain is no longer supported/,
        ],
        [{ "gatewayRouting.sandbox.enabled": "true" }, /does not support sandbox preview/],
        [{ "gatewayRouting.enabled": "false" }, /requires gatewayRouting.enabled/],
      ];
      for (const [overrides, message] of refusals) {
        assert.match(await refusal({ ...values, ...overrides }), message);
      }
    },
  );
}
