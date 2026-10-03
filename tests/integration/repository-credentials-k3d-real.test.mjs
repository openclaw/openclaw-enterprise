import { cleanupRepositoryJourney } from "../helpers/repository-remote-cleanup.mjs";
import { verifyNativeRepositoryJourney } from "../helpers/repository-native-journey.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { kubernetesHash, validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";
import {
  createInstalledRepositoryFixture,
  createRepositoryObserver,
  readProtectedInput,
  readInstalledCredentialSession,
} from "../helpers/repository-credentials-installed.mjs";

const selected = process.env.OCC_TEST_REPOSITORY_CREDENTIALS_REAL === "1";
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Preserve the startup stage before owned cleanup without exporting Pod logs,
// environment values, authentication files, or model responses.
const runtimeStartupSummaryScript = String.raw`
  const { existsSync } = require("node:fs");
  (async () => {
    const summary = {
      markerConfigured: process.env.OPENCLAW_PLUGIN_READY_MARKER !== undefined,
      markerPresent: process.env.OPENCLAW_PLUGIN_READY_MARKER !== undefined &&
        existsSync(process.env.OPENCLAW_PLUGIN_READY_MARKER),
      status: "unavailable",
    };
    const port = Number(process.env.OPENCLAW_RUNTIME_STATUS_PORT);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/openclaw/runtime/status", {
          signal: AbortSignal.timeout(2000),
        });
        const text = await response.text();
        if (response.ok && text.length <= 16384) {
          const report = JSON.parse(text);
          const failure = report.runtimeFailure;
          summary.status = failure === undefined ? "no-reported-failure" : "reported-failure";
          if (failure !== undefined) {
            summary.check = ["login", "model-probe"].includes(failure.check) ? failure.check : "other";
            summary.code = ["LOGIN_FAILED", "MODEL_PROBE_FAILED", "MODEL_PROBE_TIMEOUT", "UNAVAILABLE"]
              .includes(failure.code) ? failure.code : "other";
          }
        }
      } catch {}
    }
    process.stdout.write(JSON.stringify(summary));
  })().catch(() => process.exitCode = 1);
`;

async function agentPods(f, agentId) {
  const namespaces = [...new Set([f.tenant, f.gatewayRuntimeNamespace])];
  const groups = await Promise.all(
    namespaces.map((namespace) =>
      f.kubernetes.resources("pods", namespace, "-l", `openclaw.dev/agent=${agentId}`),
    ),
  );
  return groups.flat();
}

async function recordRuntimeStartupFailure(f, agent) {
  try {
    const pods = await agentPods(f, agent.id);
    const summaries = [];
    for (const pod of pods.slice(0, 4)) {
      for (const container of pod.spec.containers.filter((c) =>
        ["agent", "gateway"].includes(c.name),
      )) {
        const status = pod.status.containerStatuses?.find((c) => c.name === container.name);
        const summary = {
          container: container.name,
          ready: status?.ready === true,
          restartCount: status?.restartCount ?? 0,
          running: status?.state?.running !== undefined,
          startup: { status: "unavailable" },
        };
        if (summary.running) {
          try {
            summary.startup = JSON.parse(
              await f.kubectl(
                "--request-timeout=10s",
                "-n",
                pod.metadata.namespace,
                "exec",
                pod.metadata.name,
                "-c",
                container.name,
                "--",
                "node",
                "-e",
                runtimeStartupSummaryScript,
              ),
            );
          } catch {
            // A terminating container may no longer accept exec; retain unavailable.
          }
        }
        summaries.push(summary);
      }
    }
    await f.record("Bounded runtime startup failure diagnostics", { containers: summaries });
  } catch {
    await f.record("Bounded runtime startup failure diagnostics", { status: "unavailable" });
  }
}

// Diagnostic hints only: raw transcript text stays inside the Agent Pod. These
// bounded, fixed categories never substitute for tool/provider acceptance.
// This case proves the installed caller path that host-driven Git/gh smoke tests
// cannot: the model acts using material opened by the production worker.
for (const mode of ["embedded", "dedicated"]) {
  test(
    `installed ${mode} Agent isolates broker credentials and disposes worker-owned sessions`,
    {
      skip: selected
        ? false
        : "Set OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1 with explicit authorized repository, protected App inputs, model key and immutable images.",
      timeout: 1800000,
    },
    installedRepositoryJourney(mode),
  );
}

test(
  "installed dedicated read-only Agent fetches and is denied a repository push",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1 with explicit authorized repository, protected App inputs, model key and immutable images.",
    timeout: 1800000,
  },
  installedRepositoryJourney("dedicated", "git-read"),
);

function installedRepositoryJourney(mode, profile = "git-full") {
  return async (context) => {
    const dedicated = mode === "dedicated";
    const readOnly = profile === "git-read";
    if (dedicated) {
      assert.ok(
        process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
        "the reviewed Codex seccomp profile must be prepared before the dedicated Agent starts",
      );
    }
    const workspace = dedicated ? "/home/node/workspace" : "/home/node/.openclaw/workspace";
    const commandTool = dedicated ? "bash" : "exec";
    const toolNames = dedicated ? ["bash"] : ["exec", "process"];
    assert.equal(
      process.env.OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED,
      "1",
      "explicit disposable-repository write and cleanup authorization is required",
    );
    await validateExplicitK3dLoopbackContext(selection);
    const repository = process.env.OCC_TEST_REPOSITORY_CREDENTIALS_REPOSITORY;
    assert.match(
      repository ?? "",
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    );
    const images = Object.fromEntries(
      [
        ["controller", "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"],
        ["runtime", "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"],
        ["postgres", "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"],
        ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
        ["credentials", "OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE"],
      ].map(([name, variable]) => {
        const value = process.env[variable];
        assert.match(
          value ?? "",
          /^\S+@sha256:[a-f0-9]{64}$/,
          `${variable} must select an immutable image`,
        );
        return [name, value];
      }),
    );
    const upstreamCidrs = (process.env.OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS ?? "")
      .split(",")
      .filter(Boolean);
    assert.ok(
      upstreamCidrs.length > 0 && upstreamCidrs.length <= 64,
      "explicit approved provider IPv4 /32 egress is required",
    );
    for (const cidr of upstreamCidrs) {
      const parts = cidr.split("/");
      assert.equal(parts[1], "32", "provider egress must select exact IPv4 addresses");
      assert.ok(
        /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(parts[0]) &&
          parts[0].split(".").every((octet) => Number(octet) <= 255),
      );
      assert.ok(
        !/^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(parts[0]),
        "provider egress must be public",
      );
    }
    const modelKey = process.env.OPENAI_API_KEY;
    assert.ok(modelKey, "an authorized model credential is required");
    const model = process.env.OCC_TEST_OPENAI_MODEL;
    assert.ok(model, "OCC_TEST_OPENAI_MODEL must explicitly select the model");
    const app = JSON.parse(
      await readProtectedInput(
        process.env.OCC_TEST_REPOSITORY_CREDENTIALS_APP_CONFIG_FILE,
        "App identity input",
      ),
    );
    assert.deepEqual(Object.keys(app).sort(), ["appId", "githubInstallationId", "repositoryId"]);
    for (const value of Object.values(app)) {
      assert.match(value, /^[1-9][0-9]{0,15}$/);
    }
    const appKey = await readProtectedInput(
      process.env.OCC_TEST_REPOSITORY_CREDENTIALS_APP_KEY_FILE,
      "App key input",
    );
    const f = await createInstalledRepositoryFixture(context, {
      selection,
      images,
      modelKey,
      executionMode: mode,
    });
    f.secrets.push(appKey);
    const observe = createRepositoryObserver({
      run: f.run,
      repository,
      binary: process.env.OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY,
    });
    const { data: remote } = await observe("GET");
    assert.equal(
      String(remote.id),
      app.repositoryId,
      "authorized registry repository ID must match independent provider readback",
    );
    assert.equal(remote.full_name.toLowerCase(), repository.toLowerCase());
    const base = remote.default_branch;
    assert.equal(typeof base, "string");
    const { data: baseline } = await observe("GET", `git/ref/heads/${encodeURIComponent(base)}`);
    const baseSha = baseline.object.sha;
    assert.match(baseSha, /^[a-f0-9]{40}$/);
    const branch = `oce-credential-proof-${f.suffix}`;
    const file = `credential-proof-${f.suffix}.txt`;
    const content = `Installed repository credential proof ${f.suffix}\n`;
    const marker = `<!-- oce-credential-proof:${f.suffix} -->`;
    assert.equal((await observe("GET", `git/ref/heads/${branch}`, undefined, 404)).status, 404);
    let agent;
    let workerPod;
    let workerImage;
    let brokerImageId;
    let revision;
    let gateway;
    let attempt;
    let taskStarted = false;
    let agentStopped = false;
    let workFailure;
    let remoteEvidence;
    const cleanupFailures = [];
    const executeWorker = (script, args, timeout) =>
      f.run(
        "kubectl",
        [
          ...f.kubernetes.kubectlArguments([]),
          "-n",
          f.system,
          "exec",
          workerPod.metadata.name,
          "-c",
          "worker",
          "--",
          "node",
          "-e",
          script,
          ...args,
        ],
        { timeout },
      );
    const readSession = (id) => readInstalledCredentialSession(executeWorker, id);

    try {
      const backendId = "repository-proof";
      const repositoryRef = "authorized-repository";
      const driverId = "repository-proof-driver";
      const repositoryValues = {
        enabled: true,
        image: images.credentials,
        serviceName: "git",
        backendId,
        registryConfigMapName: "repository-registry-v1",
        registryKey: "registry.json",
        serviceConfigSecretName: "repository-service-config",
        serviceConfigKey: "config.json",
        appKeySecretName: "repository-app-key",
        appKeyKey: "private-key.pem",
        tlsSecretName: "repository-tls",
        publicCaSecretName: "repository-public-ca",
        publicCaKey: "ca.crt",
        upstreamCidrs,
      };
      const renderedBroker = await f.renderRepositoryCredentials(repositoryValues);
      const { origin, serviceName } = renderedBroker;
      const registry = {
        version: 1,
        backendId,
        providerInstanceId: "github-public",
        ...app,
        maximumDurationSeconds: 3600,
        repositories: [
          {
            repositoryRef,
            repositoryId: app.repositoryId,
            repository,
            namespaces: [{ namespaceId: f.namespace.id, profiles: [profile] }],
          },
        ],
      };
      delete registry.repositoryId;
      await f.apply({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: f.metadata("repository-registry-v1"),
        immutable: true,
        data: { "registry.json": JSON.stringify(registry) },
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
        join(f.directory, "repository-tls.key"),
        "-out",
        join(f.directory, "repository-tls.crt"),
        "-subj",
        "/CN=repository-credentials",
        "-addext",
        `subjectAltName=DNS:${new URL(origin).hostname}`,
      ]);
      const tlsKey = await readFile(join(f.directory, "repository-tls.key"), "utf8");
      f.secrets.push(tlsKey);
      const tlsCert = await readFile(join(f.directory, "repository-tls.crt"), "utf8");
      const socket = "/run/openclaw/repository-control/private/control.sock";
      await f.createSecret("repository-app-key", { "private-key.pem": appKey });
      await f.createSecret("repository-tls", { "tls.crt": tlsCert, "tls.key": tlsKey });
      await f.createSecret("repository-public-ca", { "ca.crt": tlsCert });
      await f.createSecret("repository-service-config", {
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
            kind: "github-app-registry",
            backendId,
            registryFile: "/etc/openclaw/repository-registry/registry.json",
            privateKeyFile: "/etc/openclaw/repository-inputs/private-key.pem",
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
      f.configuration.drivers.repo = {
        id: driverId,
        configuration: {
          controlSocket: socket,
          sessionDurationSeconds: 1800,
          publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
        },
      };
      const workerLabels = {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": f.release,
        "app.kubernetes.io/component": "worker",
      };
      f.configuration.drivers.compute.configuration.network.repositoryCredentials = {
        namespace: f.system,
        podLabels: workerLabels,
        port: 8443,
      };
      assert.deepEqual(await f.upgrade(repositoryValues), renderedBroker);
      // The service shares the worker Pod but neither the API nor worker process
      // receives App key/TLS mounts or the Agent's model credential.
      const pods = await f.kubernetes.resources("pods", f.system);
      for (const component of ["api", "worker"]) {
        const pod = pods.find(
          (p) =>
            p.metadata.labels?.["app.kubernetes.io/component"] === component &&
            !p.metadata.deletionTimestamp &&
            p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
        );
        assert.ok(pod, `${component} must be installed and Ready`);
        // Match the status list to the selected chart's worker placement,
        // including a restartable init container when repository access is enabled.
        const matches = [
          ...(pod.spec.containers ?? [])
            .filter((c) => c.name === component)
            .map((container) => ({
              container,
              kind: "container",
              statuses: pod.status.containerStatuses,
            })),
          ...(pod.spec.initContainers ?? [])
            .filter((c) => c.name === component)
            .map((container) => ({
              container,
              kind: "initContainer",
              statuses: pod.status.initContainerStatuses,
            })),
        ];
        assert.equal(matches.length, 1, `${component} must appear in exactly one container list`);
        const { container, kind, statuses } = matches[0];
        if (component === "api") {
          assert.equal(kind, "container");
        }
        assert.equal(container.image, images.controller);
        assert.ok(
          !(container.env ?? []).some((e) => /OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN/.test(e.name)),
        );
        assert.ok(
          !(container.volumeMounts ?? []).some((m) =>
            ["repository-inputs", "repository-private"].includes(m.name),
          ),
        );
        if (component === "worker") {
          workerPod = pod;
          if (kind === "initContainer") {
            assert.equal(container.restartPolicy, "Always");
          }
          const workerStatus = statuses?.find((status) => status.name === "worker");
          assert.equal(workerStatus?.ready, true, "worker container must be ready");
          assert.ok(workerStatus.imageID, "worker image ID must be observed");
          workerImage = { kind, imageId: workerStatus.imageID };
          assert.equal(
            pod.spec.containers.find((c) => c.name === "repository-credentials")?.image,
            images.credentials,
          );
          const brokerStatus = pod.status.containerStatuses?.find(
            (status) => status.name === "repository-credentials",
          );
          assert.equal(brokerStatus?.ready, true, "repository broker container must be ready");
          assert.ok(brokerStatus.imageID, "repository broker image ID must be observed");
          brokerImageId = brokerStatus.imageID;
        }
      }
      // Sidecar readiness alone cannot prove the worker sees the shared socket:
      // a parent mount in this container can hide the credential control mount.
      const workerHealthScript = String.raw`
        const { request } = require("node:http");
        const probe = request({
          socketPath: "/run/openclaw/repository-control/private/control.sock",
          method: "GET", path: "/healthz", agent: false, maxHeaderSize: 1024,
        }, response => {
          const chunks = [];
          let length = 0;
          response.on("data", chunk => {
            length += chunk.length;
            if (length > 1024) probe.destroy(new Error("invalid-health"));
            else chunks.push(chunk);
          });
          response.once("error", () => { process.exitCode = 1; });
          response.once("aborted", () => { process.exitCode = 1; });
          response.once("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (response.statusCode !== 200 || value?.ready !== true || value?.protocolVersion !== 1)
                throw new Error("invalid-health");
              process.stdout.write(JSON.stringify({ready: true, protocolVersion: 1}));
            } catch { process.exitCode = 1; }
          });
        });
        const deadline = setTimeout(() => probe.destroy(new Error("health-timeout")), 2000);
        probe.once("close", () => clearTimeout(deadline));
        probe.once("error", () => { process.exitCode = 1; });
        probe.end();
      `;
      const workerHealth = JSON.parse(
        await f.run(
          "kubectl",
          [
            ...f.kubernetes.kubectlArguments([]),
            "-n",
            f.system,
            "exec",
            workerPod.metadata.name,
            "-c",
            "worker",
            "--",
            "node",
            "-e",
            workerHealthScript,
          ],
          { timeout: 10000 },
        ),
      );
      assert.deepEqual(workerHealth, { ready: true, protocolVersion: 1 });
      await f.record("Worker reaches the installed credential service over its private socket", {
        podUid: workerPod.metadata.uid,
      });
      // Use the service container's actual trust environment before opening any
      // repository session. These fixed public HEAD requests carry no authority.
      // Unauthenticated 4xx responses still prove TLS/reachability; App access is tested later.
      const publicUpstreamScript = String.raw`
        const https = require("node:https");
        const category = error => {
          const code = typeof error?.code === "string" ? error.code : "";
          if (["UNABLE_TO_VERIFY_LEAF_SIGNATURE","UNABLE_TO_GET_ISSUER_CERT","UNABLE_TO_GET_ISSUER_CERT_LOCALLY","DEPTH_ZERO_SELF_SIGNED_CERT","SELF_SIGNED_CERT_IN_CHAIN"].includes(code)) return "tls-untrusted-certificate";
          if (["CERT_HAS_EXPIRED","CERT_NOT_YET_VALID"].includes(code)) return "tls-certificate-validity";
          if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "tls-hostname";
          if (/^ERR_(?:TLS|SSL)_/.test(code)) return "tls-error";
          if (["ENOTFOUND","EAI_AGAIN"].includes(code)) return "dns";
          if (code === "ETIMEDOUT") return "timeout";
          if (["ECONNREFUSED","ECONNRESET","EHOSTUNREACH","ENETUNREACH","EPIPE"].includes(code)) return "connection";
          return "transport-or-response";
        };
        const probe = (target, url) => new Promise(resolve => {
          let settled = false, deadline;
          const finish = (status, cause) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve({target, status, cause});
          };
          const request = https.request(url, {
            method: "HEAD", agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
            headers: {"user-agent": "repository-credentials-installed-preflight"},
          }, response => {
            const status = Number.isInteger(response.statusCode) ? response.statusCode : null;
            response.once("error", error => finish(status, category(error)));
            response.once("aborted", () => finish(status, "response-aborted"));
            response.once("end", () => finish(status, status >= 200 && status < 500 ? "none" : "http-status"));
            response.resume();
          });
          deadline = setTimeout(() => request.destroy(Object.assign(new Error("timeout"), {code: "ETIMEDOUT"})), 5000);
          request.once("error", error => finish(null, category(error)));
          request.end();
        });
        (async () => {
          const results = [];
          results.push(await probe("api.github.com", "https://api.github.com/meta"));
          results.push(await probe("github.com", "https://github.com"));
          process.stdout.write(JSON.stringify(results));
        })().catch(() => { process.stderr.write("public upstream preflight unavailable\n"); process.exitCode = 1; });
      `;
      const probePublicUpstream = async () =>
        JSON.parse(
          await f.run(
            "kubectl",
            [
              ...f.kubernetes.kubectlArguments([]),
              "-n",
              f.system,
              "exec",
              workerPod.metadata.name,
              "-c",
              "repository-credentials",
              "--",
              "node",
              "-e",
              publicUpstreamScript,
            ],
            { timeout: 15000 },
          ),
        );
      // Pod readiness can precede network-policy propagation. Retry only these
      // unauthenticated public reads, before creating any Agent or session.
      const publicPreflightDeadline = Date.now() + 45000;
      let publicPreflightAttempts = 0;
      let publicUpstream;
      do {
        publicPreflightAttempts++;
        publicUpstream = await probePublicUpstream();
        const transient = publicUpstream.some(({ cause }) =>
          ["dns", "timeout", "connection"].includes(cause),
        );
        const permanent = publicUpstream.some(
          ({ cause }) => !["none", "dns", "timeout", "connection"].includes(cause),
        );
        if (!transient || permanent || Date.now() + 5000 >= publicPreflightDeadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } while (Date.now() < publicPreflightDeadline);
      await f.record("Captured public upstream preflight; repository acceptance pending", {
        evidenceKind: "diagnostic-only",
        publicPreflightAttempts,
        publicUpstream,
      });
      assert.deepEqual(
        publicUpstream.map(({ target }) => target),
        ["api.github.com", "github.com"],
      );
      for (const result of publicUpstream) {
        assert.equal(result.cause, "none", `${result.target} public upstream preflight failed`);
        assert.ok(Number.isInteger(result.status) && result.status >= 200 && result.status < 500);
      }
      const native = createHarnessConfiguration(dedicated ? "codex" : "openclaw", model);
      native.agents.defaults.skipBootstrap = true;
      native.agents.defaults.workspace = workspace;
      native.agents.defaults.sandbox = { mode: "off" };
      if (dedicated) {
        Object.assign(native.gateway, f.gatewayConfiguration);
        // The Agent must use its native workspace sandbox without escalation.
        // The Compute Driver adds the credential broker to the managed proxy.
        Object.assign(native.plugins.entries.codex.config.appServer, {
          approvalPolicy: "never",
          sandbox: "workspace-write",
          remoteWorkspaceRoot: workspace,
        });
        native.tools = { allow: ["*"], exec: { mode: "full" }, fs: { workspaceOnly: true } };
      } else {
        native.tools = { allow: ["exec", "process"], exec: { host: "gateway", mode: "full" } };
      }
      const secret = await f.api(
        "POST",
        `/namespaces/${f.namespace.id}/secrets`,
        { name: "repository-model", value: modelKey },
        201,
      );
      const configuration = await f.api(
        "POST",
        `/namespaces/${f.namespace.id}/configurations`,
        { kind: "agent", values: native },
        201,
      );
      agent = await f.api(
        "POST",
        `/namespaces/${f.namespace.id}/agents`,
        {
          name: `repository-${f.suffix}`,
          configurationId: configuration.id,
          executionMode: mode,
          harnessAuth: { method: "api_key", source: secret.ref },
          repositoryBindings: [{ repositoryRef, profile }],
        },
        201,
      );
      const agentPath = `/namespaces/${f.namespace.id}/agents/${agent.id}`;
      // The supported administrator grant binds only the Agent's persisted service
      // Principal and its exact model Secret; it does not grant repository authority.
      const grant = await f.sql(
        `WITH principal AS (SELECT service_principal_id FROM occ.agents WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND id=${sqlLiteral(agent.id)}), role AS (INSERT INTO occ.iam_roles (id,namespace_id,name,permissions) SELECT ${sqlLiteral(`role-${f.suffix}`)},${sqlLiteral(f.namespace.id)},'Harness Secret operate','[{"action":"operate","resourceKind":"secret"}]'::jsonb FROM principal RETURNING id), binding AS (INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id) SELECT ${sqlLiteral(`binding-${f.suffix}`)},${sqlLiteral(f.namespace.id)},principal.service_principal_id,role.id,'secret',${sqlLiteral(secret.id)} FROM principal CROSS JOIN role RETURNING id) SELECT count(*) FROM binding;`,
      );
      assert.equal(grant, "1");
      await f.api("POST", `${agentPath}/runtime-credentials`, {}, 200);
      revision = await f.api("POST", `${agentPath}/deploy`, undefined, 202);
      assert.equal(revision.harness.mode, mode);
      assert.equal(revision.harness.id, dedicated ? "codex" : "openclaw");
      assert.deepEqual(revision.repositoryCredentials.bindings, [{ repositoryRef, profile }]);
      await f.waitFor(
        "admitted Agent revision active",
        async () => (await f.api("GET", agentPath)).activeRevisionId === revision.id,
        300000,
      );
      const configMap = `gateway-${kubernetesHash(agent.id)}-rev-${kubernetesHash(revision.id)}`;
      const gatewayNamespace = dedicated ? f.gatewayRuntimeNamespace : f.tenant;
      gateway = await f.waitFor("one Ready Pod serving the exact admitted revision", async () => {
        const candidates = (
          await f.kubernetes.resources(
            "pods",
            gatewayNamespace,
            "-l",
            `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=gateway`,
          )
        ).filter(
          (p) =>
            !p.metadata.deletionTimestamp &&
            p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True") &&
            p.spec.volumes.some((v) => v.configMap?.name === configMap),
        );
        assert.ok(candidates.length <= 1);
        return candidates[0] ?? false;
      });
      const gatewayContainer = gateway.spec.containers.find((c) => c.name === "gateway");
      const consumer = dedicated
        ? await f.waitFor("one Ready Codex Pod for the admitted revision", async () => {
            const candidates = (
              await f.kubernetes.resources(
                "pods",
                f.tenant,
                "-l",
                `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`,
              )
            ).filter(
              (pod) =>
                !pod.metadata.deletionTimestamp &&
                pod.status.conditions?.some(
                  (condition) => condition.type === "Ready" && condition.status === "True",
                ),
            );
            assert.ok(candidates.length <= 1);
            return candidates[0] ?? false;
          })
        : gateway;
      const consumerName = dedicated ? "agent" : "gateway";
      const consumerContainer = consumer.spec.containers.find((c) => c.name === consumerName);
      assert.equal(gatewayContainer?.image, images.runtime);
      assert.equal(consumerContainer?.image, images.runtime);
      assert.ok(
        consumerContainer.env
          .find((value) => value.name === "PATH")
          ?.value.startsWith("/opt/oce/repository-credentials/bin:"),
        "regular Git/gh commands must use the delivered client",
      );
      assert.ok(
        ![gatewayContainer, consumerContainer].some((container) =>
          container.env.some((value) =>
            ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
              value.name,
            ),
          ),
        ),
        "no alternate GitHub credential may enter the Agent",
      );
      assert.ok(
        ![gateway, consumer].some((pod) =>
          pod.spec.volumes.some((v) =>
            ["repository-app-key", "repository-tls", "repository-service-config"].includes(
              v.secret?.secretName,
            ),
          ),
        ),
      );
      const execIn = (pod, container, script, args = [], input, timeout = 30000) =>
        f.run(
          "kubectl",
          [
            ...f.kubernetes.kubectlArguments([]),
            "-n",
            pod.metadata.namespace,
            "exec",
            "-i",
            pod.metadata.name,
            "-c",
            container,
            "--",
            "env",
            "-u",
            "OPENAI_API_KEY",
            "node",
            "-e",
            script,
            ...args,
          ],
          { input, timeout },
        );
      const exec = (...args) => execIn(gateway, "gateway", ...args);
      const consumerExec = (...args) => execIn(consumer, consumerName, ...args);
      if (dedicated) {
        assert.notEqual(consumer.metadata.uid, gateway.metadata.uid);
        assert.notEqual(consumer.spec.serviceAccountName, gateway.spec.serviceAccountName);
        assert.equal(consumer.spec.securityContext.runAsNonRoot, true);
        assert.equal(consumerContainer.securityContext.readOnlyRootFilesystem, true);
        assert.equal(consumerContainer.securityContext.allowPrivilegeEscalation, false);
        assert.deepEqual(consumerContainer.securityContext.seccompProfile, {
          type: "Localhost",
          localhostProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
        });
        assert.equal(
          consumerContainer.volumeMounts.find(
            ({ mountPath }) => mountPath === "/run/oce/repository-credentials",
          )?.readOnly,
          true,
        );
        assert.ok(
          consumerContainer.env.some(
            ({ name, valueFrom }) => name === "OPENAI_API_KEY" && valueFrom?.secretKeyRef,
          ),
        );
        assert.ok(!gatewayContainer.env.some(({ name }) => name === "OPENAI_API_KEY"));
        assert.ok(!gateway.spec.volumes.some(({ name }) => name.startsWith("repository-")));
        assert.equal(
          (
            await exec(
              "process.stdout.write(String(require('node:fs').existsSync('/run/oce/repository-credentials/manifest.json')))",
            )
          ).trim(),
          "false",
        );
      }
      const versions = JSON.parse(
        await exec(
          `const fs=require('node:fs'); console.log(JSON.stringify({node:process.version,openclaw:JSON.parse(fs.readFileSync('/app/node_modules/openclaw/package.json','utf8')).version,repositoryClient:JSON.parse(fs.readFileSync('/opt/oce/repository-credentials/package.json','utf8')).version}));`,
        ),
      );
      assert.match(versions.openclaw, /^\d+\.\d+\.\d+/);
      if (dedicated) {
        versions.codex = (
          await consumerExec(
            "const result=require('node:child_process').spawnSync('codex',['--version'],{encoding:'utf8'}); if(result.status!==0) process.exit(1); process.stdout.write(result.stdout);",
          )
        ).trim();
        assert.match(versions.codex, /^codex-cli \d+\.\d+\.\d+/);
      }
      const service = await f.get("service", serviceName);
      assert.equal(origin, `https://${renderedBroker.hostname}`);
      const probe = `const net=require('node:net'); const socket=net.createConnection({host:process.argv[1],port:443}); let done=false; function finish(result){if(done)return;done=true;console.log(result);socket.destroy()}socket.setTimeout(3000);socket.on('connect',()=>finish('connected'));socket.on('timeout',()=>finish('timeout'));socket.on('error',error=>finish(error.code));`;
      assert.equal((await consumerExec(probe, [service.spec.clusterIP])).trim(), "connected");
      if (dedicated) {
        assert.ok(
          ["timeout", "EHOSTUNREACH", "ECONNREFUSED"].includes(
            (await exec(probe, [service.spec.clusterIP])).trim(),
          ),
          "the separate Gateway must not reach the repository credential service",
        );
      }
      const denied = (
        await f.run(
          "kubectl",
          [
            ...f.kubernetes.kubectlArguments([]),
            "-n",
            f.system,
            "exec",
            "operator",
            "--",
            "node",
            "-e",
            probe,
            service.spec.clusterIP,
          ],
          { timeout: 10000 },
        )
      ).trim();
      assert.ok(
        ["timeout", "EHOSTUNREACH", "ECONNREFUSED"].includes(denied),
        "an unapproved Pod must not connect to the same listening credential service",
      );
      await f.record("Credential service allows the Agent and denies an unapproved Pod", {
        targetPort: 443,
        serviceTargetPort: 8443,
        denied,
      });
      const attempts = JSON.parse(
        await f.sql(
          `SELECT coalesce(json_agg(json_build_object('sessionId',session_id,'repositoryRef',repository_ref,'phase',phase,'revisionId',revision_id,'agentId',agent_id)), '[]') FROM occ.repository_session_attempts WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND agent_id=${sqlLiteral(agent.id)} AND revision_id=${sqlLiteral(revision.id)};`,
        ),
      );
      assert.equal(attempts.length, 1);
      attempt = attempts[0];
      assert.equal(attempt.phase, "open");
      assert.equal(attempt.repositoryRef, repositoryRef);
      assert.ok(attempt.sessionId);
      const openedSession = await readSession(attempt.sessionId);
      assert.equal(openedSession.sessionId, attempt.sessionId);
      assert.equal(openedSession.state, "OPEN");
      const material = JSON.parse(
        await consumerExec(
          `const fs=require('node:fs'); const p='/run/oce/repository-credentials/manifest.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); const st=fs.statSync(p); console.log(JSON.stringify({uid:st.uid,mode:st.mode&0o777,generation:m.generation,bindings:m.bindings.map(b=>({repositoryRef:b.repositoryRef,sessionId:b.sessionId}))}));`,
        ),
      );
      assert.equal(material.uid, 1000);
      assert.equal(material.mode, 0o600);
      assert.deepEqual(material.bindings, [{ repositoryRef, sessionId: attempt.sessionId }]);
      assert.equal(
        consumer.metadata.annotations["openclaw.dev/repository-material-generation"],
        material.generation,
      );
      await f.run("kubectl", [
        ...f.kubernetes.kubectlArguments([]),
        "-n",
        gateway.metadata.namespace,
        "exec",
        gateway.metadata.name,
        "-c",
        "gateway",
        "--",
        "node",
        "/app/openclaw.mjs",
        "config",
        "validate",
        "--json",
      ]);
      await f.record("Installed Agent admitted one worker-owned repository session", {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        revisionId: revision.id,
        pod: gateway.metadata.name,
        podUid: gateway.metadata.uid,
        executionMode: mode,
        consumerPodUid: consumer.metadata.uid,
        consumerImageId: consumer.status.containerStatuses.find(
          (status) => status.name === consumerName,
        )?.imageID,
        sessionId: attempt.sessionId,
        generation: material.generation,
        model,
        versions,
        runtimeImageId: gateway.status.containerStatuses.find((status) => status.name === "gateway")
          ?.imageID,
        workerImage,
        brokerImageId,
      });
      // The canonical matrix owns native write/PR journeys for both shipped
      // installations. Keep this fixture's isolation and sandbox boundaries.
      if (readOnly) {
        taskStarted = true;
        remoteEvidence = await verifyNativeRepositoryJourney({
          f,
          dedicated,
          readOnly,
          workspace,
          repository,
          base,
          baseSha,
          branch,
          file,
          content,
          marker,
          commandTool,
          toolNames,
          gateway,
          consumer,
          agent,
          revision,
          attempt,
          exec,
          // The worker holds the scoped Gateway key and CA for dedicated
          // submission; neither credential is copied to the test runner.
          submitTask: dedicated ? (...args) => execIn(workerPod, "worker", ...args) : exec,
          consumerExec,
          observe,
          app,
          remote,
          readSession,
        });
      }
    } catch (error) {
      workFailure = { error };
      if (agent) {
        await recordRuntimeStartupFailure(f, agent).catch(() => {
          // Diagnostics must not replace the original failure or prevent cleanup.
        });
      }
    } finally {
      if (agent) {
        try {
          await f.api(
            "POST",
            `/namespaces/${f.namespace.id}/agents/${agent.id}/stop`,
            undefined,
            202,
          );
          await f.waitFor("Agent stop, session disposal and material deletion", async () => {
            const current = await f.api("GET", `/namespaces/${f.namespace.id}/agents/${agent.id}`);
            const pods = await agentPods(f, agent.id);
            const materials = (
              await f.kubectl(
                "-n",
                f.tenant,
                "get",
                "secrets",
                "-l",
                `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
                "-o",
                "jsonpath={.items[*].metadata.name}",
              )
            ).trim();
            const pending = await f.sql(
              `SELECT count(*) FROM occ.repository_session_attempts WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND agent_id=${sqlLiteral(agent.id)} AND phase IN ('opening','open','closing');`,
            );
            return (
              current.desiredRuntimeState === "stopped" &&
              !current.activeRevisionId &&
              pods.length === 0 &&
              materials.length === 0 &&
              pending === "0"
            );
          });
          if (attempt) {
            const disposed = await readSession(attempt.sessionId);
            assert.equal(disposed.sessionId, attempt.sessionId);
            assert.equal(disposed.state, "DISPOSED");
            assert.equal(disposed.activeUses, 0);
            assert.equal(disposed.cleanup.active, 0);
            assert.equal(disposed.cleanup.pending, 0);
            assert.equal(disposed.cleanup.uncertain, 0);
            assert.equal(disposed.cleanup.auxiliaryPending, false);
          }
          agentStopped = true;
          await f.record("Ordinary Agent stop disposed sessions and removed runtime material", {
            agentId: agent.id,
          });
        } catch {
          cleanupFailures.push("Agent stop or session/material cleanup unresolved");
        }
      }
      if (taskStarted && !agentStopped) {
        cleanupFailures.push("remote cleanup requires confirmed stopped Agent");
      }
      if (taskStarted && agentStopped) {
        try {
          await cleanupRepositoryJourney({
            observe,
            repository,
            repositoryId: app.repositoryId,
            branch,
            base,
            baseSha,
            file,
            content,
            marker,
            readOnly,
            commitMessage: `Installed credential proof ${f.suffix}`,
            expectedSha: remoteEvidence?.commitSha,
          });
          await f.record("Run-owned remote PR and unchanged branch reconciled and removed");
        } catch {
          cleanupFailures.push("remote ownership or cleanup unresolved");
        }
      }
    }
    if (cleanupFailures.length) {
      throw new AggregateError(
        [
          ...(workFailure ? [workFailure.error] : []),
          ...cleanupFailures.map((message) => new Error(message)),
        ],
        "cleanup must finish before installed acceptance can pass",
      );
    }
    if (workFailure) {
      throw workFailure.error;
    }
  };
}
