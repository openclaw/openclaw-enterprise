import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { isIPv4 } from "node:net";

interface ProxyHeaders {
  identity: string;
  scopes?: string | undefined;
}

export type ProxyRequest =
  | (ProxyHeaders & { kind?: undefined; operation?: "sessions_list" | undefined })
  | (ProxyHeaders & {
      kind: "ws";
      operation?: undefined;
      paired?: boolean | undefined;
      method?: "config.get" | "sessions.list" | undefined;
      password?: string | undefined;
      requestedScopes?: string[] | undefined;
    });

type SocketRequest = Extract<ProxyRequest, { kind: "ws" }> & {
  device?: { publicKey: KeyObject; privateKey: KeyObject };
};

type SocketOutcome =
  | { status: "hello"; scopes: string[]; hasDeviceToken: boolean }
  | { status: "closed"; code: number; body: string }
  | { status: "handshake-refused"; http: number | undefined }
  | { status: "timeout" }
  | {
      status: "error" | "connect-error" | "operation-ok" | "operation-denied" | "pairing-failed";
      body: string | undefined;
    };

interface ProxySocket extends EventEmitter<{
  "unexpected-response": [unknown, IncomingMessage];
  error: [Error];
  close: [number, Buffer];
  message: [Buffer];
}> {
  close(): void;
  terminate(): void;
  send(data: string): void;
}

function record(value: unknown, message: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), message);
  return Object.fromEntries(Object.entries(value));
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function proxyRequest(value: unknown): ProxyRequest {
  const { identity, scopes, kind, operation, paired, method, password, requestedScopes } = record(
    value,
    "Expected a proxy request",
  );
  assert.ok(typeof identity === "string" && identity.length > 0, "Expected a proxy identity");
  assert.ok(scopes === undefined || typeof scopes === "string", "Invalid scope header");
  if (kind === "ws") {
    assert.equal(operation, undefined);
    assert.ok(paired === undefined || typeof paired === "boolean", "Invalid pairing flag");
    assert.ok(method === undefined || method === "config.get" || method === "sessions.list");
    assert.ok(password === undefined || typeof password === "string", "Invalid password input");
    assert.ok(requestedScopes === undefined || isStringArray(requestedScopes), "Invalid scopes");
    return { kind, identity, scopes, paired, method, password, requestedScopes };
  }
  assert.equal(kind, undefined);
  assert.ok(operation === undefined || operation === "sessions_list");
  return { identity, scopes, operation };
}

function proxyHeaders({ identity, scopes }: ProxyHeaders): Record<string, string> {
  return {
    "x-real-ip": "192.0.2.10",
    "x-occ-identity": identity,
    ...(scopes === undefined ? {} : { "x-openclaw-scopes": scopes }),
  };
}

async function http(address: string, request: Extract<ProxyRequest, { kind?: undefined }>) {
  const invoke = request.operation === "sessions_list";
  const path = invoke ? "/tools/invoke" : "/sessions/probe-session/kill";
  const response = await fetch(`http://${address}:8080${path}`, {
    method: "POST",
    headers: {
      ...proxyHeaders(request),
      ...(invoke ? { "content-type": "application/json" } : {}),
    },
    ...(invoke ? { body: JSON.stringify({ tool: "sessions_list", args: {} }) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.text() };
}

type Frame =
  | { type: "challenge"; nonce: string }
  | { type: "reply"; id: "connect" | "operation"; ok: boolean; payload: unknown; error: unknown };

export function proxyFrame(json: string): Frame | undefined {
  const body = record(JSON.parse(json), "Expected a Gateway frame");
  if (body.type === "event" && body.event === "connect.challenge") {
    const { nonce } = record(body.payload, "Expected a Gateway challenge");
    assert.ok(typeof nonce === "string" && nonce.length > 0, "Invalid challenge nonce");
    return { type: "challenge", nonce };
  }
  if (body.type === "res" && (body.id === "connect" || body.id === "operation")) {
    assert.ok(typeof body.ok === "boolean", "Gateway reply is missing a boolean status");
    return { type: "reply", id: body.id, ok: body.ok, payload: body.payload, error: body.error };
  }
  // Other Gateway events are not replies to this probe.
  return undefined;
}

function connect(socket: ProxySocket, request: SocketRequest, nonce: string) {
  const client = request.device
    ? { id: "openclaw-control-ui", version: "1.0.0", platform: "linux", mode: "ui" }
    : { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" };
  const scopes = request.requestedScopes ?? [];
  let device;
  if (request.device) {
    const signedAt = Date.now();
    const publicKey = request.device.publicKey.export({ format: "jwk" }).x;
    assert.ok(publicKey, "Ed25519 public key has no coordinate");
    const id = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const payload = [
      "v3",
      id,
      client.id,
      client.mode,
      "operator",
      scopes.join(","),
      String(signedAt),
      request.password ?? "",
      nonce,
      "linux",
      "",
    ].join("|");
    device = {
      id,
      publicKey,
      signedAt,
      nonce,
      signature: sign(null, Buffer.from(payload), request.device.privateKey).toString("base64url"),
    };
  }
  socket.send(
    JSON.stringify({
      type: "req",
      id: "connect",
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client,
        caps: [],
        commands: [],
        role: "operator",
        scopes,
        ...(device ? { device } : {}),
        ...(request.password ? { auth: { password: request.password } } : {}),
      },
    }),
  );
}

function reply(
  socket: ProxySocket,
  request: SocketRequest,
  frame: Extract<Frame, { type: "reply" }>,
): SocketOutcome | undefined {
  if (frame.id === "operation") {
    return {
      status: frame.ok ? "operation-ok" : "operation-denied",
      body: JSON.stringify(frame.error ?? frame.payload),
    };
  }
  if (!frame.ok) {
    return { status: "connect-error", body: JSON.stringify(frame.error) };
  }
  if (request.method) {
    socket.send(
      JSON.stringify({ type: "req", id: "operation", method: request.method, params: {} }),
    );
    return undefined;
  }
  const { auth } = record(frame.payload, "Expected a Gateway hello");
  const { scopes, deviceToken } = record(auth, "Expected Gateway hello authentication");
  assert.ok(isStringArray(scopes), "Expected granted scopes in the Gateway hello");
  assert.ok(deviceToken === undefined || typeof deviceToken === "string", "Invalid device token");
  return { status: "hello", scopes, hasDeviceToken: deviceToken !== undefined };
}

function ws(address: string, request: SocketRequest): Promise<SocketOutcome> {
  // Resolve the image's bundled ws from the same package root as OpenClaw.
  const WebSocket = createRequire("/app/package.json")("ws") as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => ProxySocket;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${address}:8080`, {
      headers: {
        ...proxyHeaders(request),
        ...(request.device ? { origin: "https://agent.example.test" } : {}),
      },
    });
    const timer = setTimeout(() => {
      resolve({ status: "timeout" });
      socket.terminate();
    }, 15_000);
    function done(value: SocketOutcome) {
      clearTimeout(timer);
      resolve(value);
      socket.close();
    }
    socket.on("unexpected-response", (_request, response) => {
      done({ status: "handshake-refused", http: response.statusCode });
    });
    socket.on("error", (error) => done({ status: "error", body: error.message }));
    socket.on("close", (code, reason) => done({ status: "closed", code, body: String(reason) }));
    socket.on("message", (data) => {
      try {
        const frame = proxyFrame(String(data));
        if (frame?.type === "challenge") {
          connect(socket, request, frame.nonce);
        } else if (frame?.type === "reply") {
          const result = reply(socket, request, frame);
          if (result) {
            done(result);
          }
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        socket.terminate();
      }
    });
  });
}

async function runRequest(address: string, request: ProxyRequest) {
  if (request.kind !== "ws") {
    return http(address, request);
  }
  if (!request.paired) {
    return ws(address, request);
  }
  // Pair through the admin route, then reuse the privileged device on chat.
  const device = generateKeyPairSync("ed25519");
  const paired = await ws(address, {
    ...request,
    device,
    method: undefined,
    scopes: "operator.admin",
    requestedScopes: ["operator.admin"],
  });
  if (
    paired.status !== "hello" ||
    paired.hasDeviceToken ||
    !paired.scopes.includes("operator.admin")
  ) {
    return { status: "pairing-failed", body: JSON.stringify(paired) };
  }
  return ws(address, { ...request, device, requestedScopes: ["operator.admin"] });
}

if (import.meta.main) {
  const [address, encoded] = process.argv.slice(2);
  assert.ok(address && isIPv4(address), "Expected the Gateway's internal IPv4 address");
  assert.ok(encoded, "Expected encoded requests");
  const input: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.ok(Array.isArray(input), "Expected a proxy request array");
  const requests = input.map(proxyRequest);
  const outcomes = await Promise.allSettled(
    requests.map((request) => runRequest(address, request)),
  );
  console.log(
    JSON.stringify(
      outcomes.map((outcome) => {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
        return outcome.value;
      }),
    ),
  );
}
