import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  kubernetesHash,
  kubectlArguments,
} from "./kubernetes-real.mjs";
import { installProductionHelmControlPlane } from "./production-helm-real.mjs";
import { ensureEnvoyGatewayControllers } from "./envoy-workspace-gateway.mjs";
import { availablePort } from "./available-port.mjs";

export async function readProtectedInput(path, label) {
  assert.ok(path && isAbsolute(path), `${label} requires an explicit absolute file`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.nlink === 1, `${label} must be a regular private file`);
    assert.equal(stat.mode & 0o077, 0, `${label} must be owner-readable only`);
    assert.ok(
      stat.uid === process.getuid() || stat.uid === 0,
      `${label} must have a trusted owner`,
    );
    assert.ok(stat.size > 0 && stat.size <= 262144, `${label} has invalid size`);
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert.equal(bytesRead, stat.size, `${label} changed while reading`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function createInstalledRepositoryFixture(
  context,
  { selection, images, modelKey, executionMode },
) {
  const dedicated = executionMode === "dedicated";
  const suffix = randomBytes(12).toString("hex");
  const system = `oce-repository-${suffix}`;
  const release = `repository-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-installed-repository-"));
  await chmod(directory, 0o700);
  context.diagnostic(`Installed proof directory: ${directory}`);
  const names = [system];
  const secrets = [modelKey];
  const gatewayName = `${release}-agent-gateways`;
  const gatewayClassName = `repository-${suffix}`;
  const envoyNamespace = process.env.OCC_TEST_ENVOY_GATEWAY_NAMESPACE ?? "envoy-gateway-system";
  const gatewayHostname = `occ-gateway-${kubernetesHash(`${system}/${gatewayName}`)}.${envoyNamespace}.svc`;
  let gatewayConfiguration;
  let forwarding;
  let localServiceKeyFile;
  let closed = false;
  const evidence = {
    source: "production Helm",
    images,
    cluster: selection.kubernetesContext,
    system,
    release,
    rows: [],
  };
  const redact = (value) =>
    secrets
      .filter(Boolean)
      .reduce((text, credential) => text.split(credential).join("[redacted]"), String(value));
  const secret = () => {
    const value = randomBytes(32).toString("hex");
    secrets.push(value);
    return value;
  };
  const record = async (row, details = {}) => {
    evidence.rows.push({ row, ...details });
    await writeFile(
      join(directory, "proof.json"),
      redact(JSON.stringify(evidence, null, 2)) + "\n",
      { mode: 0o600 },
    );
    context.diagnostic(`PASS ${row}`);
  };
  const run = (command, args, { input, timeout = 120000, env = {}, allowExitCodes = [0] } = {}) =>
    new Promise((resolve, reject) => {
      const childEnv = { ...process.env, ...env };
      delete childEnv.OPENAI_API_KEY;
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      const killTimer = setTimeout(() => child.kill("SIGKILL"), timeout + 2000);
      const append = (field, chunk) => {
        if (field === "stdout") {
          stdout += chunk;
        } else {
          stderr += chunk;
        }
        if (stdout.length + stderr.length > 4 * 1024 * 1024) {
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (data) => append("stdout", data));
      child.stderr.on("data", (data) => append("stderr", data));
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        // Subprocesses can include protected stdin in diagnostics; never return it on failure.
        if (allowExitCodes.includes(code) && !timedOut) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `${command} failed (${timedOut ? "timeout" : code}); ${command === "helm" && input === undefined ? redact(stderr).slice(0, 4096) : "protected subprocess output withheld"}`,
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  const kubectl = (...args) => run("kubectl", kubectlArguments(selection, args));
  const kubernetes = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 180000,
    waitIntervalMs: 1000,
  });
  const kubeArgs = kubernetes.kubectlArguments([]);
  const apply = (object) =>
    run("kubectl", kubernetes.kubectlArguments(["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  const get = (kind, name, namespace = system) => kubernetes.resource(kind, name, namespace);
  const { waitFor } = kubernetes;
  const metadata = (name, namespace = system, labels = {}) => ({
    name,
    namespace,
    labels: { "oce-test": suffix, ...labels },
  });
  const createSecret = (name, stringData, namespace = system) =>
    apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name, namespace), stringData });
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
  const waitPod = (name, namespace = system) =>
    kubectl("-n", namespace, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=180s");
  const protectedBootstrapFiles = ["initial-admin-password", "initial-admin-service-key.json"];
  const assertProtectedBootstrapFileModes = (stats) => {
    for (const file of protectedBootstrapFiles) {
      assert.equal(stats[file]?.mode, 0o600);
    }
  };
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    forwarding?.kill("SIGTERM");
    const failures = [];
    await run(
      "helm",
      [
        "uninstall",
        release,
        "-n",
        system,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
      ],
      { timeout: 60000 },
    ).catch(() => failures.push("Helm uninstall"));
    for (const name of names.reverse()) {
      await kubectl(
        "delete",
        "namespace",
        name,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=90s",
      ).catch(() => failures.push("owned namespace removal"));
      try {
        const remaining = JSON.parse(await kubectl("get", "namespaces", "-o", "json"));
        if (remaining.items.some((item) => item.metadata.name === name)) {
          failures.push("namespace remains");
        }
      } catch {
        failures.push("namespace removal readback unavailable");
      }
    }
    if (dedicated) {
      await kubectl(
        "delete",
        "gatewayclass",
        gatewayClassName,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=90s",
      ).catch(() => failures.push("owned GatewayClass removal"));
    }
    for (const file of [
      "tls.key",
      "tls.crt",
      "repository-tls.key",
      "repository-tls.crt",
      "occ-service-key.json",
    ]) {
      await rm(join(directory, file), { force: true }).catch(() =>
        failures.push("protected local file removal"),
      );
    }
    assert.deepEqual(failures, [], "installed fixture cleanup must complete");
  };
  context.after(close);
  if (dedicated) {
    assert.equal(
      process.env.OCC_TEST_GATEWAY_ROUTING_REAL,
      "1",
      "Dedicated repository proof requires prepared private Gateway routing",
    );
    await ensureEnvoyGatewayControllers({ kubectl, waitFor });
  }
  await apply({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: system, labels: { "oce-test": suffix } },
  });
  const port = await availablePort();
  const baseURL = `https://localhost:${port}`;
  const configuration = createKubernetesInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: system,
    gatewayImage: images.runtime,
    codexImage: images.runtime,
    cluster: system,
    codexSeccompProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
  });
  // Match production Gateway headroom; real plugin startup can exceed the generic 1 GiB fixture limit.
  configuration.drivers.compute.configuration.resources.gateway.limits.memory = "2Gi";
  if (dedicated) {
    // Use the same authenticated route for native node enrollment and task
    // submission. The production Driver owns enrollment and shared storage.
    const compute = configuration.drivers.compute.configuration;
    compute.gatewayRouting = { gatewayName, gatewayNamespace: system, envoyNamespace };
    delete compute.network.gatewayClients;
    await createSecret("repository-gateway-api-key", { occ: secret() });
    await apply({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "GatewayClass",
      metadata: { name: gatewayClassName, labels: { "oce-test": suffix } },
      spec: { controllerName: "gateway.envoyproxy.io/gatewayclass-controller" },
    });
  }
  await installProductionHelmControlPlane({
    selection,
    images,
    namespace: system,
    release,
    directory,
    suffix,
    configuration,
    authBaseURL: baseURL,
    installationName: system,
    apiClients: [{ namespace: system, podLabels: { app: "production-tui-proxy" } }],
    ...(dedicated
      ? {
          gatewayRouting: {
            enabled: true,
            gatewayName,
            gatewayClassName,
            envoyNamespace,
            apiKeySecretName: "repository-gateway-api-key",
          },
        }
      : {}),
    run,
    kubernetes,
    createSecretValue: secret,
    record,
  });
  if (dedicated) {
    await waitFor("private Gateway programmed", async () => {
      const gateway = await get("gateway", gatewayName);
      return gateway.status?.conditions?.some(
        (condition) => condition.type === "Programmed" && condition.status === "True",
      );
    });
    const proxy = await waitFor("one Ready private Envoy proxy", async () => {
      const pods = await kubernetes.resources(
        "pods",
        envoyNamespace,
        "-l",
        `gateway.envoyproxy.io/owning-gateway-namespace=${system},gateway.envoyproxy.io/owning-gateway-name=${gatewayName}`,
      );
      const ready = pods.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
      assert.ok(ready.length <= 1, "the disposable route must have one Envoy proxy");
      return ready[0];
    });
    assert.ok(net.isIPv4(proxy.status.podIP));
    const trustedProxies = [`${proxy.status.podIP}/32`];
    configuration.drivers.compute.configuration.network.gatewayTrustedProxyCidrs = trustedProxies;
    gatewayConfiguration = {
      auth: {
        mode: "trusted-proxy",
        identityScopes: { "occ-workspace-files": ["operator.admin"] },
        trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
      },
      allowRealIpFallback: true,
      trustedProxies,
    };
    await record("Private authenticated Gateway routing ready", { gatewayName });
  }
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    join(directory, "tls.key"),
    "-out",
    join(directory, "tls.crt"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  await createSecret("proxy-tls", {
    "tls.key": await readFile(join(directory, "tls.key"), "utf8"),
    "tls.crt": await readFile(join(directory, "tls.crt"), "utf8"),
  });
  await apply({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata("proxy-code"),
    data: {
      "https-proxy.mjs": await readFile("tests/fixtures/production-tui/https-proxy.mjs", "utf8"),
    },
  });
  await apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata("operator", system, {
      app: "production-tui-proxy",
      "app.kubernetes.io/name": "approved-gateway-client",
    }),
    spec: {
      securityContext: { ...podSecurity, fsGroupChangePolicy: "OnRootMismatch" },
      containers: [
        {
          name: "operator",
          image: images.node,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "/code/https-proxy.mjs"],
          securityContext,
          resources,
          env: [
            { name: "TLS_CERT_FILE", value: "/tls/tls.crt" },
            { name: "TLS_KEY_FILE", value: "/tls/tls.key" },
            {
              name: "TARGET_URL",
              value: `http://openclaw-enterprise-api.${system}.svc.cluster.local:8080`,
            },
          ],
          volumeMounts: [
            { name: "code", mountPath: "/code", readOnly: true },
            { name: "tls", mountPath: "/tls", readOnly: true },
            { name: "bootstrap", mountPath: "/bootstrap", readOnly: true },
            { name: "operator-private", mountPath: "/operator" },
          ],
          readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 2 },
        },
      ],
      volumes: [
        { name: "code", configMap: { name: "proxy-code" } },
        { name: "tls", secret: { secretName: "proxy-tls" } },
        { name: "bootstrap", persistentVolumeClaim: { claimName: "bootstrap-password" } },
        { name: "operator-private", emptyDir: {} },
      ],
    },
  });
  await waitPod("operator");
  const bootstrapFileStats = async () =>
    JSON.parse(
      await kubectl(
        "-n",
        system,
        "exec",
        "operator",
        "--",
        "node",
        "-e",
        "const fs=require('node:fs');const root='/bootstrap';const result={};for(const name of ['initial-admin-password','initial-admin-service-key.json']){const s=fs.statSync(`${root}/${name}`);result[name]={uid:s.uid,gid:s.gid,mode:s.mode&0o777}}console.log(JSON.stringify(result));",
      ),
    );
  const beforeRetrievalStats = await bootstrapFileStats();
  assertProtectedBootstrapFileModes(beforeRetrievalStats, "before retrieval");
  forwarding = spawn(
    "kubectl",
    [
      ...kubeArgs,
      "-n",
      system,
      "port-forward",
      "pod/operator",
      `${port}:8443`,
      "--address",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let forwardOutput = "";
  forwarding.stdout.on("data", (data) => {
    forwardOutput += data;
  });
  forwarding.stderr.on("data", (data) => {
    forwardOutput += data;
  });
  await waitFor("TLS proxy forwarding", () => forwardOutput.includes("Forwarding from"));
  const ca = await readFile(join(directory, "tls.crt"));
  localServiceKeyFile = join(directory, "occ-service-key.json");
  let serviceKey;
  const externalRequest = (method, path, body, { authenticated = true } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        `${baseURL}${path}`,
        {
          method,
          ca,
          family: 4,
          headers: {
            ...(authenticated ? { "x-api-key": serviceKey } : {}),
            ...(data
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(data),
                }
              : {}),
          },
        },
        (response) => {
          let output = "";
          response.on("data", (chunk) => {
            output += chunk;
            if (output.length > 4 * 1024 * 1024) {
              response.destroy(new Error("API response exceeded bound"));
            }
          });
          response.on("error", reject);
          response.on("aborted", () => reject(new Error("API response aborted")));
          response.on("end", () => {
            try {
              for (const value of secrets) {
                assert.ok(!output.includes(value), "API response leaked a protected credential");
              }
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: output ? JSON.parse(output) : null,
              });
            } catch (error) {
              if (error instanceof SyntaxError && [502, 503, 504].includes(response.statusCode)) {
                reject(Object.assign(new Error("API is not ready"), { code: "API_NOT_READY" }));
                return;
              }
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("API request timeout")));
      req.end(data);
    });
  const stagedServiceKey = JSON.parse(
    await kubectl(
      "-n",
      system,
      "exec",
      "operator",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const source='/bootstrap/initial-admin-service-key.json';const target='/operator/occ-service-key.json';const input=JSON.parse(fs.readFileSync(source,'utf8'));if(typeof input.data?.key!=='string'||input.data.key.length===0)throw new Error('missing service key');fs.writeFileSync(target,JSON.stringify(input),{mode:0o600});fs.chmodSync(target,0o600);const sourceStat=fs.statSync(source);const targetStat=fs.statSync(target);console.log(JSON.stringify({id:input.data.id,installationId:input.meta?.installationId,expiresAt:input.data.expiresAt,sourceMode:sourceStat.mode&0o777,targetMode:targetStat.mode&0o777,targetUid:targetStat.uid,targetGid:targetStat.gid}));",
    ),
  );
  assert.equal(stagedServiceKey.sourceMode, 0o600);
  assert.equal(stagedServiceKey.targetMode, 0o600);
  await kubectl("-n", system, "cp", "operator:/operator/occ-service-key.json", localServiceKeyFile);
  await chmod(localServiceKeyFile, 0o600);
  const localServiceKey = JSON.parse(await readFile(localServiceKeyFile, "utf8"));
  assert.equal(typeof localServiceKey.data?.key, "string");
  assert.ok(localServiceKey.data.key.length > 0);
  assert.equal(localServiceKey.data.id, stagedServiceKey.id);
  assert.equal(localServiceKey.meta?.installationId, stagedServiceKey.installationId);
  serviceKey = localServiceKey.data.key;
  secrets.push(serviceKey);
  const afterRetrievalStats = await bootstrapFileStats();
  assert.deepEqual(afterRetrievalStats, beforeRetrievalStats);
  assertProtectedBootstrapFileModes(afterRetrievalStats, "after retrieval");

  const api = async (method, path, body, expected = 200) => {
    const result = await externalRequest(method, path, body);
    assert.equal(
      result.status,
      expected,
      redact(`${method} ${path}: ${JSON.stringify(result.body)}`),
    );
    assert.ok(result.body && Object.hasOwn(result.body, "data"));
    return result.body.data;
  };
  const waitForInstallation = () =>
    waitFor(
      "installation API readiness",
      async () => {
        let result;
        try {
          result = await externalRequest("GET", "/installation");
        } catch (error) {
          if (["API_NOT_READY", "ECONNREFUSED", "ECONNRESET"].includes(error?.code)) {
            return false;
          }
          throw error;
        }
        if ([502, 503, 504].includes(result.status)) {
          return false;
        }
        assert.equal(result.status, 200, "installation readiness must return HTTP 200");
        assert.ok(result.body && Object.hasOwn(result.body, "data"));
        return true;
      },
      60000,
    );
  await waitForInstallation();
  const namespace = await api("POST", "/namespaces", { name: `repository-${suffix}` }, 201);
  const tenant = await waitFor("backing tenant namespace", async () => {
    const list = JSON.parse(
      await kubectl(
        "get",
        "namespaces",
        "-l",
        `openclaw.dev/namespace=${namespace.id}`,
        "-o",
        "json",
      ),
    );
    assert.ok(list.items.length <= 1);
    return list.items[0]?.metadata.name ?? false;
  });
  names.push(tenant);
  const grantNamespaceRole = async (targetNamespace, bindingName, clusterRole, account) => {
    await apply({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: metadata(bindingName, targetNamespace),
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: clusterRole,
      },
      subjects: [
        { kind: "ServiceAccount", name: `openclaw-enterprise-${account}`, namespace: system },
      ],
    });
  };
  await grantNamespaceRole(
    tenant,
    "repository-tenant-worker",
    `${release}-openclaw-tenant-worker`,
    "worker",
  );
  await grantNamespaceRole(
    tenant,
    "repository-tenant-api-configuration",
    `${release}-openclaw-tenant-configuration`,
    "api",
  );
  await grantNamespaceRole(
    tenant,
    "repository-tenant-api-secrets",
    `${release}-openclaw-tenant-api`,
    "api",
  );
  await grantNamespaceRole(
    tenant,
    "repository-tenant-gateway-observer",
    `${release}-openclaw-gateway-observer`,
    "api",
  );
  const gatewayRuntimeNamespace = await waitFor("backing Gateway runtime namespace", async () => {
    const list = JSON.parse(
      await kubectl(
        "get",
        "namespaces",
        "-l",
        `openclaw.dev/gateway-namespace=${namespace.id}`,
        "-o",
        "json",
      ),
    );
    assert.ok(list.items.length <= 1);
    return list.items[0]?.metadata.name ?? false;
  });
  names.push(gatewayRuntimeNamespace);
  await grantNamespaceRole(
    gatewayRuntimeNamespace,
    "repository-gateway-worker",
    `${release}-openclaw-tenant-worker`,
    "worker",
  );
  await grantNamespaceRole(
    gatewayRuntimeNamespace,
    "repository-gateway-api-configuration",
    `${release}-openclaw-tenant-configuration`,
    "api",
  );
  await grantNamespaceRole(
    gatewayRuntimeNamespace,
    "repository-gateway-api-secrets",
    `${release}-openclaw-tenant-api`,
    "api",
  );
  await record("Operator granted exact tenant and control-plane namespace access", {
    tenant,
    gatewayRuntimeNamespace,
  });
  await waitFor(
    "OCC Namespace ready",
    async () => (await api("GET", `/namespaces/${namespace.id}`)).status === "ready",
  );
  const sql = async (statement) =>
    (
      await run(
        "kubectl",
        [
          ...kubeArgs,
          "-n",
          system,
          "exec",
          "-i",
          "postgres",
          "--",
          "psql",
          "-U",
          "postgres",
          "-d",
          "openclaw_enterprise",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
        ],
        { input: statement },
      )
    ).trim();
  const renderRepositoryCredentials = async (repositoryCredentials) => {
    const values = JSON.parse(await readFile(join(directory, "values.json"), "utf8"));
    values.repositoryCredentials = repositoryCredentials;
    const candidateValues = join(directory, "repository-values.json");
    await writeFile(candidateValues, JSON.stringify(values), { mode: 0o600 });
    const rendered = JSON.parse(
      await run(
        "node",
        [
          "scripts/render-repository-credentials-origin.mjs",
          "--release",
          release,
          "--namespace",
          system,
          "--values",
          candidateValues,
        ],
        { timeout: 120000 },
      ),
    );
    assert.equal(rendered.release, release);
    assert.equal(rendered.namespace, system);
    assert.equal(rendered.backendId, repositoryCredentials.backendId);
    return rendered;
  };
  const upgrade = async (repositoryCredentials) => {
    await createSecret("occ-installation-startup", {
      "installation.yaml": JSON.stringify(configuration),
    });
    const values = JSON.parse(await readFile(join(directory, "values.json"), "utf8"));
    values.repositoryCredentials = repositoryCredentials;
    await writeFile(join(directory, "values.json"), JSON.stringify(values), { mode: 0o600 });
    const renderedRepositoryCredentials = await renderRepositoryCredentials(repositoryCredentials);
    await run(
      "helm",
      [
        "upgrade",
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
      { timeout: 330000 },
    );
    await waitForInstallation();
    return renderedRepositoryCredentials;
  };
  return {
    selection,
    images,
    system,
    release,
    directory,
    suffix,
    namespace,
    tenant,
    gatewayRuntimeNamespace,
    configuration,
    gatewayConfiguration,
    gatewayHostname,
    secrets,
    record,
    run,
    kubectl,
    kubernetes,
    apply,
    get,
    metadata,
    createSecret,
    api,
    externalRequest,
    waitFor,
    sql,
    renderRepositoryCredentials,
    upgrade,
    close,
  };
}

export function createRepositoryObserver({ run, repository, binary = "gh" }) {
  assert.match(repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
  if (binary !== "gh") {
    assert.ok(isAbsolute(binary), "the managed gh binary must be absolute");
  }
  const prefix = `repos/${repository}`;
  const observe = async (method, suffix = "", body, expected = 200) => {
    assert.ok(!suffix.includes("..") && !suffix.startsWith("/"));
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--include",
      "--method",
      method,
      `${prefix}${suffix ? `/${suffix}` : ""}`,
    ];
    if (body !== undefined) {
      args.push("--input", "-");
    }
    const response = await run(binary, args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      timeout: 30000,
      allowExitCodes: [0, 1],
    });
    const separator = /\r?\n\r?\n/.exec(response);
    assert.ok(separator, "GitHub API must return a status and response");
    const status = Number(/^HTTP\/\S+ (\d+)/.exec(response)?.[1]);
    assert.ok([].concat(expected).includes(status), `GitHub ${method} returned ${status}`);
    const payload = response.slice(separator.index + separator[0].length);
    return { status, data: payload.trim() ? JSON.parse(payload) : undefined };
  };
  observe.deleteBranch = async (branch, sha) => {
    assert.match(sha, /^[a-f0-9]{40}$/);
    await run("git", ["check-ref-format", `refs/heads/${branch}`]);
    // The final compare-and-delete belongs to Git transport. The lease also
    // prevents deleting a concurrent update after our independent API readback.
    const credentialHelper = "!" + "'" + binary.replaceAll("'", "'\\''") + "' auth git-credential";
    await run(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${credentialHelper}`,
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${branch}:${sha}`,
        `https://github.com/${repository}.git`,
        `:refs/heads/${branch}`,
      ],
      { timeout: 60000, env: { GIT_TERMINAL_PROMPT: "0" } },
    );
  };
  return observe;
}

export const submitRepositoryTaskScript = String.raw`
  let stage = "input";
  (async () => {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 32768) throw new Error("task input too large");
    }
    const { sessionKey, prompt, gatewayUrl, completionMarker } = JSON.parse(input);
    stage = "authentication";
    if (process.env.OPENAI_API_KEY) throw new Error("request client must not receive model credentials");
    let url;
    let authentication;
    if (gatewayUrl !== undefined) {
      url = new URL(gatewayUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password ||
          !/^occ-gateway-[a-f0-9]{12}\.[a-z0-9-]+\.svc$/.test(url.hostname) ||
          !/^\/namespaces\/[A-Za-z0-9_-]+\/agents\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
          url.search || url.hash) throw new Error("invalid private Gateway route");
      if (typeof completionMarker !== "string" || completionMarker.length === 0 ||
          completionMarker.length > 1024) throw new Error("private Gateway route requires a completion marker");
      const key = require("node:fs").readFileSync(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8");
      if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error("Gateway API key unavailable");
      const { randomUUID } = require("node:crypto");
      const { pathToFileURL } = require("node:url");
      const { setTimeout: delay } = require("node:timers/promises");
      const { GatewayClient } = await import(
        pathToFileURL(
          require.resolve("@openclaw/gateway-client", { paths: ["/app/apps/controller"] }),
        ).href
      );
      stage = "gateway-connect";
      let resolveHello;
      let rejectHello;
      const connected = new Promise((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
      });
      url.protocol = "wss:";
      const client = new GatewayClient({
        url: url.toString(),
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        scopes: [],
        deviceIdentity: null,
        edgeAuthHeaders: { "x-api-key": key },
        onHelloOk: resolveHello,
        onConnectError: rejectHello,
      });
      const signal = AbortSignal.timeout(600000);
      const helloTimer = setTimeout(() => rejectHello(new Error("gateway hello timeout")), 15000);
      client.start();
      try {
        const hello = await connected;
        clearTimeout(helloTimer);
        if (hello.auth?.role !== "operator" || !hello.auth.scopes.includes("operator.admin")) {
          throw new Error("trusted-proxy gateway authentication did not grant operator.admin");
        }
        if (hello.auth.deviceToken !== undefined) {
          throw new Error("trusted-proxy gateway issued an unexpected device token");
        }
        stage = "chat-send";
        const acknowledgement = await client.request(
          "chat.send",
          { sessionKey, idempotencyKey: randomUUID(), message: prompt },
          { signal, timeoutMs: 30000 },
        );
        stage = "chat-history";
        while (!signal.aborted) {
          const history = await client.request(
            "chat.history",
            { sessionKey, limit: 30 },
            { signal, timeoutMs: 10000 },
          );
          for (const message of history.messages ?? []) {
            if (message.role !== "assistant") continue;
            if (message.stopReason === "error") throw new Error("native model turn failed");
            const content = typeof message.content === "string"
              ? message.content
              : (message.content ?? [])
                  .filter((part) => part?.type === "text" && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n");
            const hasToolCalls = Array.isArray(message.content) &&
              message.content.some((part) => part?.type === "toolCall");
            if (content.includes(completionMarker) && !hasToolCalls && message.stopReason !== "toolUse") {
              process.stdout.write(JSON.stringify({
                status: 200,
                transport: "wss",
                runId: acknowledgement?.runId,
              }));
              return;
            }
          }
          await delay(500, undefined, { signal });
        }
        throw new Error("native task timeout");
      } finally {
        clearTimeout(helloTimer);
        client.stop();
        await client.stopAndWait?.({ timeoutMs: 1000 }).catch(() => undefined);
      }
    } else {
      const password = process.env.OPENCLAW_GATEWAY_PASSWORD;
      if (!password) throw new Error("gateway loopback credential unavailable");
      authentication = { authorization: "Bearer " + password };
      url = "http://127.0.0.1:" + (process.env.OPENCLAW_GATEWAY_PORT || "8080") + "/v1/chat/completions";
    }
    stage = "request";
    const response = await fetch(url, {
      method: "POST", signal: AbortSignal.timeout(600000), redirect: "error",
      headers: { ...authentication, "content-type": "application/json", "x-openclaw-session-key": sessionKey },
      body: JSON.stringify({ model: "openclaw/default", stream: false, messages: [{ role: "user", content: prompt }] }),
    });
    // Persisted transcript and independent provider reads establish success, never reply prose.
    stage = "response-body";
    await response.arrayBuffer();
    process.stdout.write(JSON.stringify({ status: response.status }));
  })().catch((error) => {
    const code = error?.cause?.code ?? error?.code;
    const allowed = [
      "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
      "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
    ];
    // Return only fixed diagnostic vocabulary; the caller still requires HTTP 200.
    process.stdout.write(JSON.stringify({
      status: null,
      failure: { stage, code: allowed.includes(code) ? code : "OTHER" },
    }));
  });
`;

// Read-only private control observation. The production worker remains the only
// session opener/closer, and bearer material never leaves the workload.
export async function readInstalledCredentialSession(executeWorker, sessionId) {
  const code = String.raw`
    const http = require("node:http");
    const id = process.argv[1];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid session identity");
    const request = http.request({ socketPath: "/run/openclaw/repository-control/private/control.sock", path: "/v1/sessions/" + id, method: "GET", timeout: 5000 }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; if (text.length > 65536) response.destroy(); });
      response.on("end", () => {
        if (response.statusCode !== 200) throw new Error("session status unavailable");
        const value = JSON.parse(text);
        console.log(JSON.stringify({ sessionId: value.sessionId, state: value.state, activeUses: value.activeUses, cleanup: value.cleanup }));
      });
    });
    request.on("timeout", () => request.destroy(new Error("status timeout")));
    request.on("error", () => { process.stderr.write("session observation failed\n"); process.exitCode = 1; });
    request.end();
  `;
  return JSON.parse(await executeWorker(code, [sessionId], 10000));
}
