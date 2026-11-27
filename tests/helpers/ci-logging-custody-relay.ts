import { request, type ClientRequest, type IncomingMessage, type RequestListener } from "node:http";
import { finished, pipeline } from "node:stream/promises";

type RelayRequest = { method: string; url: string };
type RelayPlan = {
  path?: string;
  interceptResponse?: (status: number, body: Buffer) => Promise<"forward" | "drop">;
};
type RelayEvent = {
  phase:
    | "request"
    | "forward"
    | "headers"
    | "headers-forwarded"
    | "body-end"
    | "response-close"
    | "downstream-close"
    | "abort"
    | "gate-drop"
    | "failed"
    | "end";
  method: "GET" | "HEAD" | "POST" | "DELETE" | "OTHER";
  path:
    | "/_ping"
    | "/version"
    | "/info"
    | "/images/{image}/json"
    | "/containers/create"
    | "/containers/json"
    | "/containers/{id}"
    | "/containers/{id}/json"
    | "/containers/{id}/wait"
    | "/containers/{id}/start"
    | "/containers/{id}/rename"
    | "/other";
  status?: number;
};

function requestProjection(input: RelayRequest): Pick<RelayEvent, "method" | "path"> {
  const method =
    input.method === "GET" ||
    input.method === "HEAD" ||
    input.method === "POST" ||
    input.method === "DELETE"
      ? input.method
      : "OTHER";
  const pathname = new URL(input.url, "http://relay").pathname.replace(/^\/v[0-9.]+/, "");
  let path: RelayEvent["path"] = "/other";
  if (
    ["/_ping", "/version", "/info", "/containers/create", "/containers/json"].includes(pathname)
  ) {
    path = pathname as RelayEvent["path"];
  } else if (/^\/images\/[^/]+\/json$/.test(pathname)) {
    path = "/images/{image}/json";
  } else if (/^\/containers\/[^/]+$/.test(pathname)) {
    path = "/containers/{id}";
  } else {
    const operation = /^\/containers\/[^/]+\/(json|wait|start|rename)$/.exec(pathname)?.[1];
    if (operation) {
      path = `/containers/{id}/${operation}` as RelayEvent["path"];
    }
  }
  return { method, path };
}

// The owner chooses the finite responses that need custody or an after-commit
// gate. Every other response preserves the daemon's streaming HTTP semantics.
function createCiLoggingCustodyRelay({
  socketPath,
  requestTimeoutMs,
  plan,
  record = () => {},
}: {
  socketPath: string;
  requestTimeoutMs: number;
  plan: (request: RelayRequest) => Promise<RelayPlan>;
  record?: (event: RelayEvent) => void;
}) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("The relay requires a finite request deadline.");
  }
  const active = new Map<AbortController, Promise<void>>();
  let closed = false;
  const handle: RequestListener = (incoming, outgoing) => {
    if (closed) {
      outgoing.destroy();
      return;
    }
    const input = { method: incoming.method ?? "GET", url: incoming.url ?? "/" };
    const projection = requestProjection(input);
    const emit = (phase: RelayEvent["phase"], status?: number) =>
      record({ ...projection, phase, ...(status === undefined ? {} : { status }) });
    const controller = new AbortController();
    let upstream: ClientRequest | undefined;
    let upstreamClosed: Promise<void> | undefined;
    const cancel = () => {
      upstream?.destroy();
      outgoing.destroy();
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const abort = () => {
      if (!controller.signal.aborted) {
        emit("abort");
        controller.abort();
      }
    };
    const downstreamClosed = () => {
      emit("downstream-close");
      if (!outgoing.writableFinished) {
        abort();
      }
    };
    incoming.once("aborted", abort);
    outgoing.once("close", downstreamClosed);
    const timer = setTimeout(abort, requestTimeoutMs);
    const run = async () => {
      try {
        emit("request");
        const selected = await plan(input);
        controller.signal.throwIfAborted();
        emit("forward");
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          upstream = request(
            {
              socketPath,
              path: selected.path ?? input.url,
              method: input.method,
              headers: incoming.headers,
              agent: false,
              signal: controller.signal,
            },
            resolve,
          );
          upstreamClosed = new Promise<void>((done) => upstream!.once("close", done));
          upstream.once("error", reject);
          incoming.pipe(upstream);
        });
        const status = response.statusCode ?? 502;
        emit("headers", status);
        response.once("end", () => emit("body-end", status));
        response.once("close", () => emit("response-close", status));
        if (selected.interceptResponse) {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            const buffer = Buffer.from(chunk as Uint8Array);
            bytes += buffer.length;
            if (bytes > 1024 * 1024) {
              throw new Error("The finite relay response exceeded its limit.");
            }
            chunks.push(buffer);
          }
          const body = Buffer.concat(chunks);
          const decision = await selected.interceptResponse(status, body);
          if (decision === "drop") {
            emit("gate-drop", status);
            outgoing.destroy();
            return;
          }
          controller.signal.throwIfAborted();
          outgoing.writeHead(status, response.headers);
          outgoing.flushHeaders();
          emit("headers-forwarded", status);
          outgoing.end(body);
          await finished(outgoing, { cleanup: true });
        } else {
          outgoing.writeHead(status, response.headers);
          outgoing.flushHeaders();
          emit("headers-forwarded", status);
          await pipeline(response, outgoing, { signal: controller.signal });
        }
      } catch {
        emit("failed");
        outgoing.destroy();
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancel);
        incoming.removeListener("aborted", abort);
        outgoing.removeListener("close", downstreamClosed);
        upstream?.destroy();
        await upstreamClosed;
        emit("end");
      }
    };
    const pending = run();
    active.set(controller, pending);
    void pending.then(
      () => active.delete(controller),
      () => active.delete(controller),
    );
  };
  const close = async () => {
    closed = true;
    for (const controller of active.keys()) {
      controller.abort();
    }
    await Promise.allSettled(active.values());
  };
  return { handle, close };
}

export { createCiLoggingCustodyRelay };
export type { RelayEvent, RelayPlan, RelayRequest };
