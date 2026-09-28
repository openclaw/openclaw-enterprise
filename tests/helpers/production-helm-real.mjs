import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// The caller owns the disposable namespace and registers its cleanup before installation.
export async function installProductionHelmControlPlane({
  selection,
  images,
  namespace: system,
  release,
  directory,
  suffix,
  configuration,
  authBaseURL,
  installationName,
  apiClients,
  repositoryCredentials,
  gatewayRouting,
  executionCluster,
  metrics,
  databaseName = "openclaw_enterprise",
  run,
  kubernetes,
  createSecretValue: secret,
  record,
}) {
  assert.match(databaseName, /^[a-z][a-z0-9_]+$/);
  const { kubectl, waitFor } = kubernetes;
  const apply = (object) =>
    run("kubectl", kubernetes.kubectlArguments(["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  const get = (kind, name, namespace = system) => kubernetes.resource(kind, name, namespace);
  const metadata = (name, namespace = system, labels = {}) => ({
    name,
    namespace,
    labels: { "oce-test": suffix, ...labels },
  });
  const createSecret = (name, stringData) =>
    apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name), stringData });
  const createClaim = (name) =>
    apply({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: metadata(name),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-path",
        resources: { requests: { storage: "1Gi" } },
      },
    });
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
  const waitPod = (name) =>
    kubectl("-n", system, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=180s");

  const postgresPassword = secret();
  const migrationPassword = secret();
  const appPassword = secret();
  await createSecret("postgres-bootstrap", {
    password: postgresPassword,
    "init.sql": `CREATE ROLE occ_migrator LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nCREATE ROLE occ_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nGRANT CREATE ON DATABASE ${databaseName} TO occ_migrator;\nCREATE SCHEMA occ AUTHORIZATION occ_migrator;\nCREATE SCHEMA drizzle AUTHORIZATION occ_migrator;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
  });
  await createClaim("postgres-data");
  await createClaim("bootstrap-password");
  await apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata("bootstrap-password-prepare"),
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: {
        runAsUser: 0,
        runAsGroup: 0,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "prepare",
          image: images.controller,
          imagePullPolicy: "IfNotPresent",
          command: [
            "node",
            "-e",
            "const fs=require('node:fs');const root='/var/lib/openclaw/bootstrap';for(const name of ['initial-admin-password','initial-admin-service-key.json']){if(fs.existsSync(`${root}/${name}`))throw new Error(`${name} already exists on fresh bootstrap PVC`)}fs.chownSync(root,1000,1000);fs.chmodSync(root,0o700);const s=fs.statSync(root);console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777}));",
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
          },
          resources,
          volumeMounts: [{ name: "bootstrap", mountPath: "/var/lib/openclaw/bootstrap" }],
        },
      ],
      volumes: [{ name: "bootstrap", persistentVolumeClaim: { claimName: "bootstrap-password" } }],
    },
  });
  await waitFor("fresh bootstrap PVC preparation", async () => {
    const pod = await get("pod", "bootstrap-password-prepare");
    assert.notEqual(pod.status.phase, "Failed", "bootstrap PVC preparation Pod failed");
    return pod.status.phase === "Succeeded";
  });
  assert.deepEqual(
    JSON.parse((await kubectl("-n", system, "logs", "bootstrap-password-prepare")).trim()),
    { uid: 1000, gid: 1000, mode: 0o700 },
  );
  await record("Fresh bootstrap PVC root prepared for UID 1000 output", {
    claimName: "bootstrap-password",
  });
  await apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata("postgres", system, { app: "postgres" }),
    spec: {
      securityContext: { ...podSecurity, runAsUser: 999, runAsGroup: 999, fsGroup: 999 },
      containers: [
        {
          name: "postgres",
          image: images.postgres,
          imagePullPolicy: "IfNotPresent",
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
            { name: "init", mountPath: "/docker-entrypoint-initdb.d", readOnly: true },
          ],
          readinessProbe: {
            exec: { command: ["pg_isready", "-U", "postgres", "-d", databaseName] },
            initialDelaySeconds: 2,
            periodSeconds: 2,
          },
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: "postgres-data" } },
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
  await apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata("postgres"),
    spec: { selector: { app: "postgres" }, ports: [{ port: 5432 }] },
  });
  await waitPod("postgres");
  const postgresIP = (await get("pod", "postgres")).status.podIP;
  await createSecret("occ-installation-startup", {
    "installation.yaml": JSON.stringify(configuration),
  });
  await createSecret("occ-database", {
    "application-url": `postgresql://occ_app:${appPassword}@postgres.${system}.svc.cluster.local:5432/${databaseName}`,
    "migration-url": `postgresql://occ_migrator:${migrationPassword}@postgres.${system}.svc.cluster.local:5432/${databaseName}`,
  });
  await createSecret("occ-auth", { secret: secret() });
  const endpoint = (await get("endpoints", "kubernetes", "default")).subsets[0];
  const adminEmail = `admin-${suffix}@example.invalid`;
  const values = {
    images: { controller: images.controller },
    installation: { name: installationName },
    auth: { baseUrl: authBaseURL },
    bootstrap: { adminEmail, password: { claimName: "bootstrap-password" } },
    database: { cidrs: [`${postgresIP}/32`] },
    cluster: { cidrs: [`${endpoint.addresses[0].ip}/32`], port: endpoint.ports[0].port },
    api: { clients: apiClients },
    resources,
  };
  if (repositoryCredentials !== undefined) {
    values.repositoryCredentials = repositoryCredentials;
  }
  if (gatewayRouting !== undefined) {
    values.gatewayRouting = gatewayRouting;
  }
  if (executionCluster !== undefined) {
    values.executionCluster = executionCluster;
  }
  if (metrics !== undefined) {
    values.metrics = metrics;
  }
  await writeFile(join(directory, "values.json"), JSON.stringify(values), { mode: 0o600 });
  await run(
    "helm",
    [
      "upgrade",
      "--install",
      release,
      "deploy/helm/openclaw-enterprise",
      "-n",
      system,
      "--kubeconfig",
      selection.kubeconfigPath,
      "--kube-context",
      selection.kubernetesContext,
      "-f",
      join(directory, "values.json"),
      "--wait",
      "--timeout",
      "300s",
    ],
    { timeout: 330_000 },
  );
  await record("Helm initialization, API and worker ready", { namespace: system });
  return { adminEmail };
}
