import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { kubernetesHash, validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";
import {
  codexRepositoryEvidenceScript,
  completedToolResult,
  sessionEvidenceScript,
} from "../helpers/normal-agent-tools.mjs";
import {
  createInstalledRepositoryFixture,
  createRepositoryObserver,
  readProtectedInput,
  readInstalledCredentialSession,
  submitRepositoryTaskScript,
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
const repositoryFailureSummaryScript = String.raw`
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", {readOnly: true});
  const patterns = [
    ["tool-approval-or-policy", /approval required|exec denied|execution denied|not allowed by|host.*not allowed|security policy/i],
    ["command-unavailable", /command not found|spawn.*ENOENT|executable.*not found/i],
    ["repository-authentication", /authentication failed|could not read Username|bad credentials|HTTP Basic: Access denied|returned error: (?:401|403)/i],
    ["repository-unavailable", /repository.*not found|repository.*does not exist|returned error: 404/i],
    ["tls-validation", /certificate verify failed|server certificate verification failed|SSL certificate problem|SSL_ERROR|unable to get local issuer|self.signed certificate/i],
    ["tls-transport-closed", /GnuTLS recv error|TLS connection.*terminated/i],
    ["git-http-server-error", /returned error: 5[0-9]{2}|HTTP\/[0-9.]+ 5[0-9]{2}|HTTP (?:error |status )?5[0-9]{2}/i],
    ["network-resolution-or-connection", /could not resolve host|ENOTFOUND|ECONNREFUSED|connection refused|failed to connect|connection timed out/i],
    ["filesystem-permission", /EACCES|permission denied|read.only file system/i],
    ["git-worktree", /not a git repository|destination path.*already exists|working tree.*overwritten/i],
    ["git-author-identity", /author identity unknown|please tell me who you are|unable to auto.detect email/i],
    ["git-ref-or-push", /src refspec.*does not match|non.fast.forward|failed to push some refs|couldn.t find remote ref/i],
    ["model-rate-or-quota", /rate limit|quota exceeded|insufficient_quota|too many requests/i],
    ["model-authentication", /invalid api key|incorrect api key|authentication_error/i],
  ];
  const classify = message => {
    const content = typeof message.content === "string" ? message.content :
      Array.isArray(message.content) ? message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
    const text = Buffer.from([content, message.details?.aggregated, message.errorMessage].filter(value => typeof value === "string").join("\n"), "utf8").subarray(0, 262144).toString("utf8");
    const categories = patterns.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
    const failed = message.isError === true || message.stopReason === "error" || message.details?.status === "error" ||
      (Number.isInteger(message.details?.exitCode) && message.details.exitCode !== 0);
    return categories.length === 0 && failed ? ["other-failure"] : categories;
  };
  try {
    db.exec("PRAGMA busy_timeout=2000");
    const session = db.prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?").get(process.argv[1]);
    if (!session) { process.stdout.write(JSON.stringify({exists:false})); }
    else {
      const rows = db.prepare("SELECT seq, CASE WHEN length(CAST(event_json AS BLOB)) <= 524288 THEN event_json ELSE NULL END AS event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 128").all(session.current_session_id).reverse();
      const toolResults = [];
      let finalAssistant, skippedOversizeEvents = 0;
      for (const row of rows) {
        if (row.event_json === null) { skippedOversizeEvents++; continue; }
        const event = JSON.parse(row.event_json);
        if (event.type !== "message" || !event.message) continue;
        const message = event.message;
        if (message.role === "toolResult") toolResults.push({seq:row.seq, categories:classify(message)});
        if (message.role === "assistant") finalAssistant = {
          seq:row.seq,
          stopReason:["stop","length","toolUse","error","aborted"].includes(message.stopReason) ? message.stopReason : "other-or-absent",
          hasToolCalls:Array.isArray(message.content) && message.content.some(block => block?.type === "toolCall"),
          categories:classify(message),
        };
      }
      process.stdout.write(JSON.stringify({exists:true, scannedEvents:rows.length, eventLimit:128, skippedOversizeEvents, toolResults, finalAssistant}));
    }
  } catch { process.stderr.write("repository diagnostic summary unavailable\n"); process.exitCode=1; }
  finally { db.close(); }
`;

// This case proves the installed caller path that host-driven Git/gh smoke tests
// cannot: the model acts using material opened by the production worker.
for (const mode of ["embedded", "dedicated"]) {
  test(
    `installed ${mode} Agent clones, edits, commits, pushes and creates a native repository PR`,
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
    if (selected) {
      throw new Error(
        "Installed repository qualification is temporarily unavailable until safe remote cleanup is supported.",
      );
    }
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
    const cleanupFailures = [];
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
      const openedSession = await readInstalledCredentialSession(f, workerPod, attempt.sessionId);
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
      const sessionKey = `agent:main:repository-proof-${f.suffix}`;
      const checkout = `${workspace}/${repository.split("/")[1]}`;
      // The outside file is writable by the same Pod user before the sandboxed
      // model command. Independent readback detects any sandbox escape.
      const outside = `/home/node/repository-sandbox-${f.suffix}.txt`;
      const sandboxFile = `${workspace}/repository-sandbox-${f.suffix}.txt`;
      const sandboxContent = `sandbox-${f.suffix}\n`;
      const outsideContent = `outside-${f.suffix}\n`;
      const sandboxScript = [
        'const fs=require("node:fs")',
        `fs.writeFileSync(${JSON.stringify(sandboxFile)},${JSON.stringify(sandboxContent)})`,
        'let denied="NO_ERROR"',
        `try{fs.writeFileSync(${JSON.stringify(outside)},"escaped")}catch(error){denied=error.code}`,
        'if(!["EACCES","EPERM","EROFS"].includes(denied))process.exit(70)',
        'process.stdout.write("SANDBOX_DENIED:"+denied+"\\n")',
      ].join(";");
      if (dedicated) {
        await consumerExec(
          `require("node:fs").writeFileSync(${JSON.stringify(outside)},${JSON.stringify(outsideContent)})`,
        );
      }
      const commandSpecs = [
        ...(dedicated
          ? [{ operation: "sandboxProbe", workdir: workspace, argv: ["node", "-e", sandboxScript] }]
          : []),
        {
          operation: "clone",
          workdir: workspace,
          argv: ["git", "clone", `https://github.com/${repository}.git`],
        },
        { operation: "fetch", workdir: checkout, argv: ["git", "fetch", "origin"] },
        {
          operation: "readBase",
          workdir: checkout,
          argv: ["git", "rev-parse", `origin/${base}`],
        },
        ...(!readOnly
          ? [
              {
                operation: "branch",
                workdir: checkout,
                argv: ["git", "switch", "-c", branch, baseSha],
              },
              { operation: "add", workdir: checkout, argv: ["git", "add", "--", file] },
              {
                operation: "commit",
                workdir: checkout,
                argv: ["git", "commit", "-m", `Installed credential proof ${f.suffix}`],
              },
            ]
          : []),
        {
          operation: "push",
          workdir: checkout,
          argv: ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
        },
        ...(!readOnly
          ? [
              { operation: "readCommit", workdir: checkout, argv: ["git", "rev-parse", "HEAD"] },
              {
                operation: "nativePr",
                workdir: checkout,
                argv: [
                  "gh",
                  "pr",
                  "create",
                  "--base",
                  base,
                  "--head",
                  branch,
                  "--title",
                  `Installed credential proof ${f.suffix}`,
                  "--body",
                  marker,
                ],
              },
            ]
          : []),
      ];
      const quoteArgument = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      const commands = commandSpecs
        .map(
          ({ operation, workdir, argv }) =>
            `${operation}: exec.workdir=${JSON.stringify(workdir)}, exec.command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`,
        )
        .join("\n");
      const embeddedPrompt = `Complete this authorized disposable repository task once with your exec tool and normal image-installed git/gh commands. Each Git/gh operation below must be its own standalone exec.command, with the specified exec.workdir. Execute the exact arguments in the listed order. Do not use shell cd, chaining, pipelines, redirection, comments, substitutions or wrappers in those Git/gh commands. Run foreground commands and stop on any failure. If exec nevertheless reports a running process, use process.poll on that exact session until completion before continuing. Do not install tools, read credentials, use alternate tokens, force push, call a provider HTTP API to create the PR, or delegate.
After clone, its natural destination is ${checkout}. The readBase output must equal ${baseSha}; stop if it differs. Between branch and add, use exec.workdir=${JSON.stringify(checkout)} for every configuration and file-writing exec call. Configure local disposable Git identity Repository proof <repository-proof@example.invalid>, then use a separate exec call of your own to write exactly the following JSON-encoded bytes to the new file at absolute path ${JSON.stringify(`${checkout}/${file}`)}: ${JSON.stringify(content)}. Author that file yourself; do not change any other file. Make exactly one commit and exactly one same-repository ready-for-review PR. readCommit prints the full commit SHA and nativePr prints the PR URL; do not substitute echo commands for either operation. Do not close the PR or delete its branch. Finish with ${marker}.
${commands}`;
      const dedicatedPrompt = `Complete this authorized disposable repository task once using native Codex shell commands in your workspace. Execute every listed operation, including sandboxProbe, once, in order, as a separate foreground command with its specified working directory. Use the exact arguments; do not add shell cd, chaining, pipelines, redirection, comments, substitutions or wrappers to Git/gh commands. Use non-login shells. Stop on any failure. Do not request escalation, install tools, read credentials, use alternate tokens, force push, call a provider HTTP API to create the PR, or delegate.
After clone, its natural destination is ${checkout}. readBase must equal ${baseSha}; stop if it differs. Between branch and add, configure local Git identity Repository proof <repository-proof@example.invalid> and author exactly these JSON-encoded bytes in the new file ${JSON.stringify(`${checkout}/${file}`)}: ${JSON.stringify(content)}. Do not change any other file. Make one commit and one same-repository ready-for-review PR. readCommit must print the actual commit SHA and nativePr the actual PR URL. Do not close the PR or delete the branch. Finish with ${marker}.
${commandSpecs.map(({ operation, workdir, argv }) => `${operation}: working directory=${JSON.stringify(workdir)}, command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`).join("\n")}`;
      const readOnlyPrompt = `Complete this authorized read-only repository check using native Codex shell commands. Execute every listed operation once, in order, as a separate foreground command with the specified working directory and exact arguments. Use non-login shells and do not use shell cd, chaining, pipelines, redirection, substitutions or wrappers. Do not request escalation, use alternate credentials, or delegate. The sandboxProbe must succeed; clone and fetch must succeed and readBase must equal ${baseSha}. The push is intentionally unauthorized: attempt it exactly once and continue after it fails. Do not create a PR or retry; the attempted push must be the only remote write attempt. Finish with ${marker}.
${commandSpecs.map(({ operation, workdir, argv }) => `${operation}: working directory=${JSON.stringify(workdir)}, command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`).join("\n")}`;
      const prompt = readOnly ? readOnlyPrompt : dedicated ? dedicatedPrompt : embeddedPrompt;
      taskStarted = true;
      let taskFailure;
      let taskTransport = { outcome: "unresolved" };
      try {
        // The installed worker already holds the scoped Gateway key and CA for
        // node enrollment; neither credential is copied to the test runner.
        const submit = dedicated ? (...args) => execIn(workerPod, "worker", ...args) : exec;
        const response = JSON.parse(
          await submit(
            submitRepositoryTaskScript,
            [],
            JSON.stringify({
              sessionKey,
              prompt,
              ...(dedicated
                ? {
                    gatewayUrl: `https://${f.gatewayHostname}/namespaces/${f.namespace.id}/agents/${agent.id}`,
                    completionMarker: marker,
                  }
                : {}),
            }),
            610000,
          ),
        );
        taskTransport = {
          outcome: response.status === 200 ? "http-completed" : "http-failed",
          httpStatus: Number.isSafeInteger(response.status) ? response.status : null,
          ...(response.failure === undefined ? {} : { failure: response.failure }),
        };
        assert.equal(response.status, 200);
      } catch (error) {
        taskFailure = error;
        if (taskTransport.outcome === "unresolved") {
          taskTransport = {
            outcome:
              error instanceof SyntaxError
                ? "invalid-submit-response"
                : error instanceof Error && /timeout/i.test(error.message)
                  ? "transport-timeout"
                  : "transport-or-submit-failed",
          };
        }
      }
      await f.record("Captured task transport diagnostics; repository acceptance pending", {
        evidenceKind: "diagnostic-only",
        taskTransport,
      });
      // A timeout is an unknown mutation outcome. Read actual trace and provider
      // state once; never replay a model task or create the PR in the runner.
      const trace = JSON.parse(
        await exec(sessionEvidenceScript, [
          sessionKey,
          marker,
          commandTool,
          marker,
          JSON.stringify({
            toolNames,
            commands: commandSpecs,
          }),
        ]),
      );
      const nativeTrace = dedicated
        ? JSON.parse(
            await exec(codexRepositoryEvidenceScript, [marker, JSON.stringify(commandSpecs)]),
          )
        : undefined;
      if (nativeTrace) {
        await f.record("Captured native Codex command diagnostics; repository acceptance pending", {
          evidenceKind: "diagnostic-only",
          threadId: nativeTrace.threadId,
          turnId: nativeTrace.turnId,
          commands: nativeTrace.commands.map(
            ({ operations, status, exitCode, http400, sandboxDenied }) => ({
              operations,
              status,
              exitCode,
              http400,
              sandboxDenied,
            }),
          ),
        });
      }
      // Preserve the normalized call/result evidence before any remote-state
      // assertion can fail and ordinary cleanup removes the Agent transcript.
      // Store only fixed labels and numeric associations, not transcript IDs,
      // arbitrary map keys, output-derived URLs/hashes, or process session IDs.
      const expectedOperations = new Set(commandSpecs.map(({ operation }) => operation));
      const diagnosticStatus = (value) =>
        ["running", "completed", "error"].includes(value) ? value : "other-or-absent";
      const diagnosticNumber = (value) => (Number.isSafeInteger(value) ? value : null);
      const traceCalls = trace.calls ?? [];
      const traceResults = trace.results ?? [];
      const diagnosticTrace = {
        exists: trace.exists === true,
        promptReportFromRun: trace.promptReportSource === "run",
        promptIncludesExec: trace.promptToolNames?.includes("exec") === true,
        promptIncludesProcess: trace.promptToolNames?.includes("process") === true,
        messageCount: diagnosticNumber(trace.messageCount),
        eventCount: diagnosticNumber(trace.diagnostics?.eventCount),
        userMarkerSeen: trace.userMarkerSeen === true,
        assistantMarkerSeen: trace.assistantMarkerSeen === true,
        terminalAssistantMarkerSeen: trace.terminalAssistantMarkerSeen === true,
        assistantError: trace.assistantError === true,
        callCount: traceCalls.length,
        resultCount: traceResults.length,
        captureLimit: 256,
        calls: traceCalls.slice(-256).map((call) => ({
          seq: diagnosticNumber(call.seq),
          tool: toolNames.includes(call.name) ? call.name : "other",
          processPoll: call.name === "process" && call.processAction === "poll",
          operations: (call.operations ?? []).filter((operation) =>
            expectedOperations.has(operation),
          ),
        })),
        results: traceResults.slice(-256).map((result) => ({
          seq: diagnosticNumber(result.seq),
          callSeq: diagnosticNumber(traceCalls.find((call) => call.id === result.toolCallId)?.seq),
          isError: result.isError === true,
          status: diagnosticStatus(result.status),
          exitCode: diagnosticNumber(result.exitCode),
        })),
      };
      await f.record("Captured model tool diagnostics; repository acceptance pending", {
        evidenceKind: "diagnostic-only",
        taskTransport,
        trace: diagnosticTrace,
      });
      let failureSummary;
      try {
        failureSummary = JSON.parse(await exec(repositoryFailureSummaryScript, [sessionKey]));
      } catch {
        failureSummary = { available: false, reason: "bounded-summary-unavailable" };
      }
      const operationProgress = commandSpecs.map(({ operation }) => ({
        operation,
        calls: traceCalls
          .slice(-256)
          .filter((call) => call.operations?.includes(operation))
          .map((call) => ({
            callSeq: call.seq,
            results: traceResults
              .slice(-256)
              .filter((result) => result.toolCallId === call.id && result.seq > call.seq)
              .map((result) => ({
                resultSeq: result.seq,
                isError: result.isError,
                status: diagnosticStatus(result.status),
                exitCode: diagnosticNumber(result.exitCode),
                categories:
                  failureSummary.toolResults?.find((entry) => entry.seq === result.seq)
                    ?.categories ?? [],
              })),
          })),
      }));
      await f.record("Captured failure classifications; repository acceptance pending", {
        evidenceKind: "diagnostic-only",
        classificationMeaning: "text-pattern hints, not verified causes or successful operations",
        operationProgress,
        failureSummary,
      });
      assert.equal(
        (await f.get("pod", gateway.metadata.name, gateway.metadata.namespace)).metadata.uid,
        gateway.metadata.uid,
        "the task must remain bound to the observed Agent Pod",
      );
      assert.equal(
        (await f.get("pod", consumer.metadata.name, consumer.metadata.namespace)).metadata.uid,
        consumer.metadata.uid,
        "the task must remain bound to the observed repository consumer",
      );
      assert.equal((await f.api("GET", agentPath)).activeRevisionId, revision.id);
      assert.equal(
        (await readInstalledCredentialSession(f, workerPod, attempt.sessionId)).state,
        "OPEN",
      );
      if (dedicated) {
        const probe = nativeTrace.commands.find((command) =>
          command.operations.includes("sandboxProbe"),
        );
        assert.ok(
          probe?.status === "completed" && probe.exitCode === 0 && probe.sandboxDenied,
          "the actual native command must report an outside-workspace write denial",
        );
        const call = trace.calls.find(
          (entry) =>
            entry.id === probe.id &&
            entry.name === "bash" &&
            entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${probe.id}:call`,
        );
        const result = trace.results.find(
          (entry) =>
            entry.toolCallId === probe.id &&
            entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${probe.id}:result`,
        );
        assert.ok(call && result && result.seq > call.seq, "the sandbox probe must be mirrored");
        const files = JSON.parse(
          await consumerExec(
            `const fs=require("node:fs");process.stdout.write(JSON.stringify([fs.readFileSync(${JSON.stringify(sandboxFile)},"utf8"),fs.readFileSync(${JSON.stringify(outside)},"utf8")]))`,
          ),
        );
        assert.deepEqual(files, [sandboxContent, outsideContent]);
      }
      const branchResponse = await observe("GET", `git/ref/heads/${branch}`, undefined, [200, 404]);
      if (readOnly) {
        assert.equal(nativeTrace.status, "completed");
        assert.equal(trace.exists, true);
        assert.equal(trace.userMarkerSeen, true);
        assert.equal(trace.terminalAssistantMarkerSeen, true);
        const mirroredTurn = trace.codexTurns.find(
          ({ turnPrefix }) => turnPrefix === nativeTrace.turnId,
        );
        assert.ok(
          mirroredTurn?.promptSeen &&
            mirroredTurn.terminalAssistantSeen &&
            mirroredTurn.toolCallMirrorSeen &&
            mirroredTurn.toolResultMirrorSeen,
        );
        let previousCommand = -1;
        for (const operation of ["clone", "fetch", "readBase", "push"]) {
          const matches = nativeTrace.commands.filter((command) =>
            command.operations.includes(operation),
          );
          assert.equal(matches.length, 1, `${operation} must execute once in the native turn`);
          const command = matches[0];
          const commandIndex = nativeTrace.commands.indexOf(command);
          assert.ok(
            commandIndex > previousCommand,
            "read and denial operations must occur in order",
          );
          previousCommand = commandIndex;
          const call = trace.calls.find(
            (entry) =>
              entry.id === command.id &&
              entry.name === "bash" &&
              entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:call`,
          );
          const result = trace.results.find(
            (entry) =>
              entry.toolCallId === command.id &&
              entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:result`,
          );
          assert.ok(call && result && result.seq > call.seq, `${operation} must be mirrored`);
          if (operation === "push") {
            assert.equal(command.status, "failed");
            assert.ok(
              Number.isInteger(command.exitCode) && command.exitCode !== 0,
              "the read-only push must fail",
            );
            assert.equal(command.http400, true, "the broker must reject receive-pack discovery");
          } else {
            assert.equal(command.status, "completed");
            assert.equal(command.exitCode, 0, `${operation} must succeed`);
            if (operation === "readBase") {
              assert.ok(command.commitShas.includes(baseSha));
            }
          }
        }
        assert.equal(branchResponse.status, 404, "the denied push must not create a remote ref");
        assert.equal(taskFailure, undefined, "the task transport must complete");
        await f.record("Sandboxed read-only Agent fetched and its push was denied", {
          agentId: agent.id,
          revisionId: revision.id,
          sessionId: attempt.sessionId,
          baseSha,
          branch,
          seccompProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
        });
      } else {
        assert.equal(branchResponse.status, 200, "model task must push its branch");
        const commitSha = branchResponse.data.object.sha;
        const { data: commit } = await observe("GET", `commits/${commitSha}`);
        assert.deepEqual(
          commit.parents.map((p) => p.sha),
          [baseSha],
        );
        assert.deepEqual(
          commit.files.map((value) => ({ filename: value.filename, status: value.status })),
          [{ filename: file, status: "added" }],
        );
        const { data: remoteFile } = await observe("GET", `contents/${file}?ref=${commitSha}`);
        assert.equal(Buffer.from(remoteFile.content, "base64").toString("utf8"), content);
        const { data: pulls } = await observe(
          "GET",
          `pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
        );
        assert.equal(pulls.length, 1);
        const pull = pulls[0];
        assert.equal(pull.head.repo.id, Number(app.repositoryId));
        assert.equal(pull.head.ref, branch);
        assert.equal(pull.head.sha, commitSha);
        assert.equal(pull.base.repo.id, Number(app.repositoryId));
        assert.equal(pull.base.ref, base);
        assert.equal(pull.body, marker);
        assert.equal(pull.state, "open");
        assert.equal(pull.draft, false);
        assert.equal(trace.exists, true);
        if (!dedicated) {
          assert.equal(trace.promptReportSource, "run");
          assert.ok(trace.promptToolNames.includes("exec"));
        }
        assert.equal(trace.userMarkerSeen, true);
        assert.equal(trace.assistantMarkerSeen, true);
        assert.equal(trace.terminalAssistantMarkerSeen, true);
        assert.equal(trace.assistantError, false);
        let paired = trace.calls
          .filter((call) => call.name === "exec")
          .map((call) => ({ ...call, completion: completedToolResult(trace, call) }))
          .filter((call) => call.completion);
        if (dedicated) {
          assert.equal(nativeTrace.status, "completed");
          const mirroredTurn = trace.codexTurns.find(
            ({ turnPrefix }) => turnPrefix === nativeTrace.turnId,
          );
          assert.ok(
            mirroredTurn?.promptSeen &&
              mirroredTurn.terminalAssistantSeen &&
              mirroredTurn.toolCallMirrorSeen &&
              mirroredTurn.toolResultMirrorSeen,
            "native repository commands must belong to the Gateway's mirrored task turn",
          );
          paired = nativeTrace.commands
            .filter((command) => command.status === "completed" && command.exitCode === 0)
            .map((command) => {
              const call = trace.calls.find(
                (call) =>
                  call.id === command.id &&
                  call.name === "bash" &&
                  call.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:call`,
              );
              const result = trace.results.find(
                (result) =>
                  result.toolCallId === command.id &&
                  !result.isError &&
                  result.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:result`,
              );
              assert.ok(
                call && result && result.seq > call.seq,
                "native completion must have the same mirrored command call and result",
              );
              return { id: command.id, operations: command.operations, completion: command };
            });
        }
        for (const { operation } of commandSpecs) {
          assert.ok(
            paired.some((call) => call.operations.includes(operation)),
            `successful standalone tool trace must account for ${operation}`,
          );
        }
        assert.ok(
          paired.some(
            (call) =>
              call.operations.includes("readBase") && call.completion.commitShas.includes(baseSha),
          ),
          "a successful read identifies the independently observed base",
        );
        assert.ok(
          paired.some(
            (call) =>
              call.operations.includes("readCommit") &&
              call.completion.commitShas.includes(commitSha),
          ),
          "the successful git rev-parse HEAD result must identify the independently observed commit",
        );
        const expectedPullUrl = `https://github.com/${remote.full_name}/pull/${pull.number}`;
        assert.equal(pull.html_url, expectedPullUrl);
        assert.ok(
          paired.some(
            (call) =>
              call.operations.includes("nativePr") &&
              call.completion.pullUrls.includes(expectedPullUrl),
          ),
          "the successful native gh pr create result must identify this authorized repository PR",
        );
        assert.equal(
          taskFailure,
          undefined,
          "task transport failed despite reconciled remote outcome",
        );
        await f.record("Model tools and independent provider readback agree", {
          sessionKey,
          taskSessionId: trace.sessionId,
          agentId: agent.id,
          revisionId: revision.id,
          podUid: gateway.metadata.uid,
          credentialSessionId: attempt.sessionId,
          commitSha,
          baseSha,
          branch,
          file,
          pullNumber: pull.number,
          toolCallIds: paired.map((call) => call.id),
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
            const disposed = await readInstalledCredentialSession(f, workerPod, attempt.sessionId);
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
        cleanupFailures.push("remote reconciliation requires an independent operator");
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
