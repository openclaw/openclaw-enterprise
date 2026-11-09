import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { defaultAgentModel } from "../apps/controller/src/console/agents/starter-model.mts";
import { admitGatewaySecurityDefaults } from "../packages/occ/src/gateway-security-defaults.ts";

export function selectFirstAgentModel(configuredModel, existing) {
  const model = configuredModel || existing?.model || defaultAgentModel;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)) {
    throw new Error(
      "OPENCLAW_FIRST_AGENT_MODEL must be a plain OpenAI model ID, without the provider prefix.",
    );
  }
  if (existing && configuredModel && model !== existing.model) {
    throw new Error(
      "This Agent's recorded Namespace or model differs. Reuse its recorded model or choose a new Agent name.",
    );
  }
  return model;
}

/**
 * The saved record of a repeated first-agent run, checked against this run's selection.
 * A saved record this helper cannot read (not version 3, or version 3 without
 * authMethod) is unsupported. Do not infer that it is older, and do not treat
 * choosing a new Agent name as the way to recover the existing Agent. Still
 * refuse it instead of claiming the selection differs (finding 1756) or that a
 * PAT needs OpenShell (finding 1798).
 */
export function reuseFirstAgentRecord(existing, selection) {
  if (existing.version !== 3 || existing.authMethod === undefined) {
    throw new Error(
      "This Agent name has a saved record this helper does not recognize. The recorded resources were not changed. To keep using that Agent, recover the record with a helper that understands it. Choosing a new Agent name starts a different Agent.",
    );
  }
  if (
    existing.name !== selection.name ||
    existing.namespaceId !== selection.namespaceId ||
    existing.harness !== selection.harness ||
    existing.sandboxDriver !== selection.sandboxDriver ||
    existing.controlUi !== selection.controlUi
  ) {
    throw new Error(
      "This Agent's recorded Namespace, model, Harness, Sandbox Driver, or Control UI selection differs. Reuse its recorded selection or choose a new Agent name.",
    );
  }
  return existing;
}

// Only a prior PAT revision identified by the helper can have the former workspace-write
// policy, which OpenShell's blocked nested namespaces turn into failing shell tools.
export function firstAgentPriorPatPolicy(values, record, revisionId, priorRevisionId) {
  return (
    record.sandboxDriver === "openshell" &&
    record.harness === "codex" &&
    record.authMethod === "codex_pat" &&
    priorRevisionId !== undefined &&
    revisionId === priorRevisionId &&
    values.plugins?.entries?.codex?.config?.appServer?.sandbox === "workspace-write"
  );
}

export function firstAgentPriorPatPolicyWarning(revisionId) {
  return (
    `Warning: revision ${revisionId} predates OpenShell full access and keeps the Codex ` +
    "workspace-write sandbox, which OpenShell blocks: the model answers, but shell tools fail. " +
    "Rerun with --replace-key to save the key again and deploy a new revision at the current " +
    "sandbox mode (danger-full-access with user review)."
  );
}

export function firstAgentRevisionValuesMatch(
  values,
  configured,
  record,
  revisionId,
  priorRevisionId,
) {
  // Deployment admission fills the Gateway security defaults the Configuration leaves unset.
  // A saved revision the helper identified may predate some of those fills, so fill it too
  // there: a default it lacks matches, and an explicit different value is still drift.
  const prior = priorRevisionId !== undefined && revisionId === priorRevisionId;
  return snapshotValuesMatch(
    prior ? admitGatewaySecurityDefaults(values) : values,
    admitGatewaySecurityDefaults(configured),
    record,
    revisionId,
    priorRevisionId,
  );
}

function snapshotValuesMatch(values, configured, record, revisionId, priorRevisionId) {
  // Reconstruct the expected snapshot; never change the revision or ignore other drift.
  // Deployment names the helper's sole main Agent after the OCC Agent.
  const expected = structuredClone(configured);
  expected.agents = { ...expected.agents, entries: { main: { identity: { name: record.name } } } };
  if (record.sandboxDriver !== "openshell" || record.harness !== "codex") {
    return isDeepStrictEqual(values, expected);
  }

  const priorPatPolicy = firstAgentPriorPatPolicy(values, record, revisionId, priorRevisionId);
  const appServer = expected.plugins.entries.codex.config.appServer;
  appServer.sandbox = priorPatPolicy ? "workspace-write" : "danger-full-access";
  appServer.approvalsReviewer = "user";
  return isDeepStrictEqual(values, expected);
}

const readinessTimeout = 8 * 60_000;
const readinessInterval = 5_000;
const kubectlTimeout = 15_000;

const discoveryMessages = {
  cluster: "Kubernetes did not answer. Check the selected kubeconfig and cluster.",
  namespace: "The Agent's tenant namespace has not appeared. Check controller reconciliation.",
  pod: "The Agent has no gateway Pod yet. Check the deployment in the console and the controller logs.",
  revision:
    "No gateway Pod mounts the requested revision. Check whether the Agent rolled back or a different revision is active.",
  ready:
    "The gateway Pod for the requested revision is not Ready. Check its events and container logs.",
};

const probeMessages = {
  missing_password:
    "The gateway Pod has no loopback gateway password. Check its Kubernetes Secret and restart the gateway if necessary.",
  missing_provider_key:
    "The gateway container has no OpenAI provider key. Check the Agent's provider Secret and redeploy before retrying.",
  credential_prompt:
    "The model prompt contained a credential and was not sent. Remove credentials from the prompt.",
  unavailable:
    "The gateway did not answer on its internal HTTP port. Check the gateway logs and run the command again.",
  unauthenticated:
    "The gateway did not reject an unauthenticated request with HTTP 401 or 403. Check gateway authentication before retrying.",
  authorization:
    "The gateway rejected its loopback password. Check gateway authentication and the mounted Secret.",
  endpoint:
    "The gateway returned HTTP 404. Check that HTTP chat completions are enabled for this Agent's deployed revision.",
  rate_limit:
    "The gateway returned HTTP 429. Check the provider's rate or usage limit before retrying.",
  upstream:
    "The gateway returned HTTP {status} for the model request. Check the provider credential, the selected model, and the gateway logs.",
  response_format:
    "The gateway returned HTTP 200 without a usable assistant response. Check the selected model and the gateway logs.",
  nonce:
    "The assistant did not return the verification nonce. Check the selected model and run the command again.",
  credential:
    "The assistant response contained a credential and was withheld. Do not request credentials in the prompt; review the Agent's tool permissions.",
  response_size:
    "The assistant response was too long to display. Retry with a prompt requesting a shorter response.",
  unexpected:
    "The gateway could not complete the model check. Check the gateway logs and run the command again.",
};

const modelFailureMessages = {
  ...probeMessages,
  execution:
    "Could not run the model check in the Agent's gateway. Check that the Pod is still Ready and that your Kubernetes identity can exec into it.",
  invalid_result:
    "The model check returned an invalid result. Check the gateway logs and run the command again.",
};

function validProbeStatus(code, status) {
  switch (code) {
    case "authorization":
      return status === 401 || status === 403;
    case "endpoint":
      return status === 404;
    case "rate_limit":
      return status === 429;
    case "unauthenticated":
    case "upstream":
      return (
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599 &&
        !(code === "upstream" ? [200, 401, 403, 404, 429] : [401, 403]).includes(status)
      );
    default:
      return status === undefined;
  }
}

// Keep the operator explanation and machine-readable classification together.
// Neither probe output nor an underlying command error is retained.
export class FirstAgentModelError extends Error {
  #code;
  #status;
  #requestInterval;

  constructor(code, status = undefined, requestInterval = undefined) {
    const known =
      typeof code === "string" && Object.hasOwn(modelFailureMessages, code) ? code : "unexpected";
    const httpStatus =
      ["unauthenticated", "authorization", "endpoint", "rate_limit", "upstream"].includes(known) &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : undefined;
    super(modelFailureMessages[known].replace("{status}", String(httpStatus ?? "unknown")));
    this.#code = known;
    this.#status = httpStatus;
    // Diagnostic coordinates only: never retain arbitrary probe output or errors.
    const { start, end } = requestInterval ?? {};
    if (
      known === "upstream" &&
      httpStatus === 500 &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end <= 8_640_000_000_000_000 &&
      end >= start &&
      end - start <= 180_000
    ) {
      this.#requestInterval = Object.freeze({ start, end });
    }
  }

  get code() {
    return this.#code;
  }
  get status() {
    return this.#status;
  }
  get requestInterval() {
    return this.#requestInterval;
  }
}

function idHash(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function isKubernetesLabel(value) {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-zA-Z0-9](?:[-_.a-zA-Z0-9]*[a-zA-Z0-9])?$/.test(value)
  );
}

function readItems(output) {
  const data = JSON.parse(output);
  if (!Array.isArray(data.items)) {
    throw new Error("Invalid Kubernetes list response");
  }
  return data.items;
}

async function findGateway(kubectl, namespaceId, agentId, revisionId, signal) {
  const deadline = Date.now() + readinessTimeout;
  const configMap = `gateway-${idHash(agentId)}-rev-${idHash(revisionId)}`;
  const selector = [
    "app.kubernetes.io/managed-by=openclaw-enterprise",
    "openclaw.dev/workload-role=gateway",
    `openclaw.dev/namespace=${namespaceId}`,
    `openclaw.dev/agent=${agentId}`,
  ].join(",");
  let state = "cluster";

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let namespaces;
    try {
      namespaces = readItems(
        await kubectl(
          "get",
          "namespaces",
          "-l",
          `openclaw.dev/namespace=${namespaceId}`,
          "-o",
          "json",
          {
            timeout: Math.min(kubectlTimeout, Math.max(1, deadline - Date.now())),
          },
        ),
      ).filter((namespace) => namespace.metadata?.name && !namespace.metadata.deletionTimestamp);
    } catch {
      state = "cluster";
    }

    signal?.throwIfAborted();
    if (namespaces?.length > 1) {
      throw new Error(
        "More than one Kubernetes namespace matches this Agent's gateway placement. Inspect their labels before retrying.",
      );
    }
    if (namespaces?.length === 0) {
      state = "namespace";
    }
    if (namespaces?.length === 1 && Date.now() < deadline) {
      const namespace = namespaces[0].metadata.name;
      try {
        const pods = readItems(
          await kubectl("get", "pods", "--namespace", namespace, "-l", selector, "-o", "json", {
            timeout: Math.min(kubectlTimeout, Math.max(1, deadline - Date.now())),
          }),
        ).filter((pod) => pod.metadata?.name && !pod.metadata.deletionTimestamp);
        const matching = pods.filter((pod) =>
          pod.spec?.volumes?.some((volume) => volume.configMap?.name === configMap),
        );
        const ready = matching.filter(
          (pod) =>
            pod.status?.phase === "Running" &&
            pod.status.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        );
        if (ready.length > 0) {
          ready.sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
          return { namespace, pod: ready[0].metadata.name };
        }
        state = pods.length === 0 ? "pod" : matching.length === 0 ? "revision" : "ready";
      } catch {
        state = "cluster";
      }
    }

    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await delay(Math.min(readinessInterval, remaining), undefined, { signal });
    }
  }

  throw new Error(`Timed out waiting for the Agent's gateway. ${discoveryMessages[state]}`);
}

export function isGatewayCompletionId(value) {
  return (
    typeof value === "string" &&
    value.length === 45 &&
    /^chatcmpl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

// Serialized with its completion-ID validator and executed inside the Gateway container.
async function probeInGateway() {
  const emit = (value) => process.stdout.write(JSON.stringify(value));
  const failure = (code, status) => ({ error: code, ...(status === undefined ? {} : { status }) });
  try {
    let input = "";
    for await (const chunk of process.stdin.setEncoding("utf8")) {
      input += chunk;
    }
    const { nonce, prompt, expectProviderKey, sessionKey } = JSON.parse(input);
    const providerKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const password = process.env.OPENCLAW_GATEWAY_PASSWORD;
    if (!password) {
      emit(failure("missing_password"));
      return;
    }
    if (expectProviderKey && !providerKey) {
      emit(failure("missing_provider_key"));
      return;
    }
    const credentials = [password, providerKey].filter(Boolean);
    if (prompt !== undefined && credentials.some((credential) => prompt.includes(credential))) {
      emit(failure("credential_prompt"));
      return;
    }
    const url = "http://127.0.0.1:8080/v1/chat/completions";
    const noncePrompt = `Reply with exactly this nonce and no other text: ${nonce}`;

    async function request(content, authorized) {
      const headers = { "content-type": "application/json" };
      if (authorized) {
        headers.authorization = `Bearer ${password}`;
        if (sessionKey !== undefined) {
          headers["x-openclaw-session-key"] = sessionKey;
        }
      }
      try {
        return await fetch(url, {
          method: "POST",
          redirect: "manual",
          headers,
          body: JSON.stringify({
            model: "openclaw/default",
            stream: false,
            messages: [{ role: "user", content }],
          }),
          signal: AbortSignal.timeout(authorized ? 160_000 : 15_000),
        });
      } catch {
        return undefined;
      }
    }

    async function getAssistant(content) {
      const start = Date.now();
      const response = await request(content, true);
      const end = Date.now();
      if (!response) {
        return failure("unavailable");
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        const code = [401, 403].includes(response.status)
          ? "authorization"
          : response.status === 404
            ? "endpoint"
            : response.status === 429
              ? "rate_limit"
              : "upstream";
        return {
          ...failure(code, response.status),
          ...(sessionKey !== undefined && response.status === 500
            ? { requestInterval: { start, end } }
            : {}),
        };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return failure("response_format");
      }
      const result = body.choices?.[0]?.message?.content;
      const text =
        typeof result === "string"
          ? result
          : Array.isArray(result)
            ? result
                .map((part) => (typeof part?.text === "string" ? part.text : part?.text?.value))
                .filter((part) => typeof part === "string")
                .join("")
            : "";
      if (!text.trim()) {
        return failure("response_format");
      }
      if (credentials.some((credential) => text.includes(credential))) {
        return failure("credential");
      }
      if (text.length > 20_000) {
        return failure("response_size");
      }
      return { text, runId: body.id };
    }

    const denied = await request(noncePrompt, false);
    if (!denied) {
      emit(failure("unavailable"));
      return;
    }
    await denied.body?.cancel().catch(() => {});
    if (![401, 403].includes(denied.status)) {
      emit(failure("unauthenticated", denied.status));
      return;
    }

    const proof = await getAssistant(noncePrompt);
    if (proof.error) {
      emit(proof);
      return;
    }
    if (!proof.text.includes(nonce)) {
      emit(failure("nonce"));
      return;
    }

    const receipt = { nonce };
    if (sessionKey !== undefined) {
      if (!isGatewayCompletionId(proof.runId)) {
        emit(failure("response_format"));
        return;
      }
      receipt.runId = proof.runId;
    }
    if (prompt !== undefined) {
      const result = await getAssistant(prompt);
      if (result.error) {
        emit(result);
        return;
      }
      emit({ ...receipt, response: result.text });
      return;
    }
    emit(receipt);
  } catch {
    emit(failure("unexpected"));
  }
}

// Only source-owned code goes in the command. The prompt and per-request values travel on stdin.
export const gatewayProbeCommand = Object.freeze([
  "node",
  "--input-type=module",
  "--eval",
  `${isGatewayCompletionId.toString()}\n(${probeInGateway.toString()})();`,
]);

/**
 * @param {{ namespaceId: string, agentId: string, revisionId: string,
 *   prompt?: string | undefined, apiKey?: string | undefined, expectProviderKey?: boolean | undefined,
 *   sessionKey?: string | undefined, signal?: AbortSignal | undefined }} options
 */
export async function verifyFirstAgentModel(kubectl, options) {
  const {
    namespaceId,
    agentId,
    revisionId,
    prompt,
    apiKey,
    expectProviderKey = true,
    sessionKey,
    signal,
  } = options;
  if (
    !isKubernetesLabel(namespaceId) ||
    !isKubernetesLabel(agentId) ||
    typeof revisionId !== "string" ||
    !revisionId
  ) {
    throw new Error(
      "A valid namespace ID, Agent ID, and deployed revision ID are required to check the model.",
    );
  }
  // Limit this internal QA selector to synthetic git-withdrawal conversations.
  if (
    sessionKey !== undefined &&
    (typeof sessionKey !== "string" ||
      sessionKey.length !== 62 ||
      !/^agent:main:git-withdrawal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        sessionKey,
      ))
  ) {
    throw new Error("The QA session key must be a synthetic git-withdrawal UUID key.");
  }
  if (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim())) {
    throw new Error("The model prompt must contain text.");
  }
  if (typeof apiKey === "string" && apiKey && prompt?.includes(apiKey)) {
    throw new Error(
      "The model prompt contains the provider API key and was not sent. Remove the key from the prompt.",
    );
  }

  const { namespace, pod } = await findGateway(kubectl, namespaceId, agentId, revisionId, signal);
  const nonce = `FIRST_AGENT_${randomUUID()}`;
  let output;
  try {
    output = await kubectl(
      "exec",
      "-i",
      "--namespace",
      namespace,
      pod,
      "-c",
      "gateway",
      "--",
      ...gatewayProbeCommand,
      { input: JSON.stringify({ nonce, prompt, expectProviderKey, sessionKey }), timeout: 420_000 },
    );
  } catch {
    throw new FirstAgentModelError("execution");
  }
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new FirstAgentModelError("invalid_result");
  }
  if (result?.error) {
    // Wire failures must match the probe's branches. Execution/JSON failures
    // belong only to the local catches above, never to a returned payload.
    if (
      typeof result.error !== "string" ||
      !Object.hasOwn(probeMessages, result.error) ||
      !validProbeStatus(result.error, result.status)
    ) {
      throw new FirstAgentModelError("unexpected");
    }
    throw new FirstAgentModelError(
      result.error,
      result.status,
      sessionKey === undefined ? undefined : result.requestInterval,
    );
  }
  if (
    result?.nonce !== nonce ||
    (sessionKey !== undefined && !isGatewayCompletionId(result.runId)) ||
    (prompt !== undefined && (typeof result.response !== "string" || !result.response.trim()))
  ) {
    throw new FirstAgentModelError("invalid_result");
  }
  if (typeof apiKey === "string" && apiKey && result.response?.includes(apiKey)) {
    throw new FirstAgentModelError("credential");
  }
  return {
    nonce,
    ...(sessionKey !== undefined && { runId: result.runId }),
    ...(prompt !== undefined && { response: result.response }),
  };
}
