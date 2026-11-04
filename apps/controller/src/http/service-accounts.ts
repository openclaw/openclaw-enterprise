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
  async deleteServiceAccount({
    controller,
    context,
    request,
    reply,
    params,
    namespaceId,
    mutationEvent,
  }) {
    const force = (request.query as { force?: string } | undefined)?.force === "true";
    const deletion = await controller.transact(async (unit) => {
      const deleted = await controller.deleteServiceAccount(
        context.actorId,
        namespaceId,
        params.serviceAccountId as string,
        { force },
      );
      const removed = removedAccessBindingDetails(deleted.removedAccessBindings);
      const unrevoked = deleted.unrevokedCredential;
      await unit.audit.append(
        mutationEvent(
          {
            kind: "service_account",
            id: params.serviceAccountId as string,
            namespaceId,
          },
          // A requested force is recorded even when a Driver revoked as usual. Audit redaction
          // blanks keys naming a token or credential unless they end in "Id", so the outcome is
          // `revocation: "skipped"`, not a `tokenRevoked` flag.
          !force
            ? removed
            : {
                ...removed,
                force: true,
                ...(unrevoked === undefined ? {} : { revocation: "skipped", ...unrevoked }),
              },
        ),
      );
      return deleted;
    });
    if (deletion.unrevokedCredential === undefined) {
      reply.status(204).send();
      return;
    }
    const { backendId } = deletion.unrevokedCredential;
    reply.status(200).send({
      data: {
        id: params.serviceAccountId,
        namespaceId,
        revocation: "skipped",
        ...(backendId === undefined ? {} : { backendId }),
      },
      meta: { requestId: request.id },
    });
  },
} satisfies ResourceHandlers;
