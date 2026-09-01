import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  createKubernetesClient,
  kubectlArguments as buildKubectlArguments,
  kubernetesHash as hash,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const selected = process.env.OCC_TEST_SETUP_PRODUCTION_REAL === "1";
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};

test(
  "setup production CLI creates and reuses a real k3d production installation",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_SETUP_PRODUCTION_REAL=1 with explicit disposable k3d, real images, and OPENAI_API_KEY.",
    timeout: 1_800_000,
  },
  async (context) => {
    await validateExplicitK3dLoopbackContext(selection);
    assert.ok(process.env.OPENAI_API_KEY, "A real model credential is required");
    const imageMetadata = await loadImageMetadata();
    const images = {
      controller: imageFrom(imageMetadata, "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"),
      runtime: imageFrom(imageMetadata, "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"),
      postgres: imageFrom(imageMetadata, "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"),
      node: imageFrom(imageMetadata, "OCC_TEST_PRODUCTION_NODE_IMAGE"),
    };
    for (const [name, image] of Object.entries(images)) {
      assert.match(
        image,
        /^\S+@sha256:[a-f0-9]{64}$/,
        `${name} image must select a real immutable image`,
      );
    }

    const model = process.env.OCC_TEST_OPENAI_MODEL ?? "gpt-5.1";
    const kubectlCommand = process.env.OCC_TEST_KUBECTL ?? "kubectl";
    const helmCommand = process.env.OCC_TEST_HELM ?? "helm";
    const suffix = randomBytes(4).toString("hex");
    const platform = `oce-setup-${suffix}`;
    const infra = `oce-setup-infra-${suffix}`;
    const release = `setup-${suffix}`;
    const evidenceRoot = process.env.OCC_TEST_SETUP_PRODUCTION_EVIDENCE_DIR ?? tmpdir();
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(evidenceRoot, "oce-setup-production-"));
    const stateDir = join(directory, "state");
    const configPath = join(directory, "setup-production.json");
    const tlsCertificatePath = join(directory, "tls.crt");
    const secrets = [process.env.OPENAI_API_KEY];
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
    const names = [infra, platform];
    let forwarding;
    const evidence = {
      source: "setup production CLI",
      cluster: selection.kubernetesContext,
      images,
      model,
      platform,
      infra,
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
        if (childEnv)
          for (const [name, value] of Object.entries(childEnv))
            if (value === undefined) delete childEnv[name];
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
        let stdout = "",
          stderr = "";
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
          const result = { stdout, stderr, combined: `${stderr}\n${stdout}` };
          if (code === 0 || (allowFailure && code === 1)) resolve(result);
          else reject(new Error(redact(`${command} failed (${code}): ${stderr}\n${stdout}`)));
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      });
    const kubectl = async (...args) =>
      (await run(kubectlCommand, buildKubectlArguments(selection, args))).stdout;
    const kubernetes = createKubernetesClient({
      selection,
      kubectl,
      waitTimeoutMs: 240_000,
      waitIntervalMs: 1_000,
    });
    const kubeArgs = kubernetes.kubectlArguments([]);
    const apply = (object) =>
      run(kubectlCommand, kubernetes.kubectlArguments(["apply", "-f", "-"]), {
        input: JSON.stringify(object),
      });
    const create = (object) =>
      run(kubectlCommand, kubernetes.kubectlArguments(["create", "-f", "-"]), {
        input: JSON.stringify(object),
      });
    const { resource: get, resources: resourcesFor, waitFor } = kubernetes;
    const metadata = (name, namespace = infra, labels = {}) => ({
      name,
      namespace,
      labels: { "oce-test": suffix, ...labels },
    });
    const createSecret = (name, stringData, namespace = infra) =>
      create({ apiVersion: "v1", kind: "Secret", metadata: metadata(name, namespace), stringData });
    const waitPod = (name, namespace = infra) =>
      kubectl("-n", namespace, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=180s");

    context.after(async () => {
      forwarding?.kill("SIGTERM");
      for (const file of ["tls.key", "tls.crt"]) await rm(join(directory, file), { force: true });
      if (process.env.OCC_TEST_SETUP_PRODUCTION_KEEP === "1") {
        context.diagnostic(`Retained setup production proof: ${directory}`);
        return;
      }
      await run(
        helmCommand,
        [
          "uninstall",
          release,
          "-n",
          platform,
          "--kubeconfig",
          selection.kubeconfigPath,
          "--kube-context",
          selection.kubernetesContext,
        ],
        { timeout: 60_000, allowFailure: true },
      ).catch(() => {});
      for (const name of names.reverse())
        await kubectl("delete", "namespace", name, "--ignore-not-found", "--wait=false").catch(
          () => {},
        );
    });

    async function createExternalPostgres() {
      const postgresPassword = secret();
      const migrationPassword = secret();
      const appPassword = secret();
      await apply({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: infra, labels: { "oce-test": suffix } },
      });
      await createSecret("postgres-bootstrap", {
        password: postgresPassword,
        "init.sql": `CREATE ROLE occ_migrator LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nCREATE ROLE occ_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nGRANT CREATE ON DATABASE openclaw_enterprise TO occ_migrator;\nCREATE SCHEMA occ AUTHORIZATION occ_migrator;\nCREATE SCHEMA drizzle AUTHORIZATION occ_migrator;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
      });
      await apply({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: metadata("postgres-data"),
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "local-path",
          resources: { requests: { storage: "1Gi" } },
        },
      });
      await apply({
        apiVersion: "v1",
        kind: "Pod",
        metadata: metadata("postgres", infra, { app: "postgres" }),
        spec: {
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
            fsGroup: 999,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "postgres",
              image: images.postgres,
              imagePullPolicy: "IfNotPresent",
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
              env: [
                { name: "POSTGRES_DB", value: "openclaw_enterprise" },
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
                exec: { command: ["pg_isready", "-U", "postgres", "-d", "openclaw_enterprise"] },
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
      const postgresIP = (await get("pod", "postgres", infra)).status.podIP;
      await record("External reviewed-role PostgreSQL prerequisite ready", { postgresIP });
      return {
        cidr: `${postgresIP}/32`,
        applicationUrl: `postgresql://occ_app:${appPassword}@postgres.${infra}.svc.cluster.local:5432/openclaw_enterprise`,
        migrationUrl: `postgresql://occ_migrator:${migrationPassword}@postgres.${infra}.svc.cluster.local:5432/openclaw_enterprise`,
      };
    }

    async function createExternalTlsProxy(baseURL) {
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
        tlsCertificatePath,
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
        metadata: metadata("operator", infra, {
          app: "setup-production-proxy",
          "app.kubernetes.io/name": "approved-gateway-client",
        }),
        spec: {
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "operator",
              image: images.node,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "/code/https-proxy.mjs"],
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
              env: [
                { name: "TLS_CERT_FILE", value: "/tls/tls.crt" },
                { name: "TLS_KEY_FILE", value: "/tls/tls.key" },
                {
                  name: "TARGET_URL",
                  value: `http://openclaw-enterprise-api.${platform}.svc.cluster.local:8080`,
                },
              ],
              volumeMounts: [
                { name: "code", mountPath: "/code", readOnly: true },
                { name: "tls", mountPath: "/tls", readOnly: true },
              ],
              readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 2 },
            },
          ],
          volumes: [
            { name: "code", configMap: { name: "proxy-code" } },
            { name: "tls", secret: { secretName: "proxy-tls" } },
          ],
        },
      });
      await waitPod("operator");
      forwarding = spawn(
        kubectlCommand,
        [
          ...kubeArgs,
          "-n",
          infra,
          "port-forward",
          "pod/operator",
          `${new URL(baseURL).port}:8443`,
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
      await record("External HTTPS proxy prerequisite ready", { baseURL });
      return await readFile(join(directory, "tls.crt"));
    }

    async function runSetup(label) {
      const result = await run(
        "node",
        [
          "scripts/setup.mjs",
          "production",
          "--config",
          configPath,
          "--state-dir",
          stateDir,
          "--no-tui",
        ],
        {
          timeout: 600_000,
          env: {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            NODE_EXTRA_CA_CERTS: tlsCertificatePath,
          },
        },
      );
      for (const value of secrets)
        assert.ok(!result.combined.includes(value), `${label} setup output leaked a credential`);
      assert.match(result.stdout, /setup ready; reconnect with:/);
      const ready = await setupState();
      for (const name of [
        "installationId",
        "namespaceId",
        "tenantNamespace",
        "agentId",
        "activeRevisionId",
      ]) {
        assert.equal(typeof ready[name], "string", `${label} setup state must contain ${name}`);
        assert.ok(ready[name].length > 0, `${label} setup state contains empty ${name}`);
      }
      if (!names.includes(ready.tenantNamespace)) names.push(ready.tenantNamespace);
      await record(`${label} setup CLI completed`, {
        installationId: ready.installationId,
        namespaceId: ready.namespaceId,
        tenantNamespace: ready.tenantNamespace,
        agentId: ready.agentId,
        activeRevisionId: ready.activeRevisionId,
      });
      return { ready, output: result.combined };
    }

    async function setupState() {
      const state = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
      assert.equal(
        typeof state.production,
        "object",
        "setup must persist production backend state for rerun and TUI recovery",
      );
      assert.notEqual(state.production, null, "setup must persist production backend state");
      const tenantNamespace = state.production.namespaces?.[state.namespaceId];
      return {
        installationId: state.installationId,
        namespaceId: state.namespaceId,
        tenantNamespace,
        agentId: state.agentId,
        activeRevisionId: state.revisionId,
        serviceKeyFile: state.backend?.serviceKeyFile ?? state.production?.keyFile,
      };
    }

    async function assertProtectedLocalState(outputs) {
      const state = await stat(stateDir);
      assert.equal(state.mode & 0o777, 0o700, "setup state-dir must be private");
      const serviceKeys = [];
      for (const entry of await protectedEntries(stateDir)) {
        assert.equal(
          entry.mode,
          entry.kind === "directory" ? 0o700 : 0o600,
          `${entry.path} has unsafe local state permissions`,
        );
        if (entry.kind !== "file" || !entry.path.endsWith(".json")) continue;
        const parsed = JSON.parse(await readFile(entry.path, "utf8"));
        const key = parsed?.data?.key;
        if (typeof key === "string" && key.length > 0) {
          secrets.push(key);
          serviceKeys.push({ path: entry.path, key, id: parsed.data.id });
        }
      }
      assert.equal(serviceKeys.length, 1, "setup must persist exactly one local service-key JSON");
      for (const output of outputs)
        for (const { key } of serviceKeys)
          assert.ok(!output.includes(key), "setup output leaked the local service key");
      await record("Setup local state stayed 0700/0600 and key was not printed", {
        serviceKeyFile: serviceKeys[0].path,
        serviceKeyId: serviceKeys[0].id,
      });
      return serviceKeys[0];
    }

    async function assertProductionResourcesReady() {
      await run(
        helmCommand,
        [
          "status",
          release,
          "-n",
          platform,
          "--kubeconfig",
          selection.kubeconfigPath,
          "--kube-context",
          selection.kubernetesContext,
        ],
        { timeout: 60_000 },
      );
      await kubectl(
        "-n",
        platform,
        "rollout",
        "status",
        "deployment/openclaw-enterprise-api",
        "--timeout=180s",
      );
      await kubectl(
        "-n",
        platform,
        "rollout",
        "status",
        "deployment/openclaw-enterprise-worker",
        "--timeout=180s",
      );
      for (const [kind, name] of [
        ["secret", "occ-installation-startup"],
        ["secret", "occ-database"],
        ["secret", "occ-auth"],
        ["pvc", `${release}-bootstrap-output`],
        ["job", `${release}-initialization`],
      ]) {
        await get(kind, name, platform);
      }
      await record("Setup-created Helm, controller, worker, Secret and bootstrap resources ready");
    }

    async function setupResourceIdentity() {
      const status = JSON.parse(
        (
          await run(
            helmCommand,
            [
              "status",
              release,
              "-n",
              platform,
              "--kubeconfig",
              selection.kubeconfigPath,
              "--kube-context",
              selection.kubernetesContext,
              "-o",
              "json",
            ],
            { timeout: 60_000 },
          )
        ).stdout,
      );
      const job = await get("job", `${release}-initialization`, platform);
      return {
        helmVersion: status.version,
        jobUid: job.metadata.uid,
        jobSucceeded: job.status.succeeded,
      };
    }

    async function simulateCrashAfterHelmInstall() {
      const path = join(stateDir, "state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.production = {
        ...(state.production ?? {}),
        pendingInstall: true,
        helmInstalled: false,
      };
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      await record("Persisted crash-after-Helm state marker for recovery rerun");
    }

    async function assertNoCredentialDerivedSecretAnnotations(ready, database) {
      const authSecret = (await readFile(join(stateDir, "occ-auth-secret"), "utf8")).trim();
      secrets.push(authSecret);
      const forbidden = new Set();
      const addForbidden = (value) => {
        if (typeof value !== "string" || value.length === 0) return;
        forbidden.add(value);
        forbidden.add(sha256Hex(value));
        forbidden.add(stableHash(value));
        forbidden.add(stableHash({ secret: value }));
      };
      for (const value of secrets) addForbidden(value);
      for (const value of [database.applicationUrl, database.migrationUrl]) addForbidden(value);
      forbidden.add(
        stableHash({
          "application-url": database.applicationUrl,
          "migration-url": database.migrationUrl,
        }),
      );
      forbidden.add(stableHash({ OPENAI_API_KEY: process.env.OPENAI_API_KEY }));

      for (const namespace of [platform, ready.tenantNamespace]) {
        const secretsList = JSON.parse(
          await kubectl("-n", namespace, "get", "secrets", "-o", "json"),
        );
        for (const secretResource of secretsList.items) {
          const annotations = secretResource.metadata?.annotations ?? {};
          const labels = secretResource.metadata?.labels ?? {};
          assert.equal(
            Object.hasOwn(annotations, "openclaw.dev/setup-fingerprint"),
            false,
            `${namespace}/${secretResource.metadata.name} must not store a setup fingerprint annotation`,
          );
          assert.equal(
            Object.hasOwn(annotations, "kubectl.kubernetes.io/last-applied-configuration"),
            false,
            `${namespace}/${secretResource.metadata.name} must not store a last-applied configuration annotation`,
          );
          const metadataText = JSON.stringify({ annotations, labels });
          for (const value of forbidden) {
            assert.ok(
              !metadataText.includes(value),
              `${namespace}/${secretResource.metadata.name} metadata contains a credential-derived value`,
            );
          }
        }
      }
      await record(
        "Setup-owned Secret metadata contains no credential-derived labels or annotations",
      );
    }

    const request =
      (baseURL, ca, serviceKey) =>
      (method, path, body, expected = 200) =>
        new Promise((resolve, reject) => {
          const data = body === undefined ? undefined : JSON.stringify(body);
          const req = https.request(
            `${baseURL}${path}`,
            {
              method,
              ca,
              family: 4,
              headers: {
                "x-api-key": serviceKey,
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
                for (const value of secrets)
                  assert.ok(!output.includes(value), "API response leaked a protected credential");
                assert.equal(response.statusCode, expected, redact(`${method} ${path}: ${output}`));
                resolve(output ? JSON.parse(output) : null);
              });
            },
          );
          req.on("error", reject);
          req.setTimeout(30_000, () => req.destroy(new Error("API request timeout")));
          req.end(data);
        });

    async function assertApiState({ baseURL, ca, serviceKey, ready, expectedRevisionCount }) {
      const api = request(baseURL, ca, serviceKey);
      const installation = await api("GET", "/installation");
      assert.equal(installation.data.id, ready.installationId);
      const namespace = await api("GET", `/namespaces/${ready.namespaceId}`);
      assert.equal(namespace.data.id, ready.namespaceId);
      assert.equal(namespace.data.status, "ready");
      const agent = await api("GET", `/namespaces/${ready.namespaceId}/agents/${ready.agentId}`);
      assert.equal(agent.data.id, ready.agentId);
      assert.equal(agent.data.activeRevisionId, ready.activeRevisionId);
      const revisions = await api(
        "GET",
        `/namespaces/${ready.namespaceId}/agents/${ready.agentId}/revisions`,
      );
      assert.equal(
        revisions.data.length,
        expectedRevisionCount,
        "setup rerun must not create another Agent revision",
      );
      assert.ok(revisions.data.some((revision) => revision.id === ready.activeRevisionId));
      await record(
        "Production API exposes setup-created Installation, Namespace, Agent and revision",
        {
          revisionCount: revisions.data.length,
        },
      );
    }

    async function activeGateway(ready) {
      const agentHash = hash(ready.agentId);
      const configMap = `gateway-${agentHash}-rev-${hash(ready.activeRevisionId)}`;
      return await waitFor(
        "setup-created ready gateway",
        async () => {
          const pods = await resourcesFor(
            "pods",
            ready.tenantNamespace,
            "-l",
            `app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/namespace=${ready.namespaceId},openclaw.dev/agent=${ready.agentId},openclaw.dev/workload-role=gateway`,
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
          assert.ok(matches.length <= 1, "Ambiguous active setup-created gateway Pod");
          return matches[0];
        },
        300_000,
      );
    }

    async function exerciseTui(ready, gateway) {
      const first = `SETUP_${suffix}_A_${randomBytes(8).toString("hex")}`;
      const second = `SETUP_${suffix}_B_${randomBytes(8).toString("hex")}`;
      const firstPrompt = `Reply exactly: ${first}`;
      const secondPrompt = `Reply exactly: ${second}`;
      const tuiArgs = [
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
        "node",
        "scripts/setup.mjs",
        "tui",
        "--state-dir",
        stateDir,
        "--session",
        `setup-${suffix}`,
        "--message",
        firstPrompt,
      ];
      const result = await run("python3", tuiArgs, {
        timeout: 550_000,
        env: { NODE_EXTRA_CA_CERTS: tlsCertificatePath },
      });
      for (const value of secrets)
        assert.ok(!result.combined.includes(value), "TUI output leaked a credential");
      const conversation = JSON.parse(result.stdout);
      assert.equal(conversation.exitCode, 0);
      await writeFile(join(directory, "tui.json"), result.stdout, { mode: 0o600 });
      assert.equal(
        (await get("pod", gateway.metadata.name, ready.tenantNamespace)).metadata.uid,
        gateway.metadata.uid,
      );
      await record("Setup-created Agent returned two model nonce replies and exited cleanly", {
        pod: gateway.metadata.name,
        firstReply: conversation.firstReplyLine,
        secondReply: conversation.secondReplyLine,
      });
    }

    async function assertWorkerLeastPrivilege(ready) {
      const result = await run(
        kubectlCommand,
        [
          ...kubeArgs,
          "-n",
          ready.tenantNamespace,
          "auth",
          "can-i",
          "get",
          "secrets",
          "--as",
          `system:serviceaccount:${platform}:openclaw-enterprise-worker`,
        ],
        { allowFailure: true },
      );
      assert.equal(result.stdout.trim(), "no", "production worker must not read tenant Secrets");
      await record("Setup-created tenant RBAC keeps worker away from Secret reads");
    }

    const port = await freeLoopbackPort();
    const baseURL = `https://localhost:${port}`;
    const database = await createExternalPostgres();
    const modelKeyFile = join(directory, "model-key");
    const applicationUrlFile = join(directory, "database-application-url");
    const migrationUrlFile = join(directory, "database-migration-url");
    await writeFile(modelKeyFile, `${process.env.OPENAI_API_KEY}\n`, { mode: 0o600 });
    await writeFile(applicationUrlFile, `${database.applicationUrl}\n`, { mode: 0o600 });
    await writeFile(migrationUrlFile, `${database.migrationUrl}\n`, { mode: 0o600 });
    const endpoint = (await get("endpoints", "kubernetes", "default")).subsets[0];
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o700);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          model,
          modelKeyFile,
          kubeconfig: selection.kubeconfigPath,
          context: selection.kubernetesContext,
          url: baseURL,
          controllerImage: images.controller,
          runtimeImage: images.runtime,
          adminEmail: `admin-${suffix}@example.invalid`,
          clusterName: `setup-production-${suffix}`,
          systemNamespace: platform,
          release,
          gatewayStorageClass: "local-path",
          bootstrapStorageClass: "local-path",
          database: {
            applicationUrlFile,
            migrationUrlFile,
            cidr: database.cidr,
            port: 5432,
          },
          apiClient: {
            namespace: infra,
            podLabels: { app: "setup-production-proxy" },
          },
          kubernetesApi: {
            cidr: `${endpoint.addresses[0].ip}/32`,
            port: endpoint.ports[0].port,
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    const ca = await createExternalTlsProxy(baseURL);

    const firstSetup = await runSetup("first");
    await assertProductionResourcesReady();
    const serviceKey = await assertProtectedLocalState([firstSetup.output]);
    await assertApiState({
      baseURL,
      ca,
      serviceKey: serviceKey.key,
      ready: firstSetup.ready,
      expectedRevisionCount: 1,
    });
    await assertNoCredentialDerivedSecretAnnotations(firstSetup.ready, database);
    const installedIdentity = await setupResourceIdentity();
    await simulateCrashAfterHelmInstall();

    const secondSetup = await runSetup("crash-recovery rerun");
    assert.deepEqual(
      pickSetupIdentity(secondSetup.ready),
      pickSetupIdentity(firstSetup.ready),
      "setup rerun must reuse the exact Installation, Agent and active revision",
    );
    assert.deepEqual(
      await setupResourceIdentity(),
      installedIdentity,
      "crash-after-Helm recovery must inspect the existing release and bootstrap Job",
    );
    const secondServiceKey = await assertProtectedLocalState([
      firstSetup.output,
      secondSetup.output,
    ]);
    assert.equal(secondServiceKey.id, serviceKey.id);
    assert.equal(secondServiceKey.key, serviceKey.key);
    await assertApiState({
      baseURL,
      ca,
      serviceKey: serviceKey.key,
      ready: secondSetup.ready,
      expectedRevisionCount: 1,
    });
    const gateway = await activeGateway(secondSetup.ready);
    await assertWorkerLeastPrivilege(secondSetup.ready);
    await exerciseTui(secondSetup.ready, gateway);
  },
);

async function loadImageMetadata() {
  const path = process.env.OCC_TEST_PRODUCTION_IMAGES_FILE;
  if (path === undefined) return {};
  return JSON.parse(await readFile(path, "utf8"));
}

function imageFrom(metadata, variable) {
  const value = process.env[variable] ?? metadata[variable];
  assert.equal(
    typeof value,
    "string",
    `${variable} must be set or present in OCC_TEST_PRODUCTION_IMAGES_FILE`,
  );
  return value;
}

async function freeLoopbackPort() {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const result = server.address().port;
      server.close(() => resolve(result));
    });
  });
}

async function protectedEntries(root) {
  const result = [];
  async function visit(path) {
    const current = await lstat(path);
    assert.equal(current.isSymbolicLink(), false, `${path} must not be a symlink`);
    if (current.isDirectory()) {
      result.push({ path, kind: "directory", mode: current.mode & 0o777 });
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    assert.equal(current.isFile(), true, `${path} must be a regular file`);
    result.push({ path, kind: "file", mode: current.mode & 0o777 });
  }
  await visit(root);
  return result.sort((left, right) => basename(left.path).localeCompare(basename(right.path)));
}

function pickSetupIdentity(ready) {
  return {
    installationId: ready.installationId,
    namespaceId: ready.namespaceId,
    tenantNamespace: ready.tenantNamespace,
    agentId: ready.agentId,
    activeRevisionId: ready.activeRevisionId,
  };
}

function sha256Hex(value, length = 64) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
