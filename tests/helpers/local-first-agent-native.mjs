import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nativeFirstAgentProofDiagnostic } from "../../scripts/ci/reporter.ts";
import {
  nativeWorkerHistoryEvidence,
  nativeWorkerProofProgram,
} from "./native-worker-history-proof.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const proofPrefix = "OCE_NATIVE_FIRST_AGENT_PROOF ";
export const nativeFirstAgentProofTimeout = 10 * 60_000;

// Project public RPC observations before crossing the controller stdout boundary.
// Keep this function self-contained: the trusted controller executes its source.
export function nativeWorkerPlacementObservation({
  placement,
  placementLookup,
  environment,
  nodes,
  expectedNodeId,
  sessionId,
  environmentLookup,
  nodeLookup,
  elapsedMs,
}) {
  const category = (value, values) => {
    if (value == null) {
      return "absent";
    }
    return values.includes(value) ? value : "other";
  };
  const errorCategory = (value) => {
    if (value == null) {
      return "absent";
    }
    if (typeof value !== "string") {
      return "other";
    }
    // Upstream provider/bootstrap owners wrap the cause before publishing placement errors.
    // Strip only their fixed prefixes, never arbitrary peer text or identifiers.
    let detail = value.slice(0, 4096);
    let fallback = "other";
    let bundleInstall = false;
    const wrappers = [
      ["Worker node bootstrap failed: ", "worker-bootstrap-failed"],
      ["Device worker bundle installation failed: ", "bundle-install-failed"],
      ["worker-bundle-install-failed: ", "bundle-install-failed"],
      ["Worker provider preparation failed: ", "provider-preparation-failed"],
      ["Worker provider operation failed: ", "provider-operation-failed"],
      ["Worker provider rejected profile: ", "provider-profile-rejected"],
    ];
    for (let depth = 0; depth < 4; depth += 1) {
      const wrapper = wrappers.find(([prefix]) => detail.startsWith(prefix));
      if (!wrapper) {
        break;
      }
      detail = detail.slice(wrapper[0].length);
      fallback = wrapper[1];
      bundleInstall ||= fallback === "bundle-install-failed";
    }
    if (bundleInstall) {
      const http = /^gateway returned ([0-9]{1,3})(?:\b|$)/.exec(detail);
      if (http) {
        const status = Number(http[1]);
        if ([401, 403, 404].includes(status)) {
          return `bundle-http-${status}`;
        }
        if (status >= 400 && status < 500) {
          return "bundle-http-client-error";
        }
        if (status >= 500 && status < 600) {
          return "bundle-http-server-error";
        }
        return "bundle-http-unexpected-status";
      }
      const errno =
        /^(EACCES|EPERM|EROFS|ENOSPC|ENOENT):/.exec(detail) ??
        /^spawn .+ (EACCES|EPERM|EROFS|ENOSPC|ENOENT)(?:\b|$)/.exec(detail);
      if (errno) {
        return {
          EACCES: "bundle-storage-access-denied",
          EPERM: "bundle-operation-denied",
          EROFS: "bundle-storage-readonly",
          ENOSPC: "bundle-storage-full",
          ENOENT: "bundle-file-missing",
        }[errno[1]];
      }
      if (detail.startsWith("Command failed:")) {
        return "bundle-prewarm-failed";
      }
    }
    // These phrases come from the pinned OpenClaw worker environment and node tunnel owners.
    const errors = [
      ["Worker tunnel did not connect within 3 minutes", "tunnel-timeout"],
      ["node worker workspace command timed out", "workspace-command-timeout"],
      ["node workspace command failed (", "workspace-command-failed"],
      ["device worker node transport is unavailable", "node-transport-unavailable"],
      ["Device worker node transport is unavailable", "node-transport-unavailable"],
      [
        "Device worker node is not connected with the installer dialect",
        "node-installer-disconnected",
      ],
      [
        "Device worker installation connection is no longer current",
        "node-install-connection-stale",
      ],
      [
        "Device worker bundle installer returned a mismatched build receipt",
        "bundle-receipt-mismatch",
      ],
      ["Device worker bundle installation failed", "bundle-install-failed"],
      ["Device worker node does not support bundle prefetch", "bundle-prefetch-unsupported"],
      [
        "OpenClaw worker deploy artifact is missing; build the running package",
        "worker-deploy-artifact-missing",
      ],
      ["Unsafe worker deploy artifact:", "worker-deploy-artifact-unsafe"],
      ["Cloud bootstrap requires a built Gateway;", "gateway-build-missing"],
      ["Cloud bootstrap is missing its built CLI entry;", "gateway-cli-missing"],
      ["Node bootstrap distribution exceeds its artifact limits", "bootstrap-artifact-too-large"],
      ["Node bootstrap archive exceeds the transfer limit", "bootstrap-transfer-too-large"],
      ["INVALID_REQUEST: invalid node worker bundle install request", "bundle-request-invalid"],
      ["gateway returned an unexpected worker bundle range", "bundle-range-invalid"],
      ["gateway returned an unexpected worker bundle length", "bundle-transfer-length-invalid"],
      [
        "worker bundle download stopped after 3 consecutive no-progress failures",
        "bundle-download-no-progress",
      ],
      ["prepared worker bundle archive has an unexpected length", "bundle-archive-length-invalid"],
      ["worker bundle archive exceeded its byte limit", "bundle-archive-too-large"],
      ["worker bundle transfer response exceeded its byte limit", "bundle-response-too-large"],
      ["worker bundle archive failed integrity validation", "bundle-archive-integrity-failed"],
      ["published worker bundle failed validation", "bundle-published-invalid"],
      ["gateway TLS fingerprint mismatch", "bundle-tls-mismatch"],
      ["Cloudflare Access credentials require HTTPS", "bundle-https-required"],
      ["gateway transfer is unavailable", "bundle-transfer-unavailable"],
      [
        "Worker bundle archive manifest does not match its expected hash",
        "bundle-manifest-hash-mismatch",
      ],
      [
        "Extracted worker bundle does not match its expected hash",
        "bundle-extracted-hash-mismatch",
      ],
      ["Invalid worker bundle archive path:", "bundle-entry-invalid"],
      ["Duplicate worker bundle archive path:", "bundle-entry-invalid"],
      ["Invalid worker bundle archive size:", "bundle-entry-invalid"],
      ["Invalid worker bundle tar entry:", "bundle-entry-invalid"],
      ["Worker bundle contains an unsupported entry:", "bundle-entry-invalid"],
      ["Worker bundle archive exceeds its entry limit", "bundle-extraction-limit"],
      ["Worker bundle archive exceeds its expanded byte limit", "bundle-extraction-limit"],
      ["Worker bundle directory exceeds its limits", "bundle-extraction-limit"],
      ["Worker bundle contains a symbolic link:", "bundle-symlink-refused"],
      ["Worker bundle file changed while hashing:", "bundle-file-changed"],
      [
        "device worker node is not connected with the supervisor dialect",
        "node-supervisor-disconnected",
      ],
      ["node worker workspace is unavailable before sync", "workspace-not-synced"],
      ["Device folder does not belong to this workspace runner", "workspace-device-mismatch"],
      ["Device folder validation failed", "workspace-validation-failed"],
      ["Node workspace sync does not match its bound session", "workspace-session-mismatch"],
      ["Worker tunnel owner credential is not current", "owner-credential-stale"],
      ["node worker tunnel owner epoch is stale", "owner-epoch-stale"],
      ["node worker tunnel owner binding changed within one epoch", "owner-binding-changed"],
      ["node worker tunnel stopped before connecting", "tunnel-stopped"],
    ];
    return errors.find(([phrase]) => detail.startsWith(phrase))?.[1] ?? fallback;
  };
  const present = (value) => typeof value === "string" && value.length > 0;
  const count = (value) =>
    Array.isArray(value) && value.length <= 4096 ? value.length : undefined;
  const validNodes = count(nodes) !== undefined ? nodes : undefined;
  const matches = validNodes?.filter(
    (node) => present(expectedNodeId) && node?.nodeId === expectedNodeId,
  );
  const exact = matches?.length === 1 ? matches[0] : undefined;
  const bool = (value) => (typeof value === "boolean" ? value : undefined);
  const attached = environment?.worker?.attachedSessionIds;
  return {
    placementLookup:
      placementLookup === undefined
        ? undefined
        : category(placementLookup, ["fresh", "fallback", "absent"]),
    placementState: category(placement?.state, [
      "local",
      "requested",
      "provisioning",
      "syncing",
      "starting",
      "active",
      "draining",
      "reconciling",
      "reclaimed",
      "failed",
    ]),
    recoveryError: errorCategory(placement?.recoveryError),
    terminalReason: errorCategory(placement?.terminalReason),
    workspaceReferencePresent: present(placement?.remoteWorkspaceDir),
    environmentLookup: category(environmentLookup, ["absent", "found", "unavailable", "mismatch"]),
    environmentState: category(environment?.worker?.state, [
      "requested",
      "provisioning",
      "bootstrapping",
      "ready",
      "attached",
      "idle",
      "draining",
      "destroying",
      "destroyed",
      "failed",
      "orphaned",
    ]),
    environmentError: errorCategory(environment?.worker?.error),
    tunnelStatus: category(environment?.worker?.tunnelStatus, [
      "stopped",
      "connecting",
      "connected",
      "reconnecting",
    ]),
    attachedSessionCount: count(attached),
    attachedSessionMatches:
      count(attached) === undefined
        ? undefined
        : present(sessionId) && attached.includes(sessionId),
    nodeLookup: category(nodeLookup, ["found", "unavailable", "invalid"]),
    nodeCount: count(validNodes),
    connectedNodeCount: validNodes?.filter((node) => node?.connected === true).length,
    expectedNodeIdPresent: present(expectedNodeId),
    expectedNodeMatches: matches?.length,
    expectedNodeConnected: bool(exact?.connected),
    expectedNodePaired: bool(exact?.paired),
    expectedNodeSessionHost: bool(exact?.sessionHost),
    expectedNodeCaps: count(exact?.caps),
    expectedNodeCommands: count(exact?.commands),
    expectedNodeWorkerBundle: category(exact?.workerBundle?.status, ["installed", "missing"]),
    elapsedMs:
      Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 3_600_000
        ? elapsedMs
        : undefined,
  };
}

// Classify only the selected turn. Error text and transcript bytes stay in the controller.
export function nativeWorkerTurnObservation({ outcome, error, messages, runId, historyLookup }) {
  const category = (value, values) =>
    value == null ? "absent" : values.includes(value) ? value : "other";
  const classify = (value) => {
    if (value == null) {
      return "absent";
    }
    if (typeof value !== "string") {
      return "other";
    }
    const detail = value.slice(0, 4096);
    const patterns = [
      ["workspace-discovery", /Remote workspace skill discovery failed/],
      ["worker-model-output", /Runtime-local inference failed its output boundary/],
      [
        "worker-model-setup",
        /(?:Invalid node-local inference startup configuration|Node-local inference (?:startup|workspace binding)|Native runtime (?:credential is unavailable|model selection is not configured|requires the exact selected local model|workspace does not match)|Worker-local inference cannot use)/,
      ],
      [
        "worker-audit-delivery",
        /(?:OpenClaw Enterprise runtime audit did not accept the event|Worker model (?:audit start failed|observation requires an admitted turn)|Pending audit observation limit reached|worker model-observation response timed out)/,
      ],
      [
        "worker-transcript-authority",
        /Cloud worker (?:transcript (?:identity|authority)|placement authority changed)/,
      ],
      ["worker-turn-failed", /^(?:Error: )?(?:Cloud worker turn failed|Worker turn failed)$/i],
      [
        "session-read-changed",
        /^(?:Error: )?Session changed while preparing its description; retry the request$/,
      ],
      [
        "session-binding-changed",
        /^(?:Error: )?Session repository binding changed while preparing its description$/,
      ],
      [
        "model-authentication",
        /invalid.api.key|incorrect.api.key|authentication_error|No API key/i,
      ],
      ["model-rate-or-quota", /rate.limit|insufficient_quota|quota.exceeded|too many requests/i],
      [
        "model-unavailable",
        /model.not.found|unknown model|model.*does not exist|Worker model is not approved|missing from the Gateway model catalog/i,
      ],
      [
        "tool-policy",
        /approval required|exec denied|execution denied|not allowed by|host.*not allowed|security policy/i,
      ],
      [
        "filesystem-permission",
        /\bEACCES\b|\bEPERM\b|\bEROFS\b|permission denied|read.only file system/i,
      ],
      [
        "file-or-command-missing",
        /\bENOENT\b|command not found|Cannot find module|ERR_MODULE_NOT_FOUND/i,
      ],
      [
        "tls-validation",
        /certificate verify failed|unable to get local issuer|self.signed certificate|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID/i,
      ],
      [
        "network-connection",
        /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|fetch failed|connection refused|connection timed out/i,
      ],
      [
        "worker-authority",
        /Worker turn.*authority|Worker tool surface owner changed|worker credential handoff failed/i,
      ],
      [
        "worker-transport",
        /Worker tunnel does not support worker turns|worker transport limit|Worker node.*lost|worker.*disconnected/i,
      ],
      [
        "worker-provider-replay",
        /^(?:Error: )?Cloud worker could not preserve authoritative provider replay\. Stop or reclaim the cloud worker, then retry locally\./,
      ],
      [
        "worker-transcript-settlement",
        /^(?:Error: )?Cloud worker (?:result does not match its committed transcript acknowledgement \(|completed without a terminal assistant transcript message$)/,
      ],
      ["http-unauthorized", /(?:^|\bHTTP(?: status)? )401\b/i],
      ["http-forbidden", /(?:^|\bHTTP(?: status)? )403\b/i],
      ["http-rate-limit", /(?:^|\bHTTP(?: status)? )429\b/i],
    ];
    return patterns.find(([, pattern]) => pattern.test(detail))?.[0] ?? "other";
  };
  const selected =
    typeof runId === "string" && runId.length > 0 && Array.isArray(messages)
      ? messages.slice(-30).filter((message) => message?.__openclaw?.runId === runId)
      : [];
  const assistant = selected.filter((message) => message.role === "assistant").at(-1);
  const results = selected.filter(
    (message) => message.role === "toolResult" && message.toolName === "exec",
  );
  const failed = results.filter((message) => message.isError === true);
  const failedText = failed.at(-1)?.content;
  let execError;
  if (typeof failedText === "string") {
    execError = failedText;
  } else if (Array.isArray(failedText)) {
    execError = failedText.find(
      (part) => part?.type === "text" && typeof part.text === "string",
    )?.text;
  }
  return {
    turnStatus: category(outcome?.status, ["ok", "error", "timeout", "pending"]),
    turnError: classify(outcome?.error),
    proofError: classify(error?.message),
    turnStopReason: category(outcome?.stopReason, [
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
    ]),
    providerStarted:
      typeof outcome?.providerStarted === "boolean" ? outcome.providerStarted : undefined,
    historyLookup: category(historyLookup, ["found", "unavailable", "invalid", "absent"]),
    assistantStopReason: category(assistant?.stopReason, [
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
    ]),
    assistantError: classify(assistant?.errorMessage),
    execError: classify(execError),
    execResultCount: results.length,
    execFailureCount: failed.length,
  };
}

// The Gateway remaps events to the chat source's run ID. Keep only owner-published
// facts for that run and session, and disregard retryable attempt errors.
export function nativeWorkerTurnEventObservation(event, selectedTurn) {
  const payload = event?.payload;
  if (
    !selectedTurn ||
    !payload ||
    payload.runId !== selectedTurn.runId ||
    payload.sessionKey !== selectedTurn.key
  ) {
    return undefined;
  }
  if (event.event === "chat" && payload.state === "status") {
    const phase = payload.phase;
    return [
      "provisioning_environment",
      "preparing_workspace",
      "preparing_context",
      "starting_model",
    ].includes(phase)
      ? { turnStartupPhase: phase }
      : undefined;
  }
  const data = payload.data;
  if (
    event.event !== "agent" ||
    payload.stream !== "lifecycle" ||
    data?.executionSettled !== true ||
    (data.phase !== "end" && data.phase !== "error")
  ) {
    return undefined;
  }
  const terminal = nativeWorkerTurnObservation({ outcome: data });
  return {
    turnLifecyclePhase: data.phase,
    turnLifecycleError: terminal.turnError,
    providerStarted: terminal.providerStarted,
  };
}

// Keep reads within one budget and project the current session owner when a turn moved it.
// Like the projector, this collector is serialized into the trusted controller.
export async function collectNativeWorkerFailure({
  request,
  session,
  lastPlacement,
  expectedNodeId,
  elapsedMs,
  runId,
  outcome,
  turnEvents = {},
  error,
  placementReadResponse = false,
}) {
  const signal = AbortSignal.timeout(5_000);
  const read = async (method, params) => {
    try {
      return {
        status: "fulfilled",
        value: await request(method, params, { signal, timeoutMs: 5_000 }),
      };
    } catch {
      return { status: "rejected" };
    }
  };
  // Observe nodes concurrently without letting their latency delay the environment lookup.
  const nodeObservation = read("node.list", {});
  const historyObservation =
    typeof runId === "string" && runId.length > 0 && typeof session?.key === "string"
      ? read("chat.history", { sessionKey: session.key, limit: 30 })
      : undefined;
  let placement = lastPlacement;
  let placementLookup = placement === undefined ? "absent" : "fallback";
  if (
    typeof session?.key === "string" &&
    session.key.length > 0 &&
    typeof session.sessionId === "string" &&
    session.sessionId.length > 0
  ) {
    const described = await read("sessions.describe", { key: session.key, agentId: "main" });
    if (
      described.status === "fulfilled" &&
      described.value?.session?.sessionId === session.sessionId
    ) {
      placement = described.value.session.placement;
      placementLookup = "fresh";
    }
  }
  const environmentId = placement?.environmentId;
  let environment;
  let environmentLookup = "absent";
  if (typeof environmentId === "string" && environmentId.length > 0) {
    const result = await read("environments.status", { environmentId });
    environmentLookup = "unavailable";
    if (result.status === "fulfilled") {
      environmentLookup = result.value?.id === environmentId ? "found" : "mismatch";
      if (environmentLookup === "found") {
        environment = result.value;
      }
    }
  }
  const nodeResult = await nodeObservation;
  const nodes = nodeResult.status === "fulfilled" ? nodeResult.value?.nodes : undefined;
  let nodeLookup = "unavailable";
  if (nodeResult.status === "fulfilled") {
    nodeLookup = Array.isArray(nodes) ? "found" : "invalid";
  }
  const worker = nativeWorkerPlacementObservation({
    placement,
    placementLookup,
    environment,
    nodes,
    expectedNodeId,
    sessionId: session?.sessionId,
    environmentLookup,
    nodeLookup,
    elapsedMs,
  });
  if (placementReadResponse && error?.code === "UNAVAILABLE") {
    // The Gateway can reject this read before dispatch or while preparing its model catalog.
    // Project only the two pinned signals; the message and details can contain private data.
    worker.placementReadFailure = "other";
    if (error.retryable === true && error.details?.reason === "request-start-timeout") {
      worker.placementReadFailure = "request-start-timeout";
    } else if (
      error.message === "Error: Session model catalog is unavailable; refresh and try again."
    ) {
      worker.placementReadFailure = "session-model-catalog-unavailable";
    }
  }
  if (runId === undefined) {
    return error === undefined
      ? worker
      : { ...worker, proofError: nativeWorkerTurnObservation({ error }).proofError };
  }
  const history = await historyObservation;
  let historyLookup = "unavailable";
  if (history?.status === "fulfilled") {
    historyLookup = Array.isArray(history.value?.messages) ? "found" : "invalid";
  }
  const turn = nativeWorkerTurnObservation({
    outcome,
    error,
    runId,
    messages: history?.value?.messages,
    historyLookup,
  });
  // A queued observation can predate the settled lifecycle event.
  const providerStarted =
    outcome?.status === "pending"
      ? (turnEvents.providerStarted ?? turn.providerStarted)
      : (turn.providerStarted ?? turnEvents.providerStarted);
  return {
    ...worker,
    ...turn,
    ...turnEvents,
    providerStarted,
  };
}

// Validate before reading placement so a foreign response cannot poison failure evidence.
// Self-contained because the controller receives this function as source.
export function nativeWorkerSessionPlacement(description, sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    description?.session?.sessionId !== sessionId
  ) {
    throw new Error("Native worker session identity mismatch");
  }
  return description.session.placement;
}

// The pinned Gateway returns this plain read-generation error through
// UNAVAILABLE + formatForLog. The SDK separately proves response correlation.
export function nativePlacementReadRetryable(error, correlatedResponse) {
  return (
    correlatedResponse === true &&
    error?.code === "UNAVAILABLE" &&
    error.message === "Error: Session changed while preparing its description; retry the request"
  );
}

// Run in the existing trusted controller: it already has the private route key,
// cluster DNS and CA. Native admin sign-in is neither enabled nor required.
async function nativeWorkerProof({
  namespaceId,
  agentId,
  timeout,
  plainChat,
  workspaceFile,
  expectedNodeId,
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
  const { GatewayClient, isGatewayProtocolResponseError } = await import(
    pathToFileURL(require.resolve("@openclaw/gateway-client"))
  );
  assert.equal(
    typeof isGatewayProtocolResponseError,
    "function",
    "The controller SDK must recognize correlated Gateway errors",
  );
  const { loadYaml } = await import(pathToFileURL(require.resolve("@kubernetes/client-node")));
  let stage = "startup";
  let client;
  let temporarySession;
  let helloTimer;
  let collectFailure;
  let lastPlacement;
  let runId;
  let selectedTurn;
  let outcome;
  const turnEvents = {};
  let historyPredicates;
  let historySignal;
  let placementReadRetries = 0;
  const proofStarted = performance.now();
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
      onEvent: (event) => {
        Object.assign(turnEvents, nativeWorkerTurnEventObservation(event, selectedTurn));
      },
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
    collectFailure = async (error) => {
      const proofRpcResponse = isGatewayProtocolResponseError(error);
      let proofRpcCode = "other";
      if (error?.code == null) {
        proofRpcCode = "absent";
      } else if (
        ["UNAVAILABLE", "INVALID_REQUEST", "NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(
          error.code,
        )
      ) {
        proofRpcCode = error.code;
      }
      return {
        ...(await collectNativeWorkerFailure({
          request: (method, params, options) => client.request(method, params, options),
          session,
          lastPlacement,
          expectedNodeId,
          elapsedMs: Math.round(performance.now() - proofStarted),
          runId,
          outcome,
          turnEvents: runId === selectedTurn?.runId ? turnEvents : undefined,
          error,
          placementReadResponse:
            stage === "required-placement-describe-rejected" && proofRpcResponse,
        })),
        ...historyPredicates,
        historySettleExpired: historySignal?.aborted === true,
        proofRpcCode,
        proofRpcResponse,
        placementReadRetries,
      };
    };
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
      stage = "create-session-id-missing";
      const { sessionId } = created;
      assert.ok(typeof sessionId === "string" && sessionId.trim().length > 0);
      session = { key, sessionId };
      if (plainChat) {
        temporarySession = session;
      }
      stage = "required-placement";
      while (!signal.aborted) {
        let described;
        try {
          described = await call("sessions.describe", { key, agentId: "main" });
        } catch (error) {
          stage = "required-placement-describe-rejected";
          if (!nativePlacementReadRetryable(error, isGatewayProtocolResponseError(error))) {
            throw error;
          }
          placementReadRetries++;
          await delay(500, undefined, { signal });
          continue;
        }
        stage = "session-identity";
        lastPlacement = nativeWorkerSessionPlacement(described, session.sessionId);
        stage = "required-placement";
        const state = lastPlacement?.state;
        if (state === "active") {
          break;
        }
        if (["failed", "reclaimed", "local"].includes(state)) {
          stage = `required-placement-terminal-${state}`;
          assert.fail();
        }
        await delay(500, undefined, { signal });
      }
      signal.throwIfAborted();
    }
    assert.ok(session.key && session.sessionId);
    const { key } = session;
    stage = "session-identity";
    const described = await call("sessions.describe", { key, agentId: "main" });
    lastPlacement = nativeWorkerSessionPlacement(described, session.sessionId);
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
    let command;
    let message = `Reply with exactly ${marker}. Do not use tools.`;
    if (!plainChat) {
      const program = nativeWorkerProofProgram({
        sessionFile,
        sessionFileContent,
        workspaceFile,
        toolPrefix,
        createSessionFile: existingSession === undefined,
      });
      command = `node -e '${program.replaceAll("'", "'\\''")}'`;
      message = `Use exec to run exactly this command: ${command}. After exec succeeds, reply with exactly ${marker}. Do not print environment values or credentials.`;
    }
    stage = "send";
    selectedTurn = { key, runId: randomUUID() };
    const sent = await call("sessions.send", {
      key,
      agentId: "main",
      idempotencyKey: selectedTurn.runId,
      message,
    });
    assert.ok(sent.runId);
    runId = sent.runId;
    assert.ok(!["error", "timeout"].includes(sent.status));
    stage = "model-and-exec";
    while (!signal.aborted) {
      const observation = await call("agent.wait", { runId, timeoutMs: 3_000 });
      assert.equal(observation.runId, runId);
      outcome = observation;
      if (["ok", "error"].includes(outcome.status) || outcome.endedAt !== undefined) {
        break;
      }
    }
    signal.throwIfAborted();
    stage = "model-outcome";
    assert.equal(outcome.status, "ok");
    // The model turn is already terminal. Allow history delivery to settle,
    // but do not spend the remaining model-execution budget on a missing proof.
    historySignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!historySignal.aborted) {
      stage = "model-history";
      const history = await client.request(
        "chat.history",
        { sessionKey: key, limit: 30 },
        { signal: historySignal, timeoutMs: 30_000 },
      );
      const evidence = nativeWorkerHistoryEvidence({
        messages: history.messages,
        runId: sent.runId,
        toolPrefix,
        marker,
        command,
      });
      historyPredicates = evidence.observation;
      const { tool, final, messages } = evidence;
      if (final && (plainChat || tool)) {
        stage = "current-placement";
        const current = await call("sessions.describe", { key, agentId: "main" });
        assert.equal(current.session?.sessionId, session.sessionId);
        const placement = current.session?.placement;
        assert.equal(placement?.state, "active");
        assert.equal(placement.profileId, required.id);
        assert.equal(placement.providerId, required.providerId);
        assert.equal(placement.inference, "worker");
        assert.ok(placement.environmentId && placement.remoteWorkspaceDir);
        const verified = {
          verified: true,
          profileId: required.id,
          providerId: required.providerId,
          environmentId: placement.environmentId,
          session,
        };
        if (plainChat) {
          emit(verified);
          return;
        }
        stage = "exec-proof";
        const output = evidence.output;
        const line = output.split(/\r?\n/).find((line) => line.startsWith(toolPrefix));
        assert.ok(line);
        const proof = JSON.parse(line.slice(toolPrefix.length));
        assert.ok(typeof proof.hostname === "string" && proof.hostname.length > 0);
        assert.equal(proof.cwd, placement.remoteWorkspaceDir);
        assert.equal(proof.modelCredentialPresent, false);
        assert.equal(proof.sessionFileSha256, sessionFile.sha256);
        if (workspaceFile !== undefined) {
          assert.equal(
            proof.workspaceFileSha256,
            createHash("sha256").update(workspaceFile.content).digest("hex"),
          );
        }
        emit({ ...verified, hostname: proof.hostname, sessionFile });
        return;
      }
      assert.ok(
        !messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
      );
      await delay(500, undefined, { signal: historySignal });
    }
    historySignal.throwIfAborted();
  } catch (error) {
    // Dependency/RPC errors can include private headers. Preserve the failing
    // stage, never raw exceptions, keys, transcripts or controller output.
    const worker = await collectFailure?.(error).catch(() => undefined);
    emit({ verified: false, stage, worker });
    process.exitCode = 1;
  } finally {
    clearTimeout(helloTimer);
    if (temporarySession) {
      // Release this turn's worker slot before the retained-session check.
      await client
        .request(
          "sessions.delete",
          { key: temporarySession.key, expectedSessionId: temporarySession.sessionId },
          { timeoutMs: 10_000 },
        )
        .catch(() => undefined);
    }
    client?.stop();
    await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

export async function assertNativeWorkerProofInController(
  context,
  {
    stateDirectory,
    state,
    environment,
    namespaceId,
    agentId,
    plainChat = false,
    workspaceFile,
    expectedNodeId,
    session,
    sessionFile,
  },
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
  const input = `const nativePlacementReadRetryable = (${nativePlacementReadRetryable.toString()});\nconst nativeWorkerProofProgram = (${nativeWorkerProofProgram.toString()});\nconst nativeWorkerHistoryEvidence = (${nativeWorkerHistoryEvidence.toString()});\nconst nativeWorkerSessionPlacement = (${nativeWorkerSessionPlacement.toString()});\nconst nativeWorkerPlacementObservation = (${nativeWorkerPlacementObservation.toString()});\nconst nativeWorkerTurnObservation = (${nativeWorkerTurnObservation.toString()});\nconst nativeWorkerTurnEventObservation = (${nativeWorkerTurnEventObservation.toString()});\nconst collectNativeWorkerFailure = (${collectNativeWorkerFailure.toString()});\nawait (${nativeWorkerProof.toString()})(${JSON.stringify({ namespaceId, agentId, timeout: plainChat ? 3 * 60_000 : nativeFirstAgentProofTimeout, plainChat, workspaceFile, expectedNodeId, session, sessionFile })});`;
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
  if (result.code !== 0) {
    // Only the proof's explicit failure record and exit 1 identify its stage.
    // A controller exit without that evidence leaves the stage unknown.
    const diagnostic =
      result.code === 1 && result.proof?.verified === false
        ? nativeFirstAgentProofDiagnostic(result.proof.stage, result.proof.worker)
        : undefined;
    const at = diagnostic
      ? `during ${diagnostic.failureStage}`
      : "without a recognized failure stage";
    throw Object.assign(new Error(`Native first-Agent proof failed ${at}; raw output withheld`), {
      openclawCiDiagnostic: diagnostic,
    });
  }
  assert.equal(result.proof?.verified, true);
  assert.ok(result.proof.profileId && result.proof.providerId && result.proof.environmentId);
  assert.ok(result.proof.session?.key && result.proof.session.sessionId);
  if (!plainChat) {
    assert.ok(typeof result.proof.hostname === "string" && result.proof.hostname.length > 0);
    assert.ok(result.proof.sessionFile?.path && result.proof.sessionFile.sha256);
  }
  return result.proof;
}
