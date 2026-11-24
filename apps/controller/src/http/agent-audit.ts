import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { AuditEventFactory } from "@openclaw-enterprise/audit";
import {
  AGENT_AUDIT_PROJECTION_VERSION,
  type AgentAuditPage,
  type AgentAuditQuery,
  type ResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  AgentAuditDisclosureUnavailableError,
  type OpenClawController,
} from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthenticatedSession, ControllerAuth } from "../auth/index.ts";
import { failure } from "./errors.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CURSOR_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 50;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

interface AuditCursor {
  readonly start: string;
  readonly end: string;
  readonly limit: number;
  readonly after: { readonly occurredAt: string; readonly id: string };
}

export function createAgentAuditReader(secret: string) {
  const key = createHmac("sha256", secret).update("occ-agent-audit-cursor-v1").digest();

  function readCursor(token: string, scope: Buffer, limit?: number): AuditCursor {
    try {
      const bytes = Buffer.from(token, "base64url");
      if (bytes.toString("base64url") !== token || bytes.length <= NONCE_LENGTH + TAG_LENGTH) {
        throw new Error();
      }
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_LENGTH));
      decipher.setAAD(scope);
      decipher.setAuthTag(bytes.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(NONCE_LENGTH + TAG_LENGTH)),
          decipher.final(),
        ]).toString("utf8"),
      ) as AuditCursor;
      if (
        Date.now() >= Date.parse(value.end) + CURSOR_LIFETIME_MS ||
        (limit !== undefined && limit !== value.limit)
      ) {
        throw new Error();
      }
      return value;
    } catch {
      throw failure(400, "INVALID_REQUEST", "The Agent audit cursor is invalid or expired.");
    }
  }

  function writeCursor(value: AuditCursor, scope: Buffer): string {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(scope);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  return async (input: {
    readonly controller: OpenClawController;
    readonly auth: ControllerAuth;
    readonly session: AuthenticatedSession;
    readonly factory: AuditEventFactory;
    readonly actorId: string;
    readonly admissionDecisionId: string;
    readonly namespaceId: string;
    readonly agentId: string;
    readonly request: FastifyRequest;
    readonly reply: FastifyReply;
  }): Promise<void> => {
    const {
      controller,
      auth,
      session,
      factory,
      actorId,
      admissionDecisionId,
      namespaceId,
      agentId,
      request,
      reply,
    } = input;
    const query = request.query as AgentAuditQuery;
    const resource: ResourceRef = { kind: "agent", id: agentId, namespaceId };
    const scope = Buffer.from(
      JSON.stringify([
        AGENT_AUDIT_PROJECTION_VERSION,
        controller.installation.id,
        namespaceId,
        agentId,
        actorId,
        session.id,
      ]),
    );
    const now = Date.now();
    const pageLimit = query.limit === undefined ? undefined : Number(query.limit);
    const selection =
      query.cursor === undefined
        ? {
            start: new Date(now - WINDOW_MS).toISOString(),
            end: new Date(now).toISOString(),
            limit: pageLimit ?? DEFAULT_PAGE_LIMIT,
          }
        : readCursor(query.cursor, scope, pageLimit);
    const { start, end, limit } = selection;
    const page = await auth
      .withSessionAuthority(session, () =>
        controller.listAgentAuditEvents(
          actorId,
          namespaceId,
          agentId,
          selection,
          (unit) => auth.holdSession(unit, session, request),
          (count, { request: authorization, decision }) =>
            factory.create({
              kind: "access",
              installationId: controller.installation.id,
              namespaceId,
              resource,
              actor: { principalId: actorId, kind: "principal" },
              action: "openclaw.audit.agent.read",
              requestId: request.id,
              admissionDecisionId,
              iamDriverId: decision.driverId,
              authorization,
              details: {
                windowStart: start,
                windowEnd: end,
                returnedCount: count,
                projectionVersion: AGENT_AUDIT_PROJECTION_VERSION,
              },
            }),
        ),
      )
      .catch((error: unknown) => {
        if (error instanceof AgentAuditDisclosureUnavailableError) {
          request.log.warn({ event: "agent_audit.disclosure_unavailable", requestId: request.id });
        }
        throw error;
      });
    const last = page.events.at(-1);
    const data: AgentAuditPage = {
      projectionVersion: AGENT_AUDIT_PROJECTION_VERSION,
      window: { start, end },
      events: page.events,
      nextCursor:
        page.hasNextPage && last !== undefined
          ? writeCursor(
              { start, end, limit, after: { occurredAt: last.occurredAt, id: last.id } },
              scope,
            )
          : null,
    };
    reply.header("cache-control", "no-store");
    reply.send({ data, meta: { requestId: request.id } });
  };
}
