import { STATUS_CODES } from "node:http";
import {
  parameterExamples,
  requestExamples,
  responseExamples,
  errorExamples,
  meta,
} from "./api-examples.ts";

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const example = (value: unknown, summary: string) => ({ example: { summary, value } });
const cursorExamples: Record<string, string | undefined> = {
  listAgentRevisions: "v1.1",
  getAgentDeploymentRuntimeLogs: "v1.ZXhhbXBsZQ." + "x".repeat(43),
};
const rateLimitCodes: Record<string, string | undefined> = {
  signInEmail: "RATE_LIMITED",
  getAgentSandboxRecommendations: "RUNTIME_LOGS_RATE_LIMITED",
  getAgentDeploymentRuntime: "RUNTIME_LOGS_RATE_LIMITED",
  getAgentDeploymentRuntimeLogs: "RUNTIME_LOGS_RATE_LIMITED",
  getAgentHarnessStatus: "RUNTIME_LOGS_RATE_LIMITED",
  resolveAgentNativeAdminReturn: "NATIVE_ADMIN_RETURN_RATE_LIMITED",
  discoverAgentModels: "MODEL_DISCOVERY_RATE_LIMITED",
  lookupChannelDirectory: "CHANNEL_DIRECTORY_RATE_LIMITED",
  discoverAgentPlugins: "PLUGIN_DISCOVERY_RATE_LIMITED",
  discoverAgentPluginDetails: "PLUGIN_DISCOVERY_RATE_LIMITED",
  discoverSavedAgentPlugins: "PLUGIN_DISCOVERY_RATE_LIMITED",
  discoverSavedAgentPluginDetails: "PLUGIN_DISCOVERY_RATE_LIMITED",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected object: ${context}`);
  }
  return value;
}

function lookup<T>(table: T, key: string): unknown {
  if (!isRecord(table) || !Object.hasOwn(table, key)) {
    return undefined;
  }
  return table[key];
}

/** Enrich the exported contract in place. */
export function documentApiExamples<T>(document: T): T {
  const root = record(document, "document");
  const paths = record(root.paths, "paths");
  const used = new Set<string>();
  const sharedExamples: Record<string, unknown> = {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = record(rawItem, path);
    for (const [method, rawOperation] of Object.entries(item)) {
      if (!methods.has(method)) {
        continue;
      }
      const operation = record(rawOperation, `${method} ${path}`);
      const name = operation.operationId;
      if (typeof name !== "string" || !name || used.has(name)) {
        throw new Error(`Missing or duplicate operationId: ${method} ${path}`);
      }
      used.add(name);
      operation.description ??= operation.summary;
      const parameters = operation.parameters ?? [];
      if (!Array.isArray(parameters)) {
        throw new Error(`Expected parameters array: ${name}`);
      }
      for (const rawParameter of parameters) {
        const parameter = record(rawParameter, `${name} parameter`);
        const parameterName = parameter.name;
        if (typeof parameterName !== "string") {
          throw new Error(`Missing parameter name: ${name}`);
        }
        const value =
          parameterName === "cursor"
            ? (Object.hasOwn(cursorExamples, name) ? cursorExamples[name] : undefined)
            : lookup(parameterExamples, parameterName);
        if (value === undefined) {
          throw new Error(`Missing parameter example: ${name}.${parameterName}`);
        }
        parameter.examples = example(
          value,
          parameterName === "cursor"
            ? "Illustrative only: copy an actual cursor from the previous response."
            : "Example parameter; replace resource IDs with values from your Installation.",
        );
      }
      const requestBody =
        operation.requestBody === undefined
          ? undefined
          : record(operation.requestBody, `${name} request body`);
      const requestContent = record(requestBody?.content ?? {}, `${name} request content`);
      for (const rawContent of Object.values(requestContent)) {
        const content = record(rawContent, `${name} request media`);
        if (!Object.hasOwn(requestExamples, name)) {
          throw new Error(`Missing request example: ${name}`);
        }
        content.examples = example(lookup(requestExamples, name), "Example request");
      }
      const responses = record(operation.responses, `${name} responses`);
      for (const [status, rawResponse] of Object.entries(responses)) {
        const response = record(rawResponse, `${name} ${status} response`);
        const isError = Number(status) >= 400;
        let failure = lookupFailure(status);
        if (status === "429") {
          const code = Object.hasOwn(rateLimitCodes, name) ? rateLimitCodes[name] : undefined;
          if (!code) {
            throw new Error(`Missing rate limit example: ${name}`);
          }
          failure = [code, "Too many requests. Wait for Retry-After and try again."];
        }
        if (status === "504") {
          failure = ["RUNTIME_LOGS_TIMEOUT", "The runtime status or log read timed out."];
        }
        if (!response.description || response.description === "Default Response") {
          response.description = isError ? failure?.[1] : lookup(STATUS_CODES, status);
        }
        if (status === "204" || status === "302") {
          continue;
        }
        const responseContent = record(response.content ?? {}, `${name} ${status} content`);
        for (const [mediaType, rawContent] of Object.entries(responseContent)) {
          const content = record(rawContent, `${name} ${status} media`);
          if (isError) {
            if (!failure) {
              throw new Error(`Missing error example: ${name} ${status}`);
            }
            sharedExamples[failure[0]] = {
              summary: failure[0],
              value: { error: { code: failure[0], message: failure[1] }, meta },
            };
            content.examples = { example: { $ref: `#/components/examples/${failure[0]}` } };
          } else if (mediaType === "text/plain") {
            content.examples = example(
              "2026-10-01T12:00:00.000Z Agent ready\n",
              "Log download (download=true)",
            );
          } else {
            if (!Object.hasOwn(responseExamples, name)) {
              throw new Error(`Missing response example: ${name} ${status}`);
            }
            const data = lookup(responseExamples, name);
            const responseMeta =
              name === "listAgentRevisions" ? { ...meta, nextCursor: null } : meta;
            const examples: Record<string, unknown> = example(
              { data, meta: responseMeta },
              "Example response",
            );
            if (Array.isArray(data) && data.length) {
              examples.empty = {
                summary: "No readable resources",
                value: { data: [], meta: responseMeta },
              };
            }
            content.examples = examples;
          }
        }
      }
    }
  }
  for (const name of new Set([...Object.keys(requestExamples), ...Object.keys(responseExamples)])) {
    if (!used.has(name)) {
      throw new Error(`Example for unknown operation: ${name}`);
    }
  }
  root.components = { ...record(root.components ?? {}, "components"), examples: sharedExamples };
  root.servers = [{ url: "/", description: "Your OCC Installation origin" }];
  record(root.info, "info").description =
    "OpenClaw Control Plane HTTP API. Examples use synthetic IDs and credentials. Replace them with values from your Installation. Optional integrations require their configured Drivers. A 202 response accepts work; poll its status before treating it as complete.";
  return document;
}

function lookupFailure(status: string): readonly [string, string] | undefined {
  const value = lookup(errorExamples, status);
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new Error(`Invalid error example: ${status}`);
  }
  return [value[0], value[1]];
}
