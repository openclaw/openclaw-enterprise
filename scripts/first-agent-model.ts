import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { defaultAgentModel } from "../apps/controller/src/console/agents/starter-model.mts";
import { admitGatewaySecurityDefaults } from "../packages/occ/src/gateway-security-defaults.ts";

type Fields = Record<string, unknown>;

// JavaScript property access keeps primitive boxing and required-field errors at their call sites.
// A wire object never supplies a type for the value read from it.
function fields(value: unknown): Fields {
  return value as Fields;
}

function optionalFields(value: unknown): Fields | undefined {
  return value == null ? undefined : fields(value);
}

export function selectFirstAgentModel(
  configuredModel: string | undefined,
  existing: unknown,
): unknown {
  const recorded = optionalFields(existing);
  const model = configuredModel || recorded?.model || defaultAgentModel;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(`${model}`)) {
    throw new Error(
      "OPENCLAW_FIRST_AGENT_MODEL must be a plain OpenAI model ID, without the provider prefix.",
    );
  }
  if (existing && configuredModel && model !== recorded?.model) {
    throw new Error(
      "This Agent's recorded Namespace or model differs. Reuse its recorded model or choose a new Agent name.",
    );
  }
  return model;
}

type RecordSelection = {
  name: string;
  namespaceId: unknown;
  harness: string;
  sandboxDriver: unknown;
  controlUi: boolean;
};

/**
 * The saved record of a repeated first-agent run, checked against this run's selection.
 * A saved record this helper cannot read (not version 3, or version 3 without
 * authMethod) is unsupported. Do not infer that it is older, and do not treat
 * choosing a new Agent name as the way to recover the existing Agent. Still
 * refuse it instead of claiming the selection differs (finding 1756) or that a
 * PAT needs OpenShell (finding 1798).
 */
export function reuseFirstAgentRecord<T>(existing: T, selection: RecordSelection): T {
  const saved = fields(existing);
  if (saved.version !== 3 || saved.authMethod === undefined) {
    throw new Error(
      "This Agent name has a saved record this helper does not recognize. The recorded resources were not changed. To keep using that Agent, recover the record with a helper that understands it. Choosing a new Agent name starts a different Agent.",
    );
  }
  if (
    saved.name !== selection.name ||
    saved.namespaceId !== selection.namespaceId ||
    saved.harness !== selection.harness ||
    saved.sandboxDriver !== selection.sandboxDriver ||
    saved.controlUi !== selection.controlUi
  ) {
    throw new Error(
      "This Agent's recorded Namespace, model, Harness, Sandbox Driver, or Control UI selection differs. Reuse its recorded selection or choose a new Agent name.",
    );
  }
  return existing;
}

// Only a prior PAT revision identified by the helper can have the former workspace-write
// policy, which OpenShell's blocked nested namespaces turn into failing shell tools.
export function firstAgentPriorPatPolicy(
  values: unknown,
  record: unknown,
  revisionId: unknown,
  priorRevisionId?: unknown,
): boolean {
  const saved = fields(record);
  if (
    saved.sandboxDriver !== "openshell" ||
    saved.harness !== "codex" ||
    saved.authMethod !== "codex_pat" ||
    priorRevisionId === undefined ||
    revisionId !== priorRevisionId
  ) {
    return false;
  }
  const plugins = optionalFields(fields(values).plugins);
  const entries = optionalFields(plugins?.entries);
  const codex = optionalFields(entries?.codex);
  const config = optionalFields(codex?.config);
  return optionalFields(config?.appServer)?.sandbox === "workspace-write";
}

export function firstAgentPriorPatPolicyWarning(revisionId: unknown): string {
  return (
    `Warning: revision ${revisionId} predates OpenShell full access and keeps the Codex ` +
    "workspace-write sandbox, which OpenShell blocks: the model answers, but shell tools fail. " +
    "Rerun with --replace-key to save the key again and deploy a new revision at the current " +
    "sandbox mode (danger-full-access with user review)."
  );
}

export function firstAgentRevisionValuesMatch(
  values: Fields,
  configured: Fields,
  record: unknown,
  revisionId: unknown,
  priorRevisionId?: unknown,
): boolean {
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

function snapshotValuesMatch(
  values: Fields,
  configured: Fields,
  record: unknown,
  revisionId: unknown,
  priorRevisionId: unknown,
): boolean {
  // Reconstruct the expected snapshot; never change the revision or ignore other drift.
  // Deployment names the helper's sole main Agent after the OCC Agent.
  const expected = structuredClone(configured);
  const saved = fields(record);
  expected.agents = {
    ...fields(expected.agents),
    entries: { main: { identity: { name: saved.name } } },
  };
  if (saved.sandboxDriver !== "openshell" || saved.harness !== "codex") {
    return isDeepStrictEqual(values, expected);
  }

  const priorPatPolicy = firstAgentPriorPatPolicy(values, record, revisionId, priorRevisionId);
  const entries = fields(fields(expected.plugins).entries);
  const config = fields(fields(entries.codex).config);
  const appServer = fields(config.appServer);
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

type ProbeFailureCode = keyof typeof probeMessages;
type ModelFailureCode = keyof typeof modelFailureMessages;

type RequestInterval = Readonly<{ start: number; end: number }>;

function isOwnKey<T extends object>(object: T, value: unknown): value is keyof T {
  return typeof value === "string" && Object.hasOwn(object, value);
}

function isHttpStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
}

function validProbeStatus(code: ProbeFailureCode, status: unknown): boolean {
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
        isHttpStatus(status) &&
        !(code === "upstream" ? [200, 401, 403, 404, 429] : [401, 403]).includes(status)
      );
    default:
      return status === undefined;
  }
}

// Keep the operator explanation and machine-readable classification together.
// Neither probe output nor an underlying command error is retained.
export class FirstAgentModelError extends Error {
  #code: ModelFailureCode;
  #status: number | undefined;
  #requestInterval: RequestInterval | undefined;

  constructor(code: unknown, status?: unknown, requestInterval?: unknown) {
    const known = isOwnKey(modelFailureMessages, code) ? code : "unexpected";
    const httpStatus =
      ["unauthenticated", "authorization", "endpoint", "rate_limit", "upstream"].includes(known) &&
      isHttpStatus(status)
        ? status
        : undefined;
    super(modelFailureMessages[known].replace("{status}", String(httpStatus ?? "unknown")));
    this.#code = known;
    this.#status = httpStatus;
    // Diagnostic coordinates only: never retain arbitrary probe output or errors.
    const { start, end } = optionalFields(requestInterval) ?? {};
    if (
      known === "upstream" &&
      httpStatus === 500 &&
      typeof start === "number" &&
      typeof end === "number" &&
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

function idHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function isKubernetesLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-zA-Z0-9](?:[-_.a-zA-Z0-9]*[a-zA-Z0-9])?$/.test(value)
  );
}

function readItems(output: string): unknown[] {
  const data: unknown = JSON.parse(output);
  const { items } = fields(data);
  if (!Array.isArray(items)) {
    throw new Error("Invalid Kubernetes list response");
  }
  return items;
}

function optionalItems(value: unknown): unknown[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Expected a Kubernetes list field");
  }
  return value;
}

// Preserve the selected fields from kubectl. The command runner owns argv validation,
// and diagnostics compares the optional coordinates to the runtime evidence it reads.
export type GatewaySelection = { pod: unknown; uid?: unknown; restartCount?: unknown };
type GatewayTarget = GatewaySelection & { namespace: unknown };

type KubectlOptions = { input?: string; timeout: number };
export type ModelKubectl = (
  ...args:
    | [
        verb: "get",
        resource: "namespaces",
        flag: "-l",
        selector: string,
        "-o",
        "json",
        KubectlOptions,
      ]
    | [
        verb: "get",
        resource: "pods",
        "--namespace",
        namespace: unknown,
        "-l",
        selector: string,
        "-o",
        "json",
        KubectlOptions,
      ]
    | [
        verb: "exec",
        "-i",
        "--namespace",
        namespace: unknown,
        pod: unknown,
        "-c",
        "gateway",
        "--",
        ...typeof gatewayProbeCommand,
        KubectlOptions,
      ]
) => Promise<string>;

function liveMetadata(resource: unknown): Fields | undefined {
  const metadata = optionalFields(fields(resource).metadata);
  return metadata?.name && !metadata.deletionTimestamp ? metadata : undefined;
}

async function findGateway(
  kubectl: ModelKubectl,
  namespaceId: string,
  agentId: string,
  revisionId: string,
  signal: AbortSignal | undefined,
): Promise<GatewayTarget> {
  const deadline = Date.now() + readinessTimeout;
  const configMap = `gateway-${idHash(agentId)}-rev-${idHash(revisionId)}`;
  const selector = [
    "app.kubernetes.io/managed-by=openclaw-enterprise",
    "openclaw.dev/workload-role=gateway",
    `openclaw.dev/namespace=${namespaceId}`,
    `openclaw.dev/agent=${agentId}`,
  ].join(",");
  let state: keyof typeof discoveryMessages = "cluster";

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let namespaces: Fields[] | undefined;
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
      ).flatMap((namespace) => {
        const metadata = liveMetadata(namespace);
        return metadata === undefined ? [] : [metadata];
      });
    } catch {
      state = "cluster";
    }

    signal?.throwIfAborted();
    if (namespaces && namespaces.length > 1) {
      throw new Error(
        "More than one Kubernetes namespace matches this Agent's gateway placement. Inspect their labels before retrying.",
      );
    }
    if (namespaces?.length === 0) {
      state = "namespace";
    }
    if (namespaces?.length === 1 && Date.now() < deadline) {
      const namespace = namespaces[0]!.name;
      try {
        const pods = readItems(
          await kubectl("get", "pods", "--namespace", namespace, "-l", selector, "-o", "json", {
            timeout: Math.min(kubectlTimeout, Math.max(1, deadline - Date.now())),
          }),
        ).flatMap((pod) => {
          const metadata = liveMetadata(pod);
          return metadata === undefined ? [] : [{ pod: fields(pod), metadata }];
        });
        const matching = pods.filter(({ pod }) =>
          optionalItems(optionalFields(pod.spec)?.volumes)?.some(
            (volume) => optionalFields(fields(volume).configMap)?.name === configMap,
          ),
        );
        const ready = matching.flatMap(({ pod, metadata }) => {
          const status = optionalFields(pod.status);
          const ready =
            status?.phase === "Running" &&
            optionalItems(status.conditions)?.some((condition) => {
              const { type, status } = fields(condition);
              return type === "Ready" && status === "True";
            });
          return ready && status ? [{ metadata, status }] : [];
        });
        if (ready.length > 0) {
          ready.sort((left, right) => {
            const name = left.metadata.name;
            if (typeof name !== "string") {
              throw new TypeError("The Gateway Pod name is not a string");
            }
            return name.localeCompare(`${right.metadata.name}`);
          });
          const { metadata, status } = ready[0]!;
          const gateway = optionalItems(status.containerStatuses)?.find(
            (container) => fields(container).name === "gateway",
          );
          return {
            namespace,
            pod: metadata.name,
            uid: metadata.uid,
            restartCount: optionalFields(gateway)?.restartCount,
          };
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

export function isGatewayCompletionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 45 &&
    /^chatcmpl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

// The wire receives a JSON string or array when includes is usable. A different type
// fails at the same point as the original optional includes call.
function includesCredential(value: unknown, credential: string): boolean {
  if (typeof value === "string") {
    return value.includes(credential);
  }
  if (Array.isArray(value)) {
    const values: unknown[] = value;
    return values.includes(credential);
  }
  throw new TypeError("result.response?.includes is not a function");
}

type ProbeFailure = {
  error: ProbeFailureCode;
  status?: number;
  requestInterval?: RequestInterval;
};

type AssistantResult = ProbeFailure | { text: string; runId: unknown };
type ProbeReceipt = { nonce: unknown; runId?: string; response?: string };

// Serialized with its helpers and executed inside the Gateway container.
async function probeInGateway(): Promise<void> {
  const emit = (value: ProbeFailure | ProbeReceipt) => process.stdout.write(JSON.stringify(value));
  const failure = (code: ProbeFailureCode, status?: number): ProbeFailure => ({
    error: code,
    ...(status === undefined ? {} : { status }),
  });
  try {
    let input = "";
    const stdin: AsyncIterable<string, unknown, unknown> = process.stdin.setEncoding("utf8");
    for await (const chunk of stdin) {
      input += chunk;
    }
    const parsed: unknown = JSON.parse(input);
    const { nonce, prompt, expectProviderKey, sessionKey } = fields(parsed);
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
    const credentials = providerKey ? [password, providerKey] : [password];
    if (
      prompt !== undefined &&
      credentials.some((credential) => includesCredential(prompt, credential))
    ) {
      emit(failure("credential_prompt"));
      return;
    }
    const url = "http://127.0.0.1:8080/v1/chat/completions";
    const noncePrompt = `Reply with exactly this nonce and no other text: ${nonce}`;

    async function request(content: unknown, authorized: boolean): Promise<Response | undefined> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (authorized) {
        headers.authorization = `Bearer ${password}`;
        if (sessionKey !== undefined) {
          // Leave header coercion to fetch, inside its error boundary.
          Reflect.set(headers, "x-openclaw-session-key", sessionKey);
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

    async function getAssistant(content: unknown): Promise<AssistantResult> {
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
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return failure("response_format");
      }
      const choice = optionalFields(fields(body).choices)?.[0];
      const result = optionalFields(optionalFields(choice)?.message)?.content;
      let text = "";
      if (typeof result === "string") {
        text = result;
      } else if (Array.isArray(result)) {
        const parts: unknown[] = result;
        text = parts
          .map((part) => {
            const text = optionalFields(part)?.text;
            return typeof text === "string" ? text : optionalFields(text)?.value;
          })
          .filter((part) => typeof part === "string")
          .join("");
      }
      if (!text.trim()) {
        return failure("response_format");
      }
      if (credentials.some((credential) => text.includes(credential))) {
        return failure("credential");
      }
      if (text.length > 20_000) {
        return failure("response_size");
      }
      return { text, runId: fields(body).id };
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
    if ("error" in proof) {
      emit(proof);
      return;
    }
    if (!proof.text.includes(`${nonce}`)) {
      emit(failure("nonce"));
      return;
    }

    const receipt: ProbeReceipt = { nonce };
    if (sessionKey !== undefined) {
      if (!isGatewayCompletionId(proof.runId)) {
        emit(failure("response_format"));
        return;
      }
      receipt.runId = proof.runId;
    }
    if (prompt !== undefined) {
      const result = await getAssistant(prompt);
      if ("error" in result) {
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
  [fields, optionalFields, includesCredential, isGatewayCompletionId]
    .map((helper) => helper.toString())
    .join("\n") + `\n(${probeInGateway.toString()})();`,
] as const);

export type ModelVerificationOptions = {
  namespaceId: string;
  agentId: string;
  revisionId: string;
  prompt?: string | undefined;
  apiKey?: string | undefined;
  expectProviderKey?: boolean | undefined;
  sessionKey?: string | undefined;
  signal?: AbortSignal | undefined;
  onGatewaySelected?: (gateway: GatewaySelection) => void;
};

type ModelVerification = {
  nonce: string;
  runId?: string;
  response?: string;
};

export function verifyFirstAgentModel(
  kubectl: ModelKubectl,
  options: ModelVerificationOptions & { sessionKey: string },
): Promise<ModelVerification & { runId: string }>;
export function verifyFirstAgentModel(
  kubectl: ModelKubectl,
  options: ModelVerificationOptions,
): Promise<ModelVerification>;
export async function verifyFirstAgentModel(
  kubectl: ModelKubectl,
  options: ModelVerificationOptions,
): Promise<ModelVerification> {
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

  const gateway = await findGateway(kubectl, namespaceId, agentId, revisionId, signal);
  const { namespace, pod } = gateway;
  options.onGatewaySelected?.({ pod, uid: gateway.uid, restartCount: gateway.restartCount });
  const nonce = `FIRST_AGENT_${randomUUID()}`;
  let output: string;
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
  let rawResult: unknown;
  try {
    rawResult = JSON.parse(output);
  } catch {
    throw new FirstAgentModelError("invalid_result");
  }
  const result = optionalFields(rawResult);
  if (result?.error) {
    // Wire failures must match the probe's branches. Execution/JSON failures
    // belong only to the local catches above, never to a returned payload.
    if (!isOwnKey(probeMessages, result.error) || !validProbeStatus(result.error, result.status)) {
      throw new FirstAgentModelError("unexpected");
    }
    throw new FirstAgentModelError(
      result.error,
      result.status,
      sessionKey === undefined ? undefined : result.requestInterval,
    );
  }
  if (result?.nonce !== nonce) {
    throw new FirstAgentModelError("invalid_result");
  }
  const proof: ModelVerification = { nonce };
  if (sessionKey !== undefined) {
    const runId = result.runId;
    if (!isGatewayCompletionId(runId)) {
      throw new FirstAgentModelError("invalid_result");
    }
    proof.runId = runId;
  }
  const response = result.response;
  if (prompt !== undefined) {
    if (typeof response !== "string" || !response.trim()) {
      throw new FirstAgentModelError("invalid_result");
    }
    proof.response = response;
  }
  if (
    typeof apiKey === "string" &&
    apiKey &&
    response != null &&
    includesCredential(response, apiKey)
  ) {
    throw new FirstAgentModelError("credential");
  }
  return proof;
}
