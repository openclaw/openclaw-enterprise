import { match } from "ts-pattern";
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditEventFactory, AuditSink } from "@openclaw-enterprise/audit";
import type { OpenClawController } from "@openclaw-enterprise/occ";
import type { AdmittedCaller } from "../admission/admission-verifier.ts";
import type { RequestContext } from "./types.ts";
import { dependencyUnavailable, failure } from "./errors.ts";

export const AGENT_CHAT_BODY_LIMIT = 20 * 1024 * 1024;

interface AgentChatOptions {
  readonly installationId: string;
  readonly factory: AuditEventFactory;
  readonly auditSink: AuditSink;
  readonly controller: OpenClawController;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly context: RequestContext;
  readonly admission: AdmittedCaller;
  readonly gatewayApiKey: (() => Promise<string>) | undefined;
  readonly reauthenticate: () => Promise<void>;
  readonly auditFailure: (error: unknown) => void;
}

/** The wire response belongs to OpenClaw; OCC owns admission and the lifetime of its relay. */
export async function relayAgentChat(options: AgentChatOptions): Promise<void> {
  const { request, reply, controller, context, admission } = options;
  const abort = new AbortController();
  let timedOut = false;
  let finished = false;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let terminalAudit: (() => Promise<void>) | undefined;
  let result: "completed" | "interrupted" | "failed" = "interrupted";
  const disconnect = () => {
    if (!finished) {
      abort.abort(failure(502, "BAD_GATEWAY", "The caller disconnected."));
    }
  };
  request.raw.once("aborted", disconnect);
  reply.raw.once("close", disconnect);
  const totalDeadline = setTimeout(() => {
    timedOut = true;
    abort.abort(failure(504, "GATEWAY_TIMEOUT", "The Agent request deadline expired."));
  }, 600_000);
  const cancelled = new Promise<never>((_, reject) => {
    abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
  });
  // The signal can fire before the first dependency returns; retain its rejection owner.
  void cancelled.catch(() => {});
  const current = <T>(work: Promise<T>): Promise<T> => Promise.race([work, cancelled]);
  if (request.raw.aborted || reply.raw.destroyed) {
    disconnect();
  }
  try {
    if (Object.keys(request.headers).some((name) => name.startsWith("x-openclaw-"))) {
      throw failure(400, "INVALID_REQUEST", "Native routing and authority headers are reserved.");
    }
    const body = request.body as Record<string, unknown>;
    if (
      body.user !== undefined &&
      (typeof body.user !== "string" ||
        Buffer.byteLength(body.user, "utf8") < 1 ||
        Buffer.byteLength(body.user, "utf8") > 128)
    ) {
      throw failure(
        400,
        "INVALID_REQUEST",
        "The conversation label must contain 1–128 UTF-8 bytes.",
      );
    }
    const { agentId } = request.params as { agentId: string };
    const selected = await current(
      controller.resolveAgentChat(context.actorId, agentId, admission.admittedScope.namespaceId),
    );
    const endpoint = match(selected.endpoint)
      .with({ status: "unsupported" }, () => {
        throw failure(
          501,
          "NOT_IMPLEMENTED",
          "The selected Compute Driver does not support HTTP chat for this Agent.",
        );
      })
      .with({ status: "disabled" }, { status: "unavailable" }, () => {
        throw failure(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "The Agent HTTP chat endpoint is unavailable or disabled.",
        );
      })
      .with({ status: "available" }, (endpoint) => endpoint)
      .exhaustive();
    const { agent, revision } = selected;
    if (revision === undefined) {
      throw dependencyUnavailable();
    }
    const principalKind = admission.method === "api_key" ? "service_principal" : "principal";
    const upstreamBody: Record<string, unknown> = { ...body, model: endpoint.model };
    if (typeof body.user === "string") {
      upstreamBody.user = `occ-v1-${createHash("sha256")
        .update(
          JSON.stringify([
            options.installationId,
            agent.namespaceId,
            agent.id,
            principalKind,
            context.actorId,
            body.user,
          ]),
        )
        .digest("hex")}`;
    }
    const url = new URL(endpoint.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw dependencyUnavailable();
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: body.stream === true ? "text/event-stream" : "application/json",
    };
    if (options.gatewayApiKey !== undefined) {
      const key = await current(options.gatewayApiKey());
      if (!key) {
        throw dependencyUnavailable();
      }
      headers["x-api-key"] = key;
    }
    const startedAt = new Date().toISOString();
    const audit = async (outcome: "admitted" | "completed" | "interrupted" | "failed") => {
      await options.auditSink.append(
        options.factory.create({
          installationId: options.installationId,
          namespaceId: agent.namespaceId,
          kind: "mutation",
          source: "occ",
          actor: {
            principalId: context.actorId,
            kind: principalKind,
            issuer: context.issuer,
            subject: context.subject,
          },
          resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
          authorization: {
            principalId: context.actorId,
            action: "operate",
            resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
          },
          action: `openclaw.agents.chat.${outcome}`,
          outcome: outcome === "admitted" || outcome === "completed" ? "success" : "failure",
          requestId: request.id,
          admissionDecisionId: context.admissionDecisionId,
          details: {
            revisionId: revision.id,
            authenticationMethod: admission.method,
            streaming: body.stream === true,
            startedAt,
            ...(outcome === "admitted" ? {} : { finishedAt: new Date().toISOString() }),
            ...(admission.method === "api_key" && admission.serviceKeyId !== undefined
              ? { actorServiceKeyId: admission.serviceKeyId }
              : {}),
            executionOutcome: outcome === "interrupted" ? "uncertain" : outcome,
          },
        }),
      );
    };
    try {
      await current(audit("admitted"));
    } catch (error) {
      if (abort.signal.aborted) {
        throw abort.signal.reason;
      }
      options.auditFailure(error);
      throw dependencyUnavailable();
    }
    terminalAudit = () => audit(result);
    let inFlightCheck: Promise<void> | undefined;
    const verifyCurrentAdmission = (): Promise<void> => {
      if (inFlightCheck !== undefined) {
        return inFlightCheck;
      }
      const deadline = setTimeout(() => abort.abort(), 5_000);
      inFlightCheck = (async () => {
        await current(options.reauthenticate());
        const latest = await current(
          controller.resolveAgentChat(
            context.actorId,
            agent.id,
            admission.admittedScope.namespaceId,
          ),
        );
        if (latest.endpoint.status !== "available" || latest.revision?.id !== revision.id) {
          throw dependencyUnavailable();
        }
      })().finally(() => {
        clearTimeout(deadline);
        inFlightCheck = undefined;
      });
      return inFlightCheck;
    };
    recheck = setInterval(() => {
      if (!abort.signal.aborted) {
        void verifyCurrentAdmission().catch(() => abort.abort());
      }
    }, 25_000);
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            method: "POST",
            headers,
            signal: abort.signal,
          },
          resolve,
        );
        const connectionDeadline = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, 10_000);
        upstream.once("socket", (socket) => {
          if (!socket.connecting) {
            clearTimeout(connectionDeadline);
          } else {
            socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () =>
              clearTimeout(connectionDeadline),
            );
          }
        });
        upstream.once("close", () => clearTimeout(connectionDeadline));
        upstream.once("error", reject);
        upstream.end(JSON.stringify(upstreamBody));
      });
      // Never follow redirects, and never expose an infrastructure redirect location.
      if ((response.statusCode ?? 502) >= 300 && (response.statusCode ?? 502) < 400) {
        response.destroy();
        throw failure(502, "BAD_GATEWAY", "The Agent returned an unexpected redirect.");
      }
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          reply.raw.setHeader(name, value);
        }
      }
      reply.hijack();
      reply.raw.statusCode = response.statusCode ?? 502;
      for (const [name, value] of Object.entries(response.headers)) {
        if (
          value !== undefined &&
          (name === "content-type" ||
            name === "retry-after" ||
            /^x-ratelimit-(limit|remaining|reset)-(requests|tokens)$/.test(name))
        ) {
          reply.raw.setHeader(name, value);
        }
      }
      reply.raw.setHeader("cache-control", "no-store");
      reply.raw.flushHeaders();
      const streaming = body.stream === true && response.statusCode === 200;
      let pending: Buffer = Buffer.alloc(0);
      let eventPrefix = "";
      let nativeStreamError = false;
      for await (const chunk of response) {
        if (abort.signal.aborted) {
          throw dependencyUnavailable();
        }
        const text = String(chunk);
        if (body.stream === true) {
          // Native SSE errors also end with [DONE]. Observe only each line's bounded
          // prefix so a failed turn is not audited as success, without retaining content.
          for (const line of text.split(/(?<=\n)/u)) {
            eventPrefix = (eventPrefix + line).slice(0, 256);
            if (line.endsWith("\n")) {
              nativeStreamError ||= /^data:\s*\{\s*"error"\s*:/u.test(eventPrefix);
              eventPrefix = "";
            }
          }
        }
        // Retain only the terminal suffix. A truncated upstream response must not
        // release a native success terminator before its HTTP body finishes cleanly.
        const bytes = streaming ? Buffer.concat([pending, chunk]) : chunk;
        const boundary = streaming ? Math.max(0, bytes.length - 128) : bytes.length;
        pending = streaming ? bytes.subarray(boundary) : Buffer.alloc(0);
        if (boundary > 0 && !reply.raw.write(bytes.subarray(0, boundary))) {
          await once(reply.raw, "drain", { signal: abort.signal });
        }
      }
      if (
        abort.signal.aborted ||
        (streaming && !/^data:\s*\[DONE\]\r?$/mu.test(pending.toString("utf8")))
      ) {
        throw dependencyUnavailable();
      }
      // A periodic check can predate body completion. Let it settle and clear its
      // owner, then run a fresh check before releasing the retained terminal bytes.
      if (inFlightCheck !== undefined) {
        await inFlightCheck;
      }
      await verifyCurrentAdmission();
      finished = true;
      result = response.statusCode === 200 && !nativeStreamError ? "completed" : "failed";
      reply.raw.end(pending);
    } catch {
      if (reply.raw.headersSent || reply.sent) {
        reply.raw.destroy();
      } else {
        throw failure(
          timedOut ? 504 : 502,
          timedOut ? "GATEWAY_TIMEOUT" : "BAD_GATEWAY",
          timedOut ? "The Agent request deadline expired." : "The Agent request was interrupted.",
        );
      }
    }
  } finally {
    clearTimeout(totalDeadline);
    clearInterval(recheck);
    request.raw.off("aborted", disconnect);
    reply.raw.off("close", disconnect);
    abort.abort();
    try {
      await terminalAudit?.();
    } catch (error) {
      options.auditFailure(error);
    }
  }
}
