import type {
  CredentialProviderDefinition,
  EgressRequest,
  EgressResponse,
  EgressOperation,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import { normalizeOpenAiBaseUrl } from "../openai-endpoint.ts";
import { validChatRequest, validResponsesRequest } from "./openai-responses.ts";
import { protectedResponseOutput, protectedResponsesStream } from "./openai-responses-stream.ts";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";

const maximumResponseBytes = 4 * 1024 * 1024;

const jsonType = /^application\/json(?:;\s*charset=utf-8)?$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function contentType(headers: EgressRequest["headers"]): string {
  const types = headers.filter(([name]) => name.toLowerCase() === "content-type");
  return types.length === 1 ? types[0]![1] : "";
}

function validHeaders(headers: EgressRequest["headers"], forbidden: string[]): boolean {
  return (
    headers.length <= 64 &&
    headers.every(
      ([name, value]) => !/[\r\n\0]/.test(name + value) && !forbidden.includes(name.toLowerCase()),
    )
  );
}

function jsonRequest(request: EgressRequest): Record<string, unknown> | undefined {
  const headers = request.headers;
  if (
    !jsonType.test(contentType(headers)) ||
    !validHeaders(headers, [
      "content-encoding",
      "transfer-encoding",
      "upgrade",
      "proxy-authorization",
      "x-oce-binding",
    ])
  ) {
    return undefined;
  }
  try {
    return asRecord(parseUnambiguousJson(utf8.decode(request.body)));
  } catch {
    return undefined;
  }
}

function protectedResponse(
  response: EgressResponse,
  credential: string,
  request: EgressRequest,
  operation: EgressOperation,
): EgressResponse | undefined {
  if (
    operation.kind !== "inference" ||
    response.status < 200 ||
    response.status >= 600 ||
    (response.status >= 300 && response.status < 400) ||
    response.body.byteLength > maximumResponseBytes ||
    // No trailer semantics are approved for this provider. Check actual trailers,
    // not merely a Trailer declaration (HTTP/2 need not declare them in advance).
    response.trailers.length !== 0
  ) {
    return undefined;
  }
  const mediaType = contentType(response.headers);
  const streaming = jsonRequest(request)?.stream === true;
  const sse = streaming && /^text\/event-stream(?:;\s*charset=utf-8)?$/i.test(mediaType);
  if (
    !(sse || (jsonType.test(mediaType) && (!streaming || response.status >= 400))) ||
    !validHeaders(response.headers, ["content-encoding", "trailer", "upgrade"])
  ) {
    return undefined;
  }
  try {
    const body = utf8.decode(response.body);
    const encodings = [
      credential,
      encodeURIComponent(credential),
      Buffer.from(credential).toString("base64"),
      Buffer.from(credential).toString("base64url"),
    ];
    const leaked = (value: string): boolean =>
      encodings.some((candidate) => value.includes(candidate));
    // Keep parsed-string scans bounded, including decoded data split across SSE deltas.
    const scan = (root: unknown): boolean => {
      const pending = [{ value: root, depth: 0 }];
      let nodes = 0;
      while (pending.length) {
        const { value, depth } = pending.pop()!;
        if (++nodes > 100_000 || depth > 64 || (typeof value === "string" && leaked(value))) {
          return false;
        }
        if (value !== null && typeof value === "object") {
          for (const [key, item] of Object.entries(value)) {
            if (leaked(key)) {
              return false;
            }
            pending.push({ value: item, depth: depth + 1 });
          }
        }
      }
      return true;
    };
    // Parse first so JSON escapes cannot hide credential bytes from the response policy.
    if (leaked(body) || response.headers.some(([name, value]) => leaked(name) || leaked(value))) {
      return undefined;
    }
    if (sse) {
      if (
        !protectedResponsesStream(body, operation.model, {
          scan,
          leaked,
          fragmentOverlap: Math.max(1, ...encodings.map((value) => value.length - 1)),
        })
      ) {
        return undefined;
      }
    } else {
      const parsed: unknown = parseUnambiguousJson(body);
      if (!asRecord(parsed) || !scan(parsed) || !protectedResponseOutput(parsed, scan)) {
        return undefined;
      }
    }
    return {
      status: response.status,
      headers: [["content-type", sse ? "text/event-stream" : "application/json"]],
      body: new Uint8Array(response.body),
      trailers: [],
    };
  } catch {
    return undefined;
  }
}

/** Bounded inference with Harness-local tools and complete finite Responses SSE custody. */
export const openAiStaticProvider: CredentialProviderDefinition =
  Object.freeze<CredentialProviderDefinition>({
    // Generation 1 could grant only one executable. Exact provider-generation
    // matching prevents an upgrade or rollback from reinterpreting that grant.
    ref: { id: "openai-static-https", generation: 2 },
    schemaVersion: 1,
    sourceType: {
      type: "openai",
      config: [{ name: "base_url", required: false }],
      secrets: [{ name: "api_key", required: true }],
      rotation: "external",
      harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
    },
    normalizeConfig(config) {
      if (Object.keys(config).some((field) => field !== "base_url")) {
        throw new Error("Unsupported inference source configuration.");
      }
      const baseUrl = normalizeOpenAiBaseUrl(config.base_url ?? "https://api.openai.com/v1");
      if (!baseUrl) {
        throw new Error("Unsupported inference source endpoint.");
      }
      return { base_url: baseUrl };
    },
    normalizeGrant(models) {
      if (models.length !== 1 || !models[0] || models[0].length > 256) {
        throw new Error("Protected inference requires one explicit model.");
      }
      return immutableCopy({ kind: "inference", models, providerTools: "none" as const });
    },
    routes(source, binding) {
      const base = new URL(this.normalizeConfig(source.config).base_url!);
      return ["responses", "chat/completions"].map((operation) =>
        immutableCopy({
          route: {
            id: `${binding.binding.id}/${operation}`,
            generation: binding.binding.generation,
          },
          binding,
          origin: base.origin,
          path: `${base.pathname}/${operation}`,
          method: "POST" as const,
          operationPolicy: { id: "openai-bounded-inference", generation: 1 },
          responsePolicy: { id: "openai-bounded-response", generation: 1 },
          deadlineMs: 30_000,
        }),
      );
    },
    classify(route, request) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return undefined;
      }
      if (
        url.href !== request.url ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        request.method !== route.method ||
        url.origin !== route.origin ||
        url.pathname !== route.path
      ) {
        return undefined;
      }
      const body = jsonRequest(request);
      if (
        !body ||
        typeof body.model !== "string" ||
        route.binding.grant.kind !== "inference" ||
        route.binding.grant.providerTools !== "none" ||
        !route.binding.grant.models.includes(body.model)
      ) {
        return undefined;
      }
      const valid = route.path.endsWith("/responses") ? validResponsesRequest : validChatRequest;
      return valid(body) ? { kind: "inference", action: "generate", model: body.model } : undefined;
    },
    inject(value) {
      if (value.length < 8 || value.length > 8192 || /[^\x21-\x7e]/.test(value)) {
        throw new Error("Static inference credential format is unsupported.");
      }
      return [["authorization", `Bearer ${value}`]];
    },
    credentialRejected(response) {
      if (
        response.status !== 401 ||
        response.body.byteLength > maximumResponseBytes ||
        !jsonType.test(contentType(response.headers)) ||
        response.headers.some(([name]) => name.toLowerCase() === "content-encoding")
      ) {
        return false;
      }
      try {
        const body = asRecord(parseUnambiguousJson(utf8.decode(response.body)));
        const error = asRecord(body?.error);
        return error?.code === "invalid_api_key" && error.type === "invalid_request_error";
      } catch {
        return false;
      }
    },
    protectResponse: (response, value, request, operation) =>
      value === undefined ? undefined : protectedResponse(response, value, request, operation),
  });
