import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.mjs";

interface RenderedResource {
  kind: string;
  metadata: { annotations?: Record<string, string> };
  rules: { resources?: string[]; resourceNames?: string[]; verbs: string[] }[];
  spec: {
    template: {
      spec: {
        containers: {
          name: string;
          env: {
            name: string;
            value: string;
            valueFrom: { secretKeyRef: { name: string; key: string } };
          }[];
        }[];
      };
    };
  };
}

const tooling = await chartTooling();

const binding = {
  "preprovisionedNamespace.namespaceId": "ns_fixture",
  "preprovisionedNamespace.uid": "11111111-2222-3333-4444-555555555555",
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "private-envoy-gateway",
  "gatewayRouting.apiKeySecretName": "gateway-key",
  "egressAuthority.enabled": "true",
  "egressAuthority.tlsSecretName": "authority-tls",
  "egressAuthority.issuerSecretName": "authority-issuer",
  "egressAuthority.clients[0].namespaceSelector.matchLabels.role": "sandbox",
  "egressAuthority.clients[0].podSelector.matchLabels.app": "sandbox",
};
const login = {
  ...binding,
  "auth.github.enabled": "true",
  "auth.recoveryUserId": "fixture_recovery",
  "auth.passwordSignIn": "recovery-only",
  "auth.github.allowedTeams[0]": "example/maintainers",
};

async function render(values: Record<string, string>, isUpgrade = true) {
  const { stdout } = await renderProductionChart(values, { isUpgrade });
  return (await parseProductionChart(stdout)) as RenderedResource[];
}

function assertBound(objects: RenderedResource[]) {
  const expectedName = `oce-${createHash("sha256").update("ns_fixture").digest("hex").slice(0, 15)}`;
  const rules = objects.flatMap((object) =>
    object.kind === "ClusterRole"
      ? object.rules.filter((rule) => rule.resources?.includes("namespaces"))
      : [],
  );
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    assert.deepEqual(rule.resourceNames, [expectedName]);
    assert.deepEqual(rule.verbs, ["get"]);
  }
  assert.ok(!objects.some((object) => object.kind === "Job"));
  const deployments = objects.filter((object) => object.kind === "Deployment");
  assert.equal(deployments.length, 2);
  for (const deployment of deployments) {
    const container = deployment.spec.template.spec.containers[0];
    assert.ok(container, "deployment has its controller container");
    const env = container.env;
    assert.deepEqual(
      JSON.parse(env.find((entry) => entry.name === "OCC_PREPROVISIONED_NAMESPACE")!.value),
      {
        namespaceId: "ns_fixture",
        uid: binding["preprovisionedNamespace.uid"],
      },
    );
    assert.ok(!env.some((entry) => entry.name === "OCC_AUTH_COOKIE_DOMAIN"));
    assert.ok(
      !env.some(
        (entry) => entry.name === "OCC_AGENT_NATIVE_ADMIN_ENABLED" && entry.value !== "false",
      ),
    );
  }
}

const byKind = (objects: RenderedResource[], kinds: string[]) =>
  objects.filter((object) => kinds.includes(object.kind));
const hooks = (objects: RenderedResource[]) =>
  objects.filter((object) => object.metadata.annotations?.["helm.sh/hook"]);

test(
  "bound Namespace keeps closed password authentication on install and upgrade",
  tooling,
  async () => {
    for (const isUpgrade of [false, true]) {
      const objects = await render(binding, isUpgrade);
      assertBound(objects);
      for (const deployment of byKind(objects, ["Deployment"])) {
        const env = deployment.spec.template.spec.containers[0]!.env;
        assert.ok(!env.some((entry) => entry.name.startsWith("OCC_AUTH_GITHUB_")));
      }
    }
  },
);

test("bound Namespace permits a team-restricted GitHub Console upgrade", tooling, async () => {
  const objects = await render(login);
  const prior = await render(binding);
  assertBound(objects);
  assert.deepEqual(
    byKind(objects, ["ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"]),
    byKind(prior, ["ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"]),
  );
  assert.deepEqual(hooks(objects), hooks(prior), "non-Job hooks remain unchanged");
  for (const deployment of byKind(objects, ["Deployment"])) {
    const container = deployment.spec.template.spec.containers[0]!;
    const env = container.env;
    const previous = byKind(prior, ["Deployment"])
      .flatMap((object) => object.spec.template.spec.containers)
      .find((item) => item.name === container.name)!;
    assert.deepEqual(
      env.filter((entry) => entry.name.startsWith("OCC_DATABASE_")),
      previous.env.filter((entry) => entry.name.startsWith("OCC_DATABASE_")),
      "database references stay unchanged",
    );
    const github = env.filter((entry) => entry.name.startsWith("OCC_AUTH_GITHUB_CLIENT_"));
    if (container.name === "api") {
      assert.deepEqual(
        github.map((entry) => entry.valueFrom.secretKeyRef),
        [
          { name: "occ-github-login", key: "client-id" },
          { name: "occ-github-login", key: "client-secret" },
        ],
      );
      assert.equal(
        env.find((entry) => entry.name === "OCC_AUTH_PASSWORD_SIGN_IN")!.value,
        "recovery-only",
      );
      assert.equal(
        env.find((entry) => entry.name === "OCC_AUTH_GITHUB_ALLOWED_TEAMS")!.value,
        "example/maintainers",
      );
    } else {
      assert.equal(github.length, 0);
    }
  }
});

test("bound Console login refuses fresh installs and incompatible upgrades", tooling, async () => {
  await assert.rejects(renderProductionChart(login), /preprovisionedNamespace requires/);
  for (const override of [
    { "auth.passwordSignIn": "all" },
    { "agentNativeAdmin.enabled": "true" },
    { "auth.google.enabled": "true" },
    { "auth.oidc.enabled": "true" },
    { "executionCluster.enabled": "true" },
    { "gatewayRouting.enabled": "false" },
    { "gatewayRouting.serviceType": "LoadBalancer" },
  ]) {
    await assert.rejects(
      renderProductionChart({ ...login, ...override }, { isUpgrade: true }),
      /preprovisionedNamespace requires/,
    );
  }
  await assert.rejects(
    renderProductionChart({ ...login, "auth.recoveryUserId": "" }, { isUpgrade: true }),
    /preprovisionedNamespace requires/,
  );
  await assert.rejects(
    renderProductionChart(
      { ...login, "auth.recoveryUserId": "invalid identity" },
      { isUpgrade: true },
    ),
    /auth.recoveryUserId must be the existing local password administrator/,
  );
  await assert.rejects(
    renderProductionChart(
      { ...login, "preprovisionedNamespace.uid": "invalid" },
      { isUpgrade: true },
    ),
    /requires exactly namespaceId and Kubernetes uid/,
  );
});

const withoutTeams = Object.fromEntries(
  Object.entries(login).filter(([key]) => key !== "auth.github.allowedTeams[0]"),
);
const broaderProfiles: Record<string, Record<string, string>> = {
  "no allowlist": withoutTeams,
  "organization-wide allowlist": { ...withoutTeams, "auth.github.allowedOrgs[0]": "example" },
  "mixed allowlist": { ...login, "auth.github.allowedOrgs[0]": "example" },
};

test(
  "bound Console login refuses unrestricted and organization-wide admission",
  tooling,
  async (t) => {
    for (const [name, profile] of Object.entries(broaderProfiles)) {
      await t.test(name, async () => {
        await assert.rejects(render(profile), /preprovisionedNamespace requires/);
      });
    }
  },
);

test("unbound GitHub profiles retain their existing allowlist behavior", tooling, async (t) => {
  for (const [name, profile] of Object.entries<Record<string, string>>({
    ...broaderProfiles,
    "team allowlist": login,
  })) {
    await t.test(name, async () => {
      const unbound = Object.fromEntries(
        Object.entries(profile).filter(([key]) => !key.startsWith("preprovisionedNamespace.")),
      );
      const objects = await render(unbound);
      assert.ok(
        objects.some((object) => object.kind === "Job"),
        "ordinary initialization is unchanged",
      );
      const api = byKind(objects, ["Deployment"])
        .flatMap((object) => object.spec.template.spec.containers)
        .find((container) => container.name === "api")!;
      const value = (name: string) => api.env.find((entry) => entry.name === name)?.value;
      assert.equal(value("OCC_AUTH_GITHUB_ALLOWED_TEAMS"), profile["auth.github.allowedTeams[0]"]);
      assert.equal(value("OCC_AUTH_GITHUB_ALLOWED_ORGS"), profile["auth.github.allowedOrgs[0]"]);
    });
  }
});
