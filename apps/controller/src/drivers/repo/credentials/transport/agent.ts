import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { RepositoryBackendFactory, Clock } from "../backend-contracts.ts";
import type { ServiceConfig } from "../service-contracts.ts";
import type { ExchangeRef, ExchangeService } from "../internal-contracts.ts";
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

export interface AgentHandlerOptions {
  readonly config: ServiceConfig;
  readonly service: ExchangeService;
  readonly factory: RepositoryBackendFactory;
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
    if (typeof bearer !== "string") {
      sendError(response, bearer.status, bearer.code);
      return;
    }
    // A refusal before the body is read must still reach the client (see refuseUnreadInput).
    const hasBody = parsed.head.framing.kind === "chunked" || (parsed.head.framing.bytes ?? 0) > 0;
    const refuse = (status: number, code: string) =>
      hasBody
        ? refuseUnreadInput(request, response, status, code, clock, limits.stallMs)
        : sendError(response, status, code);
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
    const deadline = clock.schedule(limits.exchangeMs, cancel);
    try {
      const reserved = service.reserve(bearer, parsed.head, abort.signal);
      if ("kind" in reserved) {
        // Without an open session the socket is not worth holding; close at once.
        if (reserved.status === 401) {
          sendError(response, reserved.status, reserved.code);
        } else {
          refuse(reserved.status, reserved.code);
        }
        return;
      }
      exchange = reserved;
      request.socket.setTimeout(0);
      const plan = service.plan(exchange);
      if ((parsed.head.framing.bytes ?? 0) > plan.limits.inputWireBytes) {
        refuse(413, "limit-exceeded");
        return;
      }
      if (parsed.expectContinue) {
        response.writeContinue();
      }
      let input: Readable | undefined;
      if (plan.inputPolicy !== undefined) {
        // Inspect the decoded body before credential use or provider dispatch.
        if (parsed.head.contentEncoding !== "identity") {
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
        const verdict = plan.inputPolicy(body);
        if (verdict !== true) {
          if (verdict === false) {
            sendError(response, 400, "unsupported-request");
          } else {
            sendError(response, verdict.status, verdict.code, {}, verdict.message);
          }
          return;
        }
        // One retained copy, written in slices so the TLS sender never queues a
        // second, encrypted copy of a large body at once.
        input = Readable.from(slices(body), { objectMode: false });
      }
      const sender = createUpstreamSender({
        request,
        ...(input === undefined ? {} : { input }),
        response,
        head: parsed.head,
        trustedUpstreamOrigins,
        headerBytes: limits.headerBytes,
        headerPairs: limits.headerPairs,
        clock,
        ...(options.upstreamCa === undefined ? {} : { upstreamCa: options.upstreamCa }),
      });
      const outcome = await service.execute(exchange, sender);
      if (outcome.kind !== "completed") {
        sendError(
          response,
          outcome.kind === "not-dispatched" ? 503 : 502,
          outcome.kind === "not-dispatched" ? "unavailable" : "exchange-uncertain",
        );
      }
    } catch {
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
