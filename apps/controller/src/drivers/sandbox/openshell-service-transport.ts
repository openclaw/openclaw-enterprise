import { DependencyUnavailableError, gatewayEndpointRewritesIpv4 } from "@openclaw-enterprise/occ";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import { Agent, WebSocket, buildConnector } from "undici";
import { asRecord } from "@openclaw-enterprise/utils";
import { OpenShellGatewayFailure } from "./openshell-gateway-errors.ts";

/** What a bearer-passthrough service answered to one bounded request. */
export interface OpenShellServiceDocument {
  readonly status: number;
  /** Parsed only for an `application/json` answer within the size bound. */
  readonly json?: unknown;
}

interface ServiceTransportOptions {
  readonly endpoint: string;
  readonly rootCertificate?: Buffer;
  readonly requestTimeoutMs: number;
}

/** The gateway listener, or the service behind it, did not answer one bounded request. */
export class OpenShellServiceTransportError extends DependencyUnavailableError {
  readonly reason: "timeout" | "unreachable";

  constructor(reason: "timeout" | "unreachable") {
    super(
      reason === "timeout"
        ? "OpenShell service request timed out."
        : "OpenShell service is unreachable.",
    );
    this.name = "OpenShellServiceTransportError";
    this.reason = reason;
  }
}

const MAX_SERVICE_RESPONSE_BYTES = 16 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The pinned OpenShell release serves provider-advertised service traffic on the
// control endpoint's listener and routes it by Host. Compute reaches a service the
// way its workload client would, without depending on the advertised name resolving
// from the controller: connect to the control endpoint, name the service in Host.
export function serviceTarget(
  options: ServiceTransportOptions,
  serviceUrl: string,
): {
  readonly secure: boolean;
  readonly hostname: string;
  readonly port: number;
  readonly host: string;
} {
  let service: URL;
  try {
    service = new URL(serviceUrl);
  } catch {
    throw new OpenShellGatewayFailure("OpenShell service URL must be a valid URL.");
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(service.protocol) ||
    service.username ||
    service.password ||
    service.pathname !== "/" ||
    service.search ||
    service.hash
  ) {
    throw new OpenShellGatewayFailure(
      "OpenShell service URL must be an HTTP origin without credentials, query, or fragment.",
    );
  }
  if (gatewayEndpointRewritesIpv4(options.endpoint)) {
    throw new OpenShellGatewayFailure(
      "OpenShell gateway endpoint IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.",
    );
  }
  const endpoint = options.endpoint.includes("://")
    ? new URL(options.endpoint)
    : new URL(`http://${options.endpoint}`);
  const secure = endpoint.protocol === "https:";
  return {
    secure,
    hostname: endpoint.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(endpoint.port || (secure ? 443 : 80)),
    host: service.host,
  };
}

// The gateway certificate is verified against the control endpoint, as the gRPC
// channel does, never against the service named in Host. A DNS endpoint is sent as
// SNI. TLS forbids an IP address in SNI, so an IP endpoint sends none (an empty
// servername; left undefined, Node would derive SNI and the identity check from
// Host) and its certificate must carry that IP.
function tlsIdentity(hostname: string): {
  readonly servername: string;
  readonly checkServerIdentity?: typeof checkServerIdentity;
} {
  if (isIP(hostname) === 0) {
    return { servername: hostname };
  }
  return {
    servername: "",
    checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
  };
}

function bearerHeader(bearer: string): string {
  // OpenShell refuses anything but one RFC 6750 token68 credential before routing.
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(bearer)) {
    throw new OpenShellGatewayFailure("OpenShell service bearer must be a token68 value.");
  }
  return `Bearer ${bearer}`;
}

function send(
  options: ServiceTransportOptions,
  serviceUrl: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  handle: (
    request: ClientRequest,
    resolve: (value: OpenShellServiceDocument | boolean) => void,
    reject: (error: unknown) => void,
  ) => void,
  body?: string,
): Promise<OpenShellServiceDocument | boolean> {
  const target = serviceTarget(options, serviceUrl);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const request = (target.secure ? httpsRequest : httpRequest)({
      hostname: target.hostname,
      port: target.port,
      method: body === undefined ? "GET" : "POST",
      path,
      headers: {
        ...headers,
        host: target.host,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
            }),
      },
      agent: false,
      ...(target.secure
        ? {
            ...tlsIdentity(target.hostname),
            ...(options.rootCertificate === undefined ? {} : { ca: options.rootCertificate }),
          }
        : {}),
    });
    const abort = () => {
      request.destroy();
      finish(() => reject(signal.reason));
    };
    const timer = setTimeout(() => {
      request.destroy();
      finish(() => reject(new OpenShellServiceTransportError("timeout")));
    }, options.requestTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", () =>
      finish(() => reject(new OpenShellServiceTransportError("unreachable"))),
    );
    handle(
      request,
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    request.end(body);
  });
}

/** A bounded JSON exchange through the existing authenticated service transport. */
async function serviceDocument(
  options: ServiceTransportOptions,
  serviceUrl: string,
  path: string,
  bearer: string,
  signal: AbortSignal,
  body?: string,
): Promise<OpenShellServiceDocument> {
  if (body !== undefined && Buffer.byteLength(body) > 4096) {
    throw new OpenShellGatewayFailure("OpenShell service request exceeds its size bound.");
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new OpenShellGatewayFailure("OpenShell service path must be absolute.");
  }
  return (await send(
    options,
    serviceUrl,
    path,
    { authorization: bearerHeader(bearer), accept: "application/json" },
    signal,
    (request, resolve) => {
      request.on("upgrade", (_response: IncomingMessage, socket: Socket) => {
        socket.destroy();
        resolve({ status: 101 });
      });
      request.on("response", (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const json = /^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "");
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_SERVICE_RESPONSE_BYTES) {
            response.destroy();
            resolve({ status });
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => resolve({ status }));
        response.on("end", () => {
          if (!json) {
            resolve({ status });
            return;
          }
          try {
            resolve({ status, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            resolve({ status });
          }
        });
      });
    },
    body,
  )) as OpenShellServiceDocument;
}

export function getServiceDocument(
  options: ServiceTransportOptions,
  serviceUrl: string,
  path: string,
  bearer: string,
  signal: AbortSignal,
): Promise<OpenShellServiceDocument> {
  return serviceDocument(options, serviceUrl, path, bearer, signal);
}

export function postServiceDocument(
  options: ServiceTransportOptions,
  serviceUrl: string,
  path: string,
  bearer: string,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<OpenShellServiceDocument> {
  return serviceDocument(options, serviceUrl, path, bearer, signal, JSON.stringify(body));
}

/**
 * True when the service completes an authenticated WebSocket handshake (`101` with
 * the matching accept key), as the Agent Gateway's own connection would.
 */
export async function serviceWebSocketHandshake(
  options: ServiceTransportOptions,
  serviceUrl: string,
  bearer: string,
  signal: AbortSignal,
): Promise<boolean> {
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  return (await send(
    options,
    serviceUrl,
    "/",
    {
      authorization: bearerHeader(bearer),
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": key,
    },
    signal,
    (request, resolve) => {
      request.on("upgrade", (response: IncomingMessage, socket: Socket) => {
        if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== accept) {
          socket.destroy();
          resolve(false);
          return;
        }
        // A probe owns only this disposable connection. Send a masked RFC 6455
        // normal-close frame so the Harness does not report an abrupt disconnect.
        const mask = randomBytes(4);
        const closeFrame = Buffer.alloc(8);
        closeFrame.set([0x88, 0x82]);
        mask.copy(closeFrame, 2);
        closeFrame.writeUInt16BE(1000 ^ mask.readUInt16BE(0), 6);
        const cleanup = setTimeout(() => socket.destroy(), options.requestTimeoutMs);
        cleanup.unref();
        socket.once("close", () => clearTimeout(cleanup));
        socket.once("error", () => socket.destroy());
        // Let the server close TCP after acknowledging Close, within the bound above.
        socket.once("end", () => socket.end());
        socket.resume();
        socket.write(closeFrame);
        resolve(true);
      });
      request.on("response", (response: IncomingMessage) => {
        response.destroy();
        resolve(false);
      });
    },
  )) as boolean;
}

/** A fresh serving process must have hydrated its admitted PAT, not merely opened its port. */
export async function serviceCodexPatStatus(
  options: ServiceTransportOptions,
  serviceUrl: string,
  bearer: string,
  signal: AbortSignal,
): Promise<"unavailable" | "starting" | "serving"> {
  const target = serviceTarget(options, serviceUrl);
  const authorization = bearerHeader(bearer);
  signal.throwIfAborted();
  let transportSocket: Socket | undefined;
  let disposed = false;
  const connect = buildConnector({
    allowH2: false,
    timeout: options.requestTimeoutMs,
    ...(target.secure ? tlsIdentity(target.hostname) : {}),
    ...(options.rootCertificate === undefined ? {} : { ca: options.rootCertificate }),
  });
  // Preserve the advertised Host while verifying/connecting to the control endpoint,
  // exactly as the HTTP service transport does. This dispatcher belongs to this read only.
  const dispatcher = new Agent({
    webSocket: { maxPayloadSize: MAX_SERVICE_RESPONSE_BYTES, maxFragments: 32 },
    connect: (settings, callback) =>
      connect(
        {
          ...settings,
          hostname: target.hostname,
          host: target.hostname,
          port: String(target.port),
          ...(target.secure ? { servername: tlsIdentity(target.hostname).servername } : {}),
        },
        (...result) => {
          const [, connected] = result;
          if (connected) {
            transportSocket = connected;
            if (disposed) {
              connected.destroy();
            }
          }
          callback(...result);
        },
      ),
  });
  const url = new URL(serviceUrl);
  url.protocol = target.secure ? "wss:" : "ws:";
  // Fetch applies browser port restrictions and discards explicit Host headers.
  // Dispatch to the validated service origin after that layer to preserve its Host;
  // the connector still dials and verifies only the configured control endpoint.
  const origin = `${target.secure ? "https:" : "http:"}//${target.host}`;
  const serviceDispatcher = dispatcher.compose(
    (dispatch) => (request, handler) => dispatch({ ...request, origin }, handler),
  );
  url.port = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let opened = false;
    let bytes = 0;
    const socket = new WebSocket(url, {
      dispatcher: serviceDispatcher,
      headers: { authorization },
    });
    const dispose = () => {
      disposed = true;
      // Undici detaches upgraded sockets from the dispatcher. This read still owns
      // its connection, including when the peer never acknowledges normal Close.
      transportSocket?.destroy();
      void dispatcher.destroy().catch(() => {});
    };
    const finish = (status: "unavailable" | "starting" | "serving", error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
        const cleanup = setTimeout(dispose, options.requestTimeoutMs);
        cleanup.unref();
        socket.addEventListener(
          "close",
          () => {
            clearTimeout(cleanup);
            dispose();
          },
          { once: true },
        );
      } else {
        dispose();
      }
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(status);
      }
    };
    const abort = () => finish("starting", signal.reason);
    const deadline = setTimeout(
      () => finish("starting", new OpenShellServiceTransportError("timeout")),
      options.requestTimeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      if (settled) {
        dispose();
        return;
      }
      opened = true;
      socket.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "occ-harness-readiness", version: "1" } },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (settled) {
        return;
      }
      if (
        typeof event.data !== "string" ||
        (bytes += Buffer.byteLength(event.data)) > MAX_SERVICE_RESPONSE_BYTES
      ) {
        finish("starting");
        return;
      }
      let message;
      try {
        message = asRecord(JSON.parse(event.data));
      } catch {
        finish("starting");
        return;
      }
      // Notifications do not complete either request; the shared byte/deadline bounds apply.
      if (typeof message?.method === "string" && message.id === undefined) {
        return;
      }
      const result = asRecord(message?.result);
      if (message?.error !== undefined || result === undefined) {
        finish("starting");
      } else if (!initialized && message?.id === 1 && typeof result.userAgent === "string") {
        initialized = true;
        socket.send(JSON.stringify({ method: "initialized" }));
        socket.send(
          JSON.stringify({
            id: 2,
            method: "getAuthStatus",
            params: { includeToken: false, refreshToken: false },
          }),
        );
      } else if (initialized && message?.id === 2) {
        finish(
          result.authMethod === "personalAccessToken" &&
            result.authToken === null &&
            result.requiresOpenaiAuth === true
            ? "serving"
            : "starting",
        );
      } else {
        finish("starting");
      }
    });
    socket.addEventListener("error", () => finish(opened ? "starting" : "unavailable"));
    socket.addEventListener("close", () => finish(opened ? "starting" : "unavailable"));
  });
}
