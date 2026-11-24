import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import type { OccMetrics } from "./index.ts";

export interface MetricsConfiguration {
  readonly host: string;
  readonly port: number;
}

export function metricsConfiguration(
  environment: NodeJS.ProcessEnv,
  mode: string,
  apiPort?: number,
): MetricsConfiguration | undefined {
  const enabled = environment.OCC_METRICS_ENABLED ?? "false";
  const host = environment.OCC_METRICS_HOST;
  const rawPort = environment.OCC_METRICS_PORT;
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("OCC_METRICS_ENABLED must be true or false.");
  }
  if (enabled === "false") {
    if (host !== undefined || rawPort !== undefined) {
      throw new Error("Disabled metrics cannot have host or port settings.");
    }
    return undefined;
  }
  if (mode !== "development" && mode !== "production") {
    throw new Error("Metrics require development or production mode.");
  }
  const port = Number(rawPort);
  if (
    rawPort === undefined ||
    !/^\d+$/.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === apiPort
  ) {
    throw new Error("OCC_METRICS_PORT must be a distinct valid TCP port.");
  }
  if (host === undefined || isIP(host) === 0) {
    throw new Error("OCC_METRICS_HOST must be an explicit IP address.");
  }
  const canonicalHost =
    isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host;
  if (mode === "development" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Development metrics require loopback.");
  }
  if (
    mode === "production" &&
    (canonicalHost === "0.0.0.0" ||
      canonicalHost === "::" ||
      canonicalHost === "::1" ||
      /^127\./.test(canonicalHost) ||
      /^::ffff:/i.test(canonicalHost))
  ) {
    throw new Error("Production metrics require an explicit Pod interface address.");
  }
  return { host, port };
}

export async function startMetricsListener(
  metrics: OccMetrics,
  configuration: MetricsConfiguration,
) {
  const sockets = new WeakMap<
    Socket,
    {
      outstanding: number;
      closing: boolean;
      completions: Set<() => void>;
      closeTimer?: NodeJS.Timeout;
    }
  >();
  let admittedScrapes = 0;
  const socketState = (socket: Socket) => {
    let state = sockets.get(socket);
    if (state === undefined) {
      state = { outstanding: 0, closing: false, completions: new Set() };
      sockets.set(socket, state);
      const owned = state;
      socket.once("close", () => {
        owned.closing = true;
        clearTimeout(owned.closeTimer);
        // CONNECT and upgrade dispatch can detach Node's HTTP queue cleanup.
        // The socket still owns every admitted response until it terminates.
        for (const complete of owned.completions) {
          complete();
        }
      });
    }
    return state;
  };
  const beginClosing = (socket: Socket, state: ReturnType<typeof socketState>) => {
    state.closing = true;
    state.closeTimer = setTimeout(() => socket.destroy(), 1_000);
    state.closeTimer.unref();
  };
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    expectation?: "continue" | "unsupported",
  ) => {
    const socket = request.socket;
    const state = socketState(socket);
    if (state.closing || socket.destroyed) {
      socket.destroy();
      return;
    }

    // Host, Expect, route and capacity responses share this admission boundary.
    const overflow = state.outstanding >= 16;
    state.outstanding++;
    const owned = state;
    let responseDone = false;
    let collectionDone = true;
    let ownsScrapeSlot = false;
    let deadline: NodeJS.Timeout | undefined = undefined;
    const releaseScrape = () => {
      if (ownsScrapeSlot && responseDone && collectionDone) {
        ownsScrapeSlot = false;
        admittedScrapes--;
      }
    };
    const finishResponse = () => {
      if (responseDone) {
        return;
      }
      responseDone = true;
      owned.outstanding--;
      owned.completions.delete(finishResponse);
      clearTimeout(deadline);
      response.off("finish", finishResponse);
      response.off("close", finishResponse);
      releaseScrape();
    };
    owned.completions.add(finishResponse);
    response.once("finish", finishResponse);
    response.once("close", finishResponse);
    response.setHeader("Cache-Control", "no-store");

    const closeResponse = (status: number) => {
      // Node can parse more pipelined requests after Connection: close. Reply
      // once, then destroy on further input, or after the bounded drain period.
      beginClosing(socket, owned);
      response.writeHead(status, { Connection: "close", "Content-Length": "0" }).end();
    };
    if (overflow) {
      closeResponse(503);
      return;
    }
    if (
      request.httpVersionMajor === 1 &&
      request.httpVersionMinor === 1 &&
      request.headers.host === undefined
    ) {
      closeResponse(400);
      return;
    }
    if (expectation === "unsupported") {
      response.writeHead(417).end();
      return;
    }
    if (expectation === "continue") {
      response.writeContinue();
    }
    if (request.url !== "/metrics") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (admittedScrapes >= 16) {
      closeResponse(503);
      return;
    }
    admittedScrapes++;
    ownsScrapeSlot = true;
    collectionDone = false;
    deadline = setTimeout(() => {
      if (!responseDone && !response.writableEnded && !response.destroyed) {
        response.writeHead(503).end();
      }
    }, 5_000);
    try {
      const body = await metrics.exposition();
      if (!responseDone && !response.writableEnded && !response.destroyed) {
        response.writeHead(200, { "Content-Type": metrics.contentType }).end(body);
      }
    } catch {
      if (!responseDone && !response.writableEnded && !response.destroyed) {
        response.writeHead(503).end();
      }
    } finally {
      clearTimeout(deadline);
      collectionDone = true;
      releaseScrape();
    }
  };
  const server = createServer(
    {
      requestTimeout: 5_000,
      headersTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
      // Preserve Node's HTTP/1.1 Host requirement inside the shared admission
      // path, before an automatic 400 can bypass response accounting.
      requireHostHeader: false,
    },
    handleRequest,
  );
  server.on("checkContinue", (request, response) => {
    void handleRequest(request, response, "continue");
  });
  server.on("checkExpectation", (request, response) => {
    void handleRequest(request, response, "unsupported");
  });
  server.on("clientError", (error: NodeJS.ErrnoException, connection) => {
    const socket = connection as Socket;
    const state = socketState(socket);
    // Node's parser-error fallback writes directly to the socket. It must not
    // overtake pending responses or append another refusal while closing.
    if (state.closing || state.outstanding > 0 || !socket.writable) {
      socket.destroy();
      return;
    }
    beginClosing(socket, state);
    const status =
      error.code === "HPE_HEADER_OVERFLOW"
        ? "431 Request Header Fields Too Large"
        : error.code === "HPE_CHUNK_EXTENSIONS_OVERFLOW"
          ? "413 Payload Too Large"
          : error.code === "ERR_HTTP_REQUEST_TIMEOUT"
            ? "408 Request Timeout"
            : "400 Bad Request";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  server.maxConnections = 16;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(5_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.port, configuration.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Metrics listener address unavailable.");
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://${isIP(configuration.host) === 6 ? `[${configuration.host}]` : configuration.host}:${address.port}`,
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
