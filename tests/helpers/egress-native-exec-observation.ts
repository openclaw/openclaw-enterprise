import assert from "node:assert/strict";
import {
  parseJson,
  isArray,
  isBoundedInteger,
  isChoice,
  record,
} from "./egress-observation-values.ts";

export const nativeFailureMarker = "OCC_NATIVE_FAILURE_V1 ";
const phases = ["connect", "initialize", "thread/start", "turn/start", "turn"] as const;
const requests = ["initialize", "thread/start", "turn/start"] as const;
type Request = (typeof requests)[number];
const acknowledgementsByPhase = new Map<(typeof phases)[number], readonly (Request | null)[]>([
  ["connect", [null]],
  ["initialize", [null, "initialize"]],
  ["thread/start", [null, "initialize", "thread/start"]],
  ["turn/start", ["thread/start"]],
  ["turn", ["turn/start"]],
]);

const urlShapes = [
  "unknown",
  "missing",
  "empty",
  "malformed",
  "ws",
  "wss",
  "http",
  "https",
  "other",
] as const;
const failureSites = [
  "startup",
  "configuration",
  "websocket-constructor",
  "websocket-error",
  "websocket-close",
  "message-decode",
  "client",
] as const;

// Also embedded in the generated client. Classify the input without changing
// what is passed to WebSocket or retaining any part of the URL.
export function appServerUrlShape(value: unknown) {
  if (value === undefined) {
    return "missing";
  }
  if (value === "") {
    return "empty";
  }
  try {
    const scheme = new URL(`${value}`).protocol;
    switch (scheme) {
      case "ws:":
        return "ws";
      case "wss:":
        return "wss";
      case "http:":
        return "http";
      case "https:":
        return "https";
      default:
        return "other";
    }
  } catch {
    return "malformed";
  }
}

export function describeGatewayAppServerDeclaration(
  pod: { metadata: unknown; spec: { containers: readonly unknown[] } },
  containerName?: string,
) {
  const containers = pod.spec.containers;
  const defaultContainer =
    containerName ??
    record(record(pod.metadata).annotations)["kubectl.kubernetes.io/default-container"];
  const chosen =
    containers.find((entry) => {
      assert.ok(entry != null, "expected Pod container");
      return record(entry).name === defaultContainer;
    }) ?? (containerName === undefined && containers.length === 1 ? containers[0] : undefined);
  if (chosen === undefined) {
    return null;
  }
  const container = record(chosen);
  const describe = <Value>(name: string, classify: (value: unknown) => Value) => {
    const env = container.env;
    assert.ok(env == null || isArray(env), "expected container environment");
    const entry = env?.findLast((value) => {
      assert.ok(value != null, "expected environment entry");
      return record(value).name === name;
    });
    if (entry === undefined) {
      const sources = container.envFrom;
      const length =
        isArray(sources) || typeof sources === "string" ? sources.length : record(sources).length;
      return {
        source: length ? ("env-from-possible" as const) : ("not-declared" as const),
        value: null,
      };
    }
    const declaration = record(entry);
    if (declaration.valueFrom !== undefined) {
      return { source: "reference" as const, value: null };
    }
    const value = declaration.value ?? "";
    assert.ok(typeof value === "string" || isArray(value), "expected literal environment value");
    // Kubernetes may expand a literal using other environment variables.
    return { source: "literal" as const, value: value.includes("$(") ? null : classify(value) };
  };
  const url = describe("APP_SERVER_URL", appServerUrlShape);
  const token = describe("APP_SERVER_TOKEN", Boolean);
  return {
    urlSource: url.source,
    urlShape: url.value,
    tokenSource: token.source,
    tokenNonEmpty: token.value,
  };
}

export function readNativeFailure(stderr: string | undefined, tag: string, clientExit: boolean) {
  const marker = nativeFailureMarker + tag;
  const start = stderr?.indexOf(marker) ?? -1;
  if (stderr === undefined || start === -1) {
    return { status: "absent" as const };
  }
  const invalid = { status: "invalid" as const };
  const payload = start + marker.length + 1;
  const end = stderr.indexOf("\n", payload);
  if (
    !clientExit ||
    stderr[start - 1] !== "\n" ||
    stderr[payload - 1] !== " " ||
    end === -1 ||
    end - payload > 512 ||
    stderr.includes(marker, payload - 1)
  ) {
    return invalid;
  }
  try {
    const encoded = stderr.slice(payload, end);
    const {
      phase,
      lastAcknowledged,
      pendingRequests,
      receivedMessages,
      actionSeen,
      failureSite,
      urlShape,
      tokenPresent,
    } = record(parseJson(encoded));
    if (
      !isChoice(phases, phase) ||
      (lastAcknowledged !== null && !isChoice(requests, lastAcknowledged)) ||
      !acknowledgementsByPhase.get(phase)?.includes(lastAcknowledged) ||
      !isArray(pendingRequests) ||
      pendingRequests.length > 1 ||
      !pendingRequests.every(
        (method: unknown): method is Request =>
          isChoice(requests, method) && method === phase && lastAcknowledged !== phase,
      ) ||
      !isBoundedInteger(receivedMessages, 1_000_000) ||
      typeof actionSeen !== "boolean" ||
      !isChoice(failureSites, failureSite) ||
      !isChoice(urlShapes, urlShape) ||
      (tokenPresent !== null && typeof tokenPresent !== "boolean")
    ) {
      return invalid;
    }
    const observation = {
      phase,
      lastAcknowledged,
      pendingRequests,
      receivedMessages,
      actionSeen,
      failureSite,
      urlShape,
      tokenPresent,
    };
    // Re-encode only the closed schema. Unknown or duplicate keys and noncanonical
    // values must never survive a mixed stderr stream.
    return JSON.stringify(observation) === encoded
      ? { status: "recorded" as const, ...observation }
      : invalid;
  } catch {
    return invalid;
  }
}
