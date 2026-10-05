import type {
  AccessBinding,
  AgentRuntimeRoleCatalog,
  ResourceKind,
  ResourceRef,
  Role,
} from "@openclaw-enterprise/contracts";
import type { ResourceHandlers } from "./types.ts";

// Audit details name what a policy mutation granted or removed, by identifier.
function roleAuditDetails(role: Readonly<Role>): Record<string, unknown> {
  return { roleId: role.id, permissions: role.permissions };
}

function bindingAuditDetails(binding: Readonly<AccessBinding>): Record<string, unknown> {
  return {
    bindingId: binding.id,
    subjectKind: binding.subjectKind,
    subjectId: binding.subjectId,
    roleId: binding.roleId,
    ...(binding.runtimeRole === undefined ? {} : { runtimeRole: binding.runtimeRole }),
  };
}

// The exact resource the AccessBinding grants, or its Namespace when it has none.
function bindingAuditResource(binding: Readonly<AccessBinding>, namespaceId: string): ResourceRef {
  return binding.resourceKind === undefined || binding.resourceId === undefined
    ? { kind: "namespace", id: namespaceId, namespaceId }
    : { kind: binding.resourceKind, id: binding.resourceId, namespaceId };
}

function clientIAMRole(role: Readonly<Role>): Record<string, unknown> {
  return {
    id: role.id,
    namespaceId: role.namespaceId,
    ...(role.name === undefined ? {} : { name: role.name }),
    permissions: role.permissions,
  };
}

function clientIAMAccessBinding(binding: Readonly<AccessBinding>): Record<string, unknown> {
  return {
    id: binding.id,
    namespaceId: binding.namespaceId,
    subjectKind: binding.subjectKind,
    subjectId: binding.subjectId,
    roleId: binding.roleId,
    ...(binding.runtimeRole === undefined ? {} : { runtimeRole: binding.runtimeRole }),
    ...(binding.resourceKind === undefined ? {} : { resourceKind: binding.resourceKind }),
    ...(binding.resourceId === undefined ? {} : { resourceId: binding.resourceId }),
  };
}

export const iamHandlers = {
  async listIAMRoles({ controller, context, request, reply, namespaceId }) {
    const roles = await controller.listIAMRoles(context.actorId, namespaceId);
    reply.send({ data: roles.map(clientIAMRole), meta: { requestId: request.id } });
  },
  async createIAMRole({ controller, context, request, reply, body, namespaceId, mutationEvent }) {
    const role = await controller.transact(async (unit) => {
      const created = await controller.createIAMRole(context.actorId, {
        namespaceId,
        ...(body?.name === undefined ? {} : { name: body.name as string }),
        permissions: body?.permissions as never,
      });
      await unit.audit.append(
        mutationEvent(
          { kind: "namespace", id: namespaceId, namespaceId },
          roleAuditDetails(created),
        ),
      );
      return clientIAMRole(created);
    });
    reply.status(201).send({ data: role, meta: { requestId: request.id } });
  },
  async getIAMRole({ controller, context, request, reply, params, namespaceId }) {
    const role = await controller.getIAMRole(context.actorId, namespaceId, params.roleId as string);
    reply.send({ data: clientIAMRole(role), meta: { requestId: request.id } });
  },
  async deleteIAMRole({ controller, context, reply, params, namespaceId, mutationEvent }) {
    await controller.transact(async (unit) => {
      const deleted = await controller.deleteIAMRole(
        context.actorId,
        namespaceId,
        params.roleId as string,
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "namespace", id: namespaceId, namespaceId },
          roleAuditDetails(deleted),
        ),
      );
    });
    reply.status(204).send();
  },
  async listIAMAccessBindings({ controller, context, request, reply, namespaceId }) {
    const bindings = await controller.listIAMAccessBindings(context.actorId, namespaceId);
    reply.send({
      data: bindings.map(clientIAMAccessBinding),
      meta: { requestId: request.id },
    });
  },
  async createIAMAccessBinding({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const binding = await controller.transact(async (unit) => {
      const created = await controller.createIAMAccessBinding(context.actorId, {
        namespaceId,
        subjectKind: body?.subjectKind as "identity",
        subjectId: body?.subjectId as string,
        roleId: body?.roleId as string,
        ...(body?.runtimeRole === undefined ? {} : { runtimeRole: body.runtimeRole as string }),
        ...(body?.runtimeRoleConfiguration === undefined
          ? {}
          : {
              runtimeRoleConfiguration:
                body.runtimeRoleConfiguration as AgentRuntimeRoleCatalog["configuration"],
            }),
        resourceKind: body?.resourceKind as ResourceKind,
        resourceId: body?.resourceId as string,
      });
      await unit.audit.append(
        mutationEvent(bindingAuditResource(created, namespaceId), bindingAuditDetails(created)),
      );
      return clientIAMAccessBinding(created);
    });
    reply.status(201).send({ data: binding, meta: { requestId: request.id } });
  },
  async listAgentRuntimeRoles({ controller, context, request, reply, params, namespaceId }) {
    const roles = await controller.listAgentRuntimeRoles(
      context.actorId,
      namespaceId,
      params.agentId as string,
    );
    reply.send({ data: roles, meta: { requestId: request.id } });
  },
  async updateIAMRuntimeRole({
    controller,
    context,
    request,
    reply,
    params,
    body,
    namespaceId,
    mutationEvent,
  }) {
    const binding = await controller.transact(async (unit) => {
      const updated = await controller.updateIAMRuntimeRole(
        context.actorId,
        namespaceId,
        params.bindingId as string,
        body?.runtimeRole as string,
        body?.runtimeRoleConfiguration as AgentRuntimeRoleCatalog["configuration"],
      );
      await unit.audit.append(
        mutationEvent(bindingAuditResource(updated, namespaceId), bindingAuditDetails(updated)),
      );
      return clientIAMAccessBinding(updated);
    });
    reply.send({ data: binding, meta: { requestId: request.id } });
  },
  async getIAMAccessBinding({ controller, context, request, reply, params, namespaceId }) {
    const binding = await controller.getIAMAccessBinding(
      context.actorId,
      namespaceId,
      params.bindingId as string,
    );
    reply.send({
      data: clientIAMAccessBinding(binding),
      meta: { requestId: request.id },
    });
  },
  async deleteIAMAccessBinding({ controller, context, reply, params, namespaceId, mutationEvent }) {
    await controller.transact(async (unit) => {
      const deleted = await controller.deleteIAMAccessBinding(
        context.actorId,
        namespaceId,
        params.bindingId as string,
      );
      await unit.audit.append(
        mutationEvent(bindingAuditResource(deleted, namespaceId), bindingAuditDetails(deleted)),
      );
    });
    reply.status(204).send();
  },
} satisfies ResourceHandlers;
