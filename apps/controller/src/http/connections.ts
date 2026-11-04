import type { AuditEvent, OccApiRoute, ResourceRef } from "@openclaw-enterprise/contracts";
import {
  BrowserAuthorizationError,
  CallerStateDeniedError,
  type OpenClawController,
  type PlatformUnitOfWork,
} from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";
import { failure } from "./errors.ts";
import type { RequestContext, ResourceHandlers } from "./types.ts";

export const CONNECTION_CALLBACK_PATH = "/oauth/callback";

export function namespaceConnectionHandlers(redirectUri: string | undefined): ResourceHandlers {
  return {
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
          ...(body!.selectedScopes === undefined
            ? {}
            : { selectedScopes: body!.selectedScopes as string[] }),
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
  readonly withCurrentSession: <T>(
    request: FastifyRequest,
    work: (holdSession: (unit: PlatformUnitOfWork) => Promise<void>) => Promise<T>,
  ) => Promise<T>;
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
    const sessionId = context?.sessionId;
    const query = request.query as Record<string, unknown>;
    const fail = (reason: string) =>
      reply.redirect(`/console/?connection=failed&reason=${encodeURIComponent(reason)}`, 303);
    if (controller === undefined || !context || sessionId === undefined) {
      fail("session_required");
      return;
    }
    try {
      const connection = await dependencies.withCurrentSession(request, (holdSession) =>
        controller.completeNamespaceConnection(
          context.actorId,
          {
            state: typeof query.state === "string" ? query.state : "",
            sessionId,
            ...(typeof query.iss === "string" ? { iss: query.iss } : {}),
            ...(typeof query.code === "string" ? { code: query.code } : {}),
            ...(typeof query.error === "string" ? { error: query.error } : {}),
          },
          (result) =>
            dependencies.auditEvent(request, context, {
              kind: "credential_source",
              namespaceId: result.namespaceId,
              id: result.credentialSourceId,
            }),
          holdSession,
        ),
      );
      reply.redirect(
        `/console/?namespace=${encodeURIComponent(connection.namespaceId)}&connection=connected`,
        303,
      );
    } catch (error) {
      let reason = "unavailable";
      if (error instanceof CallerStateDeniedError) {
        reason = "session_required";
      } else if (
        error instanceof BrowserAuthorizationError &&
        /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
      ) {
        reason = error.code;
      }
      await dependencies.auditFailure(request, context, reason);
      fail(reason);
    }
  };
}
