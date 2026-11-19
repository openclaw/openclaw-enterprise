import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";

import { AuditEventFactory } from "@openclaw-enterprise/audit";
import {
  RuntimeAuditObservationSchema,
  type RuntimeAuditObservation,
} from "@openclaw-enterprise/contracts";
import type { GatewayRuntimeAuditGrant, PostgresPlatformState } from "@openclaw-enterprise/occ";
import type { FastifyInstance } from "fastify";
import { Check } from "typebox/value";

import { failure } from "./errors.ts";

export type GatewayRuntimeAuditWriter = Pick<PostgresPlatformState, "appendGatewayRuntimeAudit">;

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
  if (!("outcome" in event) || event.outcome === "succeeded") {
    return "success";
  }
  return event.outcome === "blocked" ? "denied" : "failure";
}

function auditEvidence(
  installationId: string,
  grant: GatewayRuntimeAuditGrant,
  event: RuntimeAuditObservation,
) {
  const { action, eventId, occurredAt, ...details } = event;
  const factory = new AuditEventFactory({
    clock: () => occurredAt,
    idGenerator: () => auditId(installationId, grant, eventId),
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
      if (request.method !== "POST" || request.url !== "/internal/runtime-audit") {
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
  app.post(
    "/internal/runtime-audit",
    {
      bodyLimit: 4096,
      schema: { hide: true },
      onRequest: async (request) => {
        if (!privateGatewayRequests.has(request.raw)) {
          throw failure(404, "NOT_FOUND", "The audit endpoint is unavailable on this listener.");
        }
      },
    },
    async (request, reply) => {
      const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (token === undefined) {
        throw failure(401, "UNAUTHENTICATED", "A runtime audit credential is required.");
      }
      const event = parseObservation(request.body);
      const digest = createHash("sha256").update(token).digest("hex");
      const saved = await writer.appendGatewayRuntimeAudit(digest, (installationId, grant) => {
        if (request.headers["x-openclaw-runtime-audit-source"] !== grant.runtimeSource) {
          throw failure(
            403,
            "FORBIDDEN",
            "The runtime audit credential does not match the source.",
          );
        }
        if (
          (event.action === "openclaw.runtime.model_response.observed" &&
            grant.runtimeSource !== "codex") ||
          ((event.action === "openclaw.runtime.model_call.started" ||
            event.action === "openclaw.runtime.model_call.completed") &&
            grant.runtimeSource !== "openclaw")
        ) {
          throw failure(403, "FORBIDDEN", "The runtime source cannot report this model event.");
        }
        return auditEvidence(installationId, grant, event);
      });
      if (!saved) {
        throw failure(401, "UNAUTHENTICATED", "A runtime audit credential is required.");
      }
      return reply.code(204).send();
    },
  );
}
