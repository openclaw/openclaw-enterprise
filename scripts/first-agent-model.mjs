import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { defaultAgentModel } from "../apps/controller/src/console/agents/starter-model.mjs";

export const firstAgentProviders = Object.freeze({
  openai: Object.freeze({
    label: "OpenAI",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    keyEnvironment: "OPENAI_API_KEY",
  }),
  anthropic: Object.freeze({
    label: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    keyEnvironment: "ANTHROPIC_API_KEY",
  }),
});

function validBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    value.length <= 2_048 &&
    value.trim() === value &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

export const firstAgentRecordVersion = 2;

export function selectFirstAgentModel(configured, existing) {
  if (
    existing &&
    (existing.version !== firstAgentRecordVersion ||
      !Object.hasOwn(firstAgentProviders, existing.provider) ||
      typeof existing.baseUrl !== "string")
  ) {
    throw new Error(
      "This Agent's local record was written by an older first-agent helper or is invalid. Choose a new Agent name; the existing Agent was not changed.",
    );
  }
  const recordedProvider = existing?.provider;
  const recordedBaseUrl = existing?.baseUrl;
  const provider = configured.provider || recordedProvider || "openai";
  if (!Object.hasOwn(firstAgentProviders, provider)) {
    throw new Error('OPENCLAW_FIRST_AGENT_PROVIDER must be "openai" or "anthropic".');
  }
  const baseUrl = configured.baseUrl || recordedBaseUrl || firstAgentProviders[provider].baseUrl;
  if (!validBaseUrl(baseUrl)) {
    throw new Error(
      "OPENCLAW_FIRST_AGENT_BASE_URL must be an https URL without credentials, query, or fragment.",
    );
  }
  if (existing && (provider !== recordedProvider || baseUrl !== recordedBaseUrl)) {
    throw new Error(
      "This Agent's recorded model provider or base URL differs. Reuse its recorded selection or choose a new Agent name.",
    );
  }
  const model =
    configured.model || existing?.model || (provider === "openai" ? defaultAgentModel : undefined);
  if (!model) {
    throw new Error(
      `Set OPENCLAW_FIRST_AGENT_MODEL to the served model ID for the ${provider} provider.`,
    );
  }
  if (
    model.length > 100 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(model) ||
    model.startsWith(`${provider}/`)
  ) {
    throw new Error(
      `OPENCLAW_FIRST_AGENT_MODEL must be the served model ID without the ${provider}/ prefix: letters, digits, ".", "_", or "-", with "/" only between segments.`,
    );
  }
  if (existing && configured.model && model !== existing.model) {
    throw new Error(
      "This Agent's recorded Namespace or model differs. Reuse its recorded model or choose a new Agent name.",
    );
  }
  return { provider, baseUrl, model };
}

export function firstAgentConfiguration({ provider, baseUrl, model }) {
  const { api, keyEnvironment } = firstAgentProviders[provider];
  const selected = `${provider}/${model}`;
  return {
    kind: "agent",
    values: {
      gateway: {
        mode: "local",
        bind: "lan",
        controlUi: { enabled: false },
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
        http: { endpoints: { chatCompletions: { enabled: true } } },
      },
      agents: {
        defaults: {
          model: selected,
          skipBootstrap: true,
          models: { [selected]: { agentRuntime: { id: "openclaw" } } },
        },
      },
      tools: { deny: ["*"] },
      secrets: { providers: { model: { source: "env", allowlist: [keyEnvironment] } } },
      models: {
        providers: {
          [provider]: {
            baseUrl,
            api,
            apiKey: { source: "env", provider: "model", id: keyEnvironment },
            models: [{ id: model, name: model }],
          },
        },
      },
    },
  };
}

const readinessTimeout = 8 * 60_000;
const readinessInterval = 5_000;
const kubectlTimeout = 15_000;

const discoveryMessages = {
  cluster: "Kubernetes did not answer. Check the selected kubeconfig and cluster.",
  namespace: "The tenant namespace has not appeared. Check controller reconciliation.",
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
    "The gateway container has no {provider} provider key. Check the Agent's provider Secret and redeploy before retrying.",
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

async function findGateway(kubectl, namespaceId, agentId, revisionId) {
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

    if (namespaces?.length > 1) {
      throw new Error(
        "More than one Kubernetes namespace matches this platform namespace. Inspect their labels before retrying.",
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

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await delay(Math.min(readinessInterval, remaining));
    }
  }

  throw new Error(`Timed out waiting for the Agent's gateway. ${discoveryMessages[state]}`);
}

// This function is serialized to stdin and executed inside the gateway container.
async function probeInGateway({ nonce, prompt, keyEnvironment }) {
  const emit = (value) => process.stdout.write(JSON.stringify(value));
  const failure = (code, status) => ({ error: code, ...(status === undefined ? {} : { status }) });
  try {
    const providerKey = process.env[keyEnvironment];
    delete process.env[keyEnvironment];
    const password = process.env.OPENCLAW_GATEWAY_PASSWORD;
    if (!password) {
      emit(failure("missing_password"));
      return;
    }
    if (!providerKey) {
      emit(failure("missing_provider_key"));
      return;
    }
    const credentials = [password, providerKey];
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
      const response = await request(content, true);
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
        return failure(code, response.status);
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
      return { text };
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

    if (prompt !== undefined) {
      const result = await getAssistant(prompt);
      if (result.error) {
        emit(result);
        return;
      }
      emit({ nonce, response: result.text });
      return;
    }
    emit({ nonce });
  } catch {
    emit(failure("unexpected"));
  }
}

export async function verifyFirstAgentModel(
  kubectl,
  { namespaceId, agentId, revisionId, prompt, apiKey, provider },
) {
  if (!Object.hasOwn(firstAgentProviders, provider)) {
    throw new Error("The model check requires a supported model provider.");
  }
  const { label, keyEnvironment } = firstAgentProviders[provider];
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
  if (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim())) {
    throw new Error("The model prompt must contain text.");
  }
  if (typeof apiKey === "string" && apiKey && prompt?.includes(apiKey)) {
    throw new Error(
      "The model prompt contains the provider API key and was not sent. Remove the key from the prompt.",
    );
  }

  const { namespace, pod } = await findGateway(kubectl, namespaceId, agentId, revisionId);
  const nonce = `FIRST_AGENT_${randomUUID()}`;
  const script = `await (${probeInGateway.toString()})(${JSON.stringify({ nonce, prompt, keyEnvironment })});`;
  let result;
  try {
    const output = await kubectl(
      "exec",
      "-i",
      "--namespace",
      namespace,
      pod,
      "-c",
      "gateway",
      "--",
      "node",
      "--input-type=module",
      "-",
      { input: script, timeout: 420_000 },
    );
    result = JSON.parse(output);
  } catch {
    throw new Error(
      "Could not run the model check in the Agent's gateway. Check that the Pod is still Ready and that your Kubernetes identity can exec into it.",
    );
  }
  if (result?.error) {
    const message = probeMessages[result.error] ?? probeMessages.unexpected;
    const status =
      Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
        ? result.status
        : "unknown";
    throw new Error(message.replace("{status}", String(status)).replace("{provider}", label));
  }
  if (
    result?.nonce !== nonce ||
    (prompt !== undefined && (typeof result.response !== "string" || !result.response.trim()))
  ) {
    throw new Error(
      "The model check returned an invalid result. Check the gateway logs and run the command again.",
    );
  }
  if (typeof apiKey === "string" && apiKey && result.response?.includes(apiKey)) {
    throw new Error(probeMessages.credential);
  }
  return prompt === undefined ? { nonce } : { nonce, response: result.response };
}
