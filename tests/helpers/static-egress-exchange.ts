import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import type { RequestListener, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import type { Server } from "node:net";
import { buffer } from "node:stream/consumers";
import type { TestContext } from "node:test";
import type { TlsOptions } from "node:tls";
import type {
  EgressInstallation,
  EgressRefusal,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { isArray, isRecord, parseJson } from "./egress-observation-values.ts";
import { listen } from "./listen.ts";
import { grpc, loader, type Grpc } from "./openshell-grpc-sdk.ts";
import {
  decodeExchangeReply,
  type ExchangeReply,
  type Material,
  type Resolution,
  type ResponseFrame,
} from "./static-egress-exchange-wire.ts";
import { requestId } from "./static-egress-request-id.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObservedRequest = {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  body: Json | undefined;
  headers: IncomingHttpHeaders;
};
type ProviderResponse = {
  status: number;
  body?: Json;
  contentType?: string;
  rawBody?: string | Buffer;
  trailers?: OutgoingHttpHeaders;
};

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return isArray(value)
    ? value.every(isJson)
    : isRecord(value) && Object.values(value).every(isJson);
}

export async function createExchangeOrigin<Provider extends Server>(
  t: TestContext,
  tls: TlsOptions,
  createProvider?: (tls: TlsOptions, handle: RequestListener) => Provider,
) {
  const providerRequests: ObservedRequest[] = [];
  let providerResponse: ProviderResponse = { status: 200, body: { output: "fixture answer" } };
  const handle: RequestListener = async (request, response) => {
    try {
      const bytes = await buffer(request);
      const body = bytes.length ? parseJson(bytes.toString("utf8")) : undefined;
      assert.ok(body === undefined || isJson(body), "Invalid test provider JSON request");
      providerRequests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body,
        headers: request.headers,
      });
      response.writeHead(providerResponse.status, {
        "content-type": providerResponse.contentType ?? "application/json",
      });
      response.write(providerResponse.rawBody ?? JSON.stringify(providerResponse.body));
      if (providerResponse.trailers) {
        response.addTrailers(providerResponse.trailers);
      }
      response.end();
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error("Test provider request failed"));
    }
  };
  const provider =
    createProvider === undefined ? createServer(tls, handle) : createProvider(tls, handle);
  return {
    provider,
    providerPort: await listen(t, provider),
    providerRequests,
    getResponse: () => providerResponse,
    setResponse(value: ProviderResponse) {
      providerResponse = value;
    },
  };
}

const middlewarePackage = "openshell.middleware.v1";
const exchangeService = middlewarePackage + ".HttpInstallationExchange";
const resolveRequest = middlewarePackage + ".HttpCredentialResolveRequest";
const exchangeMethod = "/" + exchangeService + "/Exchange";

export const loadExchangeDefinition = () =>
  loader.loadSync(
    new URL(
      "../../apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto",
      import.meta.url,
    ).pathname,
    { keepCase: true, longs: String, enums: Number, defaults: false, oneofs: true },
  );

const serviceNames = [
  "HttpCredentialAccess",
  "HttpResponsePreReturn",
  "SupervisorMiddleware",
  "HttpInstallationExchange",
] as const;

function serviceNamespace(value: Grpc.GrpcObject[string] | undefined): Grpc.GrpcObject {
  assert.ok(
    value && typeof value === "object" && !("format" in value),
    "Missing OpenShell middleware package",
  );
  return value;
}

function readExchangeMethod(definition: ReturnType<typeof loadExchangeDefinition>) {
  const service = definition[exchangeService];
  assert.ok(
    service && !("format" in service),
    "Missing HttpInstallationExchange service descriptor",
  );
  const method = service.Exchange;
  assert.ok(
    method?.path === exchangeMethod &&
      method.requestStream &&
      method.responseStream &&
      typeof method.requestSerialize === "function" &&
      typeof method.responseDeserialize === "function",
    "Missing bidirectional Exchange method descriptor",
  );
  // The SDK descriptors are dynamically loaded. Keep their untyped output at ingress.
  const serialize: (request: ExchangeRequest) => Buffer = method.requestSerialize;
  const deserialize: (bytes: Buffer) => unknown = method.responseDeserialize;
  return { serialize, deserialize };
}

export function createExchangeClients(
  t: TestContext,
  port: number,
  cert: Buffer,
  definition = loadExchangeDefinition(),
) {
  const codecs = readExchangeMethod(definition);
  const request = definition[resolveRequest];
  assert.ok(
    request && "serialize" in request && typeof request.serialize === "function",
    "Missing credential resolve request codec",
  );
  const serializeCapture: (request: Capture) => Buffer = request.serialize;

  const loaded = grpc.loadPackageDefinition(definition);
  const services = serviceNamespace(
    serviceNamespace(serviceNamespace(loaded.openshell).middleware).v1,
  );
  function connect(name: (typeof serviceNames)[number]) {
    const Client = services[name];
    assert.ok(
      typeof Client === "function" && Client.prototype instanceof grpc.Client,
      `Missing gRPC client constructor for ${name}`,
    );
    // Keep the connection on IPv4 loopback and verify the certificate's DNS SAN.
    return new Client(`127.0.0.1:${port}`, grpc.credentials.createSsl(cert), {
      "grpc.ssl_target_name_override": "localhost",
    });
  }

  const clients = {
    HttpCredentialAccess: connect("HttpCredentialAccess"),
    HttpResponsePreReturn: connect("HttpResponsePreReturn"),
    SupervisorMiddleware: connect("SupervisorMiddleware"),
    HttpInstallationExchange: connect("HttpInstallationExchange"),
  };
  t.after(() => {
    for (const client of Object.values(clients)) {
      client.close();
    }
  });
  return {
    clients,
    reconnect() {
      for (const name of serviceNames) {
        clients[name].close();
        clients[name] = connect(name);
      }
    },
    transport: {
      getClient: () => clients.HttpInstallationExchange,
      serializeCapture,
      ...codecs,
      refusalCode(name: Uppercase<EgressRefusal["kind"]> | "UNSPECIFIED"): number {
        const descriptor = definition[middlewarePackage + ".HttpCredentialRefusalCode"];
        assert.ok(
          descriptor &&
            "type" in descriptor &&
            isRecord(descriptor.type) &&
            isArray(descriptor.type.value),
          "Missing HTTP credential refusal codes",
        );
        const entry = descriptor.type.value.find(
          (value) => isRecord(value) && value.name === `HTTP_CREDENTIAL_REFUSAL_CODE_${name}`,
        );
        assert.ok(
          isRecord(entry) && typeof entry.number === "number",
          `Unknown HTTP credential refusal code: ${name}`,
        );
        return entry.number;
      },
    },
  };
}

export const wireTime = (millis: number) => ({
  seconds: Math.floor(millis / 1000),
  nanos: (millis % 1000) * 1e6,
});

export function supervisorBearer(claims: object, privateKey: KeyObject): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "openshell-ext+jwt", kid: "fixture-key" });
  const signed = header + "." + encode(claims);
  return `Bearer ${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
}

type Capture = {
  audience: string;
  deadline: { seconds: string | number; nanos: number };
  response_custody: Buffer;
  verified_execution_policy_hash: string;
  request: {
    context: { request_id: string; sandbox_id: string };
    target: { scheme: string; host: string; port: number; method: string; path: string };
    headers: { name: string; value: string }[];
    body: Buffer;
  };
};

type Permit = {
  context: Capture["request"]["context"];
  operation_handle: Buffer;
  audience: string;
  deadline: Capture["deadline"];
  credential_headers_sha256: Buffer;
} & (
  | { evidence: Material["evidence"]; no_material_required?: never }
  | { no_material_required: true; evidence?: never }
);

type Progress = { head_received: boolean; body_bytes: string | number };
type Opening = { open: { resolve_request: Buffer; signature: Buffer } };
type RequestPayloads = {
  open: Opening["open"];
  authorize: Permit;
  progress: Progress;
  response: ResponseFrame;
};
type ExchangeRequest = {
  [Event in keyof RequestPayloads]: Record<Event, RequestPayloads[Event]> &
    Partial<Record<Exclude<keyof RequestPayloads, Event>, never>>;
}[keyof RequestPayloads];

// The SDK's stream includes permissive Node overloads. Expose the raw operations
// the fixture uses with their request and terminal status types.
type ExchangeStream = {
  write(message: ExchangeRequest): boolean;
  cancel(): void;
  end(): void;
  once(event: "status", listener: (status: Grpc.StatusObject) => void): void;
};

export type Exchange = {
  stream: ExchangeStream;
  next(): Promise<ExchangeReply>;
  challenge: Buffer;
  received: ExchangeReply[];
  opening(captured: Capture, privateKey?: KeyObject, boundChallenge?: Buffer): Opening;
};

type ExchangeTransport = {
  getClient(): Grpc.Client;
  refusalCode(name: Uppercase<EgressRefusal["kind"]> | "UNSPECIFIED"): number;
  serializeCapture(capture: Capture): Buffer;
  serialize(request: ExchangeRequest): Buffer;
  deserialize(bytes: Buffer): unknown;
};

export function receiveExchange<Request>(stream: Grpc.ClientDuplexStream<Request, unknown>) {
  const queued: ExchangeReply[] = [];
  const received: ExchangeReply[] = [];
  const waiting: PromiseWithResolvers<ExchangeReply>[] = [];
  let failure: Error | undefined;
  function terminate(error: Error) {
    failure ??= error;
    for (const waiter of waiting.splice(0)) {
      waiter.reject(failure);
    }
  }
  stream.on("data", (message: unknown) => {
    if (failure) {
      return;
    }
    let reply: ExchangeReply;
    try {
      reply = decodeExchangeReply(message);
    } catch (error) {
      terminate(error instanceof Error ? error : new Error("Invalid installation exchange reply"));
      stream.cancel();
      return;
    }
    received.push(reply);
    const waiter = waiting.shift();
    if (waiter) {
      waiter.resolve(reply);
    } else {
      queued.push(reply);
    }
  });
  stream.on("error", terminate);
  stream.on("end", () =>
    terminate(new Error("Installation exchange ended without another message")),
  );
  return {
    received,
    next(): Promise<ExchangeReply> {
      const reply = queued.shift();
      if (reply) {
        return Promise.resolve(reply);
      }
      if (failure) {
        return Promise.reject(failure);
      }
      const waiter = Promise.withResolvers<ExchangeReply>();
      waiting.push(waiter);
      return waiter.promise;
    },
  };
}

function refusedStream(error: unknown): boolean {
  return isRecord(error) && error.code === grpc.status.PERMISSION_DENIED;
}

function permitRequest(
  captured: Capture,
  ready: Material | NonNullable<Resolution["ready_without_material"]>,
  { noMaterial = false } = {},
): Permit {
  const hash = createHash("sha256");
  let selection: { evidence: Material["evidence"] } | { no_material_required: true };
  if (noMaterial) {
    selection = { no_material_required: true };
  } else {
    assert.ok("credential_headers" in ready && "evidence" in ready, "Expected credential material");
    for (const { name, value } of ready.credential_headers) {
      for (const field of [name, value]) {
        const bytes = Buffer.from(field);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length).update(bytes);
      }
    }
    selection = { evidence: ready.evidence };
  }
  return {
    context: captured.request.context,
    operation_handle: ready.operation_handle,
    audience: "oce-egress",
    deadline: captured.deadline,
    ...selection,
    credential_headers_sha256: hash.digest(),
  };
}

export function createStaticEgressExchange<Provider extends Server>({
  cert,
  controller,
  exchangeKeys,
  getSecretReads,
  installation,
  namespace,
  now,
  origin,
  sandboxId,
  supervisorKey,
  transport,
}: {
  cert: Buffer;
  controller: OpenClawController;
  exchangeKeys: { publicKey: KeyObject; privateKey: KeyObject };
  getSecretReads(): number;
  installation: EgressInstallation;
  namespace: Namespace;
  now(): Date;
  origin: Awaited<ReturnType<typeof createExchangeOrigin<Provider>>>;
  sandboxId: string;
  supervisorKey: KeyObject;
  transport: ExchangeTransport;
}) {
  assert.ok(controller instanceof OpenClawController, "Expected the fixture's real controller");
  assert.ok(namespace.id && namespace.status === "ready", "Expected a ready exchange Namespace");
  const { provider, providerPort, providerRequests, getResponse, setResponse } = origin;
  const supervisorClaims = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: "https://gateway.example.test",
      aud: "oce-egress",
      sub: `spiffe://openshell/sandbox/${sandboxId}`,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      caller_kind: "supervisor",
      sandbox_id: sandboxId,
      instance_id: installation.enforcement.instanceId,
      exchange_key: {
        profile: "openshell-exchange-v1",
        ...exchangeKeys.publicKey.export({ format: "jwk" }),
      },
    };
  };
  function metadata(
    overrides: Partial<Record<keyof ReturnType<typeof supervisorClaims>, unknown>> = {},
  ) {
    const token = supervisorBearer({ ...supervisorClaims(), ...overrides }, supervisorKey);
    const result = new grpc.Metadata();
    result.set("authorization", token);
    return result;
  }
  function capture(
    body: Record<string, Json> = { model: "fixture-model", input: "hello", store: false },
  ): Capture {
    return {
      audience: "oce-egress",
      deadline: wireTime(now().getTime() + 20_000),
      response_custody: randomBytes(32),
      verified_execution_policy_hash: installation.enforcement.policyHash,
      request: {
        context: { request_id: requestId(now().getTime()), sandbox_id: sandboxId },
        target: {
          scheme: "https",
          host: "provider.example.test",
          port: providerPort,
          method: "POST",
          path: "/v1/responses",
        },
        headers: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(body)),
      },
    };
  }
  function send(
    captured: Capture,
    ready: { credential_headers: Material["credential_headers"] },
  ): Promise<ResponseFrame> {
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: "127.0.0.1",
          servername: "provider.example.test",
          ca: cert,
          port: providerPort,
          method: captured.request.target.method,
          path: captured.request.target.path,
          headers: Object.fromEntries(
            [...captured.request.headers, ...ready.credential_headers].map(({ name, value }) => [
              name,
              value,
            ]),
          ),
        },
        (response) => {
          void buffer(response)
            .then((body) => {
              const status = response.statusCode;
              const contentType = response.headers["content-type"];
              assert.ok(
                status !== undefined && contentType !== undefined,
                "Expected a provider status and content type",
              );
              const trailers = response.rawTrailers.flatMap((name, index, lines) => {
                if (index % 2 !== 0) {
                  return [];
                }
                const value = lines[index + 1];
                assert.ok(value !== undefined, "Expected a complete provider trailer");
                return [{ name, value }];
              });
              resolve({
                status,
                headers: [{ name: "content-type", value: contentType }],
                body,
                trailers,
                response_complete: response.complete,
              });
            })
            .catch(reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(captured.request.body);
    });
  }
  async function beginExchange(peer = metadata()): Promise<Exchange> {
    const stream = transport
      .getClient()
      .makeBidiStreamRequest(exchangeMethod, transport.serialize, transport.deserialize, peer, {
        deadline: Date.now() + 5000,
      });
    const reader = receiveExchange(stream);
    try {
      const first = await reader.next();
      assert.equal(first.event, "challenge", "Expected the initial exchange challenge");
      const { challenge } = first;
      return {
        stream,
        ...reader,
        challenge,
        opening(captured, privateKey = exchangeKeys.privateKey, boundChallenge = challenge) {
          const encoded = transport.serializeCapture(captured);
          return {
            open: {
              resolve_request: encoded,
              signature: sign(
                null,
                Buffer.concat([Buffer.from("openshell-exchange-v1\0"), boundChallenge, encoded]),
                privateKey,
              ),
            },
          };
        },
      };
    } catch (error) {
      stream.cancel();
      throw error;
    }
  }

  // These real exchanges keep the operation associated with the stream that opened it.
  const exchangeByHandle = new Map<string, { captured: Capture; exchange: Exchange }>();
  const exchangeByRequest = new WeakMap<Capture, Exchange>();
  async function resolve(captured: Capture, peer?: Grpc.Metadata) {
    const exchange = await beginExchange(peer);
    try {
      exchange.stream.write(exchange.opening(captured));
      const frame = await exchange.next();
      assert.equal(frame.event, "resolved");
      const { resolved } = frame;
      const ready = resolved.ready ?? resolved.ready_without_material;
      if (ready) {
        const handle = ready.operation_handle.toString("base64");
        exchangeByHandle.set(handle, { captured, exchange });
        exchange.stream.once("status", () => exchangeByHandle.delete(handle));
        exchangeByRequest.set(captured, exchange);
      }
      return resolved;
    } catch (error) {
      exchange.stream.cancel();
      throw error;
    }
  }
  async function authorize(permit: Permit, { cancelAfterMs }: { cancelAfterMs?: number } = {}) {
    const entry = exchangeByHandle.get(permit.operation_handle.toString("base64"));
    assert.ok(entry, "The send permit must refer to an open exchange");
    const { captured, exchange } = entry;
    const timer = cancelAfterMs
      ? setTimeout(() => exchange.stream.cancel(), cancelAfterMs)
      : undefined;
    try {
      exchange.stream.write({ authorize: permit });
      const frame = await exchange.next();
      assert.equal(frame.event, "authorized");
      const { authorized } = frame;
      if (authorized.allowed) {
        assert.equal(
          authorized.allowed.no_material_required ?? false,
          permit.no_material_required === true,
        );
        assert.deepEqual(authorized.allowed.response_custody, captured.response_custody);
        assert.deepEqual(
          authorized.allowed.credential_headers_sha256,
          permit.credential_headers_sha256,
        );
      }
      return authorized;
    } catch (error) {
      exchange.stream.cancel();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function progress(captured: Capture, frame: Progress) {
    const exchange = exchangeByRequest.get(captured);
    assert.ok(exchange, "Progress requires the original exchange");
    exchange.stream.write({ progress: frame });
    try {
      const reply = await exchange.next();
      assert.equal(reply.event, "lease", "A progress frame is answered with a lease or a refusal");
      return reply.lease;
    } catch (error) {
      exchange.stream.cancel();
      if (!refusedStream(error)) {
        throw error;
      }
      return { refused: true } as const;
    }
  }
  async function protect(captured: Capture, response: ResponseFrame) {
    const exchange = exchangeByRequest.get(captured);
    assert.ok(exchange, "Response protection requires the original exchange");
    exchange.stream.write({ response });
    try {
      const reply = await exchange.next();
      assert.equal(reply.event, "response");
      assert.equal(reply.response.response_complete, true);
      return reply.response;
    } catch (error) {
      exchange.stream.cancel();
      if (!refusedStream(error)) {
        throw error;
      }
      assert.equal(
        exchange.received.filter(({ event }) => event === "response").length,
        0,
        "a refused complete response must release no response message, even a head",
      );
      return { blocked: true } as const;
    }
  }
  async function exchangeResponse(
    response: ProviderResponse = getResponse(),
    request?: Record<string, Json>,
    peer?: Grpc.Metadata,
  ) {
    const captured = capture(request);
    const { ready } = await resolve(captured, peer);
    assert.ok(ready, "authority resolved this operation");
    const exchange = exchangeByRequest.get(captured);
    assert.ok(exchange);
    try {
      assert.ok((await authorize(permitRequest(captured, ready))).allowed);
      const before = providerRequests.length;
      setResponse(response);
      const result = await protect(captured, await send(captured, ready));
      assert.equal(providerRequests.length, before + 1, "provider received the authorized request");
      return result;
    } catch (error) {
      exchange.stream.cancel();
      throw error;
    }
  }

  return {
    authorize,
    beginExchange,
    capture,
    controller,
    exchangeResponse,
    metadata,
    namespace,
    permitRequest,
    progress,
    protect,
    refusalCode: transport.refusalCode,
    provider,
    providerRequests,
    resolve,
    send,
    get secretReads() {
      return getSecretReads();
    },
  };
}
