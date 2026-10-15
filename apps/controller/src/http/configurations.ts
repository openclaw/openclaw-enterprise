import type { OpenClawConfigurationDocument, SecretBindings } from "@openclaw-enterprise/contracts";
import { removedAccessBindingDetails, type ResourceHandlers } from "./types.ts";

export const configurationHandlers = {
  async createConfiguration({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const configuration = await controller.transact(async (unit) => {
      const created = await controller.createConfiguration(context.actorId, {
        namespaceId,
        kind: body?.kind as "agent",
        values: body?.values as OpenClawConfigurationDocument,
        ...(body?.secretBindings === undefined
          ? {}
          : { secretBindings: body.secretBindings as SecretBindings }),
      });
      await unit.audit.append(
        mutationEvent({ kind: "configuration", id: created.id, namespaceId }),
      );
      return created;
    });
    reply.status(201).send({ data: configuration, meta: { requestId: request.id } });
  },
  async getConfiguration({ controller, context, request, reply, params, namespaceId }) {
    const configuration = await controller.getConfiguration(
      context.actorId,
      namespaceId,
      params.configurationId as string,
    );
    reply.send({ data: configuration, meta: { requestId: request.id } });
  },
  async updateConfiguration({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const configuration = await controller.transact(async (unit) => {
      const updated = await controller.updateConfiguration(context.actorId, {
        namespaceId,
        configurationId: params.configurationId as string,
        values: body?.values as OpenClawConfigurationDocument,
        ...(body?.secretBindings === undefined
          ? {}
          : { secretBindings: body.secretBindings as SecretBindings }),
      });
      await unit.audit.append(
        mutationEvent({ kind: "configuration", id: updated.id, namespaceId }),
      );
      return updated;
    });
    reply.send({ data: configuration, meta: { requestId: request.id } });
  },
  async deleteConfiguration({ controller, context, reply, params, namespaceId, mutationEvent }) {
    await controller.transact(async (unit) => {
      const removed = await controller.deleteConfiguration(
        context.actorId,
        namespaceId,
        params.configurationId as string,
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "configuration", id: params.configurationId as string, namespaceId },
          removedAccessBindingDetails(removed),
        ),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
