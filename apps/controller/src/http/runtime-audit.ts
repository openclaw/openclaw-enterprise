import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";

import { AuditEventFactory, verifyRuntimeAuditReplay } from "@openclaw-enterprise/audit";
import {
  RuntimeAuditObservationSchema,
  type RuntimeAuditObservation,
} from "@openclaw-enterprise/contracts";
import type { GatewayRuntimeAuditGrant, PostgresPlatformState } from "@openclaw-enterprise/occ";
import type { FastifyInstance } from "fastify";
import { Check } from "typebox/value";

import { failure } from "./errors.ts";

export type GatewayRuntimeAuditWriter = Pick<
  PostgresPlatformState,
  "appendGatewayRuntimeAudit" | "appendGatewayRuntimeAuditReplay"
>;

interface ReplayEnvelope {
  readonly version: 1;
  readonly revisionId: string;
  readonly source: "openclaw" | "codex";
  readonly endpoint: string;
  readonly body: string;
  readonly verifier: string;
  readonly signature: string;
}

function parseReplayEnvelope(value: unknown): ReplayEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit replay is invalid.");
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 7 ||
    body.version !== 1 ||
    typeof body.revisionId !== "string" ||
    body.revisionId.length > 200 ||
    (body.source !== "openclaw" && body.source !== "codex") ||
    typeof body.endpoint !== "string" ||
    body.endpoint.length > 2048 ||
    typeof body.body !== "string" ||
    Buffer.byteLength(body.body) > 4096 ||
    typeof body.verifier !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(body.verifier) ||
    typeof body.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/u.test(body.signature)
  ) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit replay is invalid.");
  }
  return body as unknown as ReplayEnvelope;
}

function credentialDigest(authorization: string | undefined): string {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (token === undefined) {
    throw failure(401, "UNAUTHENTICATED", "A runtime audit credential is required.");
  }
  return createHash("sha256").update(token).digest("hex");
}

function parseObservation(body: unknown): RuntimeAuditObservation {
  if (!Check(RuntimeAuditObservationSchema, body)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit event is invalid.");
  }
  const time = new Date(body.occurredAt);
  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString() !== body.occurredAt ||
    time.getTime() > Date.now() + 60_000
  ) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit timestamp is invalid.");
  }
  return body;
}

// Separate each producer's IDs so a producer cannot reserve an ID for another revision.
function auditId(installationId: string, grant: GatewayRuntimeAuditGrant, eventId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([installationId, grant.agentRevisionId, grant.runtimeSource, eventId]))
    .digest("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 3) | 8).toString(16);
  return `aud_${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function eventOutcome(event: RuntimeAuditObservation) {
  if (event.action === "openclaw.runtime.model_attempt.observed") {
    // HTTP headers describe this request only. The turn has its own result.
    return event.failureCode !== undefined || event.httpStatus! >= 400 ? "failure" : "success";
  }
  if (event.action === "openclaw.runtime.model_error.observed") {
    return "failure";
  }
  if (!("outcome" in event) || event.outcome === "succeeded") {
    return "success";
  }
  return event.outcome === "blocked" ? "denied" : "failure";
}

function checkSourceRole(grant: GatewayRuntimeAuditGrant, event: RuntimeAuditObservation) {
  if (
    ((event.action === "openclaw.runtime.model_response.observed" ||
      event.action === "openclaw.runtime.model_attempt.observed" ||
      event.action === "openclaw.runtime.model_call.started") &&
      (grant.runtimeSource === "codex") !== (event.provider === "codex")) ||
    (event.action === "openclaw.runtime.model_error.observed" &&
      (grant.runtimeSource !== "openclaw" || event.provider === "codex")) ||
    (event.action === "openclaw.runtime.model_call.completed" &&
      (grant.runtimeSource !== "openclaw" || event.provider === "codex"))
  ) {
    throw failure(403, "FORBIDDEN", "The runtime source cannot report this model event.");
  }
  if (
    (event.action === "openclaw.runtime.model_attempt.observed" ||
      event.action === "openclaw.runtime.model_call.started") &&
    event.provider === "codex" &&
    !/^[0-9a-f]{64}$/u.test(event.modelCallId)
  ) {
    throw failure(400, "INVALID_REQUEST", "The Codex model call ID is invalid.");
  }
}

function auditEvidence(
  installationId: string,
  grant: GatewayRuntimeAuditGrant,
  event: RuntimeAuditObservation,
) {
  const { action, eventId, occurredAt, ...details } = event;
  // Repeated trace exports and queue retries refer to the same HTTP attempt.
  const identity =
    event.action === "openclaw.runtime.model_attempt.observed" ? event.modelAttemptId : eventId;
  const factory = new AuditEventFactory({
    clock: () => occurredAt,
    idGenerator: () => auditId(installationId, grant, identity),
  });
  const evidence = factory.create({
    installationId,
    namespaceId: grant.namespaceId,
    kind: "runtime_activity",
    source: grant.runtimeSource,
    action,
    actor: { unresolved: true },
    resource: { kind: "agent", id: grant.agentId, namespaceId: grant.namespaceId },
    outcome: eventOutcome(event),
    details: {
      ...details,
      agentRevisionId: grant.agentRevisionId,
      runtimeSource: grant.runtimeSource,
    },
  });
  // A redacted identifier cannot link this observation to the correct execution.
  if (Object.entries(details).some(([key, value]) => evidence.details?.[key] !== value)) {
    throw failure(400, "INVALID_REQUEST", "The runtime audit metadata is invalid.");
  }
  return evidence;
}

const privateGatewayRequests = new WeakSet<IncomingMessage>();

export async function startGatewayRuntimeAuditListener(
  app: FastifyInstance,
  options: {
    readonly host: string;
    readonly port: number;
    readonly loadTls: () => Promise<{ readonly key: Buffer; readonly cert: Buffer }>;
    readonly onTlsReloadError: () => void;
  },
) {
  let tls = await options.loadTls();
  const server = createServer(
    { ...tls, requestTimeout: 5_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    (request, response) => {
      if (
        request.method !== "POST" ||
        (request.url !== "/internal/runtime-audit" &&
          request.url !== "/internal/runtime-audit/replay")
      ) {
        response.writeHead(404).end();
        return;
      }
      privateGatewayRequests.add(request);
      app.routing(request, response);
    },
  );
  server.setTimeout(5_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Kubernetes replaces the mounted files when cert-manager renews the leaf.
  let refreshing = false;
  const refresh = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    void options
      .loadTls()
      .then((next) => {
        if (!next.key.equals(tls.key) || !next.cert.equals(tls.cert)) {
          server.setSecureContext(next);
          tls = next;
        }
      })
      .catch(options.onTlsReloadError)
      .finally(() => {
        refreshing = false;
      });
  }, 60_000).unref();
  server.once("close", () => clearInterval(refresh));
  return server;
}

export function registerGatewayRuntimeAudit(
  app: FastifyInstance,
  writer: GatewayRuntimeAuditWriter,
): void {
  const privateOnly = async (request: { raw: IncomingMessage }) => {
    if (!privateGatewayRequests.has(request.raw)) {
      throw failure(404, "NOT_FOUND", "The audit endpoint is unavailable on this listener.");
    }
  };
  app.post(
    "/internal/runtime-audit",
    {
      bodyLimit: 4096,
      schema: { hide: true },
      onRequest: privateOnly,
    },
    async (request, reply) => {
      const digest = credentialDigest(request.headers.authorization);
      const event = parseObservation(request.body);
      const saved = await writer.appendGatewayRuntimeAudit(digest, (installationId, grant) => {
        if (request.headers["x-openclaw-runtime-audit-source"] !== grant.runtimeSource) {
          throw failure(
            403,
            "FORBIDDEN",
            "The runtime audit credential does not match the source.",
          );
        }
        checkSourceRole(grant, event);
        return auditEvidence(installationId, grant, event);
      });
      if (!saved) {
        throw failure(401, "UNAUTHENTICATED", "A runtime audit credential is required.");
      }
      return reply.code(204).send();
    },
  );
  app.post(
    "/internal/runtime-audit/replay",
    { bodyLimit: 16 * 1024, schema: { hide: true }, onRequest: privateOnly },
    async (request, reply) => {
      const digest = credentialDigest(request.headers.authorization);
      const replay = parseReplayEnvelope(request.body);
      const fields = {
        revisionId: replay.revisionId,
        source: replay.source,
        endpoint: replay.endpoint,
        body: replay.body,
      };
      const sourceHeader = request.headers["x-openclaw-runtime-audit-source"];
      const saved = await writer.appendGatewayRuntimeAuditReplay(
        digest,
        typeof sourceHeader === "string" ? sourceHeader : undefined,
        replay,
        () => verifyRuntimeAuditReplay(fields, replay.verifier, replay.signature),
        (installationId, original) => {
          let decoded: unknown;
          try {
            decoded = JSON.parse(replay.body);
          } catch {
            throw failure(400, "INVALID_REQUEST", "The runtime audit event is invalid.");
          }
          const event = parseObservation(decoded);
          checkSourceRole(original, event);
          return auditEvidence(installationId, original, event);
        },
      );
      if (saved === "unauthenticated") {
        throw failure(401, "UNAUTHENTICATED", "A runtime audit credential is required.");
      }
      if (saved === "forbidden") {
        throw failure(403, "FORBIDDEN", "The runtime audit replay is invalid.");
      }
      return reply.code(204).send();
    },
  );
}
