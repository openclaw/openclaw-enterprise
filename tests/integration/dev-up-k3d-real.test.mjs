import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import https from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { devUpUnrelatedImage, prepareDevUpImage } from "../../scripts/ci/prepare.mjs";
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
  "dev-up refuses mismatched image selections before creating a cluster",
  {
    skip: selected ? false : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
    timeout: 60_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "oce-dev-image-preflight-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = join(root, "state");
    const environment = {
      ...process.env,
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
      OCC_DEVELOPMENT_SANDBOX_DRIVER: "none",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
    };
    delete environment.OCC_DEVELOPMENT_CONTROLLER_IMAGE;
    delete environment.OCC_KUBERNETES_RUNTIME_IMAGE;

    // Fail before state or cluster creation if an operator mixes one selected
    // image with a separately built checkout or uses mutable image tags.
    const reject = async (overrides, expected) => {
      await assert.rejects(
        execute(join(repository, "scripts", "dev-up"), [], {
          cwd: repository,
          env: { ...environment, ...overrides },
          timeout: 30_000,
        }),
        (error) => {
          assert.match(error.stderr, expected);
          return true;
        },
      );
      assert.equal(existsSync(stateDirectory), false);
    };
    await reject(
      { OCC_KUBERNETES_RUNTIME_IMAGE: "example/runtime:latest" },
      /must be selected together/,
    );
    await reject(
      {
        OCC_DEVELOPMENT_CONTROLLER_IMAGE: "example/controller:latest",
        OCC_KUBERNETES_RUNTIME_IMAGE: "example/runtime:latest",
      },
      /must use immutable sha256 digest references/,
    );

    // Preparation verified this exact image exists; its real engine metadata
    // cannot claim to be the OCE checkout's release.
    const unrelated = devUpUnrelatedImage;
    await reject(
      { OCC_DEVELOPMENT_CONTROLLER_IMAGE: unrelated, OCC_KUBERNETES_RUNTIME_IMAGE: unrelated },
      /selected image revision does not match checkout/,
    );
  },
);

test(
  "dev-up refuses gateway trust when Kubernetes does not enforce NetworkPolicy",
  {
    skip: selected ? false : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
    timeout: 1_200_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "oce-dev-policy-failure-"));
    const stateDirectory = join(root, "state");
    const cluster = `occ-dev-policy-${randomUUID().slice(0, 8)}`;
    const ports = new Set();
    while (ports.size < 3) {
      ports.add(await availablePort());
    }
    const [apiPort, kubernetesPort, browserPort] = ports;
    const realK3d = (await execute("which", ["k3d"])).stdout.trim();
    assert.ok(realK3d.startsWith("/"), "k3d must resolve to an executable path");

    // Run the genuine k3d binary while disabling only its embedded policy
    // controller. This simulates a real non-enforcing CNI, not mock traffic.
    await writeFile(
      join(root, "k3d"),
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "cluster" && args[1] === "create") {
  if (args[2] !== ${JSON.stringify(cluster)}) process.exit(1);
  args.push("--k3s-arg", "--disable-network-policy@server:0");
}
const result = spawnSync(${JSON.stringify(realK3d)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH}`,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_DEVELOPMENT_BROWSER_PORT: String(browserPort),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: process.env.OCC_TEST_DEV_UP_CONTAINER_ENGINE ?? "docker",
      OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
      OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
      OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(kubernetesPort),
      OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT:
        process.env.OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT ?? "1",
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "90",
    };
    for (const key of [
      "OCC_DEVELOPMENT_SANDBOX_DRIVER",
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
        });
      }
      await rm(root, { recursive: true, force: true });
    });

    // The launcher must reject a functioning cluster with ineffective policy
    // before configuring proxy trust or bootstrapping any Agent credentials.
    await assert.rejects(
      execute(join(repository, "scripts", "dev-up"), [], {
        cwd: repository,
        env: environment,
        timeout: 1_100_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
      (error) => {
        assert.match(
          error.stdout,
          /Verifying Kubernetes network isolation before configuring gateway trust/,
        );
        assert.match(error.stderr, /Kubernetes NetworkPolicy enforcement could not be verified/);
        assert.doesNotMatch(error.stdout, /Installing OCE in Namespace/);
        return true;
      },
    );
    assert.equal(existsSync(stateDirectory), false, "failed startup must remove owned state");
    const clusters = JSON.parse(
      (
        await execute(realK3d, ["cluster", "list", "-o", "json"], {
          cwd: repository,
          env: environment,
        })
      ).stdout,
    );
    assert.equal(
      clusters.some(({ name }) => name === cluster),
      false,
    );
  },
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
                signal,
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
                response.resume();
                response.on("error", reject);
                response.on("end", () => resolveRequest(response));
              },
            );
            request.setTimeout(10_000, () =>
              request.destroy(new Error("browser request timed out")),
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
          const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
            ...options,
            headers: { "x-api-key": serviceKey, "content-type": "application/json" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          });
          assert.equal(response.status, 200);
          return response.json();
        };
        const presets = await request(`/namespaces/${namespace.id}/presets`);
        assert.deepEqual(presets.data.map(({ name }) => name).sort(), [
          "Standard Codex",
          "Standard OpenClaw",
          "default-codex",
        ]);
        const catalog = await request(`/namespaces/${namespace.id}/agents/plugins`, {
          method: "POST",
          body: "{}",
        });
        assert.ok(
          catalog.data.plugins.some(({ id }) => id === "codex-plugin:linear@openai-curated-remote"),
        );
        // Provision the shipped dedicated Codex Preset through the same API used by
        // the console. Its native startup turn must complete against the deterministic
        // Responses fixture using a synthetic Secret; this is not live model inference.
        const { renderPresetTemplate } = await import("../../packages/contracts/src/index.ts");
        const preset = presets.data.find(({ name }) => name === "Standard Codex");
        const rendered = renderPresetTemplate(preset.template, {
          name: "Local sandbox proof",
          model: "gpt-6-astra",
          modelSecret: "synthetic-local-sandbox-key",
        });
        rendered.configuration.values.gateway.controlUi.enabled = false;
        const post = async (path, body, expected) => {
          signal.throwIfAborted();
          const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
            method: "POST",
            headers: { "x-api-key": serviceKey, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          });
          assert.equal(response.status, expected, `Unexpected status for ${path}`);
          return response.json();
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

test(
  "dev-up Keycloak profile signs in the administrator, preserves the realm and cleans up",
  {
    skip: selected ? false : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
    timeout: 1_800_000,
  },
  async (t) => {
    const { keycloakLauncher, publishedJSON, verifyKeycloakAPIEgress } =
      await import("../helpers/dev-up-keycloak.mjs");
    const { createHash, X509Certificate } = await import("node:crypto");
    const { chromium } = await import("playwright");
    const fixture = await keycloakLauncher(t);
    await fixture.dev("up");
    const state = JSON.parse(await fixture.read("state.json"));
    assert.equal(state.signIn, "keycloak");
    const values = JSON.parse(await fixture.read("helm-values.json"));
    assert.equal(values.auth.oidc.enabled, true);
    assert.equal(values.auth.passwordSignIn, "recovery-only");
    assert.equal(values.agentNativeAdmin.enabled, false);
    // Probe the actual API after the OIDC upgrade, when the additive policy is active.
    await verifyKeycloakAPIEgress(fixture, state, values);
    const issuer = `https://${fixture.keycloakHost}/realms/oce`;
    const discovery = await publishedJSON(
      {
        hostname: fixture.keycloakHost,
        port: 443,
        ca: await fixture.read("gateway-ca.crt"),
      },
      "/realms/oce/.well-known/openid-configuration",
    );
    assert.equal(discovery.issuer, issuer);
    assert.equal(discovery.token_endpoint, `${issuer}/protocol/openid-connect/token`);
    const providers = await publishedJSON(
      {
        hostname: fixture.consoleHost,
        port: fixture.browserPort,
        ca: await fixture.read("browser-ca.crt"),
      },
      "/api/auth/providers",
    );
    assert.equal(providers.data.oidc, true);
    assert.equal(providers.data.password, false);

    // Trust only this fixture's issued leaves. Chromium retains its sandbox;
    // host mapping is scoped to this process, with no global DNS/CA mutation.
    const mirror = JSON.parse(await fixture.read("keycloak-tls.json"));
    const certificates = [
      await fixture.read("browser-tls.crt"),
      Buffer.from(mirror.data["tls.crt"], "base64"),
    ];
    const pins = certificates.map((cert) =>
      createHash("sha256")
        .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
        .digest("base64"),
    );
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--ignore-certificate-errors-spki-list=${pins.join(",")}`,
        `--host-resolver-rules=MAP ${fixture.consoleHost} 127.0.0.1, MAP ${fixture.keycloakHost} 127.0.0.1`,
      ],
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
    });
    const origin = `https://${fixture.consoleHost}:${fixture.browserPort}`;
    const api = (page, path, body) =>
      page.evaluate(
        async ({ path, body }) => {
          const response = await fetch(path, {
            method: body === undefined ? "GET" : "POST",
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
          });
          return { status: response.status, json: await response.json() };
        },
        { path, body },
      );
    let alicePassword = (await fixture.read("keycloak-alice-password")).trim();
    try {
      const recovery = await browser.newContext();
      const page = await recovery.newPage();
      await page.goto(`${origin}/console/`);
      const signedIn = await api(page, "/api/auth/sign-in/email", {
        email: "admin@development.openclaw.invalid",
        password: (await fixture.read("initial-admin-password")).trim(),
      });
      assert.equal(signedIn.status, 200, "the recovery administrator remains usable");
      const admin = await api(page, "/api/auth/session");
      assert.equal(admin.status, 200);
      const adminId = admin.json.data.user.id;
      assert.equal(adminId, values.auth.recoveryUserId);
      // Create a real password account through the supported administrator API.
      // Its correct password must still be denied in the recovery-only profile.
      const member = { email: `member-${randomUUID()}@example.test`, password: randomUUID() };
      const created = await api(page, "/api/auth/accounts", member);
      assert.equal(created.status, 201);
      await recovery.close();
      const ordinary = await browser.newContext();
      const ordinaryPage = await ordinary.newPage();
      await ordinaryPage.goto(`${origin}/console/`);
      assert.equal((await api(ordinaryPage, "/api/auth/sign-in/email", member)).status, 401);
      await ordinary.close();

      const signInAlice = async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`${origin}/console/`);
          const result = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/auth/providers/oidc/result",
          );
          result.catch(() => {});
          await page.getByRole("button", { name: "Continue with Keycloak" }).click();
          await page.waitForURL((url) => url.origin === new URL(issuer).origin);
          await page.locator("#username").fill("alice");
          await page.locator("#password").fill(alicePassword);
          await page.locator("#kc-login").click();
          assert.equal((await result).status(), 200);
          await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
          const session = await api(page, "/api/auth/session");
          assert.equal(session.status, 200);
          assert.equal(
            session.json.data.user.id,
            adminId,
            "Alice is attached to the existing administrator",
          );
          // The guarded GET requires Origin, which page fetch omits for same-origin GETs.
          // Observe the same browser session through verified HTTPS with its exact cookies.
          const cookies = await context.cookies(origin);
          const account = await publishedJSON(
            {
              hostname: fixture.consoleHost,
              port: fixture.browserPort,
              ca: await fixture.read("browser-ca.crt"),
            },
            `/api/auth/accounts/${adminId}`,
            {
              headers: {
                origin,
                cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
              },
            },
          );
          assert.equal(account.data.userId, adminId);
          const sessionCookie = cookies.find(
            ({ name, value }) => name.endsWith(".session_token") && value,
          );
          assert.ok(sessionCookie);
          assert.equal(sessionCookie.domain, fixture.consoleHost);
          assert.equal(sessionCookie.secure, true);
          assert.equal(sessionCookie.httpOnly, true);
        } finally {
          await context.close();
        }
      };
      await signInAlice();
      // A password changed after realm import must survive the Pod restart.
      // Reimporting the fixture into an empty database cannot satisfy this proof.
      const keycloak = {
        hostname: fixture.keycloakHost,
        port: 443,
        ca: await fixture.read("gateway-ca.crt"),
      };
      const token = await publishedJSON(keycloak, "/realms/master/protocol/openid-connect/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: "admin",
          password: (await fixture.read("keycloak-admin-password")).trim(),
        }).toString(),
      });
      assert.equal(typeof token.access_token, "string");
      const realm = JSON.parse(
        await readFile(join(repository, "tests/fixtures/keycloak/realm-oce.json"), "utf8"),
      );
      const alice = realm.users.find(({ username }) => username === "alice");
      assert.ok(alice?.id);
      alicePassword = randomUUID();
      await publishedJSON(keycloak, `/admin/realms/oce/users/${alice.id}/reset-password`, {
        method: "PUT",
        expectedStatus: 204,
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "password", value: alicePassword, temporary: false }),
      });
      const before = JSON.parse(
        (
          await fixture.kubectl([
            "-n",
            "occ-development-keycloak",
            "get",
            "pods",
            "-l",
            "app=keycloak",
            "-o",
            "json",
          ])
        ).stdout,
      );
      assert.equal(before.items.length, 1);
      await fixture.kubectl([
        "-n",
        "occ-development-keycloak",
        "rollout",
        "restart",
        "deployment/keycloak",
      ]);
      await fixture.kubectl([
        "-n",
        "occ-development-keycloak",
        "rollout",
        "status",
        "deployment/keycloak",
        "--timeout=180s",
      ]);
      const after = JSON.parse(
        (
          await fixture.kubectl([
            "-n",
            "occ-development-keycloak",
            "get",
            "pods",
            "-l",
            "app=keycloak",
            "-o",
            "json",
          ])
        ).stdout,
      );
      assert.ok(after.items.some((pod) => pod.metadata.uid !== before.items[0].metadata.uid));
      // A fresh browser session must authenticate with the same persisted realm credentials.
      await signInAlice();
    } finally {
      await browser.close();
    }
    await fixture.dev("down");
    assert.equal(existsSync(fixture.stateDirectory), false);
    await fixture.assertCluster(false);
  },
);

test(
  "dev-up Keycloak second-pass failure retains recovery state until owned cleanup succeeds",
  {
    skip: selected ? false : "Set OCC_TEST_DEV_UP_K3D_REAL=1 to run the real development profile.",
    timeout: 1_800_000,
  },
  async (t) => {
    const { keycloakLauncher } = await import("../helpers/dev-up-keycloak.mjs");
    const fixture = await keycloakLauncher(t);
    const realHelm = (await fixture.run("which", ["helm"])).stdout.trim();
    const realK3d = (await fixture.run("which", ["k3d"])).stdout.trim();
    assert.ok(realHelm.startsWith("/") && realK3d.startsWith("/"));
    const helmMarker = join(fixture.root, "second-pass-failed");
    const deleteMarker = join(fixture.root, "delete-failed");
    // External command faults surround the real launcher. First-pass Helm,
    // Keycloak provisioning and all NetworkPolicies run normally. Refuse only
    // this cluster's second upgrade and first deletion, then use genuine down.
    for (const [name, real, fault] of [
      [
        "helm",
        realHelm,
        `const index = args.indexOf("-f");
if (args[0] === "upgrade" && index >= 0 && args[index + 1] === ${JSON.stringify(join(fixture.stateDirectory, "helm-values.json"))} && JSON.parse(readFileSync(args[index + 1], "utf8")).auth.oidc?.enabled) {
  writeFileSync(${JSON.stringify(helmMarker)}, "second pass reached");
  console.error("injected second Helm pass failure"); process.exit(1);
}`,
      ],
      [
        "k3d",
        realK3d,
        `if (args[0] === "cluster" && args[1] === "delete" && args[2] === ${JSON.stringify(fixture.cluster)} && !existsSync(${JSON.stringify(deleteMarker)})) {
  writeFileSync(${JSON.stringify(deleteMarker)}, "owned deletion refused");
  console.error("injected owned cluster deletion failure"); process.exit(1);
}`,
      ],
    ]) {
      await writeFile(
        join(fixture.root, name),
        `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
${fault}
const result = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      );
    }
    await assert.rejects(
      fixture.dev("up", {
        ...fixture.environment,
        PATH: `${fixture.root}${delimiter}${fixture.environment.PATH}`,
      }),
      (error) => {
        assert.match(error.stdout, /Enabling Keycloak sign-in \(second Helm pass\)/);
        assert.match(error.stderr, /injected second Helm pass failure/);
        assert.match(error.stderr, /injected owned cluster deletion failure/);
        return true;
      },
    );
    assert.equal(existsSync(helmMarker), true);
    assert.equal(existsSync(deleteMarker), true);
    assert.equal(JSON.parse(await fixture.read("state.json")).cluster, fixture.cluster);
    for (const name of ["kubeconfig", "initial-admin-password", "keycloak-alice-password"]) {
      assert.equal((await stat(join(fixture.stateDirectory, name))).mode & 0o077, 0);
    }
    await fixture.assertCluster(true);
    const namespace = await fixture.kubectl([
      "get",
      "namespace",
      "occ-development-keycloak",
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(namespace.stdout.trim(), "", "rollback removes the realm before cluster deletion");
    await fixture.dev("down");
    assert.equal(existsSync(fixture.stateDirectory), false);
    await fixture.assertCluster(false);
  },
);
