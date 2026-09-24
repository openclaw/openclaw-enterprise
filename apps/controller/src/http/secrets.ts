import type { SecretMetadata } from "@openclaw-enterprise/contracts";
import type { ResourceHandlers } from "./types.ts";

function clientSecret(secret: Readonly<SecretMetadata>): Record<string, unknown> {
  return {
    id: secret.id,
    namespaceId: secret.namespaceId,
    name: secret.name,
    ref: secret.ref,
  };
}

export const secretHandlers = {
  async createSecret({ controller, context, request, reply, body, namespaceId, mutationEvent }) {
    const secret = await controller.transact(async (unit) => {
      const created = await controller.createSecret(context.actorId, {
        namespaceId,
        name: body?.name as string,
        value: body?.value as string,
      });
      await unit.audit.append(mutationEvent({ kind: "secret", id: created.id, namespaceId }));
      return clientSecret(created);
    });
    reply.status(201).send({ data: secret, meta: { requestId: request.id } });
  },
  async listSecrets({ controller, context, request, reply, namespaceId }) {
    const secrets = await controller.listSecrets(context.actorId, namespaceId);
    reply.send({ data: secrets.map(clientSecret), meta: { requestId: request.id } });
  },
  async getSecret({ controller, context, request, reply, params, namespaceId }) {
    const secret = await controller.readSecret(
      context.actorId,
      namespaceId,
      params.secretId as string,
    );
    reply.send({ data: clientSecret(secret), meta: { requestId: request.id } });
  },
  async updateSecret({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const secret = await controller.transact(async (unit) => {
      const updated = await controller.updateSecret(context.actorId, {
        namespaceId,
        secretId: params.secretId as string,
        value: body?.value as string,
      });
      await unit.audit.append(mutationEvent({ kind: "secret", id: updated.id, namespaceId }));
      return clientSecret(updated);
    });
    reply.send({ data: secret, meta: { requestId: request.id } });
  },
  async deleteSecret({ controller, context, reply, params, namespaceId, mutationEvent }) {
    await controller.transact(async (unit) => {
      await controller.deleteSecret(context.actorId, namespaceId, params.secretId as string);
      await unit.audit.append(
        mutationEvent({ kind: "secret", id: params.secretId as string, namespaceId }),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
