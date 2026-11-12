import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Clock, HeaderFields, RequestHead } from "../backend-contracts.ts";
import type { ExchangeSender, UpstreamConnectFailure } from "../internal-contracts.ts";
import type { JsonValue } from "../json-value.ts";
import { ByteLimit, watchdog } from "./streams.ts";
import { responseHeaders, safeResponseHeaders } from "./response-headers.ts";
import { createUpstreamHeaders } from "./request-headers.ts";

export interface UpstreamSenderOptions {
  readonly request: IncomingMessage;
  /** A body already read from `request` under the plan's input bounds. */
  readonly input?: Readable;
  readonly response: ServerResponse;
  readonly head: RequestHead;
  readonly trustedUpstreamOrigins: ReadonlySet<string>;
  readonly clock: Clock;
  readonly upstreamCa?: Uint8Array;
  readonly headerBytes?: number;
  readonly headerPairs?: number;
}

// A socket or TLS error code (ECONNREFUSED, ETIMEDOUT, CERT_HAS_EXPIRED); never its message.
function connectErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "unknown";
}

const ipv4Literal =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
// A resolved or connected address for the operator log, only if it is a plain IP literal.
// Node supplies it; this file has no node:net capability, so it is checked here, not by isIP.
function ipLiteral(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 45) {
    return undefined;
  }
  if (ipv4Literal.test(value)) {
    return value;
  }
  // Only hex digits, colons and dots remain, so the URL parser sees an IPv6 literal or fails.
  return value.includes(":") &&
    /^[0-9A-Fa-f:.]+$/.test(value) &&
    URL.canParse(`https://[${value}]/`)
    ? value
    : undefined;
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
    let settling = false;
    let failed = false;
    let inputCompleted = false;
    let receivedHeaders = false;
    // Where the provider connection failed before TLS was established. A stale egress
    // allowlist (repositoryCredentials.upstreamCidrs) refuses or drops the connect, and
    // the operator log names this instead of a bare not_dispatched (finding 3169).
    const hostname = origin.hostname.replace(/^\[|\]$/g, "");
    const port = Number(origin.port || 443);
    // Every address the host resolved to, in order: a dual-stack host tries each before the
    // connect fails. Once TCP connects, only that address matters.
    let addresses: string[] = [];
    const noteAddress = (value: unknown) => {
      const address = ipLiteral(value);
      if (address !== undefined && !addresses.includes(address) && addresses.length < 16) {
        addresses.push(address);
      }
    };
    noteAddress(hostname);
    let tlsEstablished = false;
    let connectFailure: UpstreamConnectFailure | undefined;
    const failConnect = (error: string) => {
      // A local cancel (client gone, deadline) is not a provider connect failure.
      if (!tlsEstablished && !failed && connectFailure === undefined) {
        connectFailure = {
          host: hostname,
          ...(addresses.length === 0 ? {} : { addresses: [...addresses] }),
          port,
          error,
        };
      }
    };
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
    const inputStall = watchdog(options.clock, plan.limits.stallMs, () => {
      // Before TLS nothing is queued: a stall here is a dropped connect, not a client stall.
      // With the default limits (connectMs === stallMs) this fires before the connect timer.
      if (!tlsEstablished && !dispatched) {
        failConnect("connect-timeout");
        stopUpstream();
      } else {
        cancel();
      }
    });
    let responseStall: ReturnType<typeof watchdog> | undefined;
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (context.signal.aborted) {
        throw new Error("cancelled");
      }
      // Establish verified TLS without queuing HTTP bytes, then enter the gate
      // at the first application write for both owned and prepared credentials.
      let tlsReady!: () => void;
      let tlsFailed!: (error: Error) => void;
      const connected = new Promise<void>((resolve, reject) => {
        tlsReady = resolve;
        tlsFailed = reject;
      });
      void connected.catch(() => {});
      let resolveResponse!: (response: IncomingMessage) => void;
      let rejectResponse!: (error: Error) => void;
      const responseReady = new Promise<IncomingMessage>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      void responseReady.catch(() => {});
      const connect = () => {
        const req = httpsRequest(
          {
            protocol: "https:",
            hostname,
            port,
            method: plan.method,
            path: plan.target,
            headers,
            agent: false,
            maxHeaderSize: options.headerBytes ?? 32768,
            ...(options.upstreamCa === undefined ? {} : { ca: Buffer.from(options.upstreamCa) }),
            rejectUnauthorized: true,
          },
          (response) => {
            receivedHeaders = true;
            stopHeaders?.();
            resolveResponse(response);
          },
        );
        req.once("error", (cause) => {
          noteAddress((cause as { address?: unknown } | null)?.address);
          failConnect(connectErrorCode(cause));
          const error = new Error("upstream-failed");
          rejectResponse(error);
          tlsFailed(error);
        });
        req.once("close", () => {
          tlsFailed(new Error("upstream-closed"));
          resolveSocket();
        });
        req.once("socket", (socket) => {
          // Node emits one lookup event per resolved address.
          socket.on("lookup", (error: Error | null, address: unknown) => {
            if (!error) {
              noteAddress(address);
            }
          });
          socket.once("connect", () => {
            const connected = ipLiteral(socket.remoteAddress);
            if (connected !== undefined) {
              addresses = [connected];
            }
          });
          socket.once("secureConnect", () => {
            tlsEstablished = true;
            stopConnect?.();
            tlsReady();
          });
        });
        return req;
      };
      outbound = connect();
      context.gate.track(finishIo);
      stopTotal = options.clock.schedule(
        Math.max(0, context.deadlineMonoMs - options.clock.monotonicNow()),
        cancel,
      );
      stopConnect = options.clock.schedule(plan.limits.connectMs, () => {
        // A dropped connect (a NetworkPolicy without reject) ends here, not in a socket error.
        // TLS never completed, so nothing was dispatched: close only the provider side, as a
        // refused connect does. Destroying the caller's socket would abort the exchange before
        // it reports this failure, and the Agent would get a dropped connection, not a 503.
        failConnect("connect-timeout");
        stopUpstream();
      });
      stopInput = options.clock.schedule(plan.limits.inputMs, cancel);
      await connected;
      const req = outbound;
      await context.gate.dispatch(
        cancel,
        () => {
          // Once this write starts, an error is a possible dispatch; never replay it.
          dispatched = true;
          req.flushHeaders();
        },
        () => {
          if (req.destroyed || !req.socket?.writable) {
            throw new Error("upstream-closed");
          }
        },
      );
      const wire = new ByteLimit(plan.limits.inputWireBytes, inputStall.reset);
      const decoded = new ByteLimit(plan.limits.inputDecodedBytes, inputStall.reset);
      const source = options.input ?? options.request;
      const input =
        options.head.contentEncoding === "gzip"
          ? pipeline(source, wire, createGunzip(), decoded, outbound)
          : pipeline(source, wire, decoded, outbound);
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
      if (
        privateRequest.settle &&
        (status !== 201 ||
          noBody ||
          plan.responsePolicy.body !== "bounded-json" ||
          plan.responsePolicy.trailers !== "forbid" ||
          !plan.responsePolicy.rewriteJson)
      ) {
        throw new Error("invalid-operation-response");
      }
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
        // Trailer declarations are not the trailers received at stream end.
        // Opted-in bounded policies reject actual trailers before releasing any bytes.
        if (plan.responsePolicy.trailers === "forbid" && upstream.rawTrailers.length !== 0) {
          throw new Error("invalid-upstream");
        }
        let bytes = Buffer.concat(parts);
        if (plan.responsePolicy.rewriteJson !== undefined) {
          const parse = plan.responsePolicy.parseJson;
          const value: JsonValue = parse
            ? parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
            : JSON.parse(bytes.toString("utf8"));
          const approved = plan.responsePolicy.rewriteJson(value);
          if (privateRequest.settle) {
            await inputDone;
            settling = true;
            return await privateRequest.settle({ created: approved });
          }
          bytes = Buffer.from(JSON.stringify(approved));
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
      if (privateRequest.settle) {
        stopUpstream();
        if (!settling) {
          const receipt = await privateRequest.settle(
            dispatched ? "outcome_unknown" : "not-submitted",
          );
          // The receipt body is what the Agent receives; the connect failure is for the log only.
          return !dispatched && connectFailure !== undefined
            ? { ...receipt, upstreamConnect: connectFailure }
            : receipt;
        }
        // A commit may already have happened. Only a same-operation receipt lookup can resolve it.
      }
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
      if (!dispatched && connectFailure !== undefined) {
        return {
          kind: "not-dispatched",
          code: "upstream-connect-failed",
          upstreamConnect: connectFailure,
        };
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
      } else if (!dispatched) {
        // No HTTP data was queued. Close the TLS connection, preserving the caller's
        // socket so the broker can report a definite pre-dispatch refusal.
        stopUpstream();
      }
      // A completed response and agent:false close the socket. Failed work is destroyed.
      await Promise.allSettled(pending);
      resolveIo();
    }
  };
}
