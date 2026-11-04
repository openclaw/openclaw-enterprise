import type { AuditEvent, OccApiRoute, ResourceRef } from "@openclaw-enterprise/contracts";
import { BrowserAuthorizationError, type OpenClawController } from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";
import { failure } from "./errors.ts";
import type { RequestContext, ResourceHandlers } from "./types.ts";

export const CONNECTION_CALLBACK_PATH = "/oauth/callback";

export function namespaceConnectionHandlers(redirectUri: string | undefined): ResourceHandlers {
  return {
    async listAgentPluginConnectionTemplates({
      controller,
      context,
      request,
      reply,
      params,
      namespaceId,
    }) {
      const data = await controller.listAgentPluginConnectionTemplates(context.actorId, {
        namespaceId,
        agentId: params.agentId!,
        pluginId: params.pluginId!,
        slotId: params.slotId!,
      });
      reply.send({ data, meta: { requestId: request.id } });
    },
    async startAgentPluginConnection({
      controller,
      context,
      request,
      reply,
      params,
      namespaceId,
      body,
      mutationEvent,
    }) {
      const { sessionId } = context;
      if (!sessionId) {
        throw failure(
          403,
          "FORBIDDEN",
          "Connecting an account requires a signed-in browser session.",
        );
      }
      if (!redirectUri) {
        throw failure(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "The public OAuth callback origin is unavailable.",
        );
      }
      const data = await controller.startAgentPluginConnection(
        context.actorId,
        {
          namespaceId,
          agentId: params.agentId!,
          sessionId,
          redirectUri,
          pluginId: body!.pluginId as string,
          slotId: body!.slotId as string,
          releaseSha256: body!.releaseSha256 as string,
          expectedCredentialSourceId: body!.expectedCredentialSourceId as string | null,
          connectionTemplateId: body!.connectionTemplateId as string,
          connectionTemplateVersion: body!.connectionTemplateVersion as number,
        },
        (id) => mutationEvent({ kind: "credential_source", namespaceId, id }),
      );
      reply
        .header("cache-control", "no-store")
        .status(201)
        .send({ data, meta: { requestId: request.id } });
    },
    async attachAgentConnection({
      controller,
      context,
      reply,
      params,
      namespaceId,
      mutationEvent,
    }) {
      const { agentId, credentialSourceId } = params;
      await controller.attachAgentConnection(
        context.actorId,
        { namespaceId, agentId: agentId!, credentialSourceId: credentialSourceId! },
        mutationEvent({ kind: "agent", id: agentId!, namespaceId }, { credentialSourceId }),
      );
      reply.status(204).send();
    },
    async detachAgentConnection({
      controller,
      context,
      request,
      reply,
      params,
      namespaceId,
      mutationEvent,
    }) {
      const { agentId, credentialSourceId } = params;
      const result = await controller.detachAgentConnection(
        context.actorId,
        { namespaceId, agentId: agentId!, credentialSourceId: credentialSourceId! },
        mutationEvent({ kind: "agent", id: agentId!, namespaceId }, { credentialSourceId }),
      );
      reply.send({ data: result, meta: { requestId: request.id } });
    },
    async listUsableConnectionTemplates({ controller, context, request, reply, namespaceId }) {
      const data = await controller.listUsableConnectionTemplates(context.actorId, namespaceId);
      reply.send({ data, meta: { requestId: request.id } });
    },
    async startNamespaceConnection({
      controller,
      context,
      request,
      reply,
      body,
      namespaceId,
      mutationEvent,
    }) {
      if (!context.sessionId) {
        throw failure(
          403,
          "FORBIDDEN",
          "Connecting an account requires a signed-in browser session.",
        );
      }
      if (!redirectUri) {
        throw failure(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "The public OAuth callback origin is unavailable.",
        );
      }
      const data = await controller.startNamespaceConnection(
        context.actorId,
        {
          namespaceId,
          connectionTemplateId: body!.connectionTemplateId as string,
          redirectUri,
          sessionId: context.sessionId,
        },
        (id) => mutationEvent({ kind: "credential_source", namespaceId, id }),
      );
      reply
        .header("cache-control", "no-store")
        .status(201)
        .send({ data, meta: { requestId: request.id } });
    },
    async listNamespaceConnections({ controller, context, request, reply, namespaceId }) {
      const data = await controller.listNamespaceConnections(context.actorId, namespaceId);
      reply.send({ data, meta: { requestId: request.id } });
    },
    async disconnectNamespaceConnection({
      controller,
      context,
      reply,
      params,
      namespaceId,
      mutationEvent,
    }) {
      const id = params.credentialSourceId!;
      await controller.disconnectNamespaceConnection(
        context.actorId,
        namespaceId,
        id,
        mutationEvent({ kind: "credential_source", namespaceId, id }),
      );
      reply.status(204).send();
    },
  };
}

/** Admission identity for the callback, which is a browser redirect rather than a JSON API. */
export const connectionCallbackOperation = {
  operationId: "completeNamespaceConnection",
  method: "GET",
  path: CONNECTION_CALLBACK_PATH,
  action: "openclaw.namespaces.connections.complete",
  iamAction: "create",
  resourceKind: "credential_source",
  authorizationTarget: "namespace_collection",
  summary: "Complete a browser connection for the signed-in person who started it",
  tags: ["Connections"],
  schema: {},
} as unknown as OccApiRoute;

export const connectionCallbackSchema = {
  operationId: connectionCallbackOperation.operationId,
  summary: connectionCallbackOperation.summary,
  description:
    "Requires the signed-in human session that started the connection, permission to create a credential source in the starting Namespace, and a template available there. The provider redirects here with `state` and `code`, or with `error`. The response is a 303 redirect to the console without the query string.",
  tags: [...connectionCallbackOperation.tags],
  security: [{ sessionCookie: [] }],
  "x-openclaw-permissions": [
    { action: "create", resourceKind: "credential_source", scope: "namespace" },
  ],
  response: {
    303: { description: "Redirect to the console with the connection outcome" },
    429: { description: "Too many requests; wait for Retry-After" },
  },
  querystring: {
    type: "object",
    additionalProperties: true,
    properties: {
      state: { type: "string", maxLength: 512 },
      code: { type: "string", maxLength: 4096 },
      error: { type: "string", maxLength: 256 },
      iss: {
        type: "string",
        maxLength: 2048,
        description:
          "Authorization server issuer. Must match the connection template when present. Required for code exchange if another issuer has a client registration when consent starts or when the callback arrives.",
      },
    },
  },
} as const;

export interface ConnectionCallbackDependencies {
  readonly getController: () => OpenClawController | undefined;
  readonly getContext: (request: FastifyRequest) => RequestContext | undefined;
  readonly auditEvent: (
    request: FastifyRequest,
    context: RequestContext,
    target: ResourceRef,
  ) => AuditEvent;
  /** Audits a refused or failed callback with its safe reason code, never the query. */
  readonly auditFailure: (
    request: FastifyRequest,
    context: RequestContext,
    reasonCode: string,
  ) => Promise<void>;
}

/**
 * Completes the connection, then redirects to the console without the query string, so the
 * the landing page and callback audit receive no OAuth code or state.
 */
export function createConnectionCallback(dependencies: ConnectionCallbackDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    const controller = dependencies.getController();
    const context = dependencies.getContext(request);
    const query = request.query as Record<string, unknown>;
    const fail = (reason: string) =>
      reply.redirect(`/console/?connection=failed&reason=${encodeURIComponent(reason)}`, 303);
    if (controller === undefined || context?.sessionId === undefined) {
      fail("session_required");
      return;
    }
    try {
      const connection = await controller.completeNamespaceConnection(
        context.actorId,
        {
          state: typeof query.state === "string" ? query.state : "",
          sessionId: context.sessionId,
          ...(typeof query.iss === "string" ? { iss: query.iss } : {}),
          ...(typeof query.code === "string" ? { code: query.code } : {}),
          ...(typeof query.error === "string" ? { error: query.error } : {}),
        },
        (result, attachedAgentId) => {
          if (attachedAgentId) {
            const event = dependencies.auditEvent(request, context, {
              kind: "agent",
              namespaceId: result.namespaceId,
              id: attachedAgentId,
            });
            return { ...event, action: "openclaw.agents.connections.attach" };
          }
          return dependencies.auditEvent(request, context, {
            kind: "credential_source",
            namespaceId: result.namespaceId,
            id: result.credentialSourceId,
          });
        },
      );
      if (connection.attachment) {
        const { agentId, outcome } = connection.attachment;
        const landing = new URLSearchParams({
          namespace: connection.namespaceId,
          revision: "draft",
          tab: "plugins",
          connection: outcome,
        });
        if (outcome === "saved") {
          landing.set("sourceId", connection.credentialSourceId);
        }
        reply.redirect(`/console/agents/${encodeURIComponent(agentId)}?${landing}`, 303);
      } else {
        reply.redirect(
          `/console/?namespace=${encodeURIComponent(connection.namespaceId)}&connection=connected`,
          303,
        );
      }
    } catch (error) {
      const reason =
        error instanceof BrowserAuthorizationError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : "unavailable";
      await dependencies.auditFailure(request, context, reason);
      fail(reason);
    }
  };
}
