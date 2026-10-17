import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const proofPrefix = "OCE_NATIVE_FIRST_AGENT_PROOF ";
export const nativeFirstAgentProofTimeout = 10 * 60_000;

const workStatuses = ["queued", "running", "succeeded", "failed"];
const provisioningPhases = ["admitted", "configuration", "transport", "handoff"];
// A narrow subset of deploymentProgressForWork's public codes; never print arbitrary peer text.
const deploymentProgressCodes = new Set([
  "REVISION_INCOMPLETE",
  "REVISION_UNSCHEDULABLE",
  "WORKSPACE_NODE_PENDING",
  "WORKSPACE_NODE_BINDING_PENDING",
  "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
  "LEASE_EXPIRED",
]);

const hasIdentifier = (value) => typeof value === "string" && value.length > 0;
const observedStatus = (status) => (workStatuses.includes(status) ? status : "unknown");
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isResourceId = (value, prefix) =>
  typeof value === "string" &&
  value.startsWith(`${prefix}_`) &&
  uuidV4.test(value.slice(prefix.length + 1));

export function nativeProvisioningPath(namespaceId, provisioning) {
  const workId = provisioning?.workId;
  assert.ok(
    isResourceId(namespaceId, "ns") &&
      typeof workId === "string" &&
      /^[A-Za-z0-9._~:@/-]{1,200}$/.test(workId) &&
      workId !== "." &&
      workId !== "..",
    "Guided native provisioning returned an invalid binding",
  );
  const path = `/namespaces/${namespaceId}/agents/provision/${encodeURIComponent(workId)}`;
  assert.ok(provisioning.url === path, "Guided native provisioning returned an invalid binding");
  return path;
}

function observedProvisioning(provisioning) {
  return {
    status: observedStatus(provisioning?.status),
    phase: provisioningPhases.includes(provisioning?.phase) ? provisioning.phase : "unknown",
    attemptCount:
      Number.isSafeInteger(provisioning?.attemptCount) && provisioning.attemptCount >= 0
        ? provisioning.attemptCount
        : "unknown",
    agentIdPresent: hasIdentifier(provisioning?.agentId),
    configurationIdPresent: hasIdentifier(provisioning?.configurationId),
    revisionIdPresent: hasIdentifier(provisioning?.revisionId),
  };
}

// Kubernetes reports non-terminating Pods for both roles of this dedicated revision.
// Zero means none in that observation, not that the Harness was never created.
function observedPodReadiness(runtime, revisionId) {
  if (runtime?.revisionId !== revisionId || !Array.isArray(runtime.pods)) {
    return "unavailable";
  }
  const summary = { gateway: { count: "zero" }, agent: { count: "zero" } };
  for (const pod of runtime.pods) {
    const { role, phase, ready } = pod ?? {};
    if (
      (role !== "gateway" && role !== "agent") ||
      !["Pending", "Running", "Succeeded", "Failed", "Unknown"].includes(phase) ||
      typeof ready !== "boolean"
    ) {
      return "unavailable";
    }
    summary[role] =
      summary[role].count === "zero" ? { count: "one", phase, ready } : { count: "multiple" };
  }
  return summary;
}

// The runtime wrapper's fixed event names; the sanitizer keeps only these as `wrapper` lines.
const wrapperEvents = new Set([
  "runtime.startup_phase",
  "openclaw.model_probe",
  "codex.model_probe",
  "runtime.workspace_node",
  "runtime.gateway_settings_overridden",
]);
const fixedToken = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const token = (value) => (typeof value === "string" && fixedToken.test(value) ? value : "unknown");

// Counts of one log source's recent records, the runtime wrapper's events with their fixed
// fields (the `agent` container source) and the Sandbox's policy decisions by action and
// rule type (the `sandbox` source). Never arbitrary text: a message is printed only when
// it is a known event name, and every other value is a closed-vocabulary token or a count.
export function observedRuntimeOutput(logs, revisionId, source) {
  if (logs?.revisionId !== revisionId || logs.source !== source || !Array.isArray(logs.records)) {
    return "unavailable";
  }
  const counts = { line: 0, withheld: 0, gap: 0, other: 0 };
  const levels = {};
  const decisions = {};
  const events = [];
  for (const record of logs.records) {
    const type = ["line", "withheld", "gap"].includes(record?.type) ? record.type : "other";
    counts[type] += 1;
    if (type !== "line") {
      continue;
    }
    const level = token(record.level);
    levels[level] = (levels[level] ?? 0) + 1;
    const fields = record.fields ?? {};
    if (record.kind === "sandbox" && typeof fields.action === "string") {
      const decision = `${token(fields.action)}:${token(fields.rule_type ?? "none")}:${token(fields.source ?? "none")}`;
      decisions[decision] = (decisions[decision] ?? 0) + 1;
    }
    if (record.kind !== "wrapper" || !wrapperEvents.has(record.message)) {
      continue;
    }
    events.push({
      time: typeof record.time === "string" ? record.time : null,
      event: record.message,
      ...(fields.phase === undefined ? {} : { phase: token(fields.phase) }),
      ...(fields.outcome === undefined ? {} : { outcome: token(fields.outcome) }),
      ...(fields.code === undefined ? {} : { code: token(fields.code) }),
      ...(Number.isSafeInteger(fields.elapsedMs) ? { elapsedMs: fields.elapsedMs } : {}),
    });
  }
  return {
    records: counts,
    levels,
    truncated: logs.truncated === true,
    ...(Object.keys(decisions).length === 0 ? {} : { decisions }),
    events: events.slice(-40),
  };
}

export async function failNativeProvisioningDeadline({
  request,
  provisioningPath,
  provisioned,
  namespaceId,
  signal,
}) {
  const observation = { provisioning: observedProvisioning(provisioned) };
  if (observation.provisioning.agentIdPresent && observation.provisioning.revisionIdPresent) {
    observation.deployment = "unavailable";
    try {
      assert.ok(
        isResourceId(provisioned.agentId, "agt") &&
          isResourceId(provisioned.revisionId, "rev") &&
          nativeProvisioningPath(namespaceId, provisioned) === provisioningPath,
        "Guided native provisioning returned an invalid binding",
      );
      const diagnosticSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const deploymentPath = `/namespaces/${namespaceId}/agents/${provisioned.agentId}/deployments/${provisioned.revisionId}`;
      const deployment = await request("GET", deploymentPath, undefined, diagnosticSignal);
      if (
        deployment?.namespaceId === namespaceId &&
        deployment.agentId === provisioned.agentId &&
        deployment.deploymentId === provisioned.revisionId
      ) {
        const code = deployment.progress?.lastAttempt?.code;
        observation.deployment = {
          status: observedStatus(deployment.status),
          lastAttemptCode: deploymentProgressCodes.has(code) ? code : "unknown",
        };
        if (
          ["queued", "running"].includes(provisioned.status) &&
          ["succeeded", "failed"].includes(deployment.status)
        ) {
          observation.provisioningAfterDeployment = "unavailable";
          const after = await request("GET", provisioningPath, undefined, diagnosticSignal);
          if (nativeProvisioningPath(namespaceId, after) === provisioningPath) {
            observation.provisioningAfterDeployment = observedProvisioning(after);
          }
        } else if (
          provisioned.phase === "handoff" &&
          ["queued", "running"].includes(provisioned.status) &&
          ["queued", "running"].includes(deployment.status) &&
          (code === "REVISION_INCOMPLETE" || code === "WORKSPACE_NODE_PENDING")
        ) {
          observation.runtimeAfterDeadline = "unavailable";
          const runtime = await request(
            "GET",
            `${deploymentPath}/runtime`,
            undefined,
            diagnosticSignal,
          );
          observation.runtimeAfterDeadline = observedPodReadiness(runtime, provisioned.revisionId);
          // Recent runtime output says whether the native worker started, how its model
          // probe ended and whether the Sandbox let it reach the Gateway (finding 1629).
          // Each source is an extra: its absence must not hide the readiness observation.
          observation.runtimeOutput = {};
          for (const source of ["agent", "sandbox"]) {
            observation.runtimeOutput[source] = "unavailable";
            try {
              const logs = await request(
                "GET",
                `${deploymentPath}/runtime/logs?source=${source}&tailLines=1000`,
                undefined,
                AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
              );
              observation.runtimeOutput[source] = observedRuntimeOutput(
                logs,
                provisioned.revisionId,
                source,
              );
            } catch {
              // Reported as unavailable.
            }
          }
        }
      }
    } catch {
      // Diagnostic failures cannot replace the deadline failure or reveal peer errors.
    }
  }
  assert.fail(
    `Guided native provisioning did not become ready before the deadline: ${JSON.stringify(observation)}`,
  );
}

// Run in the existing trusted controller: it already has the private route key,
// cluster DNS and CA. Native admin sign-in is neither enabled nor required.
async function nativeWorkerProof({
  namespaceId,
  agentId,
  timeout,
  workspaceFile,
  session: existingSession,
  sessionFile: retainedSessionFile,
}) {
  const assert = (await import("node:assert/strict")).default;
  const { createHash, randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(resolve("apps/controller/package.json"));
  const { GatewayClient } = await import(
    pathToFileURL(require.resolve("@openclaw/gateway-client"))
  );
  const { loadYaml } = await import(pathToFileURL(require.resolve("@kubernetes/client-node")));
  let stage = "startup";
  let client;
  let helloTimer;
  const emit = (data) =>
    process.stdout.write("OCE_NATIVE_FIRST_AGENT_PROOF " + JSON.stringify(data) + "\n");
  try {
    const startup = loadYaml(await readFile(process.env.OCC_CONFIG_PATH, "utf8"));
    assert.equal(startup.runtime?.nativeWorkerSupport, undefined);
    assert.equal(startup.occ?.runtime?.nativeWorkerSupport, undefined);
    const routing = startup.drivers.compute.configuration.gatewayRouting;
    assert.ok(routing.hostname, "The selected OpenShell route must advertise its hostname");
    assert.ok(!routing.hostname.includes("*"), "Local Setup must provide one literal Gateway host");
    const authority =
      routing.endpointPort && routing.endpointPort !== 443
        ? `${routing.hostname}:${routing.endpointPort}`
        : routing.hostname;
    const apiKey = await readFile(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8");
    assert.ok(apiKey && /^[\x21-\x7e]+$/.test(apiKey));
    const connected = Promise.withResolvers();
    const signal = AbortSignal.timeout(timeout);
    client = new GatewayClient({
      url: `wss://${authority}/namespaces/${namespaceId}/agents/${agentId}`,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: [],
      deviceIdentity: null,
      minProtocol: 4,
      maxProtocol: 4,
      edgeAuthHeaders: { "x-api-key": apiKey },
      onHelloOk: connected.resolve,
      onConnectError: connected.reject,
    });
    const call = (method, params) => client.request(method, params, { signal, timeoutMs: 30_000 });
    helloTimer = setTimeout(() => connected.reject(new Error("Gateway hello timeout")), 15_000);
    stage = "connect";
    client.start();
    const hello = await connected.promise;
    clearTimeout(helloTimer);
    assert.equal(hello.auth.role, "operator");
    assert.ok(hello.auth.scopes.includes("operator.admin"));
    assert.equal(hello.auth.deviceToken, undefined);
    const agents = await call("agents.list", { includeSessionPlacement: true });
    const required = agents.sessionPlacement?.requiredProfile;
    assert.ok(required?.id && required.providerId);
    assert.equal(required.inference, "worker");
    assert.ok(required.executionModes.includes("worker-turn"));
    let session = existingSession;
    if (session === undefined) {
      stage = "create";
      const key = `agent:main:first-agent-native-${randomUUID()}`;
      const created = await call("sessions.create", {
        key,
        agentId: "main",
        message: "",
        displayName: "First Agent native worker proof",
        worktree: true,
        worktreeSource: "empty",
      });
      assert.equal(created.key, key);
      session = { key, sessionId: created.sessionId };
      stage = "required-placement";
      while (!signal.aborted) {
        const described = await call("sessions.describe", { key, agentId: "main" });
        if (described.session?.placement?.state === "active") {
          break;
        }
        assert.ok(!["failed", "reclaimed", "local"].includes(described.session?.placement?.state));
        await delay(500, undefined, { signal });
      }
      signal.throwIfAborted();
    }
    assert.ok(session.key && session.sessionId);
    const { key } = session;
    stage = "session-identity";
    const described = await call("sessions.describe", { key, agentId: "main" });
    assert.equal(described.session?.sessionId, session.sessionId);
    // A retained placement may recover when the next turn is sent. Check its
    // current directory after that turn, rather than trusting the old owner.
    const sessionFileContent = `FIRST_AGENT_SESSION_${randomUUID()}\n`;
    const sessionFile =
      existingSession === undefined
        ? {
            path: `.first-agent-native-${randomUUID()}.txt`,
            sha256: createHash("sha256").update(sessionFileContent).digest("hex"),
          }
        : retainedSessionFile;
    assert.match(sessionFile?.path ?? "", /^\.first-agent-native-[a-z0-9-]+\.txt$/);
    assert.match(sessionFile.sha256, /^[a-f0-9]{64}$/);
    const marker = `FIRST_AGENT_NATIVE_${randomUUID()}`;
    const toolPrefix = "FIRST_AGENT_NATIVE_TOOL ";
    const program = [
      ...(existingSession === undefined
        ? [
            `require("node:fs").writeFileSync(${JSON.stringify(sessionFile.path)},${JSON.stringify(sessionFileContent)},{flag:"wx"});`,
          ]
        : []),
      `process.stdout.write(${JSON.stringify(toolPrefix)} + JSON.stringify({`,
      'hostname:require("node:os").hostname(),',
      'cwd:process.cwd(),modelCredentialPresent:Object.hasOwn(process.env,"OPENAI_API_KEY")||Object.hasOwn(process.env,"CODEX_ACCESS_TOKEN"),',
      `sessionFileSha256:require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(${JSON.stringify(sessionFile.path)})).digest("hex"),`,
      ...(workspaceFile === undefined
        ? []
        : [
            `workspaceFileSha256:require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(${JSON.stringify(workspaceFile.path)})).digest("hex"),`,
          ]),
      '}) + "\\n")',
    ].join("");
    const command = `node -e '${program.replaceAll("'", "'\\''")}'`;
    stage = "send";
    const sent = await call("sessions.send", {
      key,
      agentId: "main",
      idempotencyKey: randomUUID(),
      message: `Use exec to run exactly this command: ${command}. After exec succeeds, reply with exactly ${marker}. Do not print environment values or credentials.`,
    });
    assert.ok(sent.runId);
    assert.ok(!["error", "timeout"].includes(sent.status));
    stage = "model-and-exec";
    let outcome;
    while (!signal.aborted) {
      outcome = await call("agent.wait", { runId: sent.runId, timeoutMs: 3_000 });
      if (["ok", "error"].includes(outcome.status) || outcome.endedAt !== undefined) {
        break;
      }
    }
    signal.throwIfAborted();
    assert.equal(outcome.status, "ok");
    const text = (content) =>
      typeof content === "string"
        ? content
        : (content ?? [])
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n");
    while (!signal.aborted) {
      const history = await call("chat.history", { sessionKey: key, limit: 30 });
      const messages = (history.messages ?? []).filter(
        (message) => message.__openclaw?.runId === sent.runId,
      );
      const tool = messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "exec" &&
          message.isError === false &&
          text(message.content).includes(toolPrefix),
      );
      const final = messages.find(
        (message) =>
          message.role === "assistant" &&
          text(message.content).trim() === marker &&
          !["toolUse", "error"].includes(message.stopReason) &&
          !(
            Array.isArray(message.content) &&
            message.content.some((part) => part?.type === "toolCall")
          ),
      );
      if (tool && final) {
        let output = text(tool.content);
        try {
          const result = JSON.parse(output);
          if (typeof result?.value?.aggregated === "string") {
            output = result.value.aggregated;
          }
        } catch {
          // Plain exec output already has the diagnostic line.
        }
        const line = output.split(/\r?\n/).find((line) => line.startsWith(toolPrefix));
        assert.ok(line);
        const proof = JSON.parse(line.slice(toolPrefix.length));
        assert.ok(typeof proof.hostname === "string" && proof.hostname.length > 0);
        stage = "current-placement";
        const current = await call("sessions.describe", { key, agentId: "main" });
        assert.equal(current.session?.sessionId, session.sessionId);
        const placement = current.session?.placement;
        assert.equal(placement?.state, "active");
        assert.equal(placement.profileId, required.id);
        assert.equal(placement.providerId, required.providerId);
        assert.equal(placement.inference, "worker");
        assert.ok(placement.environmentId && placement.remoteWorkspaceDir);
        assert.equal(proof.cwd, placement.remoteWorkspaceDir);
        assert.equal(proof.modelCredentialPresent, false);
        assert.equal(proof.sessionFileSha256, sessionFile.sha256);
        if (workspaceFile !== undefined) {
          assert.equal(
            proof.workspaceFileSha256,
            createHash("sha256").update(workspaceFile.content).digest("hex"),
          );
        }
        emit({
          verified: true,
          profileId: required.id,
          providerId: required.providerId,
          environmentId: placement.environmentId,
          hostname: proof.hostname,
          session,
          sessionFile,
        });
        return;
      }
      assert.ok(
        !messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
      );
      await delay(500, undefined, { signal });
    }
    signal.throwIfAborted();
  } catch {
    // Dependency/RPC errors can include private headers. Preserve the failing
    // stage, never raw exceptions, keys, transcripts or controller output.
    emit({ verified: false, stage });
    process.exitCode = 1;
  } finally {
    clearTimeout(helloTimer);
    client?.stop();
    await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

export async function assertNativeWorkerProofInController(
  context,
  { stateDirectory, state, environment, namespaceId, agentId, workspaceFile, session, sessionFile },
) {
  context.signal.throwIfAborted();
  const safeEnvironment = {
    ...environment,
    COMPOSE_DISABLE_ENV_FILE: "1",
    DOCKER_HOST: state.dockerHost,
  };
  delete safeEnvironment.OPENAI_API_KEY;
  delete safeEnvironment.OPENAI_API_KEY_FILE;
  delete safeEnvironment.CODEX_ACCESS_TOKEN;
  delete safeEnvironment.CODEX_ACCESS_TOKEN_FILE;
  const input = `await (${nativeWorkerProof.toString()})(${JSON.stringify({ namespaceId, agentId, timeout: nativeFirstAgentProofTimeout, workspaceFile, session, sessionFile })});`;
  const command = state.deploymentMode === "k3d" ? "kubectl" : state.containerEngine;
  const args =
    state.deploymentMode === "k3d"
      ? [
          "--kubeconfig",
          join(stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${state.cluster}`,
          "exec",
          "-i",
          "--namespace",
          state.platformNamespace,
          "deployment/openclaw-enterprise-api",
          "-c",
          "api",
          "--",
          "node",
          "--input-type=module",
          "-",
        ]
      : [
          "compose",
          "--project-directory",
          state.repository,
          "--project-name",
          state.composeProject,
          "-f",
          join(stateDirectory, "compose.yaml"),
          "exec",
          "-T",
          "controller",
          "node",
          "--input-type=module",
          "-",
        ];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: safeEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-16_384);
    });
    child.stderr.resume();
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, nativeFirstAgentProofTimeout + 30_000);
    context.signal.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.once("error", () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", stop);
      reject(new Error("Could not start the native first-Agent proof in the selected controller"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", stop);
      const line = output.split(/\r?\n/).find((line) => line.startsWith(proofPrefix));
      try {
        resolve({ code, proof: line ? JSON.parse(line.slice(proofPrefix.length)) : undefined });
      } catch {
        reject(new Error("The native first-Agent proof returned invalid evidence"));
      }
    });
  });
  assert.equal(
    result.code,
    0,
    `Native first-Agent proof failed during ${result.proof?.stage ?? "controller startup"}; raw output withheld`,
  );
  assert.equal(result.proof?.verified, true);
  assert.ok(result.proof.profileId && result.proof.providerId && result.proof.environmentId);
  assert.ok(typeof result.proof.hostname === "string" && result.proof.hostname.length > 0);
  assert.ok(result.proof.session?.key && result.proof.session.sessionId);
  assert.ok(result.proof.sessionFile?.path && result.proof.sessionFile.sha256);
  return result.proof;
}
