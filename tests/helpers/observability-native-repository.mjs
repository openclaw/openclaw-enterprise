import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Supply the chart's real native-sender profile without admitting a repository
// operation. The native sender requires one exact review ref. No Agent or
// Namespace is provisioned for this grant, and the keys are fixture-generated.
export async function prepareObservabilityNativeRepository(f) {
  const backendId = "observability-repository";
  const profile = "git-write";
  const driverId = "observability-repository-driver";
  const serviceName = "git";
  const hostname = `${serviceName}.${f.system}.svc.cluster.local`;
  const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  await f.run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    join(f.directory, "repository.key"),
    "-out",
    join(f.directory, "repository.crt"),
    "-subj",
    `/CN=${hostname}`,
    "-addext",
    `subjectAltName=DNS:${hostname}`,
  ]);
  const tlsKey = await readFile(join(f.directory, "repository.key"), "utf8");
  const tlsCert = await readFile(join(f.directory, "repository.crt"), "utf8");
  f.secrets.push(appKey, tlsKey);
  const createSecret = (name, stringData) =>
    f.apply({ apiVersion: "v1", kind: "Secret", metadata: f.metadata(name), stringData });
  await createSecret("repository-app-key", { "private-key.pem": appKey });
  await createSecret("repository-tls", { "tls.crt": tlsCert, "tls.key": tlsKey });
  await createSecret("repository-public-ca", { "ca.crt": tlsCert });
  const custodyKey = randomBytes(32).toString("base64");
  f.secrets.push(custodyKey);
  await f.apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: f.metadata("repository-custody"),
    data: { "custody.key": custodyKey },
  });
  const registry = {
    version: 1,
    backendId,
    providerInstanceId: "observability-unprovisioned",
    appId: "1",
    githubInstallationId: "1",
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: "unadmitted",
        repositoryId: "1",
        repository: "example/unadmitted",
        namespaces: [
          {
            namespaceId: `unadmitted-${f.suffix}`,
            profiles: [profile],
            transport: "git-only",
            pushRefAllowlist: ["refs/heads/observability-review"],
          },
        ],
      },
    ],
  };
  await f.apply({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: f.metadata("repository-registry-v1"),
    immutable: true,
    data: { "registry.json": JSON.stringify(registry) },
  });
  const socket = "/run/openclaw/repository-control/private/control.sock";
  await createSecret("repository-service-config", {
    "config.json": JSON.stringify({
      gateway: {
        listen: "0.0.0.0:8443",
        controlSocket: socket,
        tlsCertFile: "/etc/openclaw/repository-inputs/tls.crt",
        tlsKeyFile: "/etc/openclaw/repository-inputs/tls.key",
      },
      sessionPolicy: {
        maximumDurationSeconds: 3600,
        defaultProfile: profile,
        allowedProfiles: [profile],
      },
      limits: {},
      backend: {
        kind: "github-prepared-git-registry",
        backendId,
        registryFile: "/etc/openclaw/repository-registry/registry.json",
      },
    }),
  });
  f.configuration.backend = [
    {
      id: backendId,
      type: "github",
      configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
      drivers: { repo: driverId },
    },
  ];
  f.configuration.repository = {
    id: driverId,
    configuration: { sessionDurationSeconds: 1800 },
    nativeSender: { controlSocket: socket, publicCaPath: "/etc/openclaw/repository-ca/ca.crt" },
    preparedGitHub: {
      custodyKeyPath: "/etc/openclaw/prepared-repository/custody.key",
      privateKeyPath: "/etc/openclaw/prepared-repository/private-key.pem",
    },
  };
  f.configuration.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: f.system,
    podLabels: {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": f.release,
      "app.kubernetes.io/component": "worker",
    },
    port: 8443,
  };
  return {
    enabled: true,
    authority: "prepared-git",
    preparedCustodySecretName: "repository-custody",
    image: f.images.credentials,
    serviceName,
    backendId,
    registryConfigMapName: "repository-registry-v1",
    serviceConfigSecretName: "repository-service-config",
    appKeySecretName: "repository-app-key",
    tlsSecretName: "repository-tls",
    publicCaSecretName: "repository-public-ca",
    // No live provider operation is admitted. Retain the chart's bounded egress
    // contract while directing the unused provider grant to a documentation IP.
    upstreamCidrs: ["192.0.2.1/32"],
  };
}
