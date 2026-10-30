import { AssertionError } from "node:assert";
import { run, cleanEnvironment } from "../repository-credentials/process.mjs";
import { QualificationFailure, readRpcFailure, type FailureClass } from "./failure.ts";

interface CommandOptions {
  env: ReturnType<typeof cleanEnvironment>;
  timeout?: number;
  input?: string;
  signal?: AbortSignal;
  allowFailure?: boolean;
  boundRpc?: boolean;
}
// Keep the existing native process-group owner and its cleanup unchanged.
const runCommand = run as (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<{ code: unknown; stdout: string }>;
// These are exact, fixed messages emitted by that owner, never forwarded as evidence.
const transportFailures = new Map<string, FailureClass>([
  ["command failed (timeout)", "timeout"],
  ["command failed (cancelled)", "cancelled"],
  ["command cancelled", "cancelled"],
  ["command failed (spawn failed)", "spawn"],
  ["command failed (output overflow)", "output-limit"],
]);

export type Action =
  | "private-directory"
  | "local-setup"
  | "prerequisites"
  | "kubeconfig-view"
  | "git"
  | "archive"
  | "certificate"
  | "helm-install"
  | "helm-upgrade"
  | "helm-package"
  | "helm-read"
  | "kubernetes-create"
  | "kubernetes-apply"
  | "kubernetes-read"
  | "kubernetes-wait"
  | "kubernetes-exec"
  | "kubernetes-label"
  | "kubernetes-annotate"
  | "kubernetes-delete"
  | "namespace-create"
  | "browser-new"
  | "browser-freeze"
  | "browser-pin"
  | "browser-bootstrap"
  | "console-read"
  | "console-mutate"
  | "oauth-callback"
  | "peer-authorize"
  | "command";

/** One serial qualification. Any unknown or invalid result permanently closes admission. */
export class QualificationOperations {
  #stopped = false;
  #active = false;
  #action: Action = "prerequisites";
  #failure: Record<string, unknown> | undefined;
  #checkpoint: (action: Action) => void;
  private readonly signal: AbortSignal;
  constructor(signal: AbortSignal, checkpoint: (action: Action) => void = () => {}) {
    this.signal = signal;
    this.#checkpoint = checkpoint;
  }

  begin(action: Action) {
    if (this.#stopped || this.#active || this.signal.aborted) {
      throw this.stop();
    }
    this.#action = action;
    this.#checkpoint(action);
  }

  stop(error?: unknown): Error {
    this.#stopped = true;
    const failure =
      error instanceof QualificationFailure
        ? error
        : new QualificationFailure(
            error instanceof AssertionError
              ? "assertion"
              : error instanceof SyntaxError
                ? "malformed-response"
                : this.signal.aborted
                  ? "cancelled"
                  : "unknown-reply",
          );
    this.#failure ??= {
      action: this.#action,
      failureClass: failure.failureClass,
      ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
      // Even a received local exit says nothing conclusive about a remote mutation.
      remoteOutcome: "unknown",
    };
    return new Error("Qualification stopped; no dependent calls permitted");
  }

  reportFailure(
    error: unknown,
    stage: string,
    commandCount: number,
    diagnostic: (text: string) => void,
  ): Error {
    this.stop(error);
    const report = JSON.stringify({
      stage,
      status: "FAILED_OR_UNKNOWN",
      installedQualified: false,
      commandCount,
      ...this.#failure,
    });
    diagnostic(report);
    return new Error("Bound login qualification failed: " + report);
  }

  expectStatus(actual: number, expected: number) {
    if (actual !== expected) {
      const failure = new QualificationFailure("http-status", { httpStatus: actual });
      throw this.stop(failure);
    }
  }

  // Status belongs to this exchange only; never cache it on the action recorder.
  validateResponse<T>(
    reply: { status: number },
    expected: number,
    validate: () => T,
    mismatch: "malformed-response" | "assertion" = "malformed-response",
  ): T {
    if (this.#stopped || this.#active || this.signal.aborted) {
      throw this.stop();
    }
    this.expectStatus(reply.status, expected);
    try {
      return validate();
    } catch (error) {
      const failureClass =
        mismatch === "assertion" && error instanceof AssertionError
          ? "assertion"
          : "malformed-response";
      throw this.stop(new QualificationFailure(failureClass, { httpStatus: reply.status }));
    }
  }

  async command(command: string, args: string[], options: CommandOptions) {
    return this.call(async () => {
      let result;
      try {
        result = await runCommand(command, args, {
          ...options,
          allowFailure: true,
          signal: this.signal,
        });
      } catch (error) {
        const kind = error instanceof Error ? transportFailures.get(error.message) : undefined;
        throw new QualificationFailure(kind ?? "unknown-reply");
      }
      // The native close event has a null code on signal termination. Owner-side
      // timeouts and cancellation throw above, including bounded-join failures.
      if (result.code === null) {
        throw new QualificationFailure("signal");
      }
      if (result.code !== 0) {
        if (options.boundRpc && result.code === 2) {
          const failure = readRpcFailure(result.stdout);
          if (failure) {
            throw failure;
          }
        }
        if (typeof result.code === "number" && Number.isSafeInteger(result.code)) {
          throw new QualificationFailure("exit", { exitCode: result.code });
        }
        throw new QualificationFailure("unknown-reply");
      }
      return result.stdout;
    });
  }

  async reply(text: string, shape: "ack" | "response" | "authorization") {
    return this.call(async () => {
      const result = JSON.parse(text);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new QualificationFailure("malformed-response");
      }
      if ("error" in result) {
        // The private peer can only contribute these bounded classes and a numeric status.
        const kind = result.failureClass;
        throw new QualificationFailure(
          kind === "timeout" ||
            kind === "malformed-response" ||
            kind === "http-status" ||
            kind === "assertion"
            ? kind
            : "unknown-reply",
          { httpStatus: result.httpStatus },
        );
      }
      if (shape === "ack") {
        if (result.ok !== true || Object.keys(result).length !== 1) {
          throw new QualificationFailure("malformed-response");
        }
      } else if (shape === "authorization") {
        if (typeof result.callback !== "string" || Object.keys(result).length !== 1) {
          throw new QualificationFailure("malformed-response");
        }
      } else {
        const { status, sessionCookieIssued, sessionCookieClasses } = result;
        const hasSessionCookie =
          Array.isArray(sessionCookieClasses) && sessionCookieClasses.length > 0;
        if (
          !Number.isInteger(status) ||
          status < 200 ||
          status > 599 ||
          typeof sessionCookieIssued !== "boolean" ||
          !Array.isArray(sessionCookieClasses) ||
          sessionCookieClasses.length > 1 ||
          sessionCookieClasses.some((value: unknown) => value !== "host" && value !== "secure") ||
          sessionCookieIssued !== hasSessionCookie ||
          (status >= 200 && status < 300 && status !== 204 && !("data" in result)) ||
          (status >= 300 && status < 400 && typeof result.location !== "string")
        ) {
          throw new QualificationFailure("malformed-response", { httpStatus: status });
        }
      }
      return result;
    });
  }

  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#stopped || this.#active || this.signal.aborted) {
      throw this.stop();
    }
    this.#active = true;
    try {
      const result = await operation();
      if (this.signal.aborted) {
        throw this.stop();
      }
      return result;
    } catch (error) {
      throw this.stop(error);
    } finally {
      this.#active = false;
    }
  }
}
