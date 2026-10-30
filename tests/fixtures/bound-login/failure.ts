export type FailureClass =
  | "local-setup"
  | "directory-refusal"
  | "context-refusal"
  | "malformed-config"
  | "exit"
  | "signal"
  | "timeout"
  | "cancelled"
  | "spawn"
  | "output-limit"
  | "unknown-reply"
  | "malformed-response"
  | "http-status"
  | "assertion";
export class QualificationFailure extends Error {
  readonly failureClass: FailureClass;
  readonly exitCode?: number;
  readonly httpStatus?: number;
  constructor(
    failureClass: FailureClass,
    details: { exitCode?: number; httpStatus?: number } = {},
  ) {
    super("Bound login operation failed: " + failureClass);
    this.failureClass = failureClass;
    if (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) {
      this.exitCode = details.exitCode;
    }
    if (
      typeof details.httpStatus === "number" &&
      Number.isInteger(details.httpStatus) &&
      details.httpStatus >= 100 &&
      details.httpStatus <= 599
    ) {
      this.httpStatus = details.httpStatus;
    }
  }
}

export interface RpcFailure {
  kind: "bound-login-rpc-failure";
  failureClass: "timeout" | "unknown-reply" | "http-status";
  httpStatus?: number;
}

/** Only the RPC CLI's fixed failure envelope may refine its native exit 2. */
export function readRpcFailure(text: string): QualificationFailure | undefined {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !value ||
    value.kind !== "bound-login-rpc-failure" ||
    Object.keys(value).some((key) => !["kind", "failureClass", "httpStatus"].includes(key))
  ) {
    return undefined;
  }
  if (value.failureClass === "http-status") {
    if (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599) {
      return undefined;
    }
  } else if (
    !["timeout", "unknown-reply"].includes(value.failureClass) ||
    value.httpStatus !== undefined
  ) {
    return undefined;
  }
  return new QualificationFailure(value.failureClass, {
    exitCode: 2,
    httpStatus: value.httpStatus,
  });
}
