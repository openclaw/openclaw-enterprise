import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthOptions } from "better-auth";

type LibraryLog = NonNullable<NonNullable<BetterAuthOptions["logger"]>["log"]>;

/**
 * Which OCE call into the auth library a log line belongs to. A closed list named here, never
 * text from the library: a line outside every call below says `unattributed`.
 */
export type AuthLibraryOperation =
  | "verify-api-key"
  | "verify-session"
  | "resolve-session"
  | "session-check"
  | "sign-in-password"
  | "sign-out"
  | "provider-start"
  | "provider-callback"
  | "provider-result"
  | "create-service-key";

/**
 * The request an auth library call serves: the ID the API answers with (`meta.requestId`), the
 * method and the route pattern (`/agents/:agentId/chat`), never the path, query or a header.
 */
export interface AuthLogRequest {
  readonly requestId: string;
  readonly method: string;
  readonly route?: string;
}

interface AuthLogContext extends Partial<AuthLogRequest> {
  readonly operation: AuthLibraryOperation;
}

// The library calls its logger inside the OCE call that reached it, so the line can name that
// call and its request without the library passing either.
const contexts = new AsyncLocalStorage<AuthLogContext>();

/** Runs one OCE call into the auth library; its log lines name the operation and request. */
export function withAuthLogContext<T>(
  operation: AuthLibraryOperation,
  request: AuthLogRequest | undefined,
  work: () => T,
): T {
  return contexts.run(
    request === undefined
      ? { operation }
      : {
          operation,
          requestId: request.requestId,
          method: request.method,
          ...(request.route === undefined ? {} : { route: request.route }),
        },
    work,
  );
}

function contextFields(): Readonly<Record<string, string>> {
  const context = contexts.getStore();
  if (context === undefined) {
    return { operation: "unattributed" };
  }
  return {
    operation: context.operation,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    ...(context.method === undefined ? {} : { method: context.method }),
    ...(context.route === undefined ? {} : { route: context.route }),
  };
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

// A client failure the library reports as an error: an APIError with a 4xx status, such as
// an unknown, revoked, disabled or expired API key. Returns its code ("INVALID_API_KEY").
function clientRefusalCode(value: unknown): string | undefined {
  const error = errorRecord(value);
  const status = error?.statusCode;
  if (typeof status !== "number" || status < 400 || status >= 500) {
    return undefined;
  }
  const code = errorRecord(error?.body)?.code;
  return typeof code === "string" ? code : "CLIENT_REFUSED";
}

// The same check the structured log applies to `reasonCode`; a candidate that fails it falls
// through to the next, so a rejected code still leaves the error's class name.
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// A PostgreSQL SQLSTATE ("57P01", "23505"): starts with a digit, so it is kept as `code`, as
// `database.idle-client-error` keeps it, rather than as a `reasonCode`.
const SQLSTATE = /^[0-9A-Z]{5}$/;

// The class an error was built from ("DatabaseError"), when it is not a plain object.
function className(error: Record<string, unknown>): string | undefined {
  const name: unknown = Object.getPrototypeOf(error)?.constructor?.name;
  return typeof name === "string" && name !== "Object" ? name : undefined;
}

function failureFields(error: Record<string, unknown>): Readonly<Record<string, string>> {
  const candidates = [errorRecord(error.body)?.code, error.code, className(error), error.name];
  const reasonCode = candidates.find(
    (code): code is string => typeof code === "string" && SAFE_CODE.test(code),
  );
  // The query builder wraps a driver error and keeps it as `cause`.
  const sqlState = [error.code, errorRecord(error.cause)?.code].find(
    (code): code is string =>
      typeof code === "string" && SQLSTATE.test(code) && !SAFE_CODE.test(code),
  );
  return {
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(sqlState === undefined ? {} : { code: sqlState }),
  };
}

function firstFailureFields(args: readonly unknown[]): Readonly<Record<string, string>> {
  for (const arg of args) {
    const error = errorRecord(arg);
    if (error !== undefined) {
      const fields = failureFields(error);
      if (Object.keys(fields).length > 0) {
        return fields;
      }
    }
  }
  return {};
}

/**
 * One `authentication.library-error` line for an exception the auth library could not classify
 * and threw to OCE: the operation, its request, and the error's code or class name only.
 */
export function authLibraryFailureEvent(error: unknown): Readonly<Record<string, unknown>> {
  const event = { event: "authentication.library-error", ...contextFields() };
  try {
    return { ...event, ...firstFailureFields([error]) };
  } catch {
    return event;
  }
}

/**
 * Routes the auth library's own log calls into the API's structured log, one line each.
 * A refused API key is a client failure any caller can cause, and the request's completion
 * line already records the 401: it becomes one informational line with the refusal code and
 * the request it refused. Anything else stays an error (or warning) naming the OCE operation
 * and a code or class name: the library's message and arguments can carry request data (an
 * email address, an origin, a key), so neither is logged.
 */
export function authLibraryLog(
  emit: (event: Readonly<Record<string, unknown>>) => void,
): LibraryLog {
  return (level, _message, ...args: unknown[]) => {
    try {
      const refusal = args.map(clientRefusalCode).find((code) => code !== undefined);
      if (refusal !== undefined) {
        emit({
          event: "authentication.request-refused",
          ...contextFields(),
          reasonCode: refusal,
        });
        return;
      }
      emit({
        event:
          level === "error" ? "authentication.library-error" : "authentication.library-warning",
        ...contextFields(),
        ...firstFailureFields(args),
      });
    } catch {
      // Logging never changes the authentication outcome.
    }
  };
}
