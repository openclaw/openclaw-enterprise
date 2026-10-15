import { request } from "node:http";
import { isAbsolute, resolve } from "node:path";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { RepositoryCredentialClientConfiguration } from "../../drivers/repo/credentials/client-contracts.ts";
import {
  hasControlCharacter,
  normalizePushRefAllowlist,
} from "../../drivers/repo/credentials/client-contracts.ts";
import type {
  RepositoryCredentialBoundSessionInput,
  RepositoryCredentialSessionResult,
  SessionStatus,
} from "../../drivers/repo/credentials/service-contracts.ts";

/** Private wire response; the selected Driver renders the portable runtime files. */
export type RepositoryCredentialControlOpenResult =
  | { readonly kind: "created"; readonly result: RepositoryCredentialSessionResult }
  | { readonly kind: "recovered"; readonly status: SessionStatus }
  | { readonly kind: "missing" };

export interface RepositoryCredentialControlClient {
  descriptions(
    namespaceId: string,
    repositoryRefs: readonly string[],
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      providerInstanceId: string;
      appId: string;
      githubInstallationId: string;
      descriptions: readonly Readonly<{
        repositoryRef: string;
        repositoryId: string;
        description: string;
      }>[];
      pending: boolean;
    }>
  >;
  checkAdmissionReady(signal: AbortSignal): Promise<void>;
  open(
    input: RepositoryCredentialBoundSessionInput,
    admissionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialControlOpenResult>;
  status(sessionId: string, signal: AbortSignal): Promise<SessionStatus | undefined>;
  close(sessionId: string, signal: AbortSignal): Promise<SessionStatus | undefined>;
}

export class RepositoryCredentialControlError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean) {
    super(
      retryable
        ? "Repository credential control is unavailable."
        : "Repository credential admission was rejected.",
    );
    this.name = "RepositoryCredentialControlError";
    this.retryable = retryable;
  }
}

function unavailable(): never {
  throw new RepositoryCredentialControlError(true);
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(value, key))
  ) {
    return unavailable();
  }
  return value as Record<string, unknown>;
}

function githubId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 512 ||
    hasControlCharacter(value)
  ) {
    return unavailable();
  }
  return value;
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return unavailable();
  }
  return value;
}

function sessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return unavailable();
  }
  return value;
}

function binding(value: unknown): RepositoryCredentialGrantIdentity {
  const parsed = object(value, ["providerInstanceId", "repositoryId", "grantId"]);
  return Object.freeze({
    providerInstanceId: identity(parsed.providerInstanceId),
    repositoryId: identity(parsed.repositoryId),
    grantId: identity(parsed.grantId),
  });
}

function status(value: unknown): SessionStatus {
  const parsed = object(value, [
    "sessionId",
    "state",
    "deadlineWallMs",
    "binding",
    "activeUses",
    "cleanup",
  ]);
  const cleanup = object(parsed.cleanup, [
    "active",
    "pending",
    "revoked",
    "expired",
    "uncertain",
    "auxiliaryPending",
  ]);
  const deadlineWallMs = counter(parsed.deadlineWallMs);
  if (
    (parsed.state !== "OPEN" && parsed.state !== "CLOSED" && parsed.state !== "DISPOSED") ||
    typeof cleanup.auxiliaryPending !== "boolean" ||
    deadlineWallMs === 0
  ) {
    return unavailable();
  }
  const result = Object.freeze({
    sessionId: sessionId(parsed.sessionId),
    state: parsed.state,
    deadlineWallMs,
    binding: binding(parsed.binding),
    activeUses: counter(parsed.activeUses),
    cleanup: Object.freeze({
      active: counter(cleanup.active),
      pending: counter(cleanup.pending),
      revoked: counter(cleanup.revoked),
      expired: counter(cleanup.expired),
      uncertain: counter(cleanup.uncertain),
      auxiliaryPending: cleanup.auxiliaryPending,
    }),
  });
  if (
    result.state === "DISPOSED" &&
    (result.activeUses !== 0 ||
      result.cleanup.active !== 0 ||
      result.cleanup.pending !== 0 ||
      result.cleanup.uncertain !== 0 ||
      result.cleanup.auxiliaryPending)
  ) {
    return unavailable();
  }
  return result;
}

function client(value: unknown): RepositoryCredentialClientConfiguration {
  const hasPolicy =
    value !== null && typeof value === "object" && Object.hasOwn(value, "pushRefAllowlist");
  const parsed = object(value, [
    "gatewayOrigin",
    "gitRemote",
    "gitUsername",
    "canonicalApiHost",
    "apiHost",
    "repository",
    ...(hasPolicy ? ["pushRefAllowlist"] : []),
  ]);
  const fields: RepositoryCredentialClientConfiguration = {
    gatewayOrigin: identity(parsed.gatewayOrigin),
    gitRemote: identity(parsed.gitRemote),
    gitUsername: identity(parsed.gitUsername),
    canonicalApiHost: identity(parsed.canonicalApiHost),
    apiHost: identity(parsed.apiHost),
    repository: identity(parsed.repository),
    ...(hasPolicy ? { pushRefAllowlist: normalizePushRefAllowlist(parsed.pushRefAllowlist) } : {}),
  };
  const origin = new URL(fields.gatewayOrigin);
  const remote = new URL(fields.gitRemote);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== fields.gatewayOrigin ||
    origin.username ||
    origin.password ||
    remote.origin !== origin.origin ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash ||
    fields.apiHost !== origin.hostname ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(fields.canonicalApiHost) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(fields.repository) ||
    remote.pathname !== `/${fields.repository}.git`
  ) {
    return unavailable();
  }
  return Object.freeze(fields);
}

function opened(value: unknown): RepositoryCredentialSessionResult {
  const parsed = object(value, ["session", "bearer", "client"]);
  if (typeof parsed.bearer !== "string" || !/^[A-Za-z0-9_-]{43,256}$/.test(parsed.bearer)) {
    return unavailable();
  }
  const session = status(parsed.session);
  if (session.state !== "OPEN") {
    return unavailable();
  }
  return Object.freeze({ session, bearer: parsed.bearer, client: client(parsed.client) });
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Construction is local configuration only; neither a socket nor App material is opened. */
export class UnixRepositoryCredentialControlClient implements RepositoryCredentialControlClient {
  readonly #socket: string;

  constructor(options: { readonly controlSocket: string }) {
    if (
      !isAbsolute(options.controlSocket) ||
      resolve(options.controlSocket) !== options.controlSocket ||
      Buffer.byteLength(options.controlSocket) > 103 ||
      hasControlCharacter(options.controlSocket)
    ) {
      throw new Error("The repository credential control socket must be an absolute Unix path.");
    }
    this.#socket = options.controlSocket;
  }

  async descriptions(namespaceId: string, repositoryRefs: readonly string[], signal: AbortSignal) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespaceId) ||
      !Array.isArray(repositoryRefs) ||
      repositoryRefs.length < 1 ||
      repositoryRefs.length > 20 ||
      new Set(repositoryRefs).size !== repositoryRefs.length ||
      repositoryRefs.some((ref) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref))
    ) {
      throw new RepositoryCredentialControlError(false);
    }
    const reply = await this.call(
      "POST",
      "/v1/repository-descriptions",
      signal,
      { namespaceId, repositoryRefs },
      undefined,
      64 * 1024,
    );
    const parsed = object(reply.body, [
      "providerInstanceId",
      "appId",
      "githubInstallationId",
      "descriptions",
      "pending",
    ]);
    if (
      reply.status !== 200 ||
      typeof parsed.providerInstanceId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed.providerInstanceId) ||
      !githubId(parsed.appId) ||
      !githubId(parsed.githubInstallationId) ||
      typeof parsed.pending !== "boolean" ||
      !Array.isArray(parsed.descriptions) ||
      parsed.descriptions.length > 20
    ) {
      return unavailable();
    }
    const descriptions = new Map<string, { repositoryId: string; description: string }>();
    const duplicates = new Set<string>();
    for (const value of parsed.descriptions) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const ref = entry.repositoryRef;
      if (typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
        continue;
      }
      if (descriptions.has(ref) || duplicates.has(ref)) {
        descriptions.delete(ref);
        duplicates.add(ref);
        continue;
      }
      if (
        Object.keys(entry).some(
          (key) => !["repositoryRef", "repositoryId", "description"].includes(key),
        ) ||
        !githubId(entry.repositoryId) ||
        typeof entry.description !== "string" ||
        entry.description.trim().length === 0 ||
        entry.description.length > 512 ||
        hasControlCharacter(entry.description)
      ) {
        continue;
      }
      descriptions.set(ref, { repositoryId: entry.repositoryId, description: entry.description });
    }
    return Object.freeze({
      providerInstanceId: parsed.providerInstanceId,
      appId: parsed.appId,
      githubInstallationId: parsed.githubInstallationId,
      descriptions: Object.freeze(
        [...descriptions].map(([repositoryRef, entry]) =>
          Object.freeze({ repositoryRef, ...entry }),
        ),
      ),
      pending: parsed.pending,
    });
  }

  async checkAdmissionReady(signal: AbortSignal): Promise<void> {
    const reply = await this.call("GET", "/v1/capabilities", signal);
    const result = object(reply.body, ["durableAdmissionVersion"]);
    if (reply.status !== 200 || result.durableAdmissionVersion !== 1) {
      unavailable();
    }
  }

  async open(
    input: RepositoryCredentialBoundSessionInput,
    admissionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialControlOpenResult> {
    if (
      !/^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        admissionId,
      )
    ) {
      throw new RepositoryCredentialControlError(false);
    }
    const reply = await this.call("POST", "/v1/sessions", signal, input, admissionId);
    if (this.error(reply, "admission-missing")) {
      return { kind: "missing" };
    }
    try {
      if (reply.status === 201 && input.recoverOnly !== true) {
        return { kind: "created", result: opened(reply.body) };
      }
      if (reply.status === 200) {
        return { kind: "recovered", status: status(reply.body) };
      }
      return unavailable();
    } catch {
      return unavailable();
    }
  }

  async status(id: string, signal: AbortSignal): Promise<SessionStatus | undefined> {
    return this.session("GET", id, signal);
  }

  async close(id: string, signal: AbortSignal): Promise<SessionStatus | undefined> {
    return this.session("POST", id, signal);
  }

  async health(signal: AbortSignal): Promise<void> {
    const reply = await this.call("GET", "/healthz", signal);
    const result = object(reply.body, ["ready", "protocolVersion"]);
    if (reply.status !== 200 || result.ready !== true || result.protocolVersion !== 1) {
      unavailable();
    }
  }

  private async session(
    method: "GET" | "POST",
    id: string,
    signal: AbortSignal,
  ): Promise<SessionStatus | undefined> {
    sessionId(id);
    const reply = await this.call(
      method,
      `/v1/sessions/${id}${method === "POST" ? "/close" : ""}`,
      signal,
    );
    if (this.error(reply, "not-found")) {
      return undefined;
    }
    if (reply.status !== 200) {
      return unavailable();
    }
    const found = status(reply.body);
    if (found.sessionId !== id || (method === "POST" && found.state === "OPEN")) {
      return unavailable();
    }
    return found;
  }

  private error(reply: Reply, absent: "not-found" | "admission-missing"): boolean {
    if (
      reply.body !== null &&
      typeof reply.body === "object" &&
      Object.hasOwn(reply.body, "error")
    ) {
      const parsed = object(reply.body, ["error"]);
      if (reply.status === 404 && parsed.error === absent) {
        return true;
      }
      if (reply.status === 400 && parsed.error === "invalid-request") {
        throw new RepositoryCredentialControlError(false);
      }
      unavailable();
    }
    return false;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    input?:
      | RepositoryCredentialBoundSessionInput
      | Readonly<{ namespaceId: string; repositoryRefs: readonly string[] }>,
    admissionId?: string,
    maximumResponseBytes = 16 * 1024,
  ): Promise<Reply> {
    const body = input === undefined ? "" : JSON.stringify(input);
    const bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > 16 * 1024) {
      throw new RepositoryCredentialControlError(false);
    }
    try {
      return await new Promise<Reply>((resolveReply, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const outgoing = request(
          {
            socketPath: this.#socket,
            path,
            method,
            agent: false,
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            headers: {
              host: "localhost",
              connection: "close",
              "content-type": "application/json",
              "content-length": bodyBytes,
              ...(admissionId === undefined ? {} : { "x-admission-id": admissionId }),
            },
          },
          (incoming) => {
            incoming.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maximumResponseBytes) {
                incoming.destroy();
                outgoing.destroy();
                reject(new RepositoryCredentialControlError(true));
                return;
              }
              chunks.push(chunk);
            });
            incoming.once("error", reject);
            incoming.once("end", () => {
              try {
                if (
                  !incoming.complete ||
                  incoming.statusCode === undefined ||
                  incoming.headers["content-type"] !== "application/json"
                ) {
                  unavailable();
                }
                resolveReply({
                  status: incoming.statusCode,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                });
              } catch {
                reject(new RepositoryCredentialControlError(true));
              } finally {
                for (const chunk of chunks) {
                  chunk.fill(0);
                }
              }
            });
          },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
      });
    } catch {
      return unavailable();
    }
  }
}
