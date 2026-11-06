import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { RepositoryServiceFactory, Clock } from "../backend-contracts.ts";
import type { ServiceConfig } from "../service-contracts.ts";
import type { ExchangeRef, ExchangeService, SessionLogIdentity } from "../internal-contracts.ts";
import { inspectRequestHead } from "./request.ts";
import { createUpstreamSender } from "./upstream.ts";
import { refuseUnreadInput, sendError } from "./errors.ts";
import { readBoundedInput } from "./streams.ts";

const inputSliceBytes = 65536;

function* slices(body: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < body.length; offset += inputSliceBytes) {
    yield body.subarray(offset, offset + inputSliceBytes);
  }
}

/**
 * Where a request with credentials was refused (finding 2411): its credential for the route,
 * the session, the session's exchange capacity, the request head or target, its body, the send
 * (the owner refused or could not authorize it, or the provider connection failed before any
 * write), the spent draft allowance, or an internal failure.
 */
export type RefusalReason =
  | "credential_refused"
  | "session_unavailable"
  | "capacity"
  | "request_refused"
  | "input_refused"
  | "not_dispatched"
  | "operation_conflict"
  | "service_error";

/**
 * One operator log record per refused request that carried credentials. `reasonCode` is the
 * code the Agent receives. It never carries a bearer, credential, URL, ref or request body.
 */
export type RefusalRecord = Readonly<
  {
    event: "repository-credentials.denied";
    status: number;
    reasonCode: string;
    reason: RefusalReason;
    operation?: string;
  } & Partial<SessionLogIdentity>
>;

/**
 * The token a Bearer or Basic authorization carries, for log attribution only: it names a
 * session only if it is exactly an open session's bearer. The route's backend still decides
 * whether the request is authenticated; a request for a repository that no binding names
 * carries the session's own credential but is refused before session lookup.
 */
function presentedToken(authorization: string): string | undefined {
  const bearer = /^(?:Bearer|token) ([A-Za-z0-9_-]{1,256})$/i.exec(authorization)?.[1];
  if (bearer !== undefined) {
    return bearer;
  }
  const basic = /^Basic ([A-Za-z0-9+/]{1,1024}={0,2})$/i.exec(authorization)?.[1];
  if (basic === undefined) {
    return undefined;
  }
  const bytes = Buffer.from(basic, "base64");
  try {
    const text = bytes.toString("utf8");
    const colon = text.indexOf(":");
    return colon < 0 ? undefined : text.slice(colon + 1);
  } finally {
    bytes.fill(0);
  }
}

/** Writes one refusal record to the operator log. */
function writeRefusal(log: AgentHandlerOptions["log"], fields: Omit<RefusalRecord, "event">): void {
  try {
    log?.(Object.freeze({ event: "repository-credentials.denied", ...fields }));
  } catch {
    // Logging cannot change the answer.
  }
}

export interface AgentHandlerOptions {
  readonly config: ServiceConfig;
  /** Receives each refusal record; the process composition writes them to its log. */
  readonly log?: (record: RefusalRecord) => void;
  readonly service: ExchangeService;
  readonly factory: RepositoryServiceFactory;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  readonly clock: Clock;
  readonly upstreamCa?: Uint8Array;
}

export function createAgentHandler(
  options: AgentHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { config, service, factory, clock } = options;
  const limits = config.limits;
  const trustedUpstreamOrigins = new Set(options.trustedUpstreamOrigins);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const receivedMonoMs = clock.monotonicNow();
    const parsed = inspectRequestHead(request, {
      authority: new URL(config.gateway.publicOrigin).host,
      receivedMonoMs,
      headerBytes: limits.headerBytes,
      headerPairs: limits.headerPairs,
      targetBytes: limits.targetBytes,
    });
    if (parsed.kind === "denied") {
      // A head refused after its fields were checked (wrong Host, bad framing) is logged only
      // when its one Authorization field names an open session, so unauthenticated traffic
      // stays silent (finding 2429). Earlier refusals (bad start line, field syntax, sizes,
      // repeated fields) carry no single credential to attribute and are not logged.
      const token =
        options.log && parsed.authorization !== undefined
          ? presentedToken(parsed.authorization)
          : undefined;
      const identity = token === undefined ? undefined : service.identify(token);
      if (identity !== undefined) {
        writeRefusal(options.log, {
          status: parsed.status,
          reasonCode: parsed.code,
          reason: "request_refused",
          ...identity,
        });
      }
      sendError(response, parsed.status, parsed.code);
      return;
    }
    if (parsed.authorization === undefined) {
      const result = factory.unauthenticated(parsed.head);
      if (result.kind === "challenge") {
        if (!/^[A-Za-z0-9 _-]{1,80}$/.test(result.realm)) {
          sendError(response, 503, "unavailable");
          return;
        }
        sendError(response, 401, "authentication-required", {
          "www-authenticate": `Basic realm="${result.realm}"`,
        });
      } else {
        sendError(response, result.status, result.code);
      }
      return;
    }
    const bearer = factory.parseAuthentication(parsed.head, parsed.authorization);
    // Unauthenticated requests are Git's ordinary challenge round trip and are not logged.
    // Every refusal after this point is: one line per request, like the OpenShell route's
    // worker.openshell-git-denied. Each request is a separate TLS connection within the
    // listener's socket limit, so the Agent's own request rate bounds the volume.
    const token = !options.log
      ? undefined
      : typeof bearer === "string"
        ? bearer
        : presentedToken(parsed.authorization);
    const identity = token === undefined ? undefined : service.identify(token);
    let operation: string | undefined;
    const report = (status: number, code: string, reason: RefusalReason) =>
      writeRefusal(options.log, {
        status,
        reasonCode: code,
        reason,
        ...(operation === undefined ? {} : { operation }),
        ...identity,
      });
    if (typeof bearer !== "string") {
      report(bearer.status, bearer.code, "credential_refused");
      sendError(response, bearer.status, bearer.code);
      return;
    }
    // A refusal before the body is read must still reach the client (see refuseUnreadInput).
    const hasBody = parsed.head.framing.kind === "chunked" || (parsed.head.framing.bytes ?? 0) > 0;
    const refuse = (status: number, code: string, reason: RefusalReason = "input_refused") => {
      report(status, code, reason);
      if (hasBody) {
        refuseUnreadInput(request, response, status, code, clock, limits.stallMs);
      } else {
        sendError(response, status, code);
      }
    };
    const answer = (status: number, code: string, message?: string) => {
      report(status, code, "input_refused");
      sendError(response, status, code, {}, message);
    };
    const abort = new AbortController();
    const cancel = () => abort.abort();
    const onResponseClose = () => {
      if (!response.writableFinished) {
        cancel();
      }
    };
    request.once("aborted", cancel);
    response.once("close", onResponseClose);
    let exchange: ExchangeRef | undefined;
    const deadline = clock.schedule(limits.maxExchangeMs, cancel);
    try {
      const reserved = service.reserve(bearer, parsed.head, abort.signal);
      if ("kind" in reserved) {
        // Without an open session the socket is not worth holding; close at once.
        if (reserved.status === 401) {
          report(reserved.status, reserved.code, "session_unavailable");
          sendError(response, reserved.status, reserved.code);
        } else {
          refuse(
            reserved.status,
            reserved.code,
            reserved.code === "exchange-capacity" ? "capacity" : "request_refused",
          );
        }
        return;
      }
      exchange = reserved;
      request.socket.setTimeout(0);
      const plan = service.plan(exchange);
      operation = plan.category;
      if ((parsed.head.framing.bytes ?? 0) > plan.limits.inputWireBytes) {
        refuse(413, "limit-exceeded");
        return;
      }
      if (parsed.expectContinue) {
        response.writeContinue();
      }
      // Bind method, resolved upstream, operation, headers and exact validated body.
      // The digest never includes the Agent bearer or the provider credential.
      const digest = plan.bindRequestDigest
        ? createHash("sha256").update(
            JSON.stringify([
              plan.method,
              plan.origin,
              plan.target,
              plan.requestHeaders,
              ...(plan.digestScope ?? []),
            ]) + "\n",
          )
        : undefined;
      let input: Readable | undefined;
      let upstreamHead = parsed.head;
      if (plan.inputPolicy !== undefined) {
        // Inspect the decoded body before credential use or provider dispatch.
        const compressed = parsed.head.contentEncoding === "gzip";
        if (compressed && !(digest && plan.category === "git-fetch")) {
          refuse(400, "unsupported-request");
          return;
        }
        let body: Buffer;
        try {
          body = await readBoundedInput(request, plan.limits, clock, abort.signal);
        } catch (error) {
          // Over the limit nothing was sent upstream and no credential was used;
          // answer on the same connection so the client sees why.
          if (error instanceof Error && error.message === "limit-exceeded") {
            refuse(413, "limit-exceeded");
          } else {
            request.destroy();
            response.destroy();
          }
          return;
        }
        if (compressed) {
          try {
            // Large native upload-pack negotiations can be gzip encoded. Bound both
            // representations; authorize and send the identical decoded Git request.
            body = await promisify(gunzip)(body, {
              maxOutputLength: plan.limits.inputDecodedBytes,
            });
          } catch {
            answer(400, "unsupported-request");
            return;
          }
          upstreamHead = {
            ...parsed.head,
            contentEncoding: "identity",
            framing: { kind: "length", bytes: body.length },
          };
        }
        const verdict = plan.inputPolicy(body);
        if (typeof verdict === "object" && "body" in verdict) {
          body = Buffer.from(verdict.body);
          if (body.length > plan.limits.inputDecodedBytes) {
            answer(413, "limit-exceeded");
            return;
          }
          upstreamHead = {
            ...parsed.head,
            contentEncoding: "identity",
            framing: { kind: "length", bytes: body.length },
          };
        } else if (verdict !== true) {
          if (verdict === false) {
            answer(400, "unsupported-request");
          } else {
            answer(verdict.status, verdict.code, verdict.message);
          }
          return;
        }
        // One retained copy, written in slices so the TLS sender never queues a
        // second, encrypted copy of a large body at once.
        digest?.update(body);
        input = Readable.from(slices(body), { objectMode: false });
      } else if (digest && hasBody) {
        refuse(400, "unsupported-request");
        return;
      }
      const sender = createUpstreamSender({
        request,
        ...(input === undefined ? {} : { input }),
        response,
        head: upstreamHead,
        trustedUpstreamOrigins,
        headerBytes: limits.headerBytes,
        headerPairs: limits.headerPairs,
        clock,
        ...(options.upstreamCa === undefined ? {} : { upstreamCa: options.upstreamCa }),
      });
      const outcome = await service.execute(exchange, sender, digest?.digest("hex"));
      if (outcome.kind === "recorded") {
        // A receipt is a refusal when GitHub received nothing: the spent allowance, or a
        // create the broker settled as not sent before any write, including its replay
        // (finding 2429). Created and unknown outcomes are not refusals.
        const recorded = outcome.body as { error?: unknown } | null;
        if (recorded?.error === "operation_conflict") {
          report(outcome.status, "operation_conflict", "operation_conflict");
        } else if (recorded?.error === "not-submitted") {
          report(outcome.status, "not-submitted", "not_dispatched");
        }
        response.writeHead(outcome.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(outcome.body));
      } else if (outcome.kind !== "completed") {
        if (outcome.kind === "not-dispatched") {
          report(503, "unavailable", "not_dispatched");
        }
        sendError(
          response,
          outcome.kind === "not-dispatched" ? 503 : 502,
          outcome.kind === "not-dispatched" ? "unavailable" : "exchange-uncertain",
        );
      }
    } catch {
      report(503, "unavailable", "service_error");
      sendError(response, 503, "unavailable");
    } finally {
      deadline();
      request.off("aborted", cancel);
      response.off("close", onResponseClose);
      if (exchange !== undefined) {
        service.cancel(exchange);
      }
    }
  };
}
