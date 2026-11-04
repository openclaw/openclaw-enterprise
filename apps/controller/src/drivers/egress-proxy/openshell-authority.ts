import type { CredentialProxyExchange } from "@openclaw-enterprise/contracts";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadSync } from "@grpc/proto-loader";
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  status,
  type Metadata,
  type ServiceDefinition,
  type ServerUnaryCall,
  type sendUnaryData,
  type ServerDuplexStream,
} from "@grpc/grpc-js";
import type { EgressMaterialEvidence, EgressRefusal } from "@openclaw-enterprise/contracts";
import { STREAM_LEASE_IDLE_MS } from "@openclaw-enterprise/occ";
import { asRecord } from "@openclaw-enterprise/utils";
import { OpenShellEgressIdentity } from "./openshell-identity.ts";
import {
  advertisesOpenShellExecutionProfile,
  openShellExchangeCapabilities,
} from "./openshell-exchange-capabilities.ts";

type Wire = Record<string, unknown>;
type AuthorityCall = {
  request: Wire;
  authorization: string;
  signal: AbortSignal;
};
const contractCapability = "openshell.supervisor-middleware.contract";
export const record = (input: unknown): Wire => asRecord(input) ?? {};
const string = (input: unknown): string => (typeof input === "string" ? input : "");
const bytes = (input: unknown): Buffer =>
  input instanceof Uint8Array ? Buffer.from(input) : Buffer.alloc(0);
export const middlewareBearer = (metadata: Metadata): string => {
  const values = metadata.get("authorization");
  return values.length === 1 ? string(values[0]) : "";
};
const headers = (input: unknown): readonly (readonly [string, string])[] =>
  Array.isArray(input)
    ? input.map((item) => [string(record(item).name), string(record(item).value)] as const)
    : [];

function timestamp(value: unknown): string {
  const item = record(value);
  const seconds = Number(item.seconds);
  const nanos = Number(item.nanos ?? 0);
  const millis = seconds * 1000 + nanos / 1_000_000;
  return Number.isSafeInteger(seconds) &&
    Number.isInteger(nanos) &&
    nanos >= 0 &&
    nanos < 1_000_000_000 &&
    Number.isFinite(millis) &&
    Math.abs(millis) < 8.64e15
    ? new Date(millis).toISOString()
    : "";
}

function wireTimestamp(value: string): Wire {
  const time = Date.parse(value);
  return { seconds: Math.floor(time / 1000), nanos: (time % 1000) * 1_000_000 };
}

const refusalCodes = {
  denied: 1,
  not_ready: 2,
  unavailable: 3,
  cancelled: 4,
  deadline_exceeded: 5,
} satisfies Record<EgressRefusal["kind"], number>;

/** Exchange streams on one authority that have not yet presented a signed opening. */
const pendingOpeningCapacity = 1024;
/**
 * Pending openings for one Sandbox: a quarter of the pool, like the Credential Proxy's
 * per-Sandbox shares. A supervisor signs its opening at once, so this is far above normal use.
 */
const pendingOpeningSandboxShare = pendingOpeningCapacity / 4;

function refused(kind: EgressRefusal["kind"]): Wire {
  return { refused: { code: refusalCodes[kind] ?? refusalCodes.denied } };
}

/** Both authorities speak this wire protocol but advertise different capability profiles. */
export function loadOpenShellMiddleware() {
  const definition = loadSync(
    fileURLToPath(new URL("./proto/supervisor_middleware.proto", import.meta.url)),
    { keepCase: true, longs: String, enums: Number, defaults: false, oneofs: true },
  );
  const loaded = loadPackageDefinition(definition) as unknown as {
    openshell: { middleware: { v1: Record<string, { service: ServiceDefinition }> } };
  };
  return { definition, service: loaded.openshell.middleware.v1 };
}

export interface OpenShellHttpPolicySet {
  readonly implementation: string;
  readonly version: string;
}

export function describeOpenShellMiddleware(
  gateway: unknown,
  audience: string,
  implementation: "static-egress" | "online-request-authorization",
  httpPolicySet?: OpenShellHttpPolicySet,
): Wire | undefined {
  const execution = implementation === "static-egress";
  const profile = execution
    ? [contractCapability, ...openShellExchangeCapabilities]
    : [contractCapability];
  const peer = record(gateway);
  const supported = peer.supported_capabilities;
  const required = peer.required_capabilities;
  if (
    record(peer.protocol_version).major !== 1 ||
    !Array.isArray(supported) ||
    !supported.includes(contractCapability) ||
    (execution && !advertisesOpenShellExecutionProfile(supported)) ||
    // Describe precedes protected-policy selection; only the base contract is required here.
    !Array.isArray(required) ||
    !required.includes(contractCapability) ||
    !required.every((capability) => profile.includes(capability))
  ) {
    return undefined;
  }
  const bindings = execution
    ? [
        [1, 1],
        [4, 1],
        [3, 2],
      ]
    : httpPolicySet
      ? [
          [1, 1],
          [2, 1],
        ]
      : [[1, 1]];
  return {
    name: `oce-${implementation}`,
    expected_audience: audience,
    extension: {
      protocol_version: { major: 1, minor: 0 },
      implementation_name: httpPolicySet?.implementation ?? `oce/${implementation}`,
      implementation_version: httpPolicySet?.version ?? "1",
      supported_capabilities: profile,
      required_capabilities: profile,
    },
    bindings: bindings.map(([operation, phase]) => ({
      operation,
      phase,
      max_payload_bytes: 4 * 1024 * 1024,
    })),
  };
}

/** Actual gRPC adapter for the supervisor's exclusive static-credential authority. */
export function createOpenShellEgressAuthority(
  identity: OpenShellEgressIdentity,
  controller: {
    createCredentialProxy: (owner: OpenShellEgressIdentity) => CredentialProxyExchange;
  },
): Server {
  // The verifier owns acceptance on the actual stream. No separate synthetic owner,
  // bearer-only profile or caller-selected response destination can enter this composition.
  const forwarder = controller.createCredentialProxy(identity);
  const { service, definition } = loadOpenShellMiddleware();
  const server = new Server({
    "grpc.max_receive_message_length": 5 * 1024 * 1024,
    "grpc.max_send_message_length": 5 * 1024 * 1024,
  });
  // Count openings across all streams on this authority, independently of the
  // identity's limit on exchanges that have already proved possession. Each Sandbox
  // also has its own share, so one Sandbox cannot hold the pool and refuse the others.
  let pendingOpenings = 0;
  const sandboxOpenings = new Map<string, number>();
  const unary =
    (work: (call: ServerUnaryCall<Wire, Wire>) => Promise<Wire>) =>
    (call: ServerUnaryCall<Wire, Wire>, callback: sendUnaryData<Wire>) => {
      void work(call).then(
        (result) => callback(null, result),
        () =>
          callback({ code: status.UNAVAILABLE, message: "Egress authority unavailable." }, null),
      );
    };
  server.addService(service.SupervisorMiddleware!.service, {
    Describe: unary(async (call) => {
      const description =
        identity.verifyControl(middlewareBearer(call.metadata)) &&
        describeOpenShellMiddleware(call.request.gateway, identity.audience, "static-egress");
      if (!description) {
        throw new Error("Unsupported or unauthenticated counterpart.");
      }
      return description;
    }),
    ValidateConfig: unary(async (call) => ({
      valid:
        identity.verifyControl(middlewareBearer(call.metadata)) &&
        Object.keys(record(record(call.request.config).fields)).length === 0,
    })),
    EvaluateHttpRequest: unary(async (call) => ({
      decision: identity.supervisor(middlewareBearer(call.metadata)) ? 1 : 2,
      reason_code: "egress_identity",
    })),
  });
  const resolve = async (call: AuthorityCall): Promise<Wire> => {
    if (call.request.audience !== identity.audience) {
      return refused("denied");
    }
    const evaluation = record(call.request.request);
    const context = record(evaluation.context);
    const target = record(evaluation.target);
    const port = Number(target.port);
    const host = string(target.host);
    const path = string(target.path);
    if (
      context.verified_credential_connector !== undefined ||
      target.scheme !== "https" ||
      !/^[a-z0-9.-]+$/.test(host) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !path.startsWith("/") ||
      string(target.query) !== ""
    ) {
      return refused("denied");
    }
    const result = await forwarder.resolve(
      call.authorization,
      string(context.sandbox_id),
      {
        id: string(context.request_id),
        verifiedExecutionPolicyHash: string(call.request.verified_execution_policy_hash),
        method: string(target.method),
        url: `https://${host}${port === 443 ? "" : `:${port}`}${path}`,
        headers: headers(evaluation.headers),
        body: bytes(evaluation.body),
        deadlineAt: timestamp(call.request.deadline),
      },
      call.signal,
    );
    if (result.kind === "refused") {
      return refused(result.error.kind);
    }
    const ready = {
      request_id: context.request_id,
      operation_handle: Buffer.from(result.handle),
      audience: identity.audience,
    };
    if (result.kind === "ready_without_material") {
      return { ready_without_material: ready };
    }
    return {
      ready: {
        ...ready,
        evidence: {
          material_id: result.evidence.materialId,
          material_version: result.evidence.materialVersion,
          usable_until: wireTimestamp(result.evidence.usableUntil),
          authority_evidence: Buffer.from(JSON.stringify(result.evidence)),
        },
        credential_headers: result.headers.map(([name, value]) => ({ name, value })),
      },
    };
  };
  const authorizeSend = async (call: AuthorityCall): Promise<Wire> => {
    if (call.request.audience !== identity.audience) {
      return refused("denied");
    }
    const context = record(call.request.context);
    let selection: EgressMaterialEvidence | true;
    // Reject absent, false and conflicting oneof selections, including from an older peer.
    if (
      call.request.selection === "no_material_required" &&
      call.request.no_material_required === true &&
      call.request.evidence === undefined
    ) {
      selection = true;
    } else if (
      call.request.selection === "evidence" &&
      call.request.no_material_required === undefined &&
      call.request.evidence !== undefined
    ) {
      const wireEvidence = record(call.request.evidence);
      try {
        selection = JSON.parse(
          bytes(wireEvidence.authority_evidence).toString("utf8"),
        ) as EgressMaterialEvidence;
      } catch {
        return refused("denied");
      }
      if (
        selection.materialId !== wireEvidence.material_id ||
        selection.materialVersion !== wireEvidence.material_version ||
        selection.usableUntil !== timestamp(wireEvidence.usable_until) ||
        Date.parse(timestamp(call.request.deadline)) < Date.parse(selection.usableUntil)
      ) {
        return refused("denied");
      }
    } else {
      return refused("denied");
    }
    if (context.verified_credential_connector !== undefined) {
      return refused("denied");
    }
    const result = await forwarder.authorizeSend(
      call.authorization,
      string(context.sandbox_id),
      string(context.request_id),
      bytes(call.request.operation_handle).toString("utf8"),
      selection,
      bytes(call.request.credential_headers_sha256).toString("hex"),
      timestamp(call.request.deadline),
      call.signal,
    );
    if (result.kind === "refused") {
      return refused(result.error.kind);
    }
    const responseCustody = identity.responseCustody(
      call.authorization,
      result.authorization.association,
    );
    return responseCustody === undefined
      ? refused("cancelled")
      : {
          allowed: {
            request_id: context.request_id,
            operation_handle: call.request.operation_handle,
            credential_headers_sha256: Buffer.from(result.injectionDigest, "hex"),
            send_start_by: wireTimestamp(result.sendStartBy),
            response_custody: responseCustody,
            no_material_required: result.noMaterialRequired,
          },
        };
  };
  server.addService(service.HttpCredentialAccess!.service, {
    Resolve: unary(async () => refused("denied")),
    AuthorizeSend: unary(async () => refused("denied")),
  });
  server.addService(service.HttpResponsePreReturn!.service, {
    Evaluate(call: ServerDuplexStream<Wire, Wire>) {
      call.emit("error", {
        code: status.PERMISSION_DENIED,
        message: "Installation exchange required.",
      });
    },
  });
  server.addService(service.HttpInstallationExchange!.service, {
    Exchange(call: ServerDuplexStream<Wire, Wire>) {
      const bearer = middlewareBearer(call.metadata);
      // This is only a preliminary check. acceptExchange repeats it and verifies
      // possession against the exact opening and challenge before granting authority.
      const peer = identity.supervisor(bearer);
      if (!peer) {
        call.emit("error", {
          message: "Installation exchange refused.",
          code: status.PERMISSION_DENIED,
        });
        return;
      }
      const sandboxPending = sandboxOpenings.get(peer.sandboxId) ?? 0;
      if (
        pendingOpenings >= pendingOpeningCapacity ||
        sandboxPending >= pendingOpeningSandboxShare
      ) {
        call.emit("error", {
          message: "Installation exchange unavailable.",
          code: status.RESOURCE_EXHAUSTED,
        });
        return;
      }
      pendingOpenings += 1;
      sandboxOpenings.set(peer.sandboxId, sandboxPending + 1);
      let openingPending = true;
      const releaseOpening = () => {
        if (openingPending) {
          openingPending = false;
          pendingOpenings -= 1;
          const held = sandboxOpenings.get(peer.sandboxId)! - 1;
          if (held === 0) {
            sandboxOpenings.delete(peer.sandboxId);
          } else {
            sandboxOpenings.set(peer.sandboxId, held);
          }
        }
      };
      const challenge = randomBytes(32);
      const signal = new AbortController();
      let capability: string | undefined;
      let context: Wire = {};
      let phase: "open" | "authorize" | "response" | "done" = "open";
      let busy = false;
      // One bound for the whole exchange until the response streams; each renewed
      // lease re-arms it to the idle horizon (the authority refuses the rest).
      let timer = setTimeout(() => fail(), 30_000).unref();
      const rearm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(), ms).unref();
      };
      const close = () => {
        clearTimeout(timer);
        releaseOpening();
        signal.abort();
        phase = "done";
      };
      const fail = () => {
        close();
        call.emit("error", {
          message: "Installation exchange refused.",
          code: status.PERMISSION_DENIED,
        });
      };
      call.on("cancelled", close);
      call.on("error", close);
      call.on("end", () => {
        close();
        call.end();
      });
      call.write({ challenge });
      call.on("data", (event: Wire) => {
        // Capture and authenticate before any queued work; pipelining is forbidden.
        if (busy || phase === "done") {
          fail();
          return;
        }
        let request: Wire;
        let progress: Wire | undefined;
        if (phase === "open" && event.open !== undefined) {
          const opening = record(event.open);
          const encoded = bytes(opening.resolve_request);
          const codec = definition[
            "openshell.middleware.v1.HttpCredentialResolveRequest"
          ] as unknown as { deserialize(value: Buffer): Wire };
          capability = identity.acceptExchange(
            bearer,
            challenge,
            encoded,
            bytes(opening.signature),
            () => {
              request = codec.deserialize(encoded);
              context = record(record(request.request).context);
              return {
                requestId: string(context.request_id),
                sandboxId: string(context.sandbox_id),
                responseCustody: bytes(request.response_custody),
              };
            },
            signal.signal,
          );
          if (!capability) {
            fail();
            return;
          }
          releaseOpening();
        } else if (phase === "authorize" && event.authorize !== undefined) {
          request = record(event.authorize);
        } else if (phase === "response" && event.response !== undefined) {
          request = record(event.response);
        } else if (phase === "response" && event.progress !== undefined) {
          request = record(event.progress);
          progress = request;
        } else {
          fail();
          return;
        }
        busy = true;
        const acceptedPhase = phase;
        // The internal credential is created only by the real stream verifier.
        const acceptedCall: AuthorityCall = {
          request: request!,
          authorization: capability!,
          signal: signal.signal,
        };
        void (async () => {
          if (acceptedPhase === "open") {
            const result = await resolve(acceptedCall);
            if (signal.signal.aborted) {
              return;
            }
            phase = result.ready || result.ready_without_material ? "authorize" : "done";
            call.write({ resolved: result });
          } else if (acceptedPhase === "authorize") {
            const result = await authorizeSend(acceptedCall);
            if (signal.signal.aborted) {
              return;
            }
            phase = result.allowed ? "response" : "done";
            call.write({ authorized: result });
          } else if (progress !== undefined) {
            const lease = await forwarder.renewResponse(
              capability!,
              string(context.sandbox_id),
              string(context.request_id),
              {
                headReceived: progress.head_received === true,
                // uint64 arrives as a decimal string (longs: String); unsafe values are refused.
                bodyBytes: progress.body_bytes === undefined ? 0 : Number(progress.body_bytes),
              },
            );
            if (!lease || signal.signal.aborted) {
              fail();
              return;
            }
            rearm(
              Math.min(
                STREAM_LEASE_IDLE_MS,
                Math.max(1000, Date.parse(lease.renewBy) - Date.now()),
              ),
            );
            call.write({
              lease: {
                renew_by: wireTimestamp(lease.renewBy),
                expires_at: wireTimestamp(lease.expiresAt),
              },
            });
          } else {
            const handle = await forwarder.beginResponse(
              capability!,
              string(context.sandbox_id),
              string(context.request_id),
            );
            if (!handle) {
              fail();
              return;
            }
            const complete = acceptedCall.request;
            const response = await forwarder.protectResponse(
              handle,
              {
                status: Number(complete.status),
                headers: headers(complete.headers),
                body: bytes(complete.body),
                trailers: headers(complete.trailers),
              },
              signal.signal,
              complete.response_complete === true,
            );
            if (!response || signal.signal.aborted) {
              fail();
              return;
            }
            call.write({
              response: {
                status: response.status,
                headers: response.headers.map(([name, value]) => ({ name, value })),
                body: response.body,
                trailers: response.trailers.map(([name, value]) => ({ name, value })),
                response_complete: true,
              },
            });
            phase = "done";
          }
          busy = false;
          if (phase === "done") {
            close();
            call.end();
          }
        })().catch(() => {
          if (signal.signal.aborted) {
            return;
          }
          close();
          call.emit("error", {
            code: status.UNAVAILABLE,
            message: "Installation exchange unavailable.",
          });
        });
      });
    },
  });
  return server;
}

/** TLS is mandatory even on loopback; the JWT authenticates the supervisor separately. */
export function bindOpenShellEgressAuthority(
  server: Server,
  address: string,
  certificate: Buffer,
  privateKey: Buffer,
): Promise<number> {
  const credentials = ServerCredentials.createSsl(
    null,
    [{ cert_chain: certificate, private_key: privateKey }],
    false,
  );
  return new Promise((resolve, reject) =>
    server.bindAsync(address, credentials, (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
}
