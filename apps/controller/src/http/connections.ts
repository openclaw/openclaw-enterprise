import type {
  AuditEvent,
  ConnectionTemplate,
  OccApiRoute,
  ResourceRef,
} from "@openclaw-enterprise/contracts";
import type {
  CreateConnectionTemplateInput,
  OpenClawController,
  UpdateConnectionTemplateInput,
} from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { RequestContext, ResourceHandlers } from "./types.ts";

/** The exact OCC callback URI providers redirect to; registered with each OAuth client. */
export const CONNECTION_CALLBACK_PATH = "/oauth/callback";

function templateResponse(
  template: Readonly<ConnectionTemplate>,
  redirectUri: string | undefined,
): Record<string, unknown> {
  const { templateId: _templateId, ...current } = template.current;
  return {
    id: template.id,
    displayName: template.displayName,
    current,
    ...(redirectUri === undefined ? {} : { redirectUri }),
    createdAt: template.createdAt,
  };
}

export interface InstallationConnectionOperation {
  readonly controller: OpenClawController;
  readonly operation: OccApiRoute;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly context: RequestContext;
  readonly params: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
  readonly redirectUri: string | undefined;
  /** Builds the success audit event for a mutation of `target`. */
  readonly mutationEvent: (target: ResourceRef) => AuditEvent;
}

/**
 * Installation-scoped connection template and IAM binding routes. Returns false for any
 * other operation. Template mutations call the Credential Refresh Driver, so their audit
 * event commits after the change rather than inside it.
 */
export async function performInstallationConnectionOperation(
  input: InstallationConnectionOperation,
): Promise<boolean> {
  const { controller, operation, request, reply, context, params, body, redirectUri } = input;
  const audit = (target: ResourceRef) =>
    controller.transact((unit) => unit.audit.append(input.mutationEvent(target)));
  const send = (data: unknown, status = 200) =>
    reply.status(status).send({ data, meta: { requestId: request.id } });
  const templateRef = (id: string): ResourceRef => ({ kind: "connection_template", id });

  switch (operation.operationId) {
    case "listConnectionTemplates":
      send(
        (await controller.listConnectionTemplates(context.actorId)).map((template) =>
          templateResponse(template, redirectUri),
        ),
      );
      return true;
    case "createConnectionTemplate": {
      const created = await controller.createConnectionTemplate(
        context.actorId,
        body as unknown as CreateConnectionTemplateInput,
      );
      await audit(templateRef(created.id));
      send(templateResponse(created, redirectUri), 201);
      return true;
    }
    case "getConnectionTemplate":
      send(
        templateResponse(
          await controller.getConnectionTemplate(context.actorId, params.connectionTemplateId!),
          redirectUri,
        ),
      );
      return true;
    case "updateConnectionTemplate": {
      const updated = await controller.updateConnectionTemplate(
        context.actorId,
        params.connectionTemplateId!,
        body as unknown as UpdateConnectionTemplateInput,
      );
      await audit(templateRef(updated.id));
      send(templateResponse(updated, redirectUri));
      return true;
    }
    case "deleteConnectionTemplate":
      await controller.deleteConnectionTemplate(context.actorId, params.connectionTemplateId!);
      await audit(templateRef(params.connectionTemplateId!));
      reply.status(204).send();
      return true;
    case "rotateConnectionClientSecret": {
      const template = await controller.rotateConnectionClientSecret(
        context.actorId,
        params.connectionTemplateId!,
        body?.clientSecret as string,
      );
      await audit(templateRef(template.id));
      send(templateResponse(template, redirectUri));
      return true;
    }
    case "listInstallationRoles":
      send(await controller.listInstallationRoles(context.actorId));
      return true;
    case "listInstallationAccessBindings":
      send(await controller.listInstallationAccessBindings(context.actorId));
      return true;
    case "createInstallationAccessBinding": {
      const binding = await controller.transact(async (unit) => {
        const created = await controller.createInstallationAccessBinding(context.actorId, {
          subjectKind: body?.subjectKind as "identity" | "namespace",
          subjectId: body?.subjectId as string,
          roleId: body?.roleId as string,
          resourceKind: "connection_template",
          resourceId: body?.resourceId as string,
        });
        await unit.audit.append(input.mutationEvent(templateRef(created.resourceId!)));
        return created;
      });
      send(binding, 201);
      return true;
    }
    case "deleteInstallationAccessBinding":
      await controller.transact(async (unit) => {
        const removed = await controller.deleteInstallationAccessBinding(
          context.actorId,
          params.bindingId!,
        );
        await unit.audit.append(input.mutationEvent(templateRef(removed.resourceId!)));
      });
      reply.status(204).send();
      return true;
    default:
      return false;
  }
}

/** Namespace-scoped connection routes, dispatched with the other resource handlers. */
export function connectionHandlers(redirectUri: () => string | undefined): ResourceHandlers {
  return {
    async listUsableConnectionTemplates({ controller, context, request, reply, namespaceId }) {
      reply.send({
        data: (await controller.listUsableConnectionTemplates(context.actorId, namespaceId)).map(
          (template) => templateResponse(template, undefined),
        ),
        meta: { requestId: request.id },
      });
    },
    async startAgentConnection({
      controller,
      context,
      request,
      reply,
      params,
      body,
      namespaceId,
      mutationEvent,
    }) {
      // The dispatcher refuses this operation with 503 when no callback URI is configured.
      const callback = redirectUri() as string;
      const started = await controller.startAgentConnection(context.actorId, {
        namespaceId,
        agentId: params.agentId!,
        connectionTemplateId: body?.connectionTemplateId as string,
        redirectUri: callback,
      });
      await controller.transact((unit) =>
        unit.audit.append(mutationEvent({ kind: "agent", id: params.agentId!, namespaceId })),
      );
      reply.header("cache-control", "no-store");
      reply.status(201).send({ data: started, meta: { requestId: request.id } });
    },
    async listAgentConnections({ controller, context, request, reply, params, namespaceId }) {
      reply.send({
        data: await controller.listAgentConnections(context.actorId, namespaceId, params.agentId!),
        meta: { requestId: request.id },
      });
    },
    async disconnectAgentConnection({
      controller,
      context,
      request,
      reply,
      params,
      namespaceId,
      mutationEvent,
    }) {
      const result = await controller.disconnectAgentConnection(context.actorId, {
        namespaceId,
        agentId: params.agentId!,
        credentialSourceId: params.credentialSourceId!,
      });
      await controller.transact((unit) =>
        unit.audit.append(mutationEvent({ kind: "agent", id: params.agentId!, namespaceId })),
      );
      reply.send({ data: result, meta: { requestId: request.id } });
    },
  };
}

/** Admission identity for the callback, which is a browser redirect rather than a JSON API. */
export const connectionCallbackOperation = {
  operationId: "completeAgentConnection",
  method: "GET",
  path: CONNECTION_CALLBACK_PATH,
  action: "openclaw.agents.connections.complete",
  iamAction: "update",
  resourceKind: "agent",
  authorizationTarget: "agent",
  summary: "Complete a browser connection for the signed-in person who started it",
  tags: ["Connections"],
  schema: {},
} as unknown as OccApiRoute;

export const connectionCallbackSchema = {
  operationId: connectionCallbackOperation.operationId,
  summary: connectionCallbackOperation.summary,
  description:
    "Requires the signed-in human session that started the connection, update permission on its Agent, and use permission on its connection template for the Agent's Namespace. The provider redirects here with `state` and `code`, or with `error`. The response is a 303 redirect to the console without the query string.",
  tags: [...connectionCallbackOperation.tags],
  security: [{ sessionCookie: [] }],
  "x-openclaw-permissions": [
    { action: "update", resourceKind: "agent", scope: "requested" },
    { action: "use", resourceKind: "connection_template", scope: "requested" },
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
    },
  },
} as const;

export interface ConnectionCallbackDependencies {
  readonly getController: () => OpenClawController | undefined;
  readonly getContext: (request: FastifyRequest) => RequestContext | undefined;
  readonly isSession: (request: FastifyRequest) => boolean;
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
 * authorization code never reaches a referrer, history entry, log line, or audit record.
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
    if (controller === undefined || context === undefined || !dependencies.isSession(request)) {
      fail("session_required");
      return;
    }
    try {
      const connection = await controller.completeAgentConnection(context.actorId, {
        state: typeof query.state === "string" ? query.state : "",
        ...(typeof query.code === "string" ? { code: query.code } : {}),
        ...(typeof query.error === "string" ? { error: query.error } : {}),
      });
      const target: ResourceRef = {
        kind: "agent",
        id: connection.agentId,
        namespaceId: connection.namespaceId,
      };
      await controller.transact((unit) =>
        unit.audit.append(dependencies.auditEvent(request, context, target)),
      );
      reply.redirect(
        `/console/agents/${encodeURIComponent(connection.agentId)}?namespace=${encodeURIComponent(
          connection.namespaceId,
        )}&connection=connected`,
        303,
      );
    } catch (error) {
      const reason =
        typeof (error as { code?: unknown }).code === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/.test((error as { code: string }).code)
          ? (error as { code: string }).code
          : "unavailable";
      await dependencies.auditFailure(request, context, reason);
      fail(reason);
    }
  };
}
