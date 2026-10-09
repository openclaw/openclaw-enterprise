import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { availablePort } from "./available-port.mjs";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");

// Each scenario owns a fresh cluster and state directory. Failed teardown must
// leave the recorded endpoint and credentials available for an explicit retry.
export async function keycloakLauncher(t) {
  const root = await mkdtemp(join(tmpdir(), "oce-dev-keycloak-"));
  const stateDirectory = join(root, "state");
  t.after(async () => {
    if (existsSync(stateDirectory)) {
      try {
        await dev("down");
      } catch (error) {
        throw new Error(`Cleanup failed; recovery state retained at ${stateDirectory}`, {
          cause: error,
        });
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const cluster = `occ-dev-keycloak-${randomUUID().slice(0, 8)}`;
  const ports = new Set([443]);
  while (ports.size < 4) {
    ports.add(await availablePort());
  }
  const [, apiPort, kubernetesPort, browserPort] = [...ports];
  const environment = {
    ...process.env,
    OCC_DEVELOPMENT_SIGN_IN: "keycloak",
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
    OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
    OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
    OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
    OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
    OPENCLAW_DEV_PORT: String(apiPort),
    OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
  };
  for (const key of [
    "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY",
    "OPENAI_API_KEY",
    "OPENAI_API_KEY_FILE",
    "CODEX_API_KEY",
    "CODEX_API_KEY_FILE",
  ]) {
    delete environment[key];
  }
  const run = (program, args, env = environment, timeout = 300_000) =>
    execute(program, args, { cwd: repository, env, timeout, maxBuffer: 16 * 1024 * 1024 });
  const dev = async (action, env = environment) => {
    try {
      return await run(
        join(repository, "bin/occ"),
        ["dev", action],
        env,
        action === "up" ? 1_100_000 : 300_000,
      );
    } finally {
      const statePath = join(stateDirectory, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        // Later observations use the engine endpoint the launcher actually selected.
        environment.DOCKER_HOST = state.dockerHost;
      }
    }
  };

  const kubectl = (args) =>
    run("kubectl", [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
      ...args,
    ]);
  const assertCluster = async (present) => {
    const clusters = JSON.parse((await run("k3d", ["cluster", "list", "-o", "json"])).stdout);
    assert.equal(
      clusters.some(({ name }) => name === cluster),
      present,
    );
  };
  return {
    root,
    stateDirectory,
    cluster,
    browserPort,
    environment,
    run,
    dev,
    kubectl,
    assertCluster,
    consoleHost: `console.${cluster}.oce.localhost`,
    keycloakHost: `keycloak.${cluster}.oce.test`,
    read: (name) => readFile(join(stateDirectory, name), "utf8"),
  };
}

// Dial the owned publication while verifying its real DNS identity and CA.
// No host-file edits or global trust changes are needed for this automation.
export function publishedJSON(
  { hostname, port, ca },
  path,
  { method = "GET", headers = {}, body, expectedStatus = 200 } = {},
) {
  return new Promise((resolveResponse, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        ca,
        path,
        method,
        headers: { host: port === 443 ? hostname : `${hostname}:${port}`, ...headers },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, expectedStatus);
            const payload = Buffer.concat(chunks).toString("utf8");
            resolveResponse(payload === "" ? null : JSON.parse(payload));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

// The fixture owns this unrelated HTTPS listener and removes it with its cluster.
// Successful verified requests before and after each denial exclude dead-listener proof.
export async function verifyKeycloakAPIEgress(fixture, state, values) {
  const marker = randomUUID();
  const name = "unrelated-https";
  const ca = await fixture.read("browser-ca.crt");
  const manifest = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, namespace: "default" },
        stringData: {
          "tls.crt": await fixture.read("browser-tls.crt"),
          "tls.key": await fixture.read("browser-tls.key"),
        },
      },
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, namespace: "default" },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "https",
              image: values.images.controller,
              imagePullPolicy: "IfNotPresent",
              command: [
                "node",
                "-e",
                `
              const fs = require('node:fs');
              require('node:https').createServer({
                key: fs.readFileSync('/tls/tls.key'), cert: fs.readFileSync('/tls/tls.crt'),
              }, (_req, res) => res.end(${JSON.stringify(marker)})).listen(443, '0.0.0.0');
            `,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] },
              },
              readinessProbe: { tcpSocket: { port: 443 }, periodSeconds: 1 },
              resources: {
                requests: { cpu: "10m", memory: "32Mi" },
                limits: { cpu: "100m", memory: "128Mi" },
              },
              volumeMounts: [{ name: "tls", mountPath: "/tls", readOnly: true }],
            },
          ],
          volumes: [{ name: "tls", secret: { secretName: name } }],
        },
      },
    ],
  };
  const path = join(fixture.root, "https-control.json");
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  await fixture.kubectl(["apply", "-f", path]);
  await fixture.kubectl([
    "-n",
    "default",
    "wait",
    "--for=condition=Ready",
    `pod/${name}`,
    "--timeout=90s",
  ]);
  const listener = JSON.parse(
    (await fixture.kubectl(["-n", "default", "get", "pod", name, "-o", "json"])).stdout,
  );
  assert.ok(listener.status.podIP);
  const apiPods = JSON.parse(
    (
      await fixture.kubectl([
        "-n",
        state.platformNamespace,
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=openclaw-enterprise,app.kubernetes.io/component=api",
        "-o",
        "json",
      ])
    ).stdout,
  ).items.filter((pod) =>
    pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.ok(apiPods.length > 0, "second-pass API must be ready");
  const request = `
    const https = require('node:https');
    const input = JSON.parse(process.argv[1]);
    const req = https.get({
      hostname: input.hostname, port: 443, servername: input.servername,
      path: input.path, ca: input.ca, signal: AbortSignal.timeout(5000),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
      res.on('error', error => { console.error(error.code); process.exitCode = 1; });
      res.on('end', () => {
        if (input.denied || res.statusCode !== 200 ||
            (input.marker ? body !== input.marker : JSON.parse(body).issuer !== input.issuer)) {
          console.error('unexpected HTTPS response'); process.exitCode = 1;
        } else console.log(JSON.stringify({allowed: true}));
      });
    });
    req.on('error', error => {
      if (input.denied && ['ABORT_ERR', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED'].includes(error.code)) {
        console.log(JSON.stringify({denied: true}));
      } else { console.error(error.code); process.exitCode = 1; }
    });
  `;
  const unrelated = {
    hostname: listener.status.podIP,
    servername: fixture.consoleHost,
    path: "/",
    ca,
    marker,
  };
  const probe = async (namespace, pod, input, expected) => {
    const result = await fixture.kubectl([
      "-n",
      namespace,
      "exec",
      pod,
      "--",
      "node",
      "-e",
      request,
      JSON.stringify(input),
    ]);
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
  };
  const keycloak = {
    hostname: fixture.keycloakHost,
    servername: fixture.keycloakHost,
    path: "/realms/oce/.well-known/openid-configuration",
    ca: await fixture.read("gateway-ca.crt"),
    issuer: `https://${fixture.keycloakHost}/realms/oce`,
  };
  for (const pod of apiPods) {
    await probe("default", name, unrelated, { allowed: true });
    await probe(state.platformNamespace, pod.metadata.name, keycloak, { allowed: true });
    await probe(
      state.platformNamespace,
      pod.metadata.name,
      { ...unrelated, denied: true },
      { denied: true },
    );
    await probe("default", name, unrelated, { allowed: true });
    await probe(state.platformNamespace, pod.metadata.name, keycloak, { allowed: true });
  }
}
