import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import https from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const occ = join(repository, "bin", "occ");
const selected = process.env.OCC_TEST_DEV_UP_K3D_REAL === "1";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

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
      assert.equal(await exists(stateDirectory), false);
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

    // The pinned public k3s image is already required by this suite. Its real
    // engine metadata cannot claim to be the OCE checkout's release.
    const unrelated =
      "rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657";
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
      ports.add(await unusedPort());
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
      if (await exists(stateDirectory)) {
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
    assert.equal(await exists(stateDirectory), false, "failed startup must remove owned state");
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
    const apiPort = await unusedPort();
    let kubernetesPort = await unusedPort();
    while (kubernetesPort === apiPort) {
      kubernetesPort = await unusedPort();
    }
    let browserPort = await unusedPort();
    while (browserPort === apiPort || browserPort === kubernetesPort) {
      browserPort = await unusedPort();
    }
    const environment = {
      ...process.env,
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
      OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "600",
    };
    delete environment.OCC_DEVELOPMENT_SANDBOX_DRIVER;
    // Cleanup uses the recorded engine and cluster; failed cleanup preserves recovery state.
    t.after(async () => {
      if (await exists(stateDirectory)) {
        try {
          await execute(join(repository, "scripts", "dev-down"), [], {
            cwd: repository,
            env: environment,
            timeout: 300_000,
          });
        } catch (error) {
          throw new Error(
            `Development cleanup failed; recovery state preserved at ${stateDirectory}.`,
            {
              cause: error,
            },
          );
        }
      }
      await rm(root, { recursive: true, force: true });
    });

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
    assert.equal(await exists(join(stateDirectory, "compose.yaml")), false);
    for (const file of ["initial-admin-password", "initial-admin-service-key.json"]) {
      assert.equal((await stat(join(stateDirectory, file))).mode & 0o077, 0);
    }

    // The browser endpoint terminates TLS for this installation only. Verify
    // the real console and sign-in response over that endpoint; this does not
    // claim that an Agent native UI or its WebSocket has been exercised.
    const browserHost = `console.${cluster}.oce.localhost`;
    const browserCA = await readFile(join(stateDirectory, "browser-ca.crt"));
    const browserRequest = (path, options = {}) =>
      new Promise((resolveRequest, reject) => {
        const request = https.request(
          {
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
            response.on("end", () => resolveRequest(response));
          },
        );
        request.setTimeout(10_000, () => request.destroy(new Error("browser request timed out")));
        request.on("error", reject);
        request.end(options.body);
      });
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
      const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        ...options,
        headers: { "x-api-key": serviceKey, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const presets = await request(`/namespaces/${namespace.id}/presets`);
    assert.deepEqual(presets.data.map(({ name }) => name).sort(), [
      "Standard Codex",
      "Standard OpenClaw",
    ]);
    const catalog = await request(`/namespaces/${namespace.id}/agents/plugins`, {
      method: "POST",
      body: "{}",
    });
    assert.ok(
      catalog.data.plugins.some(({ id }) => id === "codex-plugin:linear@openai-curated-remote"),
    );
    // Provision the shipped dedicated Codex Preset through the same API used by
    // the console. The synthetic Secret permits startup but cannot run a model.
    const { renderPresetTemplate } = await import("../../packages/contracts/src/index.ts");
    const preset = presets.data.find(({ name }) => name === "Standard Codex");
    const rendered = renderPresetTemplate(preset.template, {
      name: "Local sandbox proof",
      model: "gpt-6-astra",
      modelSecret: "synthetic-local-sandbox-key",
    });
    rendered.configuration.values.gateway.controlUi.enabled = false;
    const post = async (path, body, expected) => {
      const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        method: "POST",
        headers: { "x-api-key": serviceKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
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
      assert.notEqual(observation.data.status, "failed", "Agent deployment failed");
      assert.notEqual(observation.data.status, "cancelled", "Agent deployment was cancelled");
      if (observation.data.status === "succeeded") {
        deployment = observation.data;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    assert.ok(deployment, "Agent deployment did not activate");

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
    if (await exists(provenancePath)) {
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
      const repositories = await request(`/namespaces/${namespace.id}/agents/repository-options`);
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
    assert.ok(pods.items.some(({ metadata }) => metadata.name === "postgres"));
    assert.ok(pods.items.some(({ metadata }) => metadata.name.startsWith("openclaw-enterprise")));
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
