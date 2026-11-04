import type {
  AuditEvent,
  ConnectionTemplate,
  OccApiOperationId,
} from "@openclaw-enterprise/contracts";
import type {
  CreateConnectionTemplateInput,
  OpenClawController,
  UpdateConnectionTemplateInput,
} from "@openclaw-enterprise/occ";
import type { FastifyReply, FastifyRequest } from "fastify";

function present(template: Readonly<ConnectionTemplate>) {
  const { templateId: _templateId, ...current } = template.current;
  return {
    id: template.id,
    namespaceId: template.namespaceId,
    displayName: template.displayName,
    createdAt: template.createdAt,
    current,
  };
}

type TemplateHandler = (input: {
  controller: OpenClawController;
  actorId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  mutationEvent: (templateId: string) => AuditEvent;
}) => Promise<void>;

export const connectionTemplateHandlers: Partial<Record<OccApiOperationId, TemplateHandler>> = {
  async listConnectionTemplates({ controller, actorId, request, reply }) {
    const templates = await controller.listConnectionTemplates(actorId);
    reply.send({ data: templates.map(present), meta: { requestId: request.id } });
  },
  async createConnectionTemplate({ controller, actorId, request, reply, mutationEvent }) {
    const created = await controller.createConnectionTemplate(
      actorId,
      request.body as CreateConnectionTemplateInput,
      mutationEvent,
    );
    reply.status(201).send({ data: present(created), meta: { requestId: request.id } });
  },
  async getConnectionTemplate({ controller, actorId, request, reply }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    const template = await controller.getConnectionTemplate(actorId, connectionTemplateId);
    reply.send({ data: present(template), meta: { requestId: request.id } });
  },
  async updateConnectionTemplate({ controller, actorId, request, reply, mutationEvent }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    const updated = await controller.updateConnectionTemplate(
      actorId,
      connectionTemplateId,
      request.body as UpdateConnectionTemplateInput,
      mutationEvent(connectionTemplateId),
    );
    reply.send({ data: present(updated), meta: { requestId: request.id } });
  },
  async deleteConnectionTemplate({ controller, actorId, request, reply, mutationEvent }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    await controller.deleteConnectionTemplate(
      actorId,
      connectionTemplateId,
      mutationEvent(connectionTemplateId),
    );
    reply.status(204).send();
  },
  async rotateConnectionClientSecret({ controller, actorId, request, reply, mutationEvent }) {
    const { connectionTemplateId } = request.params as { connectionTemplateId: string };
    const { clientSecret } = request.body as { clientSecret: string };
    const template = await controller.rotateConnectionClientSecret(
      actorId,
      connectionTemplateId,
      clientSecret,
      mutationEvent(connectionTemplateId),
    );
    reply.send({ data: present(template), meta: { requestId: request.id } });
  },
};
