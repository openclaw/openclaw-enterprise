import type { BetterAuthOptions } from "better-auth";

type LibraryLog = NonNullable<NonNullable<BetterAuthOptions["logger"]>["log"]>;

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

function failureCode(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    const error = errorRecord(arg);
    const code = errorRecord(error?.body)?.code ?? error?.code ?? error?.name;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * Routes the auth library's own log calls into the API's structured log, one line each.
 * A refused API key is a client failure any caller can cause, and the request's completion
 * line already records the 401: it becomes one informational line with the refusal code.
 * Anything else stays an error (or warning) with a code only: the library's message and
 * arguments can carry request data, so neither is logged.
 */
export function authLibraryLog(
  emit: (event: Readonly<Record<string, unknown>>) => void,
): LibraryLog {
  return (level, _message, ...args: unknown[]) => {
    try {
      const refusal = args.map(clientRefusalCode).find((code) => code !== undefined);
      if (refusal !== undefined) {
        emit({ event: "authentication.request-refused", reasonCode: refusal });
        return;
      }
      const reasonCode = failureCode(args);
      emit({
        event:
          level === "error" ? "authentication.library-error" : "authentication.library-warning",
        ...(reasonCode === undefined ? {} : { reasonCode }),
      });
    } catch {
      // Logging never changes the authentication outcome.
    }
  };
}
