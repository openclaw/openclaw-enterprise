import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { renderProductionChart, parseProductionChart } from "../helpers/production-chart.mjs";

interface ChartResource {
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  rules: { resources?: string[]; verbs: string[]; resourceNames?: string[] }[];
  subjects: { name: string }[];
  spec: {
    replicas: number;
    strategy: { type: string };
    ingress: unknown[];
    egress: unknown[];
    type: string;
    template: { spec: { containers: { env: { name: string; value: string }[] }[] } };
  };
}

const binding = {
  stage: "runtime",
  installationId: "ins_00000000-0000-4000-8000-000000000001",
  namespaceId: "ns_00000000-0000-4000-8000-000000000002",
  uid: "00000000-0000-4000-8000-000000000003",
  startupCycle: "independent",
};
const hash = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
const namedValues = {
  ...Object.fromEntries(
    Object.entries(binding).map(([key, value]) => [`namedWorkspace.${key}`, value]),
  ),
  "worker.replicaCount": "0",
  "api.clients": "null",
  "bootstrap.adminEmail": "",
  "bootstrap.password.claimName": "",
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "private-envoy",
  "gatewayRouting.apiKeySecretName": "synthetic-routing",
  "metrics.enabled": "false",
  "auth.github.enabled": "true",
  "auth.github.allowedOrgs[0]": "synthetic-organization",
  "auth.github.egressCidrs[0]": "192.0.2.0/24",
  "auth.recoveryUserId": "synthetic-recovery",
};

test("named runtime Helm install and upgrade preserve identity and Git-disabled permissions", async () => {
  // Actual Helm parses both release modes; no Kubernetes server is used or implied.
  for (const isUpgrade of [false, true]) {
    const objects: ChartResource[] = (
      await parseProductionChart((await renderProductionChart(namedValues, { isUpgrade })).stdout)
    ).filter(Boolean);
    assert.equal(
      objects.some((o) => o.metadata?.annotations?.["helm.sh/hook"]),
      false,
    );
    assert.equal(
      objects.some((o) => ["Job", "Secret", "HTTPRoute", "Ingress"].includes(o.kind)),
      false,
    );
    // Retain every private routing resource on upgrades, including its TLS issuers.
    const ordinary: ChartResource[] = (
      await parseProductionChart(
        (
          await renderProductionChart(
            {
              "gatewayRouting.enabled": "true",
              "gatewayRouting.gatewayClassName": "private-envoy",
              "gatewayRouting.apiKeySecretName": "synthetic-routing",
            },
            { isUpgrade },
          )
        ).stdout,
      )
    ).filter(Boolean);
    const gatewayGraph = (resources: ChartResource[]) =>
      resources.filter(
        (o) =>
          ["Gateway", "EnvoyProxy", "Certificate", "Issuer", "SecurityPolicy"].includes(o.kind) ||
          (o.kind === "NetworkPolicy" && /envoy/.test(o.metadata.name)),
      );
    const retained = gatewayGraph(objects);
    // The only graph changes are added exact-name conjuncts on tenant selectors.
    const stripExactTenant = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(stripExactTenant);
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if ("openclaw-enterprise.io/gateway" in record) {
          assert.equal(
            record["kubernetes.io/metadata.name"],
            `oce-${hash(binding.namespaceId, 15)}`,
          );
          const { ["kubernetes.io/metadata.name"]: _name, ...rest } = record;
          return rest;
        }
        return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, stripExactTenant(v)]));
      }
      return value;
    };
    assert.deepEqual(stripExactTenant(retained), gatewayGraph(ordinary));
    const api = objects.find((o) => o.kind === "Deployment" && o.metadata.name.endsWith("-api"));
    assert.ok(api);
    assert.equal(api.spec.replicas, 1);
    assert.equal(api.spec.strategy.type, "Recreate");
    const worker = objects.find(
      (o) => o.kind === "Deployment" && o.metadata.name.endsWith("-worker"),
    );
    assert.ok(worker);
    assert.equal(worker.spec.replicas, 0);
    for (const deployment of [api, worker]) {
      const env = deployment.spec.template.spec.containers[0]!.env;
      assert.deepEqual(
        JSON.parse(env.find((e) => e.name === "OCC_NAMED_WORKSPACE")!.value),
        binding,
      );
      for (const name of ["OCC_EGRESS_AUTHORITY_PORT", "OCC_OPENSHELL_GIT_PORT"]) {
        assert.deepEqual(
          env.filter((entry) => entry.name === name),
          [{ name, value: "disabled" }],
        );
      }
    }
    assert.deepEqual(
      objects.find((o) => o.metadata.name === "openclaw-enterprise-api-github-login-egress")!.spec
        .egress,
      [{ to: [{ ipBlock: { cidr: "192.0.2.0/24" } }], ports: [{ protocol: "TCP", port: 443 }] }],
    );
    const accounts = objects.filter((o) => o.kind === "ServiceAccount");
    assert.deepEqual(
      accounts.map((o) => o.metadata.name),
      ["openclaw-enterprise-api", "openclaw-enterprise-worker"],
    );
    const roles = objects.filter((o) => o.kind === "ClusterRole");
    const nsRules = roles
      .flatMap((o) => o.rules)
      .filter((r) => r.resources?.includes("namespaces"));
    assert.equal(nsRules.length, 2);
    for (const rule of nsRules) {
      assert.deepEqual(rule.verbs, ["get"]);
      assert.deepEqual(rule.resourceNames, [`oce-${hash(binding.namespaceId, 15)}`]);
    }
    const tenantBindings = objects.filter((o) => o.kind === "RoleBinding");
    assert.equal(tenantBindings.length, 2);
    assert.ok(
      tenantBindings.every(
        (o) =>
          o.metadata.namespace === `oce-${hash(binding.namespaceId, 15)}` &&
          o.subjects[0]!.name === "openclaw-enterprise-api",
      ),
    );
    assert.deepEqual(
      objects.find((o) => o.metadata.name === "openclaw-enterprise-api-ingress")!.spec.ingress,
      [],
    );
    assert.ok(
      objects.filter((o) => o.kind === "Service").every((o) => o.spec.type === "ClusterIP"),
    );
  }
  for (const overrides of [
    { "namedWorkspace.stage": "bootstrap" },
    { "namedWorkspace.extra": "no" },
    { "namedWorkspace.uid": "wrong" },
    { "namedWorkspace.installationId": "" },
    {
      "preprovisionedNamespace.namespaceId": binding.namespaceId,
      "preprovisionedNamespace.uid": binding.uid,
    },
    { "openshellGit.enabled": "true" },
    { "egressAuthority.enabled": "true" },
    { "repositoryCredentials.enabled": "true" },
    { "slackProxy.enabled": "true" },
    { "publicGithubRead.enabled": "true" },
    { "gatewayRouting.sandbox.enabled": "true" },
    { "backend.chatgpt.enabled": "true" },
    { "gatewayRouting.serviceType": "LoadBalancer" },
    { "api.clients[0].namespace": "unwanted", "api.clients[0].podLabels.app": "unwanted" },
    { "auth.github.egressCidrs": "null" },
    { "auth.github.egressCidrs[0]": "0.0.0.0/0" },
    { "auth.github.egressCidrs[0]": "0.0.0.0/1", "auth.github.egressCidrs[1]": "128.0.0.0/1" },
    { "agentNativeAdmin.enabled": "true" },
    { "auth.github.allowedOrgs": "null" },
  ]) {
    const values: Record<string, string> = { ...namedValues, ...overrides };
    if ("api.clients[0].namespace" in overrides) {
      // Remove the later whole-list null override so Helm receives real clients.
      delete values["api.clients"];
    }
    await assert.rejects(
      renderProductionChart(values),
      /namedWorkspace/,
      JSON.stringify(overrides),
    );
  }
  const enabledWorker: ChartResource[] = (
    await parseProductionChart(
      (await renderProductionChart({ ...namedValues, "worker.replicaCount": "1" })).stdout,
    )
  ).filter(Boolean);
  assert.equal(
    enabledWorker.filter(
      (o) => o.kind === "RoleBinding" && o.subjects[0]!.name === "openclaw-enterprise-worker",
    ).length,
    2,
  );
  const defaults: ChartResource[] = (
    await parseProductionChart((await renderProductionChart()).stdout)
  ).filter(Boolean);
  assert.ok(defaults.some((o) => o.kind === "Job"));
  assert.ok(
    defaults.some(
      (o) =>
        o.kind === "ClusterRole" &&
        o.rules.some((r) => r.resources?.includes("namespaces") && r.verbs.includes("create")),
    ),
  );
});
