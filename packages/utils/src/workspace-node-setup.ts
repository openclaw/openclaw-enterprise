import { isUtf8 } from "node:buffer";
import { asRecord } from "./objects.ts";
import { isNonEmptyString } from "./validation.ts";

export interface WorkspaceNodeSetupEnvelope {
  readonly url: string;
  readonly bootstrapToken: string;
  readonly expiresAtMs: number;
  readonly tlsFingerprint?: string;
}

export class WorkspaceNodeSetupValidationError extends Error {}

function nonempty(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new WorkspaceNodeSetupValidationError(`${description} must be a nonempty string.`);
  }
  return value;
}

function configurationObject(
  value: unknown,
  description: string,
): Readonly<Record<string, unknown>> {
  const object = asRecord(value);
  if (object === undefined) {
    throw new WorkspaceNodeSetupValidationError(`${description} must be an object.`);
  }
  return object;
}

/** Device identifiers accepted by the persisted workspace-node binding. */
export function isWorkspaceNodeDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export function canonicalWorkspaceNodeTlsFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const fingerprint = value.trim().replace(/^sha256:/iu, "");
  if (
    !/^[a-f0-9]{64}$/iu.test(fingerprint) &&
    !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/iu.test(fingerprint)
  ) {
    return undefined;
  }
  return fingerprint.replaceAll(":", "").toLowerCase();
}

/**
 * Validate the result of a trusted read of the exact admitted setup Secret.
 * This function performs no lookup and confers no authority to choose a Secret.
 */
export function validateWorkspaceNodeSetupSecret(
  secret: unknown,
  expected: Readonly<{ namespace: string; namespaceId: string; agentId: string; key: string }>,
): WorkspaceNodeSetupEnvelope {
  const metadata = asRecord(asRecord(secret)?.metadata);
  const secretLabels = asRecord(metadata?.labels);
  if (
    secret === undefined ||
    metadata?.namespace !== expected.namespace ||
    secretLabels?.["openclaw.dev/namespace"] !== expected.namespaceId ||
    secretLabels?.["openclaw.dev/agent"] !== expected.agentId
  ) {
    throw new WorkspaceNodeSetupValidationError(
      "Refusing a workspace node setup Secret without exact Agent ownership.",
    );
  }
  const secretData = asRecord(asRecord(secret)?.data);
  const encoded = secretData?.[nonempty(expected.key, "Workspace node setup Secret key")];
  if (typeof encoded !== "string") {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup Secret has no projected value.",
    );
  }
  const value = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (
    !isNonEmptyString(value) ||
    value.length > 65_536 ||
    Buffer.from(value, "utf8").toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup Secret contains invalid material.",
    );
  }
  const setupCode = value.toLowerCase().startsWith("oc-pair://")
    ? value.slice("oc-pair://".length)
    : value;
  if (!/^[A-Za-z0-9_-]+$/u.test(setupCode)) {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup Secret does not contain a base64url setup code.",
    );
  }
  let payload: Readonly<Record<string, unknown>>;
  try {
    const bytes = Buffer.from(setupCode, "base64url");
    if (!isUtf8(bytes)) {
      throw new Error("Invalid setup encoding.");
    }
    payload = configurationObject(
      JSON.parse(bytes.toString("utf8")),
      "Workspace node setup envelope",
    );
  } catch {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup Secret contains a malformed setup envelope.",
    );
  }
  const allowed = new Set(["url", "bootstrapToken", "expiresAtMs", "tlsFingerprint"]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup envelope contains unsupported fields.",
    );
  }
  const bootstrapToken = nonempty(payload.bootstrapToken, "Workspace node setup bootstrap token");
  const encodedDeviceId = secretData?.deviceId;
  const deviceId =
    typeof encodedDeviceId === "string"
      ? Buffer.from(encodedDeviceId, "base64").toString("utf8")
      : "";
  const recordedDevice =
    typeof encodedDeviceId === "string" &&
    isWorkspaceNodeDeviceId(deviceId) &&
    Buffer.from(deviceId, "utf8").toString("base64").replace(/=+$/u, "") ===
      encodedDeviceId.replace(/=+$/u, "");
  if (encodedDeviceId !== undefined && !recordedDevice) {
    throw new WorkspaceNodeSetupValidationError("The workspace node device ID is invalid.");
  }
  const expiresAtMs = payload.expiresAtMs;
  // A recorded device may reconnect after bootstrap expiry. Native still has
  // to verify its retained identity, Gateway scope, pin and device token.
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    (expiresAtMs <= Date.now() && !recordedDevice)
  ) {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup envelope is expired or has no bounded expiry.",
    );
  }
  if (
    payload.tlsFingerprint !== undefined &&
    canonicalWorkspaceNodeTlsFingerprint(payload.tlsFingerprint) === undefined
  ) {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup TLS fingerprint is invalid.",
    );
  }
  let endpoint: URL;
  try {
    const rawUrl = nonempty(payload.url, "Workspace node setup URL").trim();
    const hasInvalidCharacter = [...rawUrl].some(
      (character) => character.charCodeAt(0) <= 0x20 || character === "\\",
    );
    if (!/^wss?:\/\/[^/\\]/iu.test(rawUrl) || hasInvalidCharacter) {
      throw new Error("Invalid setup URL.");
    }
    endpoint = new URL(rawUrl);
  } catch {
    throw new WorkspaceNodeSetupValidationError("The workspace node setup URL is invalid.");
  }
  if (
    (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.search !== ""
  ) {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup URL must be an exact ws or wss endpoint without credentials, query, or fragment.",
    );
  }
  if (payload.tlsFingerprint !== undefined && endpoint.protocol !== "wss:") {
    throw new WorkspaceNodeSetupValidationError(
      "The workspace node setup TLS fingerprint requires a wss endpoint.",
    );
  }
  return Object.freeze({
    url: endpoint.href,
    bootstrapToken,
    expiresAtMs,
    ...(payload.tlsFingerprint === undefined
      ? {}
      : {
          tlsFingerprint: nonempty(payload.tlsFingerprint, "Workspace node setup TLS fingerprint"),
        }),
  });
}
