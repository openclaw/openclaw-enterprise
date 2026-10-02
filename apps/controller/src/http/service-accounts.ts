import type { ServiceAccount, ServiceAccountCredential } from "@openclaw-enterprise/contracts";
import { removedAccessBindingDetails, type ResourceHandlers } from "./types.ts";

function clientServiceAccount(account: Readonly<ServiceAccount>): Record<string, unknown> {
  return {
    id: account.id,
    namespaceId: account.namespaceId,
    name: account.name,
    ...(account.credential === undefined ? {} : { credential: { kind: account.credential.kind } }),
  };
}

export const serviceAccountHandlers = {
  async createServiceAccount({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const account = await controller.transact(async (unit) => {
      const created = await controller.createServiceAccount(context.actorId, {
        namespaceId,
        name: body?.name as string,
      });
      await unit.audit.append(
        mutationEvent({ kind: "service_account", id: created.id, namespaceId }),
      );
      return clientServiceAccount(created);
    });
    reply.status(201).send({ data: account, meta: { requestId: request.id } });
  },
  async listServiceAccounts({ controller, context, request, reply, namespaceId }) {
    const accounts = await controller.listServiceAccounts(context.actorId, namespaceId);
    reply.send({ data: accounts.map(clientServiceAccount), meta: { requestId: request.id } });
  },
  async getServiceAccount({ controller, context, request, reply, params, namespaceId }) {
    const account = await controller.getServiceAccount(
      context.actorId,
      namespaceId,
      params.serviceAccountId as string,
    );
    reply.send({ data: clientServiceAccount(account), meta: { requestId: request.id } });
  },
  async createServiceAccountCredential({
    controller,
    context,
    request,
    reply,
    params,
    namespaceId,
    mutationEvent,
  }) {
    const account = await controller.transact(async (unit) => {
      const updated = await controller.createServiceAccountCredential(
        context.actorId,
        namespaceId,
        params.serviceAccountId as string,
      );
      await unit.audit.append(
        mutationEvent({ kind: "service_account", id: updated.id, namespaceId }),
      );
      return clientServiceAccount(updated);
    });
    reply.status(201).send({ data: account, meta: { requestId: request.id } });
  },
  async updateServiceAccountCredential({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const account = await controller.transact(async (unit) => {
      const updated = await controller.updateServiceAccountCredential(
        context.actorId,
        namespaceId,
        params.serviceAccountId as string,
        body as unknown as ServiceAccountCredential,
      );
      await unit.audit.append(
        mutationEvent({ kind: "service_account", id: updated.id, namespaceId }),
      );
      return clientServiceAccount(updated);
    });
    reply.send({ data: account, meta: { requestId: request.id } });
  },
  async deleteServiceAccount({ controller, context, reply, params, namespaceId, mutationEvent }) {
    await controller.transact(async (unit) => {
      const removed = await controller.deleteServiceAccount(
        context.actorId,
        namespaceId,
        params.serviceAccountId as string,
      );
      await unit.audit.append(
        mutationEvent(
          {
            kind: "service_account",
            id: params.serviceAccountId as string,
            namespaceId,
          },
          removedAccessBindingDetails(removed),
        ),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
