import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import {
  assertConnectedResponse,
  serializeConnectedRequest,
  sendConnectedRequest,
  validateConnectedDatabaseUrl,
} from "./egress-connected-inputs.mjs";
import { codexRepositoryEvidenceScript } from "./normal-agent-tools.mjs";

const exec = promisify(execFile);
export async function waitFor(description, observe, timeout = 120_000) {
  const end = Date.now() + timeout;
  do {
    const value = await observe();
    if (value) {
      return value;
    }
    await delay(500);
  } while (Date.now() < end);
  assert.fail("timed out: " + description);
}

/** Operate only the supplied fresh, local Compute installation and its synthetic model. */
export async function prepareComputeSkipper(t, inputPath, repositoryRef) {
  // Keep the controller key in this client, never in the environment inherited by Git or kubectl.
  const serviceKey = process.env.OCC_TEST_SKIPPER_COMPUTE_SERVICE_KEY;
  delete process.env.OCC_TEST_SKIPPER_COMPUTE_SERVICE_KEY;
  assert.ok(serviceKey && !/\s/.test(serviceKey));
  const input = JSON.parse(await readFile(inputPath));
  const {
    apiOrigin,
    namespaceId,
    system,
    kubeconfig,
    context,
    clusterUID,
    modelDirectory,
    modelContainer,
    directory,
  } = input;
  assert.equal(input.topology, "compute-owned-prepared-private-git");
  assert.match(apiOrigin, /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
  assert.match(namespaceId, /^ns_[A-Za-z0-9_-]+$/);
  assert.match(context, /^k3d-occ-dev-skipper-[a-f0-9]{12}$/);
  assert.equal(modelContainer, "oce-first-agent-smoke-model");
  assert.match(clusterUID, /^[a-f0-9-]{36}$/);
  assert.equal(input.sourceCommit, (await exec("git", ["rev-parse", "HEAD"])).stdout.trim());
  const kc = async (...args) =>
    (
      await exec("kubectl", ["--kubeconfig", kubeconfig, "--context", context, ...args], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 240_000,
      })
    ).stdout;
  const resource = async (...args) => JSON.parse(await kc("get", ...args, "-o", "json"));
  const uid = async () => (await resource("namespace", "kube-system")).metadata.uid;
  // Use occ dev up's actual context, never an alias or the runner's default cluster.
  const binding = JSON.parse(await kc("config", "view", "--minify", "-o", "json"));
  assert.equal(binding["current-context"], context);
  assert.equal(binding.contexts[0].context.cluster, context);
  assert.equal(binding.clusters[0].name, context);
  assert.equal(binding.clusters[0].cluster.server, input.kubernetesServer);
  assert.match(input.kubernetesServer, /^https:\/\/127\.0\.0\.1:\d{4,5}$/);
  assert.equal(await uid(), clusterUID);
  const nodes = (await resource("nodes")).items.map((n) => n.metadata.name);
  assert.deepEqual(nodes, [context + "-server-0"]);
  const api = async (method, path, body, status = 200) => {
    const wire = serializeConnectedRequest(method, path, body);
    const response = await sendConnectedRequest(
      { apiOrigin, serviceKey },
      wire,
      AbortSignal.timeout(20_000),
    );
    return assertConnectedResponse(
      { status: response.status, body: await response.json() },
      status,
    );
  };
  const pool = new pg.Pool({
    connectionString: validateConnectedDatabaseUrl(process.env.OCC_TEST_DATABASE_URL),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const inst = await api("GET", "/installation");
  assert.equal(inst.id, (await pool.query("SELECT id FROM occ.installation")).rows[0].id);
  const { items: nss } = await resource(
    "namespaces",
    "-l",
    "openclaw.dev/namespace=" + namespaceId,
  );
  assert.ok(nss.length > 0, "the accepted OCC Namespace must have live Kubernetes placement");
  const brokerIngress = async () =>
    (
      await resource(
        "networkpolicy",
        "openclaw-enterprise-prepared-repository-ingress",
        "-n",
        system,
      )
    ).spec.ingress ?? [];
  assert.deepEqual(
    await brokerIngress(),
    [],
    "this fresh installation must start with broker ingress closed",
  );
  const ledger = join(directory, "compute-journey.jsonl");
  const checkpoint = (phase, data = {}) =>
    writeFile(ledger, JSON.stringify({ phase, time: new Date().toISOString(), ...data }) + "\n", {
      flag: "a",
      mode: 0o600,
      flush: true,
    });
  const root = "/namespaces/" + namespaceId;
  const create = (p, b) => api("POST", root + "/" + p, b, 201);
  const id = randomUUID();
  await checkpoint("create-synthetic-model-secret", {
    source: input.sourceCommit,
    clusterUID,
    topology: input.topology,
  });
  const secret = await create("secrets", {
    name: "skipper-compute-model-" + id,
    value: "sk-synthetic-qualification-" + id,
  });
  const values = createHarnessConfiguration("codex", defaultAgentModel);
  values.agents.defaults.workspace = "/home/node/workspace";
  Object.assign(values.plugins.entries.codex.config.appServer, {
    approvalPolicy: "never",
    sandbox: "workspace-write",
    remoteWorkspaceRoot: "/home/node/workspace",
  });
  const config = await create("configurations", { kind: "agent", values });
  const agent = await create("agents", {
    name: "skipper-compute-" + id,
    configurationId: config.id,
    executionMode: "dedicated",
    harnessAuth: { method: "api_key", source: secret.ref },
    repositoryBindings: [{ repositoryRef, profile: "git-write" }],
  });
  const agentPath = root + "/agents/" + agent.id;
  const query = (text, params) => pool.query(text, params);
  const pods = () => resource("pods", "-A", "-l", "openclaw.dev/agent=" + agent.id);
  t.after(async () => {
    assert.equal(await uid(), clusterUID);
    await checkpoint("owned-agent-delete-started", { agentId: agent.id });
    await api("DELETE", agentPath, undefined, 202);
    await waitFor(
      "owned Agent pods and open repository sessions retired",
      async () => {
        const { items } = await pods();
        const { rows } = await query(
          "SELECT phase FROM occ.repository_session_attempts WHERE namespace_id=$1 AND agent_id=$2 AND phase IN ('opening','open','closing')",
          [namespaceId, agent.id],
        );
        return !items.length && !rows.length;
      },
      300_000,
    );
    await waitFor(
      "the owned revision broker ingress peer removed",
      async () => (await brokerIngress()).length === 0,
    );
    await checkpoint("owned-agent-retired-cluster-cleanup-still-required");
  });
  // node:test runs after hooks in registration order: the session read above needs this pool.
  t.after(() => pool.end());
  const role = await create("iam/roles", {
    name: "skipper-compute-model-" + id,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await create("iam/access-bindings", {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secret.id,
  });
  const runtime = await api("GET", agentPath + "/runtime-credentials");
  if (!runtime.transportConfigured) {
    await api("POST", agentPath + "/runtime-credentials", {});
  }
  await checkpoint("deploy-request-started", { agentId: agent.id });
  const revision = await api("POST", agentPath + "/deploy", undefined, 202);
  assert.equal(revision.harness.mode, "dedicated");
  assert.equal(revision.harness.id, "codex");
  assert.equal(revision.sandboxDriverId, undefined);
  assert.deepEqual(revision.repositoryCredentials.bindings, [
    { repositoryRef, profile: "git-write" },
  ]);
  const deploymentPath = agentPath + "/deployments/" + revision.id;
  await waitFor(
    "the admitted Compute-owned deployment to succeed with its revision active",
    async () => {
      const deployment = await api("GET", deploymentPath);
      assert.notEqual(deployment.status, "failed", "Compute deployment failed");
      if (deployment.status !== "succeeded") {
        return false;
      }
      const current = await api("GET", agentPath);
      return current.activeRevisionId === revision.id && current.desiredRuntimeState === "running";
    },
    720_000,
  );
  const hash = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);
  const configMap = "gateway-" + hash(agent.id) + "-rev-" + hash(revision.id);
  const select = async () => {
    const entries = (await pods()).items;
    const p = (role) => {
      const found = entries.filter(
        ({ metadata: m }) =>
          !m.deletionTimestamp && m.labels["openclaw.dev/workload-role"] === role,
      );
      assert.equal(found.length, 1, "exactly one " + role + " for the dedicated Agent");
      const pod = found[0];
      assert.ok(pod.status.conditions.some((c) => c.type === "Ready" && c.status === "True"));
      if (role === "gateway") {
        assert.ok(pod.spec.volumes.some((v) => v.configMap?.name === configMap));
        assert.equal(
          pod.spec.containers.find((c) => c.name === "gateway").image,
          input.runtimeImage,
        );
      } else {
        assert.equal(pod.metadata.labels["openclaw.dev/revision"], revision.id);
      }
      return pod;
    };
    return { gateway: p("gateway"), harness: p("agent") };
  };
  const { gateway, harness } = await select();
  assert.ok(
    nss.some((n) => n.metadata.name === harness.metadata.namespace),
    "the Agent belongs to the bound tenant placement",
  );
  const hc = harness.spec.containers.find((c) => c.name === "agent");
  assert.equal(hc.image, input.runtimeImage);
  for (const name of ["prepare-repository-material", "prepare-repository-native-git"]) {
    assert.equal(harness.spec.initContainers.find((c) => c.name === name)?.image, hc.image, name);
  }
  assert.equal(harness.spec.securityContext.runAsNonRoot, true);
  assert.equal(hc.securityContext.allowPrivilegeEscalation, false);
  const seccomp = hc.securityContext.seccompProfile ?? harness.spec.securityContext.seccompProfile;
  assert.deepEqual(
    seccomp,
    input.codexSeccompProfile === null
      ? { type: "RuntimeDefault" }
      : { type: "Localhost", localhostProfile: input.codexSeccompProfile },
  );
  assert.notEqual(harness.spec.serviceAccountName, gateway.spec.serviceAccountName);
  assert.doesNotMatch(
    JSON.stringify(harness.spec),
    /occ-repository-app|prepared-repository|custody\.key|private-key\.pem|openshell/i,
  );
  assert.ok(
    hc.volumeMounts.some((m) => m.mountPath === "/run/oce/repository-credentials" && m.readOnly),
  );
  assert.ok(
    hc.env.some(
      (e) => e.name === "PATH" && e.value?.startsWith("/opt/oce/repository-credentials/bin:"),
    ),
  );
  assert.ok(
    !hc.env.some((e) =>
      ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
        e.name,
      ),
    ),
  );
  const peer = (
    await resource("networkpolicy", "openclaw-enterprise-prepared-repository-ingress", "-n", system)
  ).spec.ingress;
  assert.equal(peer?.length, 1, "fresh installation must grant only the admitted Compute peer");
  assert.equal(peer[0].from.length, 1);
  const labels = peer[0].from[0].podSelector.matchLabels;
  assert.ok(
    Object.values(labels).includes(revision.id),
    "the broker peer must be bound to this revision",
  );
  for (const [key, value] of Object.entries(labels)) {
    assert.equal(harness.metadata.labels[key], value);
  }
  assert.equal(peer[0].ports[0].port, 8443);
  assert.equal(labels["openclaw.dev/workload-role"], "agent");
  assert.equal(labels["openclaw.dev/agent"], agent.id);
  assert.equal(labels["openclaw.dev/namespace"], namespaceId);
  assert.equal(labels["openclaw.dev/service-principal"], agent.servicePrincipalId);
  assert.equal(labels["openclaw.dev/revision"], revision.id);
  assert.equal(
    peer[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
    harness.metadata.namespace,
  );
  const stable = async () => {
    const live = await select();
    assert.equal(live.harness.metadata.uid, harness.metadata.uid);
    assert.equal(live.gateway.metadata.uid, gateway.metadata.uid);
    assert.deepEqual(
      live.harness.status.containerStatuses.map((c) => c.containerID),
      harness.status.containerStatuses.map((c) => c.containerID),
    );
    assert.equal((await api("GET", agentPath)).activeRevisionId, revision.id);
  };
  const enter = (...args) =>
    kc(
      "exec",
      gateway.metadata.name,
      "-n",
      gateway.metadata.namespace,
      "-c",
      "gateway",
      "--",
      ...args,
    );
  // The prepared-repository thread profile includes these two read-only paths even when no
  // plugins are selected. Observe the actual Agent as its normal UID, without reading any file.
  await checkpoint("observe-installed-agent-readonly-skill-directories");
  const skillPaths = await kc(
    "exec",
    harness.metadata.name,
    "-n",
    harness.metadata.namespace,
    "-c",
    "agent",
    "--",
    "node",
    "-e",
    `
      const {accessSync, constants, realpathSync, statSync} = require("node:fs");
      const root = "/home/node/openclaw-runtime-assets/plugin-skills";
      const alias = "/home/node/.openclaw/plugin-skills";
      if (process.getuid() === 0 || !statSync(root).isDirectory() || realpathSync(alias) !== realpathSync(root)) {
        throw Error("expected read-only thread skill directory unavailable");
      }
      accessSync(alias, constants.R_OK | constants.X_OK);
      console.log("readable");
    `,
  );
  assert.equal(skillPaths.trim(), "readable");
  await checkpoint("deployed-revision-gateway-and-harness-ready", {
    agentId: agent.id,
    revisionId: revision.id,
    seccomp,
  });
  const chat = async (prompt) => {
    // Readiness isn't a model turn. Record a bounded, content-free failure at the real receiver
    // before cleanup; never replay a turn whose effect might be unknown.
    const before = (await modelEvents()).length;
    const since = new Date().toISOString();
    const text = await enter(
      "node",
      "-e",
      `(${inGateway.toString()})(process.argv[1], process.argv[2])`,
      prompt,
      "agent:main:skipper-acceptance-" + id,
    );
    const { status, category, content } = JSON.parse(text);
    if (status !== 200) {
      const events = (await modelEvents()).slice(before);
      const nonce = prompt.match(/OCE_SMOKE_[a-f0-9-]+/)?.[0];
      // Do not retain runtime logs. An allowlisted signal can distinguish a native thread
      // sandbox failure before the first model request from an observed transport failure.
      const runtimeSignal = await Promise.all(
        [
          [gateway, "gateway"],
          [harness, "agent"],
        ].map(([pod, container]) =>
          kc(
            "logs",
            pod.metadata.name,
            "-n",
            pod.metadata.namespace,
            "-c",
            container,
            "--since-time=" + since,
            "--tail=200",
            "--limit-bytes=65536",
          ),
        ),
      ).then(
        (logs) => {
          const raw = logs.join("\n");
          if (
            /fs sandbox helper|bwrap:.*(?:permission denied|operation not permitted)/i.test(raw)
          ) {
            return "thread-filesystem-sandbox-denied";
          }
          if (/thread\/start|failed to start.*thread/i.test(raw)) {
            return "thread-start";
          }
          if (
            /websocket.*failed|tls.*failed|certificate verify failed|unable to get local issuer/i.test(
              raw,
            )
          ) {
            return "model-transport";
          }
          return "no-known-signal";
        },
        () => "logs-unavailable",
      );
      await checkpoint("gateway-chat-refused", {
        httpStatus: status,
        category,
        runtimeSignal,
        modelTurns: events.filter((e) => e.event === "request" && e.turn).length,
        modelAnswers: events.filter((e) => e.event === "turn-answered").length,
        expectedNonceAnswered: Boolean(
          nonce &&
          events.some((e) => e.event === "turn-answered" && e.status === 200 && e.text === nonce),
        ),
        tlsErrors: events.filter((e) => e.event === "tls-error").length,
      });
      assert.fail("gateway chat did not return 200; content-free status and model counts recorded");
    }
    return content;
  };
  const native = async (marker) => {
    const t = JSON.parse(await enter("node", "-e", codexRepositoryEvidenceScript, marker, "[]"));
    assert.equal(t.status, "completed");
    assert.equal(
      t.commands.length,
      1,
      "exactly one native command on this Agent turn; never replay",
    );
    const [command] = t.commands;
    assert.equal(command.status, "completed");
    assert.equal(command.exitCode, 0, "native command failed on the Agent");
    assert.ok(t.threadId && t.turnId);
    return { ...command, threadId: t.threadId, turnId: t.turnId };
  };
  const modelEvents = async () =>
    (await exec("docker", ["logs", modelContainer], { maxBuffer: 8 * 1024 * 1024 })).stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
  const controlFile = join(modelDirectory, "skipper-command.json");
  const sendScript = async (cmd, label) => {
    const marker = "skipper-" + randomUUID();
    const text = JSON.stringify({ cmd, id: marker });
    await writeFile(controlFile + ".next", text, { mode: 0o644 });
    await chmod(controlFile + ".next", 0o644);
    await rename(controlFile + ".next", controlFile);
    await checkpoint("native-command-started", { label });
    assert.equal(
      await chat("Perform the authorized disposable private Git task " + marker),
      "SKIPPER_COMPUTE_DONE_" + marker,
    );
    const completed = await native(marker);
    const observations = (await modelEvents()).filter((e) => e.id === marker);
    assert.deepEqual(
      observations.map((e) => e.event),
      ["skipper-native-request", "skipper-native-result"],
    );
    assert.equal(observations.at(-1).markerSeen, true);
    await checkpoint("native-command-and-model-observed", {
      label,
      commitShas: completed.commitShas,
      threadId: completed.threadId,
      turnId: completed.turnId,
    });
    await unlink(controlFile);
    return completed;
  };
  async function ordinaryChat(label) {
    const nonce = "OCE_SMOKE_" + randomUUID();
    assert.equal(await chat("Please reply with exactly " + nonce), nonce);
    const matches = (await modelEvents()).filter(
      (e) => e.event === "turn-answered" && e.text === nonce && e.status === 200,
    );
    assert.equal(matches.length, 1, "one actual synthetic provider answer for the ordinary chat");
    await stable();
    await checkpoint(label + "-verified", {
      agent: agent.id,
      revision: revision.id,
      gateway: gateway.metadata.uid,
      harness: harness.metadata.uid,
    });
  }
  return {
    api,
    agentPath,
    revision,
    agent,
    namespaceId,
    query,
    checkpoint,
    stable,
    sendScript,
    ordinaryChat,
  };
}

// Use the installed Agent Gateway, as a user of that Agent would. Never exec Git on the host.
export async function inGateway(prompt, sessionKey) {
  if (!process.env.OPENCLAW_GATEWAY_PASSWORD) {
    process.stdout.write(JSON.stringify({ status: 0, category: "gateway-credential-unavailable" }));
    return;
  }
  const res = await fetch(
    "http://127.0.0.1:" + (process.env.OPENCLAW_GATEWAY_PORT || 8080) + "/v1/chat/completions",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(170_000),
      headers: {
        authorization: "Bearer " + process.env.OPENCLAW_GATEWAY_PASSWORD,
        "content-type": "application/json",
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    },
  );
  const raw = await res.text();
  // Only allowlisted categories can leave the receiver on failure; bodies may carry secrets.
  if (!res.ok) {
    const category =
      [
        [/unauthori[sz]ed|invalid.*password|authentication|invalid.*token/i, "authentication"],
        [/forbidden|permission|scope/i, "permission"],
        [/workspace|eacces|read.only/i, "workspace"],
        [/app.?server|codex|guardian/i, "agent-runtime"],
        [/timeout|timed out|deadline/i, "timeout"],
        [/unavailable|no route|econn|refused/i, "unavailable"],
      ].find(([pattern]) => pattern.test(raw))?.[1] ?? "unclassified";
    process.stdout.write(JSON.stringify({ status: res.status, category }));
    return;
  }
  const body = JSON.parse(raw);
  process.stdout.write(
    JSON.stringify({ status: res.status, content: body?.choices?.[0]?.message?.content }),
  );
}
