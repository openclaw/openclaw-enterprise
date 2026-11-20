import type { ChannelEgressOptions } from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  V1NetworkPolicyPeer,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Secret,
  V1Service,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { asRecord } from "../../packages/utils/src/index.ts";
import { failureSecrets, type RedactionSecrets } from "../../scripts/ci/failure-redaction.ts";
import { podFailureDiagnostic } from "./k3d-failure-diagnostics.ts";
import {
  createKubernetesClient,
  type createKubernetesInstallationConfiguration,
  diagnosticDeadlineMs,
  withinDiagnosticDeadline,
} from "./kubernetes-real.ts";
import type { FixtureRun } from "./production-rehearsal-custody.ts";

type Labels = Readonly<Record<string, string>>;
type PodPeer = { namespace: string; podLabels: Labels };

type RepositoryCredentialsValues = {
  enabled?: boolean;
  authority?: "prepared-git";
  delivery?: "" | "credential-proxy";
  image?: string;
  serviceName?: string;
  clusterDomain?: string;
  hostname?: string;
  backendId?: string;
  registryConfigMapName?: string;
  registryKey?: string;
  serviceConfigSecretName?: string;
  serviceConfigKey?: string;
  appKeySecretName?: string;
  appKeyKey?: string;
  preparedCustodySecretName?: string;
  preparedProviderCaConfigMapName?: string;
  tlsSecretName?: string;
  publicCaSecretName?: string;
  publicCaKey?: string;
  upstreamCidrs?: readonly string[];
  upstreamPort?: number;
};

type GatewayRoutingValues = {
  enabled?: boolean;
  hostname?: string;
  gatewayClassName?: string;
  gatewayName?: string;
  envoyNamespace?: string;
  apiKeySecretName?: string;
  caSecretName?: string;
  caSecretKey?: string;
  tlsSecretName?: string;
  serviceType?: "ClusterIP" | "LoadBalancer" | "NodePort";
  remoteNodeCidrs?: readonly string[];
  tenantGatewayPort?: number;
  envoyHttpsTargetPort?: number;
  sandbox?: {
    enabled?: boolean;
    domain?: string;
    tlsSecretName?: string;
    listenerPort?: number;
    ingressPeers?: readonly V1NetworkPolicyPeer[];
  };
  issuerRef?: { name?: string; kind?: string; group?: string };
  envoyGatewayPodLabels?: Labels;
};

type HelmOverrides = {
  repositoryCredentials?: RepositoryCredentialsValues | undefined;
  gatewayRouting?: GatewayRoutingValues | undefined;
  controlPlane?: { nodeSelector?: Labels; installationChecksum?: string } | undefined;
  executionCluster?:
    | {
        enabled?: boolean;
        apiKubeconfigSecretName?: string;
        workerKubeconfigSecretName?: string;
        kubeconfigKey?: string;
        apiCidrs?: readonly string[];
        apiPort?: number;
      }
    | undefined;
  metrics?:
    | {
        enabled?: boolean;
        port?: number;
        scraperNamespaceLabels?: Labels;
        scraperPodLabels?: Labels;
      }
    | undefined;
};

type HelmTarget = {
  selection: { kubeconfigPath: string; kubernetesContext: string };
  namespace: string;
  release: string;
};

type PrepareOptions = HelmTarget &
  HelmOverrides & {
    images: { controller: string; postgres: string };
    directory: string;
    suffix: string;
    configuration: ReturnType<typeof createKubernetesInstallationConfiguration>;
    authBaseURL: string;
    agentNativeAdminDomain: string;
    installationName: string;
    bootstrapCredentials?: "generate" | "existing";
    apiClients: readonly PodPeer[];
    channelEgress?: ChannelEgressOptions | undefined;
    slackProxy?: { enabled: boolean } | undefined;
    databaseName?: string | undefined;
    databaseUpgradeMigration?: "hook" | "separate" | undefined;
    databaseTLS?:
      | {
          caSecretName: string;
          serverSecretName: string;
          imagePullPolicy?: "Never" | "IfNotPresent" | undefined;
        }
      | undefined;
    run: FixtureRun;
    kubernetes: Pick<
      ReturnType<typeof createKubernetesClient>,
      "kubectl" | "kubectlArguments" | "resource" | "waitFor"
    >;
    createSecretValue: () => string;
    record: (
      message: string,
      details: { claimName: string } | { namespace: string },
    ) => void | Promise<void>;
  };

type FixtureResource = V1Secret | V1PersistentVolumeClaim | V1Pod | V1Service;

function firstRecord(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: unknown[] = value;
  return asRecord(items[0]);
}

// The caller owns the disposable namespace and registers its cleanup before installation.
export async function prepareProductionHelmControlPlane({
  selection,
  images,
  namespace: system,
  release,
  directory,
  suffix,
  configuration,
  authBaseURL,
  agentNativeAdminDomain,
  installationName,
  apiClients,
  channelEgress,
  slackProxy,
  repositoryCredentials,
  gatewayRouting,
  controlPlane,
  executionCluster,
  metrics,
  databaseName = "openclaw_enterprise",
  databaseUpgradeMigration,
  databaseTLS,
  run,
  kubernetes,
  createSecretValue,
  bootstrapCredentials = "existing",
}: PrepareOptions) {
  // The values this installation creates, so a failure diagnostic can redact them.
  const secretValues: string[] = [];
  const secret = () => {
    const value = createSecretValue();
    secretValues.push(value);
    return value;
  };
  assert.match(databaseName, /^[a-z][a-z0-9_]+$/);
  if (databaseTLS) {
    assert.match(databaseTLS.caSecretName, /^[a-z0-9-]+$/);
    assert.match(databaseTLS.serverSecretName, /^[a-z0-9-]+$/);
    assert.notEqual(databaseTLS.caSecretName, databaseTLS.serverSecretName);
  }
  const { kubectl } = kubernetes;
  const apply = (object: FixtureResource) =>
    run("kubectl", kubernetes.kubectlArguments(["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  const get = (kind: string, name: string, namespace = system) =>
    kubernetes.resource(kind, name, namespace);
  const metadata = (name: string, namespace = system, labels: Labels = {}) => ({
    name,
    namespace,
    labels: { "oce-test": suffix, ...labels },
  });
  const createSecret = (name: string, stringData: Record<string, string>) =>
    apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name), stringData });
  const postgresResources: FixtureResource[] = [];
  const createClaim = (name: string) =>
    postgresResources.push({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: metadata(name),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-path",
        resources: { requests: { storage: "1Gi" } },
      },
    });
  const nodePlacement =
    controlPlane?.nodeSelector === undefined ? {} : { nodeSelector: controlPlane.nodeSelector };
  const podSecurity = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  };
  const securityContext = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };
  const resources = {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  };
  const waitPod = (name: string) =>
    kubectl("-n", system, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=180s");

  const postgresPassword = secret();
  const migrationPassword = secret();
  const appPassword = secret();
  await createSecret("postgres-bootstrap", {
    password: postgresPassword,
    "init.sql": `CREATE ROLE occ_migrator LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nCREATE ROLE occ_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nGRANT CREATE ON DATABASE ${databaseName} TO occ_migrator;\nCREATE SCHEMA occ AUTHORIZATION occ_migrator;\nCREATE SCHEMA drizzle AUTHORIZATION occ_migrator;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
  });
  await createClaim("postgres-data");
  const adminPassword = bootstrapCredentials === "existing" ? secret() : undefined;
  const serviceKey =
    bootstrapCredentials === "existing"
      ? `occ_${randomBytes(32).toString("base64url")}`
      : undefined;
  if (adminPassword !== undefined && serviceKey !== undefined) {
    secretValues.push(serviceKey);
    await createSecret("occ-bootstrap-credentials", {
      "admin-password": adminPassword,
      "admin-service-key": serviceKey,
    });
  }
  postgresResources.push({
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata("postgres", system, { app: "postgres" }),
    spec: {
      ...nodePlacement,
      securityContext: {
        ...podSecurity,
        runAsUser: 999,
        runAsGroup: 999,
        fsGroup: 999,
      },
      ...(databaseTLS && {
        initContainers: [
          {
            name: "prepare-database-tls",
            image: images.postgres,
            imagePullPolicy: databaseTLS.imagePullPolicy ?? "IfNotPresent",
            securityContext,
            resources,
            command: [
              "sh",
              "-ec",
              "umask 077; cp /tls-source/server.pem /tls/server.pem; cp /tls-source/server.key /tls/server.key; chmod 600 /tls/server.key",
            ],
            volumeMounts: [
              { name: "tls-source", mountPath: "/tls-source", readOnly: true },
              { name: "tls", mountPath: "/tls" },
            ],
          },
        ],
      }),
      containers: [
        {
          name: "postgres",
          image: images.postgres,
          ...(databaseTLS && {
            args: [
              "postgres",
              "-c",
              "ssl=on",
              "-c",
              "ssl_cert_file=/etc/postgresql/tls/server.pem",
              "-c",
              "ssl_key_file=/etc/postgresql/tls/server.key",
            ],
          }),
          imagePullPolicy: databaseTLS?.imagePullPolicy ?? "IfNotPresent",
          securityContext,
          resources,
          env: [
            { name: "POSTGRES_DB", value: databaseName },
            {
              name: "POSTGRES_PASSWORD",
              valueFrom: { secretKeyRef: { name: "postgres-bootstrap", key: "password" } },
            },
          ],
          volumeMounts: [
            { name: "data", mountPath: "/var/lib/postgresql" },
            {
              name: "init",
              mountPath: "/docker-entrypoint-initdb.d",
              readOnly: true,
            },
            ...(databaseTLS
              ? [
                  {
                    name: "tls",
                    mountPath: "/etc/postgresql/tls",
                    readOnly: true,
                  },
                ]
              : []),
          ],
          readinessProbe: {
            exec: {
              command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", databaseName],
            },
            initialDelaySeconds: 2,
            periodSeconds: 2,
          },
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: "postgres-data" } },
        ...(databaseTLS
          ? [
              {
                name: "tls-source",
                secret: {
                  secretName: databaseTLS.serverSecretName,
                  defaultMode: 0o440,
                },
              },
              { name: "tls", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
            ]
          : []),
        {
          name: "init",
          secret: {
            secretName: "postgres-bootstrap",
            items: [{ key: "init.sql", path: "init.sql" }],
          },
        },
      ],
    },
  });
  postgresResources.push({
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata("postgres"),
    spec: { selector: { app: "postgres" }, ports: [{ port: 5432 }] },
  });
  // PostgreSQL is a real Helm-installed fixture dependency. Credentials stay in
  // the separately provisioned Secret, outside chart files and Helm values.
  const postgresChart = join(directory, "postgres-chart");
  await mkdir(join(postgresChart, "templates"), { recursive: true });
  await writeFile(
    join(postgresChart, "Chart.yaml"),
    "apiVersion: v2\nname: proof-postgres\nversion: 0.1.0\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(postgresChart, "templates", "resources.yaml"),
    postgresResources.map((object) => JSON.stringify(object)).join("\n---\n"),
    { mode: 0o600 },
  );
  await run("helm", [
    "install",
    `${release}-postgres`,
    postgresChart,
    "--kubeconfig",
    selection.kubeconfigPath,
    "--kube-context",
    selection.kubernetesContext,
    "--namespace",
    system,
  ]);
  await waitPod("postgres");
  const postgres = asRecord(await get("pod", "postgres"));
  const postgresIP = asRecord(postgres?.status)?.podIP;
  assert.ok(typeof postgresIP === "string" && postgresIP, "Expected the ready PostgreSQL Pod IP");
  if (channelEgress) {
    Object.assign(configuration.drivers.compute.configuration.runtime, { channelEgress });
  }
  await createSecret("occ-installation-startup", {
    "installation.yaml": JSON.stringify(configuration),
  });
  const databaseQuery = databaseTLS
    ? "?" +
      new URLSearchParams({
        sslmode: "verify-full",
        sslrootcert: "/etc/openclaw/database-ca/ca.pem",
      })
    : "";
  await createSecret("occ-database", {
    "application-url": `postgresql://occ_app:${appPassword}@postgres.${system}.svc.cluster.local:5432/${databaseName}${databaseQuery}`,
    "migration-url": `postgresql://occ_migrator:${migrationPassword}@postgres.${system}.svc.cluster.local:5432/${databaseName}${databaseQuery}`,
  });
  await createSecret("occ-auth", { secret: secret() });
  const endpoints = asRecord(await get("endpoints", "kubernetes", "default"));
  const endpoint = firstRecord(endpoints?.subsets);
  const endpointIP = firstRecord(endpoint?.addresses)?.ip;
  const endpointPort = firstRecord(endpoint?.ports)?.port;
  assert.ok(typeof endpointIP === "string" && endpointIP, "Expected the Kubernetes endpoint IP");
  assert.ok(typeof endpointPort === "number", "Expected the Kubernetes endpoint port");
  const adminEmail = `admin-${suffix}@example.invalid`;
  const channelSettings =
    channelEgress === undefined
      ? { enabled: false }
      : {
          ...channelEgress,
          enabled: true,
          gatewayClassName: gatewayRouting?.gatewayClassName ?? "eg",
        };
  const values = {
    images: { controller: images.controller },
    ...(slackProxy ? { slackProxy } : { channelEgress: channelSettings }),
    installation: { name: installationName },
    auth: { baseUrl: authBaseURL },
    agentNativeAdmin: { domain: agentNativeAdminDomain },
    bootstrap: { adminEmail, credentials: { secretName: "occ-bootstrap-credentials" } },
    database: {
      ...(databaseUpgradeMigration ? { upgradeMigration: databaseUpgradeMigration } : {}),
      cidrs: [`${postgresIP}/32`],
      ...(databaseTLS && {
        caSecretName: databaseTLS.caSecretName,
        caKey: "ca.pem",
        caMountPath: "/etc/openclaw/database-ca",
      }),
    },
    cluster: {
      cidrs: [`${endpointIP}/32`],
      port: endpointPort,
    },
    api: {
      clients: apiClients,
    },
    resources,
    // Callers without prepared routing exercise the supported direct-access installation.
    gatewayRouting: gatewayRouting === undefined ? { enabled: false } : gatewayRouting,
    repositoryCredentials,
    controlPlane,
    executionCluster,
    metrics,
  };
  const valuesPath = join(directory, "values.json");
  await writeFile(valuesPath, JSON.stringify(values), { mode: 0o600 });
  return {
    adminEmail,
    adminPassword,
    serviceKey,
    valuesPath,
    registerBootstrapSecrets: (password: string, key: string) => {
      secretValues.push(password, key);
    },
    diagnose: (error: unknown) =>
      withHelmInstallDiagnostic(error, {
        selection,
        namespace: system,
        release,
        secrets: failureSecrets([
          process.env,
          Object.fromEntries(
            secretValues.map((value, index) => [`INSTALL_SECRET_${index}`, value]),
          ),
        ]),
      }),
  };
}

export async function installProductionHelmControlPlane(
  options: PrepareOptions & { chartDirectory?: string | undefined },
) {
  const {
    selection,
    namespace: system,
    release,
    chartDirectory = "deploy/helm/openclaw-enterprise",
    run,
    record,
  } = options;
  const mode = options.bootstrapCredentials ?? "generate";
  const prepared = await prepareProductionHelmControlPlane({
    ...options,
    bootstrapCredentials: mode,
  });
  if (mode === "generate") {
    const occ = join(options.directory, "occ");
    const receipt = join(options.directory, "install-receipt");
    const state = join(options.directory, "installer-state");
    await run("go", ["build", "-trimpath", "-o", occ, "./cmd/occ"]);
    async function retainedInputs() {
      const record: unknown = JSON.parse(
        await readFile(join(receipt, "bootstrap-secret.json"), "utf8"),
      );
      const directory = asRecord(record)?.inputDirectory;
      assert.ok(typeof directory === "string" && directory.startsWith(state + "/"));
      const password = await readFile(join(directory, "initial-admin-password"), "utf8");
      const key = await readFile(join(directory, "initial-admin-service-key"), "utf8");
      prepared.registerBootstrapSecrets(password, key);
      return { adminPassword: password, serviceKey: key };
    }
    try {
      await run(
        occ,
        [
          "installation",
          "install",
          "--kubeconfig",
          selection.kubeconfigPath,
          "--context",
          selection.kubernetesContext,
          "--kube-namespace",
          system,
          "--release",
          release,
          "--chart",
          chartDirectory,
          "--values",
          prepared.valuesPath,
          "--receipt",
          receipt,
          "--wait-timeout",
          "5m",
        ],
        { timeout: 330_000, env: { ...process.env, XDG_STATE_HOME: state } },
      );
    } catch (error) {
      // Read generated inputs before collecting any Pod diagnostics so errors
      // can redact material produced inside the real CLI process.
      await retainedInputs().catch(() => undefined);
      throw await prepared.diagnose(error);
    }
    const inputs = await retainedInputs();
    // The CLI injects its attempt ID through --set-string. Future upgrades must
    // compare against the actual release values, not the pre-dispatch input file.
    const liveValues: unknown = JSON.parse(
      await run("helm", [
        "get",
        "values",
        release,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
        "--namespace",
        system,
        "--output",
        "json",
      ]),
    );
    assert.ok(asRecord(liveValues), "Expected installed Helm user values");
    await writeFile(prepared.valuesPath, JSON.stringify(liveValues), { mode: 0o600 });
    await record("CLI-generated bootstrap, Helm initialization, API and worker ready", {
      namespace: system,
    });
    return { adminEmail: prepared.adminEmail, ...inputs };
  }
  assert.ok(prepared.adminPassword && prepared.serviceKey);
  await run(
    "helm",
    [
      "upgrade",
      "--install",
      release,
      chartDirectory,
      "-n",
      system,
      "--kubeconfig",
      selection.kubeconfigPath,
      "--kube-context",
      selection.kubernetesContext,
      "-f",
      prepared.valuesPath,
      "--wait",
      "--timeout",
      "300s",
    ],
    { timeout: 330_000 },
  ).catch(async (error: unknown) => {
    throw await prepared.diagnose(error);
  });
  await record("Helm initialization, API and worker ready", { namespace: system });
  return {
    adminEmail: prepared.adminEmail,
    adminPassword: prepared.adminPassword,
    serviceKey: prepared.serviceKey,
  };
}

// A failed install says only which hook or resource failed (finding 1574: the initialization
// hook Job's BackoffLimitExceeded). Before the caller's cleanup removes the namespace, the error
// gains each Pod's state, the namespace's events and the hook Job Pod's logs from every
// container, init containers included. The hook keeps its failed Job until the next install.
export async function withHelmInstallDiagnostic(
  error: unknown,
  { selection, namespace, release, secrets }: HelmTarget & { secrets: RedactionSecrets },
) {
  const job = `${release}-initialization`.slice(0, 63).replace(/-$/u, "");
  // Its kubectl stops at the diagnostic's deadline (finding 1557).
  const { kubectl } = createKubernetesClient({ selection });
  const detail = await withinDiagnosticDeadline(
    () =>
      podFailureDiagnostic({
        kubectl,
        namespace,
        logLabels: { "job-name": job },
        secrets,
      }).catch((diagnosticError: unknown) => {
        const name =
          ((typeof diagnosticError === "object" && diagnosticError !== null) ||
            typeof diagnosticError === "function") &&
          "name" in diagnosticError
            ? diagnosticError.name
            : undefined;
        return `\nHelm install diagnostic unavailable: ${name ?? "Error"}`;
      }),
    { timedOut: `\nHelm install diagnostic timed out after ${diagnosticDeadlineMs / 1_000} s` },
  );
  if (error instanceof Error) {
    error.message = `${error.message}${detail}`;
    return error;
  }
  return new Error(`${String(error)}${detail}`);
}
