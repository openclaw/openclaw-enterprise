import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultInstallSettings,
  githubUpgradeSettings,
  githubUpgradeValues,
} from "../helpers/production-sign-in.mjs";
import {
  chartTooling,
  deploymentEnv,
  renderChart as render,
  signInSettings,
} from "../helpers/sign-in-chart.mjs";

const recoveryUserId = "Xk3u9pQ2rT7vW1yZ";
const tooling = await chartTooling();

const githubEgress = ({ kind, metadata }) =>
  kind === "NetworkPolicy" && metadata.name.endsWith("-api-github-login-egress");
const googleEgress = ({ kind, metadata }) =>
  kind === "NetworkPolicy" && metadata.name.endsWith("-api-google-login-egress");

test(
  "the example install renders password-only sign-in and GitHub only as an upgrade",
  tooling,
  async () => {
    const install = await render();
    assert.deepEqual(signInSettings(deploymentEnv(install, "api")), defaultInstallSettings);
    assert.equal(install.some(githubEgress), false);
    assert.equal(install.some(googleEgress), false);

    const upgrade = await render(githubUpgradeValues(recoveryUserId));
    assert.deepEqual(
      signInSettings(deploymentEnv(upgrade, "api")),
      githubUpgradeSettings(recoveryUserId),
    );
    assert.equal(upgrade.filter(githubEgress).length, 1);
    assert.equal(upgrade.some(googleEgress), false);

    const proxied = await render({
      "api.trustedProxy.preset": "ingress-nginx",
      "api.trustedProxy.cidrs[0]": "10.42.0.0/16",
    });
    assert.deepEqual(signInSettings(deploymentEnv(proxied, "api")), {
      ...defaultInstallSettings,
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16",
      OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx",
    });
    for (const objects of [install, upgrade, proxied]) {
      assert.ok(
        !deploymentEnv(objects, "worker").some(({ name }) =>
          /^OCC_AUTH_(GITHUB_|GOOGLE_|TRUSTED_PROXY_|CLIENT_IP_HEADER)/.test(name),
        ),
      );
    }
  },
);
