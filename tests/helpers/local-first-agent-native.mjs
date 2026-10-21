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
  "REVISION_IMAGE_PULL_FAILED",
  "WORKSPACE_NODE_PENDING",
  "WORKSPACE_NODE_BINDING_PENDING",
  "REPOSITORY_GIT_MATERIAL_PENDING",
  "WORKSPACE_NODE_RECONNECT_PENDING",
  "WORKSPACE_SETUP_RETRYING",
  "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
  "LEASE_EXPIRED",
]);

// The API can return other error codes or peer-supplied text. Report only these public categories.
const runtimeFailureCodes = new Set([
  "RUNTIME_AUTHENTICATION_FAILED",
  "RUNTIME_CPU_STARVED",
  "RUNTIME_MODEL_PROBE_TIMEOUT",
  "RUNTIME_MODEL_PROBE_FAILED",
  "RUNTIME_LOGIN_FAILED",
  "RUNTIME_STARTUP_FAILED",
  "WORKSPACE_SETUP_REFUSED",
  "CONVERGENCE_DEADLINE_EXCEEDED",
  "PROVISIONING_DEPLOYMENT_FAILED",
]);
// Held failures whose model check can name the provider's response.
const providerFailureCodes = new Set([
  "RUNTIME_AUTHENTICATION_FAILED",
  "RUNTIME_MODEL_PROBE_FAILED",
]);
// The fixed values the runtime wrapper logs on `openclaw.model_probe` (runtime-entrypoints.ts):
// its result code and a provider error code from its closed list or classified upfront 401.
const modelProbeCodes = new Set([
  "READY",
  "AUTHENTICATION_FAILED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "MODEL_PROBE_CPU_STARVED",
  "UNAVAILABLE",
]);
const providerCodes = new Set([
  "usage_limit_reached",
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "invalid_api_key",
  "model_not_found",
  "server_error",
  "overloaded_error",
  "missing_api_key",
  "insufficient_permissions",
]);
// Which response header names the upfront 401 carried (names only, no origin claim).
// "none" is a real value here, so an absent field prints "absent" instead.
const responseHeaderMarkers = new Set(["none", "provider-like", "openshell-policy", "mixed"]);
// The upfront 401 body's form and its error.code and error.type, each from a closed
// set ("other" off-set); the message never reaches the log. They mirror the sets in
// runtime-entrypoints.ts; runtime-model-probe-settlement.test.mjs pins that.
export const bodyShapes = new Set([
  "json-error-code",
  "json-error-no-code",
  "json-no-error",
  "non-json",
  "empty",
]);
export const providerErrorCodes = new Set([
  "invalid_api_key",
  "insufficient_permissions",
  "invalid_organization",
  "mismatched_organization",
  "no_organization",
  "invalid_project",
  "mismatched_project",
  "account_deactivated",
  "deactivated_workspace",
  "ip_not_authorized",
  "other",
]);
export const providerErrorTypes = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "other",
]);

const absentOr = (value, observe) =>
  value === undefined || value === null ? "none" : observe(value);
// For fields where "none" is a real value: absent prints "absent", off-set "other".
const markerOrAbsent = (value, known) =>
  value === undefined || value === null ? "absent" : known.has(value) ? value : "other";
const failureCategory = (code) => (runtimeFailureCodes.has(code) ? code : "unrecognized");
const progressCode = (code) => (deploymentProgressCodes.has(code) ? code : "unknown");

// The latest model check in the exact revision's agent log page, as fixed values only.
function observedModelProbe(logs, revisionId) {
  if (logs?.revisionId !== revisionId || logs.source !== "agent" || !Array.isArray(logs.records)) {
    return "unavailable";
  }
  const probes = logs.records.filter(
    (record) =>
      record?.type === "line" &&
      record.kind === "wrapper" &&
      record.message === "openclaw.model_probe",
  );
  const fields = probes.at(-1)?.fields ?? {};
  return {
    probes: probes.length,
    code: absentOr(fields.code, (code) => (modelProbeCodes.has(code) ? code : "other")),
    providerStatus: absentOr(fields.providerStatus, (status) =>
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : "other",
    ),
    providerCode: absentOr(fields.providerCode, (code) =>
      providerCodes.has(code) ? code : "other",
    ),
    responseHeaderMarker: markerOrAbsent(fields.responseHeaderMarker, responseHeaderMarkers),
    bodyShape: markerOrAbsent(fields.bodyShape, bodyShapes),
    providerErrorCode: markerOrAbsent(fields.providerErrorCode, providerErrorCodes),
    providerErrorType: markerOrAbsent(fields.providerErrorType, providerErrorTypes),
  };
}

// Codes from the provisioning record, its exact deployment and, for a held model-check
// failure, that check's log event. Every value comes from a fixed vocabulary.
async function observeNativeFailure({
  request,
  namespaceId,
  provisioningPath,
  provisioned,
  signal,
}) {
  const observation = {
    provisioning: {
      ...observedProvisioning(provisioned),
      errorCode: absentOr(provisioned?.error?.code, failureCategory),
    },
  };
  if (!observation.provisioning.agentIdPresent || !observation.provisioning.revisionIdPresent) {
    return observation;
  }
  observation.deployment = "unavailable";
  try {
    const deploymentPath = nativeDeploymentPath(namespaceId, provisioned, provisioningPath);
    const diagnosticSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    const deployment = await request("GET", deploymentPath, undefined, diagnosticSignal);
    const revision = {
      namespaceId,
      agentId: provisioned.agentId,
      revisionId: provisioned.revisionId,
      deploymentPath,
    };
    await observeDeployment(observation, deployment, revision, request, diagnosticSignal);
  } catch {
    // Diagnostic failures cannot replace the terminal failure or reveal peer errors.
  }
  return observation;
}

// The exact revision's status and codes and, for a held model-check failure, that check's
// log event. Sets `deployment` (and `modelProbe`) on the observation as it learns them.
async function observeDeployment(observation, deployment, revision, request, signal) {
  if (
    deployment?.namespaceId !== revision.namespaceId ||
    deployment.agentId !== revision.agentId ||
    deployment.deploymentId !== revision.revisionId
  ) {
    return;
  }
  const code = deployment.error?.code;
  observation.deployment = {
    status: observedStatus(deployment.status),
    errorCode: absentOr(code, failureCategory),
    lastAttemptCode: absentOr(deployment.progress?.lastAttempt?.code, progressCode),
  };
  if (deployment.status === "failed" && providerFailureCodes.has(code)) {
    observation.modelProbe = "unavailable";
    const logs = await request(
      "GET",
      `${revision.deploymentPath}/runtime/logs?source=agent&tailLines=1000`,
      undefined,
      signal,
    );
    observation.modelProbe = observedModelProbe(logs, revision.revisionId);
  }
}

// CI keeps only the start of this message. Lead with the probe; its 401 response
// does not tell us whether credentials were attached when the request was made.
function failNativeWork(expectation, code, { modelProbe, ...work }) {
  const observation = {
    modelProbe,
    credentialAttachment: modelProbe?.providerStatus === 401 ? "not observed" : undefined,
    ...work,
  };
  assert.fail(`${expectation}: ${failureCategory(code)} ${JSON.stringify(observation)}`);
}

export async function assertNativeWorkNotFailed(response, expectation, diagnostics = {}) {
  if (response.status === "failed") {
    const observation = await observeNativeFailure(diagnostics);
    failNativeWork(expectation, response.error?.code, observation);
  }
}

// A redeploy's failure, reported like the first deployment's: the replacement revision's
// codes and its model check, from the same fixed vocabularies and one five-second budget.
async function assertNativeRedeployNotFailed(
  deployment,
  expectation,
  { request, namespaceId, agentId, revisionId, signal },
) {
  if (deployment?.status !== "failed") {
    return;
  }
  const observation = { deployment: "unavailable" };
  try {
    assert.ok(
      isResourceId(namespaceId, "ns") &&
        isResourceId(agentId, "agt") &&
        isResourceId(revisionId, "rev"),
      "The native redeploy returned an invalid binding",
    );
    const revision = {
      namespaceId,
      agentId,
      revisionId,
      deploymentPath: `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`,
    };
    const diagnosticSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    await observeDeployment(observation, deployment, revision, request, diagnosticSignal);
  } catch {
    // Diagnostic failures cannot replace the terminal failure or reveal peer errors.
  }
  failNativeWork(expectation, deployment.error?.code, observation);
}

// Polls the replacement revision until it is active. A failed redeploy fails the test with
// its public failure code; it never prints the deployment's message or other peer text.
export async function waitForNativeRedeploy({
  request,
  namespaceId,
  agentId,
  revisionId,
  signal,
  timeoutMs = 8 * 60_000,
  pollMs = 2_000,
}) {
  const agentPath = `/namespaces/${namespaceId}/agents/${agentId}`;
  const deadline = Date.now() + timeoutMs;
  let deployment;
  let agent;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    deployment = await request("GET", `${agentPath}/deployments/${revisionId}`);
    // Bind the response before interpreting status or collecting failure diagnostics.
    assert.ok(
      deployment?.namespaceId === namespaceId &&
        deployment.agentId === agentId &&
        deployment.deploymentId === revisionId,
      "The native redeploy returned a mismatched deployment binding",
    );
    await assertNativeRedeployNotFailed(
      deployment,
      "Redeployment with the retained native workspace must succeed",
      { request, namespaceId, agentId, revisionId, signal },
    );
    agent = await request("GET", agentPath);
    if (deployment.status === "succeeded" && agent.activeRevisionId === revisionId) {
      break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))),
    );
  }
  return { deployment, agent };
}

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

function nativeDeploymentPath(namespaceId, provisioned, provisioningPath) {
  assert.ok(
    isResourceId(provisioned.agentId, "agt") &&
      isResourceId(provisioned.revisionId, "rev") &&
      nativeProvisioningPath(namespaceId, provisioned) === provisioningPath,
    "Guided native provisioning returned an invalid binding",
  );
  return `/namespaces/${namespaceId}/agents/${provisioned.agentId}/deployments/${provisioned.revisionId}`;
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
export const runtimeLogSources = Object.freeze(["agent", "sandbox", "gateway"]);

// CI receives counts, not the contents of an authorized runtime log page. Even sanitized
// fields can contain peer-selected values that are inappropriate for an assertion message.
function observedRuntimeOutput(logs, revisionId, source) {
  if (logs?.revisionId !== revisionId || logs.source !== source || !Array.isArray(logs.records)) {
    return "unavailable";
  }
  const events = {};
  const decisions = {};
  for (const record of logs.records) {
    if (record?.type !== "line") {
      continue;
    }
    if (record.kind === "wrapper" && wrapperEvents.has(record.message)) {
      const event = record.message;
      events[event] = (events[event] ?? 0) + 1;
    } else if (record.kind === "sandbox" && record.fields?.action !== undefined) {
      const action = record.fields.action;
      const decision = action === "ALLOWED" || action === "DENIED" ? action : "other";
      decisions[decision] = (decisions[decision] ?? 0) + 1;
    }
  }
  return { records: logs.records.length, events, decisions };
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
      const deploymentPath = nativeDeploymentPath(namespaceId, provisioned, provisioningPath);
      const diagnosticSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
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
          const pods = observedPodReadiness(runtime, provisioned.revisionId);
          observation.runtimeAfterDeadline = pods;
          // Read optional pages only for one ready Pod per role, within the original budget.
          if (pods.gateway?.ready === true && pods.agent?.ready === true) {
            observation.runtimeOutput = {};
            for (const source of runtimeLogSources) {
              if (diagnosticSignal.aborted) {
                break;
              }
              observation.runtimeOutput[source] = "unavailable";
              try {
                const logs = await request(
                  "GET",
                  `${deploymentPath}/runtime/logs?source=${source}&tailLines=1000`,
                  undefined,
                  diagnosticSignal,
                );
                observation.runtimeOutput[source] = observedRuntimeOutput(
                  logs,
                  provisioned.revisionId,
                  source,
                );
              } catch {
                // A failed log read cannot hide Pod readiness or replace the deadline failure.
              }
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
