import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Clock, HeaderFields, RequestHead } from "../backend-contracts.ts";
import type { ExchangeSender } from "../internal-contracts.ts";
import type { JsonValue } from "../json-value.ts";
import { ByteLimit, watchdog } from "./streams.ts";
import { responseHeaders, safeResponseHeaders } from "./response-headers.ts";
import { createUpstreamHeaders } from "./request-headers.ts";

export interface UpstreamSenderOptions {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly head: RequestHead;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  readonly clock: Clock;
  readonly upstreamCa?: Uint8Array;
  readonly headerBytes?: number;
  readonly headerPairs?: number;
}

/** One sender owns exactly one exchange; it never retries an upstream request. */
export function createUpstreamSender(options: UpstreamSenderOptions): ExchangeSender {
  const trustedUpstreamOrigins = new Set(options.trustedUpstreamOrigins);
  let used = false;
  return async (privateRequest, context) => {
    if (used) {
      return { kind: "not-dispatched", code: "sender-reused" };
    }
    used = true;
    const { plan } = privateRequest;
    let origin: URL;
    try {
      origin = new URL(plan.origin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== plan.origin ||
        origin.username ||
        origin.password ||
        !trustedUpstreamOrigins.has(plan.origin) ||
        !plan.target.startsWith("/") ||
        plan.target.startsWith("//") ||
        [...plan.target].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x20 || code === 0x7f || character === "#";
        })
      ) {
        throw new Error();
      }
    } catch {
      return { kind: "not-dispatched", code: "untrusted-upstream" };
    }
    if ((options.head.framing.bytes ?? 0) > plan.limits.inputWireBytes) {
      return { kind: "not-dispatched", code: "limit-exceeded" };
    }
    let headers: HeaderFields;
    try {
      headers = createUpstreamHeaders(privateRequest.headers, {
        authority: origin.host,
        head: options.head,
        maximumBytes: options.headerBytes ?? 32768,
        maximumPairs: options.headerPairs ?? 64,
      });
    } catch {
      return { kind: "not-dispatched", code: "invalid-upstream-headers" };
    }
    let outbound: ClientRequest | undefined;
    let upstream: IncomingMessage | undefined;
    let dispatched = false;
    let failed = false;
    let inputCompleted = false;
    let receivedHeaders = false;
    const pending: Promise<unknown>[] = [];
    const stopUpstream = () => {
      failed = true;
      outbound?.destroy();
      upstream?.destroy();
    };
    const cancel = () => {
      stopUpstream();
      options.request.destroy();
      options.response.destroy();
    };
    let resolveSocket!: () => void;
    let resolveIo!: () => void;
    pending.push(
      new Promise<void>((resolve) => {
        resolveSocket = resolve;
      }),
    );
    const finishIo = new Promise<void>((resolve) => {
      resolveIo = resolve;
    });
    let stopTotal: (() => void) | undefined;
    let stopConnect: (() => void) | undefined;
    let stopHeaders: (() => void) | undefined;
    let stopInput: (() => void) | undefined;
    const inputStall = watchdog(options.clock, plan.limits.stallMs, cancel);
    let responseStall: ReturnType<typeof watchdog> | undefined;
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (context.signal.aborted) {
        throw new Error("cancelled");
      }
      const responseReady = new Promise<IncomingMessage>((resolve, reject) => {
        try {
          outbound = context.gate.dispatch(cancel, () => {
            dispatched = true;
            const req = httpsRequest(
              {
                protocol: "https:",
                hostname: origin.hostname.replace(/^\[|\]$/g, ""),
                port: origin.port || 443,
                method: plan.method,
                path: plan.target,
                headers,
                agent: false,
                maxHeaderSize: options.headerBytes ?? 32768,
                ...(options.upstreamCa === undefined
                  ? {}
                  : { ca: Buffer.from(options.upstreamCa) }),
                rejectUnauthorized: true,
              },
              (response) => {
                receivedHeaders = true;
                stopHeaders?.();
                resolve(response);
              },
            );
            req.once("error", () => reject(new Error("upstream-failed")));
            req.once("close", () => resolveSocket());
            req.once("socket", (socket) => {
              socket.once("secureConnect", () => {
                stopConnect?.();
              });
            });
            return req;
          });
        } catch {
          reject(new Error("dispatch-denied"));
        }
      });
      void responseReady.catch(() => {});
      context.gate.track(finishIo);
      stopTotal = options.clock.schedule(
        Math.max(0, context.deadlineMonoMs - options.clock.monotonicNow()),
        cancel,
      );
      stopConnect = options.clock.schedule(plan.limits.connectMs, cancel);
      stopInput = options.clock.schedule(plan.limits.inputMs, cancel);
      if (!outbound) {
        throw new Error("dispatch-denied");
      }
      const wire = new ByteLimit(plan.limits.inputWireBytes, inputStall.reset);
      const decoded = new ByteLimit(plan.limits.inputDecodedBytes, inputStall.reset);
      const input =
        options.head.contentEncoding === "gzip"
          ? pipeline(options.request, wire, createGunzip(), decoded, outbound)
          : pipeline(options.request, wire, decoded, outbound);
      const inputDone = input.then(
        () => {
          stopInput?.();
          inputStall.close();
          inputCompleted = true;
          // An upstream may need the complete upload before it can respond.
          if (!failed && !receivedHeaders) {
            stopHeaders = options.clock.schedule(plan.limits.firstHeaderMs, cancel);
          }
        },
        () => {
          cancel();
          throw new Error("invalid-input");
        },
      );
      pending.push(inputDone);
      void inputDone.catch(() => {});
      upstream = await responseReady;
      stopConnect?.();
      responseStall = watchdog(options.clock, plan.limits.stallMs, cancel);
      const status = upstream.statusCode ?? 502;
      if (status < 200 || status > 599 || (status >= 300 && status < 400 && status !== 304)) {
        throw new Error("invalid-upstream");
      }
      const raw = responseHeaders(
        upstream,
        options.headerBytes ?? 32768,
        options.headerPairs ?? 64,
      );
      if (Number(raw["content-length"] ?? 0) > plan.limits.responseBytes) {
        throw new Error("limit-exceeded");
      }
      const allowed = safeResponseHeaders(plan.responsePolicy.headers(status, raw));
      const noBody = plan.method === "HEAD" || status === 204 || status === 304;
      if (noBody) {
        for await (const chunk of upstream) {
          if (chunk.length) {
            throw new Error("invalid-upstream");
          }
        }
        await inputDone;
        options.response.writeHead(status, allowed);
        options.response.end();
      } else if (plan.responsePolicy.body !== "stream") {
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of upstream) {
          size += chunk.length;
          if (size > plan.limits.responseBytes) {
            throw new Error("limit-exceeded");
          }
          responseStall.reset();
          parts.push(Buffer.from(chunk));
        }
        let bytes = Buffer.concat(parts);
        if (plan.responsePolicy.rewriteJson !== undefined) {
          const value: JsonValue = JSON.parse(bytes.toString("utf8"));
          bytes = Buffer.from(JSON.stringify(plan.responsePolicy.rewriteJson(value)));
          if (bytes.length > plan.limits.responseBytes) {
            throw new Error("limit-exceeded");
          }
          delete allowed.etag;
          delete allowed["content-md5"];
          delete allowed.digest;
        }
        await inputDone;
        allowed["content-length"] = String(bytes.length);
        options.response.writeHead(status, allowed);
        options.response.end(bytes);
      } else {
        options.response.writeHead(status, allowed);
        await pipeline(
          upstream,
          new ByteLimit(plan.limits.responseBytes, responseStall.reset),
          options.response,
        );
        await inputDone;
      }
      if (!options.response.writableFinished) {
        await new Promise<void>((resolve, reject) => {
          options.response.once("finish", resolve);
          options.response.once("error", reject);
          options.response.once("close", () =>
            options.response.writableFinished ? resolve() : reject(new Error("client-closed")),
          );
        });
      }
      if (failed) {
        throw new Error("exchange-failed");
      }
      return { kind: "completed", status };
    } catch {
      if (dispatched) {
        // An active input pipeline owns the incoming socket. Preserve it for a
        // service error only after the pipeline settles, before response headers.
        if (
          inputCompleted &&
          !context.signal.aborted &&
          !options.response.headersSent &&
          !options.response.destroyed
        ) {
          stopUpstream();
        } else {
          cancel();
        }
      }
      return {
        kind: dispatched ? "possibly-dispatched" : "not-dispatched",
        code: dispatched ? "exchange-failed" : "dispatch-denied",
      };
    } finally {
      stopTotal?.();
      stopConnect?.();
      stopHeaders?.();
      stopInput?.();
      inputStall.close();
      responseStall?.close();
      context.signal.removeEventListener("abort", cancel);
      if (!outbound) {
        resolveSocket();
      }
      // A completed response and agent:false close the socket. Failed work is destroyed.
      await Promise.allSettled(pending);
      resolveIo();
    }
  };
}
