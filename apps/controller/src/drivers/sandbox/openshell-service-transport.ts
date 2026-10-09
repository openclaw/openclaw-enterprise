import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
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

const MAX_SERVICE_RESPONSE_BYTES = 16 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The pinned OpenShell release serves provider-advertised service traffic on the
// control endpoint's listener and routes it by Host. Compute reaches a service the
// way its workload client would, without depending on the advertised name resolving
// from the controller: connect to the control endpoint, name the service in Host.
function serviceTarget(
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
      method: "GET",
      path,
      headers: { ...headers, host: target.host },
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
      finish(() => reject(new DependencyUnavailableError("OpenShell service request timed out.")));
    }, options.requestTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", () =>
      finish(() => reject(new DependencyUnavailableError("OpenShell service is unreachable."))),
    );
    handle(
      request,
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    request.end();
  });
}

/** One bounded GET to a bearer-passthrough service path. */
export async function getServiceDocument(
  options: ServiceTransportOptions,
  serviceUrl: string,
  path: string,
  bearer: string,
  signal: AbortSignal,
): Promise<OpenShellServiceDocument> {
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
  )) as OpenShellServiceDocument;
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
        socket.destroy();
        resolve(response.statusCode === 101 && response.headers["sec-websocket-accept"] === accept);
      });
      request.on("response", (response: IncomingMessage) => {
        response.resume();
        resolve(false);
      });
    },
  )) as boolean;
}
