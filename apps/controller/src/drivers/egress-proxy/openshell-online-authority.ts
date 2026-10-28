import { isIP } from "node:net";
import { hasControlCharacter } from "@openclaw-enterprise/utils";
import {
  Server,
  status,
  type ServerDuplexStream,
  type ServerUnaryCall,
  type sendUnaryData,
} from "@grpc/grpc-js";
import {
  describeOpenShellMiddleware,
  loadOpenShellMiddleware,
  middlewareBearer,
  record,
  type OpenShellHttpPolicySet,
} from "./openshell-authority.ts";
import {
  OpenShellExtensionJwtVerifier,
  type OpenShellEgressIdentityOptions,
} from "./openshell-identity.ts";

type Wire = Record<string, unknown>;
const deny = { decision: 2, reason_code: "online_authorization_denied" };

/** A denial whose stable reason code the supervisor shows the workload instead of the generic
 * one. OpenShell accepts `[a-z][a-z0-9_]{0,63}`; anything else denies with the generic code. */
export interface OpenShellOnlineReasonedDenial {
  readonly reasonCode: string;
}

export type OpenShellOnlineDecision =
  | "allow"
  | "deny"
  | OpenShellOnlineReasonedDenial
  | { readonly kind: "allow"; readonly replyBy: string };

function denial(result: OpenShellOnlineDecision): Wire {
  return typeof result === "object" &&
    "reasonCode" in result &&
    /^[a-z][a-z0-9_]{0,63}$/.test(result.reasonCode)
    ? { decision: 2, reason_code: result.reasonCode }
    : deny;
}
const boundedId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(value);

/** The target is the supervisor's reported, normalized view, not proof of an exact wire request. */
export interface OpenShellOnlineRequest {
  readonly sandboxId: string;
  readonly bindingId: string;
  readonly requestId: string;
  readonly target: {
    readonly reportedScheme: "https";
    readonly host: string;
    readonly port: 443;
    readonly method: "GET";
    readonly path: string;
    readonly query: "absent_or_empty";
  };
}

export interface OpenShellOnlineAuthorityOptions {
  readonly identity: Pick<
    OpenShellEgressIdentityOptions,
    "issuer" | "audience" | "keyId" | "publicKey"
  >;
  readonly registrationName: string;
  /**
   * Resolve exactly one current execution and admitted binding from the signed sandbox ID and
   * opaque binding ID, then check current source, grant, method and path authority. The signed
   * sandbox ID does not identify a supervisor instance: qualification requires a never-reused
   * sandbox identity dedicated to one execution, restart disabled, and prevention of stop/start
   * or replacement under its admitted authority. Refuse release if these cannot be enforced.
   * Independently establish a mandatory, fail-closed TLS-only path: the reported scheme does not
   * prove TLS. Deny unknown, ambiguous, withdrawn or unsupported state. Never persist or reuse an
   * allow. The view excludes headers and carries no body bytes. Stock cannot distinguish an absent query from
   * a bare trailing query delimiter; allow only if both forms are authorized. Policies requiring
   * header, framing or exact original-target identity are unsupported by this adapter. Honor abort.
   */
  readonly authorize: (
    request: OpenShellOnlineRequest,
    signal: AbortSignal,
  ) => Promise<OpenShellOnlineDecision>;
  readonly budgetMs?: number;
  /** Advertise a pinned REST-only policy set. Each binding must name a release in that set. */
  readonly httpPolicySet?: OpenShellHttpPolicySet & {
    readonly validateBindingConfig: (id: string, scope: string) => boolean;
  };
}

/** Stock v0.1.4's normalized pre-credential view. Omitted headers and original framing
 * cannot be authorized here. Workspace is checked against the owner's mapping, never proof. */
export interface OpenShellOnlineHttpRequest {
  readonly sandboxId: string;
  readonly bindingId: string;
  readonly bindingConfig?: string;
  readonly requestId: string;
  readonly workspace: string;
  readonly target: {
    readonly reportedScheme: "https";
    readonly host: string;
    readonly port: number;
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly query: string;
  };
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly deadlineAt: string;
}

export interface OpenShellOnlineHttpAuthorityOptions extends Omit<
  OpenShellOnlineAuthorityOptions,
  "authorize"
> {
  readonly authorize: (
    request: OpenShellOnlineHttpRequest,
    signal: AbortSignal,
  ) => Promise<OpenShellOnlineDecision>;
}

function httpMethod(value: unknown): value is OpenShellOnlineHttpRequest["target"]["method"] {
  return (
    typeof value === "string" && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(value)
  );
}

function httpRequestView(
  request: Wire,
  sandboxId: string,
  deadlineAt: string,
  scoped: boolean,
): OpenShellOnlineHttpRequest | undefined {
  const context = record(request.context);
  const target = record(request.target);
  const id = bindingId(request.config, scoped);
  const config = record(record(record(request.config).fields).request_scope).stringValue;
  const body = request.body ?? new Uint8Array();
  const rawHeaders = request.headers ?? [];
  const query = target.query ?? "";
  if (
    request.phase !== 1 ||
    context.sandbox_id !== sandboxId ||
    !id ||
    typeof context.request_id !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(context.request_id) ||
    typeof context.workspace !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(context.workspace) ||
    target.scheme !== "https" ||
    !Number.isInteger(target.port) ||
    Number(target.port) < 1 ||
    Number(target.port) > 65535 ||
    typeof target.host !== "string" ||
    target.host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      target.host,
    ) ||
    isIP(target.host) !== 0 ||
    !httpMethod(target.method) ||
    typeof target.path !== "string" ||
    !/^\/[\x21-\x7e]{0,4095}$/.test(target.path) ||
    /[?#]/.test(target.path) ||
    typeof query !== "string" ||
    !/^[\x21-\x7e]{0,4096}$/.test(query) ||
    !(body instanceof Uint8Array) ||
    body.byteLength > 4 * 1024 * 1024 ||
    !Array.isArray(rawHeaders) ||
    rawHeaders.length > 128
  ) {
    return undefined;
  }
  const headers: [string, string][] = [];
  let headerBytes = 0;
  for (const raw of rawHeaders) {
    const { name, value } = record(raw);
    if (
      typeof name !== "string" ||
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      typeof value !== "string" ||
      hasControlCharacter(value) ||
      value.trim() !== value
    ) {
      return undefined;
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 64 * 1024) {
      return undefined;
    }
    headers.push([name, value]);
  }
  return {
    sandboxId,
    bindingId: id,
    ...(typeof config === "string" && { bindingConfig: config }),
    requestId: context.request_id,
    workspace: context.workspace,
    target: {
      reportedScheme: "https",
      host: target.host,
      port: Number(target.port),
      method: target.method,
      path: target.path,
      query,
    },
    headers,
    body,
    deadlineAt,
  };
}

/** Private composition seam: only a trusted operation owner may opt into body inspection. */
export function createOpenShellOnlineHttpAuthority(
  options: OpenShellOnlineHttpAuthorityOptions,
): Server {
  return createAuthority(options, (request, sandbox, deadline) =>
    httpRequestView(request, sandbox, deadline, options.httpPolicySet !== undefined),
  );
}

function bindingId(config: unknown, scoped = false): string | undefined {
  const fields = record(record(config).fields);
  const value = record(fields.binding_id);
  const scope = record(fields.request_scope);
  const validFields =
    Object.keys(fields).length === 1 ||
    (scoped &&
      Object.keys(fields).length === 2 &&
      scope.kind === "stringValue" &&
      typeof scope.stringValue === "string" &&
      scope.stringValue.length <= 16384);
  return validFields &&
    Object.keys(value).every((key) => key === "stringValue" || key === "kind") &&
    value.kind === "stringValue" &&
    boundedId(value.stringValue)
    ? value.stringValue
    : undefined;
}

function supervisor(claims: Wire | undefined): string | undefined {
  const id = claims?.sandbox_id;
  return claims?.caller_kind === "supervisor" &&
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    id.trim() === id &&
    claims.sub === `spiffe://openshell/sandbox/${id}`
    ? id
    : undefined;
}

function requestView(request: Wire, sandboxId: string): OpenShellOnlineRequest | undefined {
  const context = record(request.context);
  const target = record(request.target);
  const id = bindingId(request.config);
  if (
    request.phase !== 1 ||
    context.sandbox_id !== sandboxId ||
    typeof context.request_id !== "string" ||
    !context.request_id ||
    context.request_id.length > 256 ||
    !id ||
    target.scheme !== "https" ||
    target.port !== 443 ||
    typeof target.host !== "string" ||
    target.host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      target.host,
    ) ||
    isIP(target.host) !== 0 ||
    target.method !== "GET" ||
    (request.body !== undefined &&
      (!(request.body instanceof Uint8Array) || request.body.byteLength !== 0)) ||
    typeof target.path !== "string" ||
    !/^\/[\x21-\x7e]{0,4095}$/.test(target.path) ||
    /[?#]/.test(target.path) ||
    (target.query !== undefined && target.query !== "")
  ) {
    return undefined;
  }
  return {
    sandboxId,
    bindingId: id,
    requestId: context.request_id,
    target: {
      reportedScheme: "https",
      host: target.host,
      port: 443,
      method: target.method,
      path: target.path,
      query: "absent_or_empty",
    },
  };
}

/** Unregistered stock protocol adapter; it has no material, send, or exact-exchange authority. */
export function createOpenShellOnlineAuthority(options: OpenShellOnlineAuthorityOptions): Server {
  return createAuthority(options, requestView);
}

function createAuthority<T>(
  options: Omit<OpenShellOnlineAuthorityOptions, "authorize"> & {
    readonly authorize: (request: T, signal: AbortSignal) => Promise<OpenShellOnlineDecision>;
  },
  view: (request: Wire, sandboxId: string, deadlineAt: string) => T | undefined,
): Server {
  const verifier = new OpenShellExtensionJwtVerifier(options.identity);
  const budgetMs = options.budgetMs ?? 400;
  if (
    !options.registrationName ||
    typeof options.authorize !== "function" ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 10 ||
    budgetMs > 30_000
  ) {
    throw new Error("Invalid OpenShell online authorization configuration.");
  }
  const { service } = loadOpenShellMiddleware();
  const server = new Server({ "grpc.max_receive_message_length": 5 * 1024 * 1024 });
  const claims = (call: Pick<ServerUnaryCall<Wire, Wire>, "metadata">) =>
    verifier.verify(middlewareBearer(call.metadata));
  const control = (identity: Wire | undefined) =>
    (identity?.caller_kind === "gateway" &&
      identity.sub === options.identity.issuer &&
      identity.sandbox_id === undefined) ||
    supervisor(identity) !== undefined;
  const acceptedBinding = (config: unknown) => {
    const profile = options.httpPolicySet;
    const id = bindingId(config, profile !== undefined);
    const scope = record(record(record(config).fields).request_scope).stringValue;
    return (
      id !== undefined &&
      (profile
        ? typeof scope === "string" && profile.validateBindingConfig(id, scope)
        : scope === undefined)
    );
  };
  let pending = 0;
  server.addService(service.SupervisorMiddleware!.service, {
    Describe(call: ServerUnaryCall<Wire, Wire>, callback: sendUnaryData<Wire>) {
      const description =
        control(claims(call)) &&
        describeOpenShellMiddleware(
          call.request.gateway,
          options.identity.audience,
          "online-request-authorization",
          options.httpPolicySet,
        );
      if (description) {
        callback(null, description);
      } else {
        callback({ code: status.PERMISSION_DENIED, message: "Unsupported counterpart." }, null);
      }
    },
    ValidateConfig(call: ServerUnaryCall<Wire, Wire>, callback: sendUnaryData<Wire>) {
      callback(null, {
        valid:
          control(claims(call)) &&
          call.request.middleware_name === options.registrationName &&
          acceptedBinding(call.request.config),
      });
    },
    ...(options.httpPolicySet !== undefined && {
      EvaluateWebSocketSession(call: ServerDuplexStream<Wire, Wire>) {
        const sandboxId = supervisor(claims(call));
        call.once("data", (event: Wire) => {
          const preflight = record(event.preflight);
          if (!sandboxId || record(preflight.context).sandbox_id !== sandboxId) {
            call.emit("error", { code: status.PERMISSION_DENIED, message: "Supervisor required." });
            return;
          }
          call.write({ preflight_decision: { action: 3, reason_code: "http_only" } });
          call.end();
        });
      },
    }),
    EvaluateHttpRequest(call: ServerUnaryCall<Wire, Wire>, callback: sendUnaryData<Wire>) {
      // Convert the call deadline once; delayed timers or wall-clock changes cannot extend it.
      const startedAt = performance.now();
      const expiresAt = startedAt + Math.min(budgetMs, Number(call.getDeadline()) - Date.now());
      const expired = () => !(performance.now() < expiresAt);
      const sandboxId = supervisor(claims(call));
      const request =
        sandboxId &&
        !expired() &&
        view(
          call.request,
          sandboxId,
          new Date(Date.now() + Math.max(0, expiresAt - performance.now())).toISOString(),
        );
      if (
        !request ||
        call.request.middleware_name !== options.registrationName ||
        (options.httpPolicySet !== undefined && !acceptedBinding(call.request.config)) ||
        pending >= 1024 ||
        expired()
      ) {
        callback(null, deny);
        return;
      }
      pending += 1;
      const controller = new AbortController();
      const cancelled = () => controller.abort();
      call.once("cancelled", cancelled);
      const timeout = setTimeout(cancelled, Math.max(0, expiresAt - performance.now()));
      const aborted = new Promise<"deny">((resolve) => {
        controller.signal.addEventListener("abort", () => resolve("deny"), { once: true });
        if (call.cancelled) {
          cancelled();
        }
      });
      const authorization = Promise.resolve()
        .then(() =>
          controller.signal.aborted || expired()
            ? "deny"
            : options.authorize(request, controller.signal),
        )
        .finally(() => {
          pending -= 1;
        });
      void Promise.race([authorization, aborted])
        .then((result) =>
          callback(
            null,
            controller.signal.aborted || expired()
              ? deny
              : result === "allow" ||
                  (typeof result === "object" &&
                    "kind" in result &&
                    result.kind === "allow" &&
                    Date.now() < Date.parse(result.replyBy))
                ? { decision: 1 }
                : denial(result),
          ),
        )
        .catch(() => callback(null, deny))
        .finally(() => {
          clearTimeout(timeout);
          call.removeListener("cancelled", cancelled);
          controller.abort();
        });
    },
  });
  return server;
}
