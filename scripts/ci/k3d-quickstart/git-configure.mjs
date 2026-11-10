// Render the public enrollment fragment into this run's k3d installation and Helm values.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { dumpYaml, loadYaml } = createRequire(join(process.cwd(), "apps/controller/package.json"))(
  "@kubernetes/client-node",
);
const { RUN_DIR, PLATFORM_NS, TENANT_NAMESPACE, RELEASE, INSTALLATION_FILE, VALUES_FILE } =
  process.env;
const file = (name) => join(RUN_DIR, name);
const read = (path) => readFileSync(path, "utf8");
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const installation = loadYaml(read(INSTALLATION_FILE));
const fragment = loadYaml(read("deploy/examples/repository-credentials/openshell.fragment.yaml"));
const sandbox = installation.drivers.sandbox;
const owner = installation.backend.filter((backend) => backend.drivers?.sandbox === sandbox.id);
assert.equal(owner.length, 1);
assert.ok(!installation.repository && !installation.drivers.credential_proxy);
assert.ok(
  !sandbox.configuration.policy.networkPolicies.some((policy) => policy.name === "source-control"),
);

owner[0].drivers.credential_proxy = sandbox.id;
installation.drivers.credential_proxy = { id: sandbox.id, configuration: {} };
installation.backend.push(...fragment.backend);
installation.repository = fragment.repository;
installation.repository.configuration.sessionDurationSeconds = 3600;
installation.repository.openShell.authority.keyId = read(file("gateway-kid")).trim();
const peer = (namespace, labels) => ({
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
  podSelector: { matchLabels: labels },
});
const supervisor = peer(TENANT_NAMESPACE, {
  "openshell.ai/managed-by": "openshell",
  "openshell.ai/boundary-role": "supervisor",
});
const gateway = peer(PLATFORM_NS, {
  "app.kubernetes.io/name": "openshell",
  "app.kubernetes.io/instance": "openshell-gateway",
});
const supervisorEgress = {
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  metadata: { name: "allow-oce-prepared-git" },
  spec: {
    podSelector: supervisor.podSelector,
    policyTypes: ["Egress"],
    egress: [
      {
        to: [
          peer(PLATFORM_NS, {
            "app.kubernetes.io/instance": RELEASE,
            "app.kubernetes.io/component": "worker",
          }),
        ],
        ports: [{ protocol: "TCP", port: 8445 }],
      },
    ],
  },
};
sandbox.configuration.gateway.networkPolicyResources.push(supervisorEgress);
writeFileSync(INSTALLATION_FILE, dumpYaml(installation));
json(file("git-egress.json"), supervisorEgress);
const values = JSON.parse(read(VALUES_FILE));
values.repositoryCredentials = {
  ...values.repositoryCredentials,
  enabled: false,
  authority: "prepared-git",
  backendId: "repository-backend",
  registryConfigMapName: "qa-git-write",
  appKeySecretName: "qa-git-app",
  preparedCustodySecretName: "qa-git-custody",
  upstreamCidrs: JSON.parse(read(file("github-meta.json"))).api.filter(
    (cidr) => !cidr.includes(":"),
  ),
};
assert.ok(values.repositoryCredentials.upstreamCidrs.length > 0);
values.openshellGit = {
  enabled: true,
  mode: "protected",
  port: 8445,
  tlsSecretName: "qa-git-tls",
  issuerPublicKeyConfigMapName: "qa-git-issuer",
  clients: [gateway, supervisor],
};
json(VALUES_FILE, values);

const openshell = JSON.parse(read(file("openshell-values.json")));
const middleware = openshell.gatewayConfig["openshell.supervisor.middleware"];
assert.deepEqual(middleware, []);
middleware.push({
  name: "oce-prepared-git",
  binding_policy: "allowlist",
  bindings: ["http_request_pre_credentials"],
  grpc_endpoint: `https://openclaw-enterprise-openshell-git.${PLATFORM_NS}.svc:8445`,
  tls_ca_cert_path: "/etc/oce-git-ca/ca.crt",
  audience: "oce-prepared-git",
  max_payload_bytes: 4194304,
  timeout: "5s",
});
(openshell.server.extraVolumes ??= []).push({
  name: "qa-git-ca",
  configMap: { name: "qa-git-ca" },
});
(openshell.server.extraVolumeMounts ??= []).push({
  name: "qa-git-ca",
  mountPath: "/etc/oce-git-ca",
  readOnly: true,
});
json(file("openshell-git-values.json"), openshell);
