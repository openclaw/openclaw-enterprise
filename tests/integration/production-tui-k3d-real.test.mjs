import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { installProductionHelmControlPlane } from "../helpers/production-helm-real.mjs";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  kubectlArguments as buildKubectlArguments,
  kubernetesHash as hash,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";
import {
  assertKubernetesRuntimeOtelSettings,
  createOtelLogObservation,
  OTEL_RESOURCE,
} from "../helpers/logging-otel-observation.mjs";

const selected = process.env.OCC_TEST_PRODUCTION_TUI_REAL === "1";
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};

test(
  "Helm production installation supports interactive TUI and revision cutover",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_PRODUCTION_TUI_REAL=1 with explicit disposable k3d and real images/key.",
    timeout: 1_800_000,
  },
  async (context) => {
    await validateExplicitK3dLoopbackContext(selection);
    const images = Object.fromEntries(
      [
        ["controller", "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"],
        ["runtime", "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"],
        ["postgres", "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"],
        ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
      ].map(([name, variable]) => {
        const value = process.env[variable];
        assert.match(
          value ?? "",
          /^\S+@sha256:[a-f0-9]{64}$/,
          `${variable} must select a real immutable image`,
        );
        return [name, value];
      }),
    );
    assert.ok(process.env.OPENAI_API_KEY, "A real model credential is required");
    const model = process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel;
    const suffix = randomBytes(4).toString("hex");
    const system = `oce-tui-${suffix}`;
    const foreign = `oce-denied-${suffix}`;
    const release = `tui-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "oce-production-tui-"));
    const secrets = [process.env.OPENAI_API_KEY];
    const otelLogs = createOtelLogObservation(context, {
      description: "production Helm real-Pod OTel logs",
    });
    const secret = () => {
      const value = randomBytes(32).toString("hex");
      secrets.push(value);
      return value;
    };
    const redact = (value) =>
      secrets.reduce(
        (text, credential) => text.split(credential).join("[redacted]"),
        String(value),
      );
    const names = [system, foreign];
    let localServiceKeyFile;
    let forwarding;
    const evidence = {
      source: "production Helm",
      cluster: selection.kubernetesContext,
      images,
      model,
      system,
      release,
      rows: [],
    };
    const record = async (row, details = {}) => {
      evidence.rows.push({ row, ...details });
      await writeFile(join(directory, "proof.json"), JSON.stringify(evidence, null, 2) + "\n", {
        mode: 0o600,
      });
      context.diagnostic(`PASS ${row}`);
    };
    const run = (command, args, { input, timeout = 120_000, allowFailure = false, env } = {}) =>
      new Promise((resolve, reject) => {
        const childEnv = env ? { ...process.env, ...env } : undefined;
        if (childEnv) {
          for (const [name, value] of Object.entries(childEnv)) {
            if (value === undefined) {
              delete childEnv[name];
            }
          }
        }
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 || (allowFailure && code === 1)) {
            resolve(stdout);
          } else {
            reject(new Error(redact(`${command} failed (${code}): ${stderr}\n${stdout}`)));
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      });
    // Build the operator CLI before using it against the real Helm installation.
    const occCli = join(process.cwd(), "bin", "occ");
    await run("go", ["build", "-trimpath", "-o", occCli, "./cmd/occ"]);
    const kubectl = (...args) => run("kubectl", buildKubectlArguments(selection, args));
    const kubernetes = createKubernetesClient({
      selection,
      kubectl,
      waitTimeoutMs: 180_000,
      waitIntervalMs: 1_000,
    });
    const kubeArgs = kubernetes.kubectlArguments([]);
    const apply = (object) =>
      run("kubectl", kubernetes.kubectlArguments(["apply", "-f", "-"]), {
        input: JSON.stringify(object),
      });
    const get = async (kind, name, namespace = system) =>
      kubernetes.resource(kind, name, namespace);
    const { resources: resourcesFor, waitFor } = kubernetes;
    const metadata = (name, namespace = system, labels = {}) => ({
      name,
      namespace,
      labels: { "oce-test": suffix, ...labels },
    });
    const createSecret = (name, stringData, namespace = system) =>
      apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name, namespace), stringData });
    const protectedBootstrapFiles = ["initial-admin-password", "initial-admin-service-key.json"];
    const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
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
    const assertProtectedBootstrapFileModes = (stats, label) => {
      for (const file of protectedBootstrapFiles) {
        assert.equal(stats[file]?.mode, 0o600, `${label}: ${file} must stay owner-readable only`);
      }
    };

    context.after(async () => {
      forwarding?.kill("SIGTERM");
      // Preserve nonsecret proof and attach.sh; delete locally copied TLS credentials.
      for (const file of ["tls.key", "tls.crt"]) {
        await rm(join(directory, file), { force: true });
      }
      // These namespaces are unique to this run. Keep is an explicit operator rehearsal mode.
      if (process.env.OCC_TEST_PRODUCTION_TUI_KEEP === "1") {
        context.diagnostic(`Retained production setup: ${directory}`);
        return;
      }
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
        { timeout: 60_000 },
      ).catch(() => {});
      for (const name of names.reverse()) {
        await kubectl("delete", "namespace", name, "--ignore-not-found", "--wait=false").catch(
          () => {},
        );
      }
    });

    async function installProductionControlPlane() {
      for (const name of names) {
        await apply({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name, labels: { "oce-test": suffix } },
        });
      }
      const configuration = createKubernetesInstallationConfiguration({
        authentication: { mode: "inCluster" },
        platformNamespace: system,
        gatewayImage: images.runtime,
        codexImage: images.runtime,
        cluster: `production-tui-${suffix}`,
      });
      const port = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
          const result = server.address().port;
          server.close(() => resolve(result));
        });
      });
      const baseURL = `https://localhost:${port}`;
      await installProductionHelmControlPlane({
        selection,
        images,
        namespace: system,
        release,
        directory,
        suffix,
        configuration,
        authBaseURL: baseURL,
        installationName: `Production TUI ${suffix}`,
        apiClients: [{ namespace: system, podLabels: { app: "production-tui-proxy" } }],
        metrics: {
          enabled: true,
          scraperNamespaceLabels: { "kubernetes.io/metadata.name": system },
          scraperPodLabels: { app: "production-tui-proxy" },
        },
        run,
        kubernetes,
        createSecretValue: secret,
        record,
      });

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
          "https-proxy.mjs": await readFile(
            "tests/fixtures/production-tui/https-proxy.mjs",
            "utf8",
          ),
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
              });
              response.on("end", () => {
                for (const value of secrets) {
                  assert.ok(!output.includes(value), "API response leaked a protected credential");
                }
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  body: output ? JSON.parse(output) : null,
                });
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
      await kubectl(
        "-n",
        system,
        "cp",
        "operator:/operator/occ-service-key.json",
        localServiceKeyFile,
      );
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

      const runGuideOcc = async (args) => {
        const output = await run(occCli, [...args, "--output", "json"], {
          env: {
            OCC_URL: baseURL,
            OCC_SERVICE_KEY_FILE: localServiceKeyFile,
            OCC_CA_BUNDLE: join(directory, "tls.crt"),
            OPENAI_API_KEY: undefined,
          },
        });
        for (const value of secrets) {
          assert.ok(!output.includes(value), "Guide output leaked a credential");
        }
        return JSON.parse(output);
      };
      const request = async (method, path, body, expected = 200) => {
        const result = await externalRequest(method, path, body);
        assert.equal(
          result.status,
          expected,
          redact(`${method} ${path}: ${JSON.stringify(result.body)}`),
        );
        assert.ok(result.body && typeof result.body === "object");
        assert.ok(Object.hasOwn(result.body, "data"));
        assert.ok(Object.hasOwn(result.body, "meta"));
        return result.body;
      };
      const installation = await request("GET", "/installation");
      assert.equal(stagedServiceKey.installationId, installation.data.id);
      const guideInstallation = await runGuideOcc(["installation", "get"]);
      assert.equal(guideInstallation.id, installation.data.id);
      const externalUnauthenticatedInstallation = await externalRequest(
        "GET",
        "/installation",
        undefined,
        {
          authenticated: false,
        },
      );
      assert.equal(externalUnauthenticatedInstallation.status, 401);
      await record("Protected bootstrap output files remain 0600 through retrieval");
      await record("Service-key authenticated production HTTPS Installation read", {
        installationId: installation.data.id,
        serviceKeyId: stagedServiceKey.id,
      });
      const api = async (method, path, body, expected = 200) => {
        const result = await request(method, path, body, expected);
        return result.data;
      };
      return { api, externalRequest, runGuideOcc };
    }

    async function provisionNamespaceAndAgent({ api, externalRequest, runGuideOcc }) {
      assert.equal(
        (await externalRequest("GET", "/installation", undefined, { authenticated: false })).status,
        401,
      );
      const namespace = await runGuideOcc(["namespace", "create", `production-tui-${suffix}`]);
      await record("Guide occ CLI created OCC Namespace through production HTTPS", {
        namespaceId: namespace.id,
      });
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
        if (!list.items.length) {
          return false;
        }
        assert.equal(list.items.length, 1);
        assert.equal(list.items[0].metadata.annotations["openclaw.dev/namespace-id"], namespace.id);
        return list.items[0].metadata.name;
      });
      names.push(tenant);
      for (const [name, role, account] of [
        ["worker", "worker", "worker"],
        ["configuration", "configuration", "api"],
        ["secrets", "api", "api"],
      ]) {
        await apply({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: metadata(`production-tui-${name}`, tenant),
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: `${release}-openclaw-tenant-${role}`,
          },
          subjects: [
            { kind: "ServiceAccount", name: `openclaw-enterprise-${account}`, namespace: system },
          ],
        });
      }
      await waitFor("OCC Namespace ready", async () => {
        const current = await api("GET", `/namespaces/${namespace.id}`);
        assert.ok(!["failed", "deleting"].includes(current.status), `Namespace ${current.status}`);
        return current.status === "ready";
      });
      // A connectivity demo has no identity wizard; first-run BOOTSTRAP.md would override its nonce prompt.
      const nativeConfiguration = createHarnessConfiguration("openclaw", model);
      nativeConfiguration.agents.defaults.skipBootstrap = true;
      nativeConfiguration.gateway.auth = {
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      };
      const agentConfiguration = await api(
        "POST",
        `/namespaces/${namespace.id}/configurations`,
        { kind: "agent", values: nativeConfiguration },
        201,
      );
      const agent = await api(
        "POST",
        `/namespaces/${namespace.id}/agents`,
        {
          name: `tui-${suffix}`,
          configurationId: agentConfiguration.id,
          executionMode: "embedded",
        },
        201,
      );
      const agentHash = hash(agent.id);
      const gatewayPassword = secret();
      secrets.push(gatewayPassword);
      await createSecret(
        `openclaw-agent-transport-${agentHash}`,
        { "app-server-token": secret(), "gateway-password": gatewayPassword },
        tenant,
      );
      await createSecret(
        `openclaw-agent-model-${agentHash}`,
        { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
        tenant,
      );
      await record("API-created Namespace ready and embedded Agent provisioned", {
        namespaceId: namespace.id,
        tenant,
        agentId: agent.id,
      });
      return { agent, agentHash, namespace, tenant };
    }

    async function proveProductionApiNetworkPolicy() {
      // Both clients use real listening services; a timeout alone is not a positive control.
      await apply({
        apiVersion: "v1",
        kind: "Pod",
        metadata: metadata("unapproved", foreign),
        spec: {
          securityContext: podSecurity,
          containers: [
            {
              name: "probe",
              image: images.node,
              imagePullPolicy: "IfNotPresent",
              securityContext,
              resources,
              command: [
                "node",
                "-e",
                "require('node:net').createServer(s=>s.end()).listen(8123,'0.0.0.0')",
              ],
              readinessProbe: { tcpSocket: { port: 8123 }, periodSeconds: 2 },
            },
          ],
        },
      });
      await waitPod("unapproved", foreign);
      const foreignIP = (await get("pod", "unapproved", foreign)).status.podIP;
      const probe = async (podNamespace, pod, host, targetPort, container) => {
        const code =
          "const net=require('node:net');const s=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});s.setTimeout(3000);let done=false;function end(result){if(done)return;done=true;console.log(result);s.destroy()}s.on('connect',()=>end('connected'));s.on('timeout',()=>end('timeout'));s.on('error',e=>end(e.code));";
        return (
          await kubectl(
            "-n",
            podNamespace,
            "exec",
            pod,
            ...(container ? ["-c", container] : []),
            "--",
            "node",
            "-e",
            code,
            host,
            String(targetPort),
          )
        ).trim();
      };
      const apiService = (await get("service", "openclaw-enterprise-api")).spec.clusterIP;
      assert.equal(await probe(system, "operator", apiService, 8080), "connected");
      // Enforcing CNIs may REJECT immediately or DROP; the listening positive control stays live.
      assert.ok(
        ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
          await probe(foreign, "unapproved", apiService, 8080),
        ),
      );
      assert.equal(await probe(system, "operator", apiService, 8080), "connected");
      assert.equal(await probe(system, "operator", foreignIP, 8123), "connected");
      // Both live OCC processes expose private metrics. Prove the allowed peer
      // can scrape, and the foreign peer cannot connect, against the same Pod IP.
      for (const component of ["api", "worker"]) {
        const pods = JSON.parse(
          await kubectl(
            "-n",
            system,
            "get",
            "pods",
            "-l",
            `app.kubernetes.io/component=${component},app.kubernetes.io/instance=${release}`,
            "-o",
            "json",
          ),
        );
        const running = pods.items.filter((pod) => pod.status.phase === "Running");
        assert.ok(running.length > 0, `${component} must have a running metrics target`);
        for (const pod of running) {
          const host = pod.status.podIP;
          assert.equal(await probe(system, "operator", host, 9464), "connected");
          assert.ok(
            ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
              await probe(foreign, "unapproved", host, 9464),
            ),
          );
          const output = await kubectl(
            "-n",
            system,
            "exec",
            "operator",
            "--",
            "node",
            "-e",
            "fetch(process.argv[1]).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())})",
            `http://${host}:9464/metrics`,
          );
          assert.match(output, /occ_process_resident_memory_bytes/);
        }
      }
      await record("Production API NetworkPolicy allows operator and denies foreign namespace");
      return { foreignIP, probe };
    }

    const nativeTuiArgv = ({ pod, state, session, message, invalidGatewayPassword = false }) => [
      ...kubeArgs,
      "-n",
      tenant,
      "exec",
      "-it",
      pod,
      "-c",
      "gateway",
      "--",
      "env",
      "-u",
      "OPENAI_API_KEY",
      `OPENCLAW_STATE_DIR=${state}`,
      ...(invalidGatewayPassword ? [`OPENCLAW_GATEWAY_PASSWORD=invalid-${suffix}`] : []),
      "node",
      "/app/openclaw.mjs",
      "tui",
      "--session",
      session,
      ...(message ? ["--message", message] : []),
    ];

    async function exerciseRevisionCutover() {
      let previousPod;
      let firstRevision;
      let finalPod;
      let finalRevision;
      for (const round of [1, 2]) {
        // Each bodyless deployment freezes a new immutable revision of the same Agent.
        const revision = await api(
          "POST",
          `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
          undefined,
          202,
        );
        const configMap = `gateway-${agentHash}-rev-${hash(revision.id)}`;
        await waitFor(
          `Agent active revision ${round}`,
          async () =>
            (await api("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
              .activeRevisionId === revision.id,
          300_000,
        );
        const gateway = await waitFor(`Ready gateway for revision ${round}`, async () => {
          const pods = await resourcesFor(
            "pods",
            tenant,
            "-l",
            `app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/namespace=${namespace.id},openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=gateway`,
          );
          const matches = pods.filter(
            (pod) =>
              !pod.metadata.deletionTimestamp &&
              pod.status.phase === "Running" &&
              pod.status.conditions?.some(
                (condition) => condition.type === "Ready" && condition.status === "True",
              ) &&
              pod.spec.volumes.some((volume) => volume.configMap?.name === configMap),
          );
          assert.ok(matches.length <= 1, "Ambiguous active gateway Pod");
          return matches[0];
        });
        if (previousPod) {
          assert.notEqual(
            gateway.metadata.uid,
            previousPod.metadata.uid,
            "Cutover must serve the new immutable config in a new Pod",
          );
        }
        previousPod = gateway;
        if (round === 1) {
          firstRevision = revision.id;
        }
        finalPod = gateway.metadata.name;
        finalRevision = revision.id;
        if (round === 1) {
          const nonce = `DENIED_${suffix}`;
          const prompt = `Reply exactly: ${nonce}`;
          const output = await run("python3", [
            "tests/helpers/tui-pty.py",
            "expect-failure",
            "--nonce",
            nonce,
            "--prompt",
            prompt,
            "--timeout",
            "60",
            "--",
            "kubectl",
            ...nativeTuiArgv({
              pod: gateway.metadata.name,
              state: `/tmp/occ-denied-${suffix}`,
              session: `denied-${suffix}`,
              message: prompt,
              invalidGatewayPassword: true,
            }),
          ]);
          for (const value of secrets) {
            assert.ok(!output.includes(value), "Denied TUI output leaked a credential");
          }
          assert.equal(JSON.parse(output).denied, true);
          await record("Fresh-state invalid gateway password rejected");
        }
        const first = `TUI_${round}_A_${randomBytes(8).toString("hex")}`;
        const second = `TUI_${round}_B_${randomBytes(8).toString("hex")}`;
        const firstPrompt = `Reply exactly: ${first}`;
        const secondPrompt = `Reply exactly: ${second}`;
        const output = await run(
          "python3",
          [
            "tests/helpers/tui-pty.py",
            "conversation",
            "--first-nonce",
            first,
            "--first-prompt",
            firstPrompt,
            "--second-nonce",
            second,
            "--second-prompt",
            secondPrompt,
            "--timeout",
            "240",
            "--",
            "kubectl",
            ...nativeTuiArgv({
              pod: gateway.metadata.name,
              state: `/tmp/occ-tui-${suffix}`,
              session: `production-${suffix}-${round}`,
              message: firstPrompt,
            }),
          ],
          { timeout: 550_000 },
        );
        for (const value of secrets) {
          assert.ok(!output.includes(value), "TUI output leaked a credential");
        }
        const conversation = JSON.parse(output);
        assert.equal(conversation.exitCode, 0);
        await writeFile(join(directory, `tui-revision-${round}.json`), output, { mode: 0o600 });
        assert.equal(
          (await get("pod", gateway.metadata.name, tenant)).metadata.uid,
          gateway.metadata.uid,
        );
        assert.equal(
          await kubectl(
            "-n",
            tenant,
            "exec",
            gateway.metadata.name,
            "-c",
            "gateway",
            "--",
            "node",
            "-e",
            "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1);console.log('ready')})",
          ),
          "ready\n",
        );
        await record(
          `Revision ${round}: two assistant replies in one TUI, Ctrl+D leaves gateway ready`,
          {
            revisionId: revision.id,
            pod: gateway.metadata.name,
            podUid: gateway.metadata.uid,
            configMap,
            firstReply: conversation.firstReplyLine,
            secondReply: conversation.secondReplyLine,
          },
        );
        const gatewayService = (await get("service", `gateway-${agentHash}`, tenant)).spec
          .clusterIP;
        assert.equal(await probe(system, "operator", gatewayService, 8080), "connected");
        assert.ok(
          ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
            await probe(foreign, "unapproved", gatewayService, 8080),
          ),
        );
        assert.equal(await probe(system, "operator", gatewayService, 8080), "connected");
        assert.ok(
          ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
            await probe(tenant, gateway.metadata.name, foreignIP, 8123, "gateway"),
          ),
        );
        assert.equal(await probe(system, "operator", foreignIP, 8123), "connected");
        await record(`Revision ${round}: gateway ingress and private egress isolation`);
      }
      return {
        pod: finalPod,
        revisionId: finalRevision,
        successfulWorkerRevisionId: firstRevision,
      };
    }

    async function verifyCredentialBoundariesAndPrepareHandoff(finalGateway) {
      const { pod: finalPod, revisionId: finalRevision } = finalGateway;
      for (const [verb, resource] of [
        ["get", "secrets"],
        ["create", "rolebindings"],
      ]) {
        const allowed = await run(
          "kubectl",
          [
            ...kubeArgs,
            "-n",
            tenant,
            "auth",
            "can-i",
            verb,
            resource,
            "--as",
            `system:serviceaccount:${system}:openclaw-enterprise-worker`,
          ],
          { allowFailure: true },
        );
        assert.equal(allowed.trim(), "no", `Worker must not ${verb} ${resource}`);
      }
      const systemPods = await resourcesFor(
        "pods",
        system,
        "-l",
        "app.kubernetes.io/name=openclaw-enterprise",
      );
      for (const pod of systemPods.filter((item) => item.status.phase === "Running")) {
        await kubectl(
          "-n",
          system,
          "exec",
          pod.metadata.name,
          "--",
          "node",
          "-e",
          "if(process.env.OPENAI_API_KEY)process.exit(1)",
        );
        const logs = await kubectl(
          "-n",
          system,
          "logs",
          pod.metadata.name,
          "--all-containers",
          "--tail=200",
        );
        for (const value of secrets) {
          assert.ok(!logs.includes(value), "Control-plane log leaked a credential");
        }
      }
      const gatewayLogs = await kubectl(
        "-n",
        tenant,
        "logs",
        finalPod,
        "-c",
        "gateway",
        "--tail=200",
      );
      for (const value of secrets) {
        assert.ok(!gatewayLogs.includes(value), "Gateway log leaked a credential");
      }
      await record("Worker least privilege and credential output boundaries");
      await kubectl(
        "-n",
        system,
        "exec",
        "operator",
        "--",
        "rm",
        "-f",
        "/operator/occ-service-key.json",
      );
      if (localServiceKeyFile) {
        await rm(localServiceKeyFile, { force: true });
      }
      const bootstrapServiceKeyMode = JSON.parse(
        await kubectl(
          "-n",
          system,
          "exec",
          "operator",
          "--",
          "node",
          "-e",
          "const fs=require('node:fs');const s=fs.statSync('/bootstrap/initial-admin-service-key.json');console.log(JSON.stringify({mode:s.mode&0o777}))",
        ),
      );
      assert.equal(bootstrapServiceKeyMode.mode, 0o600);
      await record("Private service-key working copies removed before handoff");
      await record("No controller session required before interactive handoff");
      const attach = [
        "kubectl",
        ...nativeTuiArgv({
          pod: finalPod,
          state: `/tmp/occ-tui-${suffix}`,
          session: `production-${suffix}-2`,
        }),
      ];
      await writeFile(
        join(directory, "attach.sh"),
        "#!/bin/sh\nexec " + attach.map(shellQuote).join(" ") + "\n",
        { mode: 0o700 },
      );
      evidence.attachScript = join(directory, "attach.sh");
      await record("Final production setup attachable", {
        tenant,
        agentId: agent.id,
        revisionId: finalRevision,
        pod: finalPod,
      });
      context.diagnostic(`Evidence directory: ${directory}`);
    }

    async function newestPod(component) {
      const pods = await resourcesFor(
        "pods",
        system,
        "-l",
        `app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/component=${component}`,
      );
      const candidates = pods
        .filter((pod) => pod.metadata.deletionTimestamp === undefined)
        .sort((left, right) =>
          String(left.metadata.creationTimestamp).localeCompare(
            String(right.metadata.creationTimestamp),
          ),
        );
      assert.ok(candidates.length > 0, `expected a ${component} Pod`);
      return candidates.at(-1);
    }

    async function assertProductionOtelLogs(finalGateway) {
      const [initializationPod, apiPod, workerPod, gatewayPod] = await Promise.all([
        newestPod("initialization"),
        newestPod("api"),
        newestPod("worker"),
        get("pod", finalGateway.pod, tenant),
      ]);
      assertKubernetesRuntimeOtelSettings(otelLogs, [gatewayPod]);
      await otelLogs.assertRecords({
        forbidden: secrets,
        expected: [
          {
            label: "production migration completed",
            serviceName: "occ-api",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: initializationPod.metadata.uid,
            },
            attributes: { "event.name": "migration.completed" },
            body: "migration.completed",
          },
          {
            label: "production bootstrap completed",
            serviceName: "occ-api",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: initializationPod.metadata.uid,
            },
            attributes: { "event.name": "installation.bootstrapped" },
            body: "installation.bootstrapped",
          },
          {
            label: "production API request completed",
            serviceName: "occ-api",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: apiPod.metadata.uid,
            },
            attributes: {
              "event.name": "http.completed",
              "http.request.method": "GET",
              "http.response.status_code": 200,
            },
            body: "http.completed",
          },
          {
            label: "production worker completed embedded revision",
            serviceName: "occ-worker",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: workerPod.metadata.uid,
            },
            attributes: {
              "event.name": "worker.completed",
              "occ.namespace.id": namespace.id,
              "occ.agent.id": agent.id,
              "occ.revision.id": finalGateway.successfulWorkerRevisionId,
              "work.operation": "agent_revision.reconcile",
              "work.outcome": "success",
            },
            body: "worker.completed",
          },
          {
            label: "production embedded gateway operational record",
            serviceName: "openclaw-gateway",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: gatewayPod.metadata.uid,
              [OTEL_RESOURCE.namespaceId]: namespace.id,
              [OTEL_RESOURCE.agentId]: agent.id,
              [OTEL_RESOURCE.revisionId]: finalGateway.revisionId,
            },
            attributes: { "event.name": "gateway.operational" },
            body: "gateway.operational",
          },
        ],
      });
    }

    const { api, externalRequest, runGuideOcc } = await installProductionControlPlane();
    const { agent, agentHash, namespace, tenant } = await provisionNamespaceAndAgent({
      api,
      externalRequest,
      runGuideOcc,
    });
    const { foreignIP, probe } = await proveProductionApiNetworkPolicy();
    const finalGateway = await exerciseRevisionCutover();
    await assertProductionOtelLogs(finalGateway);
    await verifyCredentialBoundariesAndPrepareHandoff(finalGateway);
  },
);
