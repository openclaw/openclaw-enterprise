import type { PresetTemplate } from "@openclaw-enterprise/contracts";
import type { ResourceHandlers } from "./types.ts";

export const presetHandlers = {
  async createPreset({ controller, context, request, reply, body, namespaceId, mutationEvent }) {
    const preset = await controller.transact(async (unit) => {
      const created = await controller.createPreset(context.actorId, {
        namespaceId,
        name: body?.name as string,
        template: body?.template as PresetTemplate,
      });
      await unit.audit.append(mutationEvent({ kind: "preset", id: created.id, namespaceId }));
      return created;
    });
    reply.status(201).send({ data: preset, meta: { requestId: request.id } });
  },
  async listPresets({ controller, context, request, reply, namespaceId }) {
    const presets = await controller.listPresets(context.actorId, namespaceId);
    reply.send({ data: presets, meta: { requestId: request.id } });
  },
  async getPreset({ controller, context, request, reply, params, namespaceId }) {
    const preset = await controller.getPreset(
      context.actorId,
      namespaceId,
      params.presetId as string,
    );
    reply.send({ data: preset, meta: { requestId: request.id } });
  },
  async updatePreset({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const preset = await controller.transact(async (unit) => {
      const updated = await controller.updatePreset(context.actorId, {
        namespaceId,
        presetId: params.presetId as string,
        ...(body?.name === undefined ? {} : { name: body.name as string }),
        ...(body?.template === undefined ? {} : { template: body.template as PresetTemplate }),
      });
      await unit.audit.append(mutationEvent({ kind: "preset", id: updated.id, namespaceId }));
      return updated;
    });
    reply.send({ data: preset, meta: { requestId: request.id } });
  },
  async deletePreset({ controller, context, reply, params, namespaceId, mutationEvent }) {
    await controller.transact(async (unit) => {
      await controller.deletePreset(context.actorId, namespaceId, params.presetId as string);
      await unit.audit.append(
        mutationEvent({ kind: "preset", id: params.presetId as string, namespaceId }),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
