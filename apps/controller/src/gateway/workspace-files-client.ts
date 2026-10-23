import {
  GatewayClient,
  type GatewayClientOptions,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from "@openclaw/gateway-client";
import type { WorkspaceFileName } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  ControllerWorkspaceFileUnknownOutcomeError,
  type ControllerWorkspaceFileData,
  isAllowedWorkspaceFileName,
  type ControllerWorkspaceFileReadRequest,
  type ControllerWorkspaceFileReadResult,
  type ControllerWorkspaceFilesAccess,
  type ControllerWorkspaceFileWriteRequest,
  type ControllerWorkspaceFileWriteResult,
} from "./contracts.ts";

export const NATIVE_WORKSPACE_FILE_CONTENT_MAX_BYTES = 16 * 1024;

export interface NativeWorkspaceFilesTarget {
  readonly url: string;
  readonly nativeAgentId: string;
  readonly apiKey: string;
  // Composition can follow an unambiguous native sole roster without listing Agents.
  readonly preferSoleNativeAgent?: true;
}

export type NativeWorkspaceFilesTargetResolver = (
  request: ControllerWorkspaceFileReadRequest | ControllerWorkspaceFileWriteRequest,
) => Promise<NativeWorkspaceFilesTarget | undefined> | NativeWorkspaceFilesTarget | undefined;

export function createNativeWorkspaceFilesAccess(
  resolveTarget: NativeWorkspaceFilesTargetResolver,
): ControllerWorkspaceFilesAccess {
  return {
    read: async (request) => {
      if (!isAllowedWorkspaceFileName(request.filename)) {
        return { status: "unavailable" };
      }
      const result = await requestNativeWorkspaceFile(request, resolveTarget, "read");
      if (result.status !== "ok") {
        return result;
      }
      return normalizeReadResponse(request.filename, result.payload);
    },
    write: async (request) => {
      if (
        !isAllowedWorkspaceFileName(request.filename) ||
        !validWorkspaceFileContent(request.content)
      ) {
        return { status: "unavailable" };
      }
      const result = await requestNativeWorkspaceFile(request, resolveTarget, "write");
      if (result.status !== "ok") {
        return { status: "unavailable" };
      }
      const normalized = normalizeWriteResponse(request.filename, result.payload);
      if (normalized.status !== "ok") {
        throw new ControllerWorkspaceFileUnknownOutcomeError(
          "The native gateway returned an invalid workspace file write acknowledgement.",
        );
      }
      return normalized;
    },
  };
}

type WorkspaceFileOperation = "read" | "write";
type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

type NativeRequestResult =
  | { readonly status: "ok"; readonly payload: unknown }
  | { readonly status: "missing" | "unavailable" };

async function requestNativeWorkspaceFile(
  request: ControllerWorkspaceFileReadRequest | ControllerWorkspaceFileWriteRequest,
  resolveTarget: NativeWorkspaceFilesTargetResolver,
  operation: WorkspaceFileOperation,
): Promise<NativeRequestResult> {
  const timeoutMs = remainingDeadlineMs(request.deadline);
  if (timeoutMs === undefined || request.signal.aborted) {
    return { status: "unavailable" };
  }

  let requestSent = false;
  let resolveHello!: (hello: GatewayHello) => void;
  let rejectHello!: (error: Error) => void;
  const connected = new Promise<GatewayHello>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  let client: GatewayClient | undefined;

  try {
    const target = normalizeTarget(await resolveTarget(request));
    if (target === undefined) {
      return { status: "unavailable" };
    }
    client = new GatewayClient({
      url: target.url,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      deviceIdentity: null,
      scopes: [],
      edgeAuthHeaders: { "x-api-key": target.apiKey },
      onHelloOk: resolveHello,
      onConnectError: rejectHello,
    });
    client.start();
    const hello = await waitForHello(connected, request, timeoutMs);
    if (!hasGrant(hello, operation)) {
      return { status: "unavailable" };
    }
    const defaults = hello.snapshot.sessionDefaults;
    const nativeAgentId =
      target.preferSoleNativeAgent === true &&
      defaults?.ownership === "sole" &&
      defaults.selectionRequired === false &&
      isNonEmptyString(defaults.defaultAgentId)
        ? defaults.defaultAgentId
        : target.nativeAgentId;
    const requestTimeoutMs = remainingDeadlineMs(request.deadline);
    if (requestTimeoutMs === undefined || request.signal.aborted) {
      return { status: "unavailable" };
    }
    const params =
      operation === "read"
        ? { agentId: nativeAgentId, name: request.filename }
        : {
            agentId: nativeAgentId,
            name: request.filename,
            content: (request as ControllerWorkspaceFileWriteRequest).content,
          };
    const payload = await client.request(
      operation === "read" ? "agents.files.get" : "agents.files.set",
      params,
      {
        signal: request.signal,
        timeoutMs: requestTimeoutMs,
        onSent: () => {
          requestSent = true;
        },
      },
    );
    return { status: "ok", payload };
  } catch (error) {
    if (operation === "write" && writeOutcomeUnknown(error, requestSent)) {
      throw new ControllerWorkspaceFileUnknownOutcomeError(undefined, { cause: error });
    }
    if (operation === "read" && isMissingFileError(error)) {
      return { status: "missing" };
    }
    return { status: "unavailable" };
  } finally {
    client?.stop();
    await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

function waitForHello(
  connected: Promise<GatewayHello>,
  request: ControllerWorkspaceFileReadRequest | ControllerWorkspaceFileWriteRequest,
  timeoutMs: number,
): Promise<GatewayHello> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      request.signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error("workspace file request aborted"));
    connected.then(
      (hello) => finish(resolve, hello),
      (error) => finish(reject, error),
    );
    if (request.signal.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(
      () => finish(reject, new Error("workspace file gateway connect timed out")),
      timeoutMs,
    );
    timeout.unref?.();
    request.signal.addEventListener("abort", abort, { once: true });
  });
}

function normalizeTarget(
  target: NativeWorkspaceFilesTarget | undefined,
): NativeWorkspaceFilesTarget | undefined {
  if (target === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "wss:") {
    return undefined;
  }
  if (!isNonEmptyString(target.nativeAgentId) || !isNonEmptyString(target.apiKey)) {
    return undefined;
  }
  return target;
}

function hasGrant(hello: GatewayHello, operation: WorkspaceFileOperation): boolean {
  if (hello.auth?.role !== "operator") {
    return false;
  }
  const scopes = Array.isArray(hello.auth.scopes) ? new Set(hello.auth.scopes) : new Set<string>();
  if (scopes.has("operator.admin")) {
    return true;
  }
  return operation === "read" && scopes.has("operator.read");
}

function normalizeReadResponse(
  filename: WorkspaceFileName,
  payload: unknown,
): ControllerWorkspaceFileReadResult {
  const file = asRecord(payload);
  if (file?.missing === true) {
    return { status: "missing" };
  }
  const nativeFile = asRecord(file?.file);
  if (nativeFile?.missing === true) {
    return { status: "missing" };
  }
  if (nativeFile?.name !== filename || typeof nativeFile.content !== "string") {
    return { status: "unavailable" };
  }
  if (!validWorkspaceFileContent(nativeFile.content)) {
    return { status: "unavailable" };
  }
  const size = safeSize(nativeFile.size);
  const response: ControllerWorkspaceFileData = {
    name: filename,
    content: nativeFile.content,
    ...(size === undefined ? {} : { size }),
  };
  return { status: "ok", file: response };
}

function normalizeWriteResponse(
  filename: WorkspaceFileName,
  payload: unknown,
): ControllerWorkspaceFileWriteResult {
  const file = asRecord(asRecord(payload)?.file);
  if (file?.name !== filename) {
    return { status: "unavailable" };
  }
  const size = safeSize(file.size);
  return { status: "ok", file: { name: filename, ...(size === undefined ? {} : { size }) } };
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof GatewayClientRequestError)) {
    return false;
  }
  const code = error.gatewayCode || error.code;
  if (code === "NOT_FOUND" || code === "ENOENT") {
    return true;
  }
  const details = asRecord(error.details);
  return details?.missing === true || details?.fileMissing === true;
}

function writeOutcomeUnknown(error: unknown, requestSent: boolean): boolean {
  if (error instanceof GatewayClientRequestError) {
    return false;
  }
  if (error instanceof GatewayClientRequestTimeoutError) {
    return error.requestSent || requestSent;
  }
  return requestSent;
}

function remainingDeadlineMs(deadline: Date): number | undefined {
  const remaining = deadline.getTime() - Date.now();
  return Number.isFinite(remaining) && remaining > 0
    ? Math.max(1, Math.floor(remaining))
    : undefined;
}

function validWorkspaceFileContent(value: string): boolean {
  const isWellFormed = (String.prototype as unknown as { isWellFormed: (this: string) => boolean })
    .isWellFormed;
  return (
    Buffer.byteLength(value, "utf8") <= NATIVE_WORKSPACE_FILE_CONTENT_MAX_BYTES &&
    !value.includes("\u0000") &&
    isWellFormed.call(value)
  );
}

function safeSize(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}
