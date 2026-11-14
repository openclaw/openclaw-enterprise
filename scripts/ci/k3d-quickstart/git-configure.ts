// Render the public enrollment fragment into this run's k3d installation and Helm values.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// The controller owns the Kubernetes client dependency and its YAML codec.
const {
  dumpYaml,
  loadYaml,
}: {
  dumpYaml(value: Record<string, unknown>): string;
  loadYaml(text: string): unknown;
} = createRequire(join(process.cwd(), "apps/controller/package.json"))("@kubernetes/client-node");

const { RUN_DIR, PLATFORM_NS, TENANT_NAMESPACE, RELEASE, INSTALLATION_FILE, VALUES_FILE } =
  process.env;

function requiredPath(value: string | undefined, name: string): string {
  assert.ok(value !== undefined, `${name} is required`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

const file = (name: string) => join(requiredPath(RUN_DIR, "RUN_DIR"), name);
const read = (path: string) => readFileSync(path, "utf8");
const readJson = (path: string): unknown => JSON.parse(read(path));
const writeJson = (path: string, value: object) =>
  writeFileSync(path, JSON.stringify(value, null, 2));
const installationFile = requiredPath(INSTALLATION_FILE, "INSTALLATION_FILE");
const installation = record(loadYaml(read(installationFile)));
const fragment = record(
  loadYaml(read("deploy/examples/repository-credentials/openshell.fragment.yaml")),
);
const drivers = record(installation.drivers);
const sandbox = record(drivers.sandbox);
const sandboxId = sandbox.id;
assert.ok(typeof sandboxId === "string");
const backends = array(installation.backend);
const owners = backends.flatMap((backend) => {
  const selection = record(backend).drivers;
  if (selection == null) {
    return [];
  }
  const backendDrivers = record(selection);
  return backendDrivers.sandbox === sandboxId ? [backendDrivers] : [];
});
assert.equal(owners.length, 1);
const [owner] = owners;
assert.ok(owner);
assert.ok(!installation.repository && !drivers.credential_proxy);
const configuration = record(sandbox.configuration);
const policy = record(configuration.policy);
assert.ok(!array(policy.networkPolicies).some((rule) => record(rule).name === "source-control"));

owner.credential_proxy = sandboxId;
drivers.credential_proxy = { id: sandboxId, configuration: {} };
backends.push(...array(fragment.backend));
const repository = record(fragment.repository);
installation.repository = repository;
record(repository.configuration).sessionDurationSeconds = 3600;
record(record(repository.openShell).authority).keyId = read(file("gateway-kid")).trim();

const peer = (namespace: string | undefined, labels: Record<string, string | undefined>) => ({
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
array(record(configuration.gateway).networkPolicyResources).push(supervisorEgress);
writeFileSync(installationFile, dumpYaml(installation));
writeJson(file("git-egress.json"), supervisorEgress);

const valuesFile = requiredPath(VALUES_FILE, "VALUES_FILE");
const values = record(readJson(valuesFile));
const previousCredentials = values.repositoryCredentials;
const upstreamCidrs = array(record(readJson(file("github-meta.json"))).api).filter((cidr) => {
  assert.ok(typeof cidr === "string");
  return !cidr.includes(":");
});
values.repositoryCredentials = {
  ...(previousCredentials == null ? {} : record(previousCredentials)),
  enabled: false,
  authority: "prepared-git",
  backendId: "repository-backend",
  registryConfigMapName: "qa-git-write",
  appKeySecretName: "qa-git-app",
  preparedCustodySecretName: "qa-git-custody",
  upstreamCidrs,
};
assert.ok(upstreamCidrs.length > 0);
values.openshellGit = {
  enabled: true,
  mode: "protected",
  port: 8445,
  tlsSecretName: "qa-git-tls",
  issuerPublicKeyConfigMapName: "qa-git-issuer",
  clients: [gateway, supervisor],
};
writeJson(valuesFile, values);

const openshell = record(readJson(file("openshell-values.json")));
const middleware = record(openshell.gatewayConfig)["openshell.supervisor.middleware"];
assert.deepEqual(middleware, []);
array(middleware).push({
  name: "oce-prepared-git",
  binding_policy: "allowlist",
  bindings: ["http_request_pre_credentials"],
  grpc_endpoint: `https://openclaw-enterprise-openshell-git.${PLATFORM_NS}.svc:8445`,
  tls_ca_cert_path: "/etc/oce-git-ca/ca.crt",
  audience: "oce-prepared-git",
  max_payload_bytes: 4194304,
  timeout: "5s",
});
const server = record(openshell.server);
array((server.extraVolumes ??= [])).push({
  name: "qa-git-ca",
  configMap: { name: "qa-git-ca" },
});
array((server.extraVolumeMounts ??= [])).push({
  name: "qa-git-ca",
  mountPath: "/etc/oce-git-ca",
  readOnly: true,
});
writeJson(file("openshell-git-values.json"), openshell);
