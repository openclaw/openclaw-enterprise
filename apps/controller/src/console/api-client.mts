import type { ViewLifetime } from "./view-lifetime.mjs";

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  expectedStatus?: number;
  includeMeta?: boolean;
  responseType?: "json" | "text";
  /** A session-scoped read that a later view joins instead of aborting it. */
  outlivesView?: boolean;
  /**
   * A read the console makes because it takes the caller for an Installation administrator:
   * "required" when only that administration allows it, "path" when other grants may allow it too
   * (a Secret's metadata by ID). The console sends these one at a time until a "required" one
   * succeeds, and refuses them unsent once it knows the caller does not administer the
   * Installation (finding D760).
   */
  installationAdministration?: "required" | "path";
}

/** Options for a read only Installation administration allows. */
export const INSTALLATION_ADMINISTRATION = { installationAdministration: "required" } as const;
/** Options for a read on the administrator path that other grants may also allow. */
export const ADMINISTRATOR_PATH = { installationAdministration: "path" } as const;

/**
 * Whether a refusal settled that the caller does not administer the Installation: the console
 * refused the read unsent, or the refusal itself settled it. The page then takes its member path.
 */
export function refusedAsNonAdministrator(cause: unknown) {
  return responseFields(cause).notAdministrator === true;
}

interface ApiClientOptions {
  lifetime: Pick<ViewLifetime, "capture" | "isCurrent" | "signal">;
  hasSession(): boolean;
  onExpired(): void;
  sessionKey?(): string | null;
}

interface ErrorDetail {
  path: string;
  code: string;
  message?: string;
}

export interface ConsoleApiError extends Error {
  status: number;
  code?: string;
  serverMessage?: string;
  details: ErrorDetail[];
  detailPaths?: string[];
  retryAfterSeconds?: number;
  requestId?: string;
  remainingResources?: { kind: string; count: number; ids: string[] }[];
}

// Responses are untrusted JSON. Check each field before exposing it on an error.
export function responseFields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** An HTTP refusal has a status. A failed fetch or an unusable success response may have none. */
export function requestFailure(cause: unknown) {
  const { status, requestId, serverMessage, code, retryAfterSeconds } = responseFields(cause);
  return {
    status: typeof status === "number" ? status : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
    serverMessage: typeof serverMessage === "string" ? serverMessage : undefined,
    code: typeof code === "string" ? code : undefined,
    retryAfterSeconds: typeof retryAfterSeconds === "number" ? retryAfterSeconds : undefined,
  };
}

// The API's denial of a caller's own request when it names no grant. An API from before finding
// 2534 sends it for every such denial. It names nothing the caller can act on, so views keep their
// own guidance instead of showing it.
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";

/**
 * The API's denial of a caller's own request that names the grant the request checked and who
 * grants it (finding 2534), or undefined. The API words it from the request alone, never from
 * whether the resource exists, so views show it as written.
 */
export function namedDenial(cause: unknown): string | undefined {
  const { status, code, serverMessage } = requestFailure(cause);
  return status === 403 && code === "FORBIDDEN" && serverMessage?.startsWith("Not authorized: ")
    ? serverMessage
    : undefined;
}

function validDetail(value: unknown): value is ErrorDetail {
  const { path, code, message } = responseFields(value);
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    /^(?:\/(?:[^~/]|~0|~1)*)*$/.test(path) &&
    typeof code === "string" &&
    (message === undefined || (typeof message === "string" && message.length <= 512))
  );
}

/** Field errors a view can show from an HTTP refusal; transport errors have none. */
export function requestErrorDetails(cause: unknown): ErrorDetail[] {
  const { details } = responseFields(cause);
  return Array.isArray(details) ? details.slice(0, 32).filter(validDetail) : [];
}

export function createApiClient({
  lifetime,
  hasSession,
  onExpired,
  sessionKey = () => null,
}: ApiClientOptions) {
  async function request(
    path: string,
    {
      method = "GET",
      body,
      signal,
      expectedStatus,
      includeMeta = false,
      responseType = "json",
      outlivesView = false,
    }: RequestOptions = {},
  ): Promise<unknown> {
    const active = lifetime.capture();
    const pinned = sessionKey();
    // A pinned key lets this tab act only as its own session. If another tab
    // replaces the shared cookie, the controller answers 401 instead.
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(pinned ? { "x-occ-session-key": pinned } : {}),
    };
    const requestSignal = AbortSignal.any([
      ...(outlivesView ? [] : [lifetime.signal]),
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15_000),
    ]);
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: requestSignal,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Expiry invalidates the whole view, including other reads or saves still pending.
    if (response.status === 401 && hasSession() && lifetime.isCurrent(active)) {
      onExpired();
    }
    if (response.status === 204 && response.ok && expectedStatus === 204) {
      return undefined;
    }
    let payload: Record<string, unknown>;
    try {
      // Attachments (runtime log downloads) are text; failures stay JSON error envelopes.
      if (
        responseType === "text" &&
        response.status === 200 &&
        response.headers.get("content-type")?.startsWith("text/plain")
      ) {
        return await response.text();
      }
      payload = responseFields(await response.json());
    } catch (error) {
      // Body reads can fail after fetch returned headers. Keep cancellation,
      // deadline and socket failures distinct from a complete, malformed JSON body.
      requestSignal.throwIfAborted();
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      payload = {};
    }
    if (
      !response.ok ||
      (expectedStatus !== undefined && response.status !== expectedStatus) ||
      !Object.hasOwn(payload, "data")
    ) {
      const problem = responseFields(payload.error);
      const details: unknown[] = Array.isArray(problem.details) ? problem.details : [];
      const error: ConsoleApiError = Object.assign(
        new Error("The request could not be completed."),
        { status: response.status, details: requestErrorDetails(problem) },
      );
      const code = problem.code;
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
        error.code = code;
      }
      if (code === "NAMESPACE_NOT_EMPTY" && Array.isArray(problem.remainingResources)) {
        error.remainingResources = problem.remainingResources.slice(0, 7).flatMap((entry) => {
          const { kind, count, ids } = responseFields(entry);
          return typeof kind === "string" &&
            kind.length <= 64 &&
            typeof count === "number" &&
            Number.isSafeInteger(count) &&
            count >= 0 &&
            Array.isArray(ids) &&
            ids.length <= 20 &&
            ids.every(
              (id): id is string => typeof id === "string" && /^[a-z]+_[0-9a-f-]{36}$/.test(id),
            )
            ? [{ kind, count, ids }]
            : [];
        });
      }
      // The API's own sentence, for views that show it instead of a generic status text.
      const serverMessage = problem.message;
      if (
        typeof serverMessage === "string" &&
        serverMessage.length > 0 &&
        serverMessage.length <= 256 &&
        !/\p{Cc}/u.test(serverMessage)
      ) {
        error.serverMessage = serverMessage;
      }
      const detailPaths = details
        .map((detail) => responseFields(detail).path)
        .filter(
          (path): path is string =>
            typeof path === "string" && /^\/[A-Za-z0-9_/~-]{0,128}$/.test(path),
        );
      if (detailPaths.length > 0) {
        error.detailPaths = detailPaths;
      }
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null && /^[1-9][0-9]{0,4}$/.test(retryAfter)) {
        error.retryAfterSeconds = Number(retryAfter);
      }
      const requestId = responseFields(payload.meta).requestId;
      if (
        typeof requestId === "string" &&
        /^req_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId)
      ) {
        error.requestId = requestId;
      }
      throw error;
    }
    return includeMeta ? { data: payload.data, meta: payload.meta } : payload.data;
  }

  return request;
}
