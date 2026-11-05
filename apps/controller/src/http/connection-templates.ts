import type { AuditEvent, OccApiOperationId } from "@openclaw-enterprise/contracts";
import type {
  CreateConnectionTemplateInput,
  CreateOAuthClientInput,
  OpenClawController,
  PlatformUnitOfWork,
  UpdateConnectionTemplateInput,
} from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { discoverMcpAuthorization } from "../connections/mcp-discovery.ts";

type TemplateHandler = (input: {
  controller: OpenClawController;
  meta: { requestId: string; redirectUri?: string };
  holdSession?: (state: PlatformUnitOfWork) => Promise<void>;
  discover: typeof discoverMcpAuthorization;
  actorId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  mutationEvent: (templateId: string) => AuditEvent;
}) => Promise<void>;

export const connectionTemplateHandlers: Partial<Record<OccApiOperationId, TemplateHandler>> = {
  async listConnectionTemplates({ meta, controller, actorId, reply }) {
    const data = await controller.listConnectionTemplates(actorId);
    reply.send({ data, meta });
  },
  async createConnectionTemplate({
    holdSession,
    meta,
    discover,
    controller,
    actorId,
    request,
    reply,
    mutationEvent,
  }) {
    const created = await controller.createConnectionTemplate(
      actorId,
      request.body as CreateConnectionTemplateInput,
      discover,
      mutationEvent,
      holdSession,
    );
    reply.status(201).send({ data: created, meta });
  },
  async getConnectionTemplate({ meta, controller, actorId, request, reply }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    const template = await controller.getConnectionTemplate(actorId, connectionTemplateId);
    reply.send({ data: template, meta });
  },
  async updateConnectionTemplate({
    holdSession,
    meta,
    discover,
    controller,
    actorId,
    request,
    reply,
    mutationEvent,
  }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    const updated = await controller.updateConnectionTemplate(
      actorId,
      connectionTemplateId,
      request.body as UpdateConnectionTemplateInput,
      discover,
      mutationEvent(connectionTemplateId),
      holdSession,
    );
    reply.send({ data: updated, meta });
  },
  async deleteConnectionTemplate({
    holdSession,
    controller,
    actorId,
    request,
    reply,
    mutationEvent,
  }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    await controller.deleteConnectionTemplate(
      actorId,
      connectionTemplateId,
      mutationEvent(connectionTemplateId),
      holdSession,
    );
    reply.status(204).send();
  },
  async discoverConnectionTemplate({ meta, discover, controller, actorId, request, reply }) {
    const data = await controller.discoverConnectionTemplate(
      actorId,
      request.body as { serverUrl: string; issuer?: string },
      discover,
    );
    reply.send({ data, meta });
  },
  async listOAuthClients({ meta, controller, actorId, reply }) {
    const clients = await controller.listOAuthClients(actorId);
    reply.send({ data: clients, meta });
  },
  async createOAuthClient({
    holdSession,
    meta,
    controller,
    actorId,
    request,
    reply,
    mutationEvent,
  }) {
    const client = await controller.createOAuthClient(
      actorId,
      request.body as CreateOAuthClientInput,
      mutationEvent,
      holdSession,
    );
    reply.status(201).send({ data: client, meta });
  },
  async rotateOAuthClientSecret({
    holdSession,
    meta,
    controller,
    actorId,
    request,
    reply,
    mutationEvent,
  }) {
    const { oauthClientId } = request.params as { oauthClientId: string };
    const { clientSecret } = request.body as { clientSecret: string };
    const client = await controller.rotateOAuthClientSecret(
      actorId,
      oauthClientId,
      clientSecret,
      mutationEvent(oauthClientId),
      holdSession,
    );
    reply.send({ data: client, meta });
  },
  async deleteOAuthClient({ holdSession, controller, actorId, request, reply, mutationEvent }) {
    const { oauthClientId } = request.params as { oauthClientId: string };
    await controller.deleteOAuthClient(
      actorId,
      oauthClientId,
      mutationEvent(oauthClientId),
      holdSession,
    );
    reply.status(204).send();
  },
};
