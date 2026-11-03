import { STATUS_CODES } from "node:http";
import {
  parameterExamples,
  requestExamples,
  responseExamples,
  errorExamples,
  meta,
} from "./api-examples.mjs";

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const example = (value, summary) => ({ example: { summary, value } });
const cursorExamples = {
  listAgentRevisions: "v1.1",
  getAgentDeploymentRuntimeLogs: "v1.ZXhhbXBsZQ." + "x".repeat(43),
};
const rateLimitCodes = {
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

/** Enrich the exported contract; leave runtime validation and serialization unchanged. */
export function documentApiExamples(document) {
  const used = new Set();
  const sharedExamples = {};
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) {
        continue;
      }
      const name = operation.operationId;
      if (!name || used.has(name)) {
        throw new Error(`Missing or duplicate operationId: ${method} ${path}`);
      }
      used.add(name);
      operation.description ??= operation.summary;
      for (const parameter of operation.parameters ?? []) {
        const value =
          parameter.name === "cursor" ? cursorExamples[name] : parameterExamples[parameter.name];
        if (value === undefined) {
          throw new Error(`Missing parameter example: ${name}.${parameter.name}`);
        }
        parameter.examples = example(
          value,
          parameter.name === "cursor"
            ? "Illustrative only: copy an actual cursor from the previous response."
            : "Example parameter; replace resource IDs with values from your Installation.",
        );
      }
      for (const content of Object.values(operation.requestBody?.content ?? {})) {
        if (!Object.hasOwn(requestExamples, name)) {
          throw new Error(`Missing request example: ${name}`);
        }
        content.examples = example(requestExamples[name], "Example request");
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        const isError = Number(status) >= 400;
        let failure = errorExamples[status];
        if (status === "429") {
          if (!rateLimitCodes[name]) {
            throw new Error(`Missing rate limit example: ${name}`);
          }
          failure = [
            rateLimitCodes[name],
            "Too many requests. Wait for Retry-After and try again.",
          ];
        }
        if (status === "504") {
          failure = ["RUNTIME_LOGS_TIMEOUT", "The runtime status or log read timed out."];
        }
        if (!response.description || response.description === "Default Response") {
          response.description = isError ? failure?.[1] : STATUS_CODES[status];
        }
        if (status === "204" || status === "302") {
          continue;
        }
        for (const [mediaType, content] of Object.entries(response.content ?? {})) {
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
            const data = responseExamples[name];
            const responseMeta =
              name === "listAgentRevisions" ? { ...meta, nextCursor: null } : meta;
            content.examples = example({ data, meta: responseMeta }, "Example response");
            if (Array.isArray(data) && data.length) {
              content.examples.empty = {
                summary: "No readable resources",
                value: { data: [], meta: responseMeta },
              };
            }
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
  document.components = { ...document.components, examples: sharedExamples };
  document.servers = [{ url: "/", description: "Your OCC Installation origin" }];
  document.info.description =
    "OpenClaw Control Plane HTTP API. Examples use synthetic IDs and credentials. Replace them with values from your Installation. Optional integrations require their configured Drivers. A 202 response accepts work; poll its status before treating it as complete.";
  return document;
}
