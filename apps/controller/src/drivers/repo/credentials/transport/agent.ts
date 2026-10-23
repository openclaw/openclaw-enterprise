import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { RepositoryServiceFactory, Clock } from "../backend-contracts.ts";
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
    const deadline = clock.schedule(limits.maxExchangeMs, cancel);
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
            sendError(response, 400, "unsupported-request");
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
            sendError(response, 413, "limit-exceeded");
            return;
          }
          upstreamHead = {
            ...parsed.head,
            contentEncoding: "identity",
            framing: { kind: "length", bytes: body.length },
          };
        } else if (verdict !== true) {
          if (verdict === false) {
            sendError(response, 400, "unsupported-request");
          } else {
            sendError(response, verdict.status, verdict.code, {}, verdict.message);
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
        response.writeHead(outcome.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(outcome.body));
      } else if (outcome.kind !== "completed") {
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
