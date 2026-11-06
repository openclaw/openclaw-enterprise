import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { prepareDevUpImage } from "../../scripts/ci/prepare.mjs";
import { availablePort } from "../helpers/available-port.mjs";
import { runDevUpModelProviderCase } from "../helpers/dev-up-model-provider.mjs";

const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const occ = join(repository, "bin", "occ");
const selected = process.env.OCC_TEST_DEV_UP_K3D_REAL === "1";

// Both the lane and direct opt-in execution need this image on a cold engine.
// Keep the 15-minute pull retry bound, three 30-second inspections and process
// termination margin outside the rejection case's 60-second assertion budget.
before(
  async () => {
    if (selected) {
      await prepareDevUpImage();
    }
  },
  { timeout: 1_080_000 },
);

test(
  "dev-up installs the selected Kubernetes control plane and cleans up its owned cluster",
  {
    skip: selected ? false : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
    timeout: 1_200_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "oce-dev-up-k3d-real-"));
    const stateDirectory = join(root, "state");
    const cluster = `occ-dev-k3d-${randomUUID().slice(0, 8)}`;
    const environment = {
      ...process.env,
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
      OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
        process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    };
    delete environment.OCC_DEVELOPMENT_SANDBOX_DRIVER;
    for (const key of [
      "OPENAI_API_KEY",
      "OPENAI_API_KEY_FILE",
      "CODEX_API_KEY",
      "CODEX_API_KEY_FILE",
    ]) {
      delete environment[key];
    }
    await runDevUpModelProviderCase(
      t,
      { root, cluster, environment },
      async ({ provider, execute, signal }) => {
        const apiPort = await availablePort();
        let kubernetesPort = await availablePort();
        while (kubernetesPort === apiPort) {
          kubernetesPort = await availablePort();
        }
        let browserPort = await availablePort();
        while (browserPort === apiPort || browserPort === kubernetesPort) {
          browserPort = await availablePort();
        }
        Object.assign(environment, {
          OPENCLAW_DEV_PORT: String(apiPort),
          OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
          OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
        });
        Object.assign(environment, await provider.prepare());
        // The fixture and launcher use the same pinned local engine socket.
        delete environment.DOCKER_CONTEXT;
        delete environment.DOCKER_TLS_VERIFY;
        delete environment.DOCKER_CERT_PATH;

        // This invokes the regular launcher and real Helm, PostgreSQL, API, and worker.
        const started = await execute(join(repository, "scripts", "dev-up"), [], {
          cwd: repository,
          env: environment,
          timeout: 1_100_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        assert.match(started.stdout, /Deployment: Kubernetes only/);
        assert.match(started.stdout, /Sandbox Driver: none/);
        const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
        assert.equal(state.cluster, cluster);
        assert.equal(state.deploymentMode, "k3d");
        assert.equal(state.sandboxDriver, "none");
        // Route only this owned cluster, and await both provider and controller
        // Service DNS before any Agent can make its native startup model request.
        await provider.route(stateDirectory);
        assert.equal(existsSync(join(stateDirectory, "compose.yaml")), false);
        for (const file of ["initial-admin-password", "initial-admin-service-key.json"]) {
          assert.equal((await stat(join(stateDirectory, file))).mode & 0o077, 0);
        }

        // The browser endpoint terminates TLS for this installation only. Verify
        // the real console and sign-in response over that endpoint; this does not
        // claim that an Agent native UI or its WebSocket has been exercised.
        const browserHost = `console.${cluster}.oce.localhost`;
        const browserCA = await readFile(join(stateDirectory, "browser-ca.crt"));
        const browserRequest = (path, options = {}) => {
          signal.throwIfAborted();
          return new Promise((resolveRequest, reject) => {
            const request = https.request(
              {
                // Bound the whole request, including body consumption, to its owner
                // and an absolute deadline even if the peer keeps sending data.
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                hostname: "127.0.0.1",
                port: browserPort,
                servername: browserHost,
                ca: browserCA,
                path,
                method: options.method ?? "GET",
                headers: {
                  host: `${browserHost}:${browserPort}`,
                  ...(options.headers ?? {}),
                },
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                  body += chunk;
                });
                response.on("error", reject);
                response.on("end", () =>
                  resolveRequest({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body,
                  }),
                );
              },
            );
            request.on("error", reject);
            request.end(options.body);
          });
        };
        assert.equal((await browserRequest("/console/")).statusCode, 200);
        const password = (
          await readFile(join(stateDirectory, "initial-admin-password"), "utf8")
        ).trim();
        const signedIn = await browserRequest("/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: `https://${browserHost}:${browserPort}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: "admin@development.openclaw.invalid", password }),
        });
        assert.equal(signedIn.statusCode, 200, "browser sign-in failed");
        // Sign-in clears stale cookie variants before issuing the new session.
        // Select the nonempty session rather than one of those clearing cookies.
        const sessionCookie = signedIn.headers["set-cookie"]?.find((entry) =>
          /^(?:__Secure-)?openclaw_occ_shared\.session_token=[^;]+/.test(entry),
        );
        assert.ok(sessionCookie, "browser sign-in did not issue the expected session cookie");
        assert.ok(/;\s*Secure(?:;|$)/i.test(sessionCookie), "session cookie must be Secure");
        assert.ok(/;\s*HttpOnly(?:;|$)/i.test(sessionCookie), "session cookie must be HttpOnly");
        assert.ok(
          sessionCookie.toLowerCase().includes(`domain=${cluster}.oce.localhost`),
          "session cookie must be scoped to this installation",
        );

        // The service key must authenticate against the real API, and readiness
        // must include the initial tenant Namespace, not just the API process.
        const clientEnvironment = {
          ...environment,
          OCC_URL: `http://127.0.0.1:${apiPort}`,
          OCC_SERVICE_KEY_FILE: join(stateDirectory, "initial-admin-service-key.json"),
        };
        const namespaces = await execute(occ, ["namespace", "list", "--output", "json"], {
          cwd: repository,
          env: clientEnvironment,
        });
        const namespace = JSON.parse(namespaces.stdout).find(
          ({ name, status }) => name === "default" && status === "ready",
        );
        assert.ok(namespace);

        // Defaults and discovery use the authenticated production API, so a saved
        // YAML value alone cannot masquerade as successful startup composition.
        const serviceKey = JSON.parse(
          await readFile(join(stateDirectory, "initial-admin-service-key.json"), "utf8"),
        ).data.key;
        const request = async (path, options = {}) => {
          signal.throwIfAborted();
          // Native HTTPS uses the verified Console publication without following redirects.
          const response = await browserRequest(path, {
            ...options,
            headers: { "x-api-key": serviceKey, "content-type": "application/json" },
          });
          assert.equal(response.statusCode, 200);
          return JSON.parse(response.body);
        };
        const presets = await request(`/namespaces/${namespace.id}/presets`);
        assert.deepEqual(presets.data.map(({ name }) => name).sort(), [
          "Standard Codex",
          "Standard OpenClaw",
          "default-codex",
        ]);
        const catalog = await request(`/namespaces/${namespace.id}/agents/plugins`, {
          method: "POST",
          body: JSON.stringify({ harnessId: "codex" }),
        });
        assert.ok(
          catalog.data.plugins.some(({ id }) => id === "codex-plugin:linear@openai-curated-remote"),
        );
        // Provision the shipped dedicated Codex Preset through the same API used by
        // the console. Its native startup turn must complete against the deterministic
        // Responses fixture using a synthetic Secret; this is not live model inference.
        const { renderPresetTemplate } = await import("../../packages/contracts/src/index.ts");
        // The Preset list returns summaries; the exact Preset carries the template.
        const preset = (
          await request(
            `/namespaces/${namespace.id}/presets/${presets.data.find(({ name }) => name === "Standard Codex").id}`,
          )
        ).data;
        const rendered = renderPresetTemplate(preset.template, {
          name: "Local sandbox proof",
          model: "gpt-6-astra",
          modelSecret: "synthetic-local-sandbox-key",
        });
        rendered.configuration.values.gateway.controlUi.enabled = false;
        const post = async (path, body, expected) => {
          signal.throwIfAborted();
          const response = await browserRequest(path, {
            method: "POST",
            headers: { "x-api-key": serviceKey, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          assert.equal(response.statusCode, expected, `Unexpected status for ${path}`);
          return JSON.parse(response.body);
        };
        const secret = await post(
          `/namespaces/${namespace.id}/secrets`,
          {
            name: "Local sandbox proof",
            value: "synthetic-local-sandbox-key",
          },
          201,
        );
        const admitted = await post(
          `/namespaces/${namespace.id}/agents/provision`,
          {
            requestId: `req_${randomUUID()}`,
            ...rendered.agent,
            harnessAuth: { method: "api_key", source: secret.data.ref },
            configuration: { kind: "agent", ...rendered.configuration },
          },
          202,
        );
        const deadline = Date.now() + 300_000;
        let provisioned;
        while (Date.now() < deadline) {
          const observation = await request(admitted.data.provisioning.url);
          assert.notEqual(observation.data.status, "failed", "Agent provisioning failed");
          assert.notEqual(observation.data.status, "cancelled", "Agent provisioning was cancelled");
          if (observation.data.status === "succeeded") {
            provisioned = observation.data;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        }
        assert.ok(provisioned, "Agent provisioning did not complete");
        let deployment;
        while (Date.now() < deadline) {
          const observation = await request(
            `/namespaces/${namespace.id}/agents/${provisioned.agentId}/deployments/${provisioned.revisionId}`,
          );
          // The API error contains a fixed safe message and allowlisted runtime
          // evidence. Retain it before cleanup removes the owned deployment.
          assert.notEqual(
            observation.data.status,
            "failed",
            `Agent deployment failed: ${JSON.stringify(observation.data.error)}`,
          );
          assert.notEqual(observation.data.status, "cancelled", "Agent deployment was cancelled");
          if (observation.data.status === "succeeded") {
            deployment = observation.data;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        }
        assert.ok(deployment, "Agent deployment did not activate");
        t.diagnostic(
          `Dedicated startup provider receipt: ${JSON.stringify(await provider.assertAnswered())}`,
        );

        const kubeArgs = [
          "--kubeconfig",
          join(stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${cluster}`,
        ];
        const agentPods = JSON.parse(
          (
            await execute(
              "kubectl",
              [
                ...kubeArgs,
                "get",
                "pods",
                "--all-namespaces",
                "-l",
                `openclaw.dev/agent=${provisioned.agentId},openclaw.dev/workload-role=agent`,
                "-o",
                "json",
              ],
              { cwd: repository, env: environment },
            )
          ).stdout,
        ).items;
        assert.equal(agentPods.length, 1, "expected the provisioned dedicated Codex Pod");
        const agentPod = agentPods[0];
        const container = agentPod.spec.containers.find(({ name }) => name === "agent");
        assert.ok(container);
        const provenancePath = join(stateDirectory, "codex-seccomp-provenance.json");
        if (existsSync(provenancePath)) {
          const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
          assert.deepEqual(container.securityContext.seccompProfile, {
            type: "Localhost",
            localhostProfile: provenance.profileName,
          });
        } else {
          assert.equal(container.securityContext.seccompProfile, undefined);
          assert.equal(agentPod.spec.securityContext.seccompProfile.type, "RuntimeDefault");
        }

        // Exercise the actual sandbox inside the provisioned Agent, including a
        // writable outside marker. This does not claim a model or WebSocket turn.
        const nonce = randomUUID();
        const outside = `/home/node/codex-sandbox-${nonce}`;
        const workspace = `/home/node/workspace/codex-sandbox-${nonce}`;
        const script = `set -eu; cd /home/node/workspace; echo outside > ${outside}; timeout 60s codex sandbox -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -- sh -c 'echo inside > ${workspace}; if echo escaped > ${outside}; then exit 70; fi'; test "$(cat ${workspace})" = inside; test "$(cat ${outside})" = outside; rm -f ${workspace} ${outside}`;
        await execute(
          "kubectl",
          [
            ...kubeArgs,
            "-n",
            agentPod.metadata.namespace,
            "exec",
            agentPod.metadata.name,
            "-c",
            "agent",
            "--",
            "sh",
            "-c",
            script,
          ],
          { cwd: repository, env: environment, timeout: 90_000 },
        );
        if (environment.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY) {
          // This checks the deployed API's Namespace-scoped discovery. It does not
          // claim that a model turn or a Git operation has used the broker.
          const registry = JSON.parse(
            await readFile(
              join(environment.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY, "registry.json"),
              "utf8",
            ),
          );
          const repositories = await request(
            `/namespaces/${namespace.id}/agents/repository-options`,
          );
          const actual = repositories.data
            .map(({ repositoryRef, allowedProfiles }) => ({
              repositoryRef,
              profiles: [...allowedProfiles].sort(),
            }))
            .sort((left, right) => left.repositoryRef.localeCompare(right.repositoryRef));
          const expected = registry.repositories
            .map(({ repositoryRef, namespaces }) => ({
              repositoryRef,
              profiles: [...namespaces[0].profiles].sort(),
            }))
            .sort((left, right) => left.repositoryRef.localeCompare(right.repositoryRef));
          assert.deepEqual(actual, expected);
        }
        const pods = JSON.parse(
          (
            await execute(
              "kubectl",
              [
                "--kubeconfig",
                join(stateDirectory, "kubeconfig"),
                "--context",
                `k3d-${cluster}`,
                "-n",
                state.platformNamespace,
                "get",
                "pods",
                "-o",
                "json",
              ],
              { cwd: repository, env: environment },
            )
          ).stdout,
        );
        assert.ok(pods.items.some(({ metadata }) => metadata.labels?.app === "postgres"));
        assert.ok(
          pods.items.some(({ metadata }) => metadata.name.startsWith("openclaw-enterprise")),
        );
        if (environment.OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY) {
          const worker = pods.items.find(
            ({ metadata }) => metadata.labels?.["app.kubernetes.io/component"] === "worker",
          );
          assert.ok(worker);
          assert.ok(
            worker.status.containerStatuses.some(
              ({ name, ready }) => name === "repository-credentials" && ready,
            ),
          );
        }
        assert.equal(
          pods.items.some(({ metadata }) => metadata.name.includes("openshell")),
          false,
        );
      },
    );
  },
);

test(
  "dev-up prepares the real Codex sandbox with a Compose control plane",
  {
    skip: selected ? false : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
    timeout: 1_200_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "oce-dev-compose-sandbox-"));
    const stateDirectory = join(root, "state");
    const cluster = `occ-dev-compose-${randomUUID().slice(0, 8)}`;
    const apiPort = await availablePort();
    let kubernetesPort = await availablePort();
    while (kubernetesPort === apiPort) {
      kubernetesPort = await availablePort();
    }
    let postgresPort = await availablePort();
    while (postgresPort === apiPort || postgresPort === kubernetesPort) {
      postgresPort = await availablePort();
    }
    const environment = {
      ...process.env,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_POSTGRES_PORT: String(postgresPort),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
      OCC_DEVELOPMENT_COMPOSE_PROJECT: cluster,
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
      OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
      OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
        process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    };
    // This proof needs no provider or repository credentials. Keep ambient
    // credentials out of the disposable control plane and probe Pod.
    for (const key of [
      "OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY",
      "OPENAI_API_KEY",
      "OPENAI_API_KEY_FILE",
      "CODEX_API_KEY",
      "CODEX_API_KEY_FILE",
    ]) {
      delete environment[key];
    }
    t.after(async () => {
      if (existsSync(stateDirectory)) {
        await execute(join(repository, "scripts", "dev-down"), [], {
          cwd: repository,
          env: environment,
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        });
      }
      await rm(root, { recursive: true, force: true });
    });

    // Invoke the regular launcher, including the unmodified seccomp helper,
    // real Docker/Compose, k3d, runtime probe, and profile installation.
    const started = await execute(join(repository, "scripts", "dev-up"), [], {
      cwd: repository,
      env: environment,
      timeout: 1_100_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.match(started.stdout, /Control plane: Compose/);
    const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(state.deploymentMode, undefined);
    assert.equal(state.sandboxDriver, "none");
    assert.equal(state.cluster, cluster);
    const installation = loadYaml(
      await readFile(join(stateDirectory, "installation.yaml"), "utf8"),
    );
    const compute = installation.drivers.compute.configuration;
    const profileName = compute.runtime.codexSeccompProfile;
    if (profileName) {
      const provenance = JSON.parse(
        await readFile(join(stateDirectory, "codex-seccomp-provenance.json"), "utf8"),
      );
      assert.equal(profileName, provenance.profileName);
    }

    // Independently consume the generated image/profile on the owned node.
    // A writable outside marker distinguishes sandbox denial from filesystem
    // permissions. This verifies startup sandbox preparation, not Agent routing
    // or model execution, which require their separate runtime workflows.
    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "compose-sandbox-proof", namespace: "default" },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "probe",
            image: compute.images.agent,
            imagePullPolicy: "Never",
            command: [
              "sh",
              "-c",
              'set -eu; mkdir -p /home/node/.codex /home/node/workspace; cd /home/node/workspace; echo outside > /home/node/outside; codex sandbox -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -- sh -c "set -eu; echo inside > inside; if echo escaped > /home/node/outside; then exit 70; fi"; test "$(cat inside)" = inside; test "$(cat /home/node/outside)" = outside',
            ],
            env: [{ name: "CODEX_HOME", value: "/home/node/.codex" }],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
              ...(profileName
                ? { seccompProfile: { type: "Localhost", localhostProfile: profileName } }
                : {}),
            },
            volumeMounts: [
              { name: "home", mountPath: "/home/node" },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "home", emptyDir: {} },
          { name: "tmp", emptyDir: {} },
        ],
      },
    };
    const manifestPath = join(root, "sandbox-proof.json");
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const kubeArgs = [
      "--kubeconfig",
      join(stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${cluster}`,
      "--namespace",
      "default",
    ];
    await execute("kubectl", [...kubeArgs, "apply", "-f", manifestPath], { env: environment });
    await execute(
      "kubectl",
      [
        ...kubeArgs,
        "wait",
        "--for=jsonpath={.status.phase}=Succeeded",
        "pod/compose-sandbox-proof",
        "--timeout=180s",
      ],
      { env: environment, timeout: 200_000 },
    );
  },
);
