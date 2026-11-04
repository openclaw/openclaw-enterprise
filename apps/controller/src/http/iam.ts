import type {
  AccessBinding,
  NamespaceAgentOperatorProfile,
  ResourceKind,
  ResourceRef,
  Role,
  ServicePrincipal,
  StageNamespaceAgentOperatorProfileBody,
} from "@openclaw-enterprise/contracts";
import type { RequestContext, ResourceHandlers } from "./types.ts";

function policyActor(context: RequestContext) {
  return { id: context.actorId, issuer: context.issuer, subject: context.subject };
}

function profileAuditDetails(profile: Readonly<NamespaceAgentOperatorProfile>) {
  return { generation: profile.generation, status: profile.status, groupId: profile.groupId };
}

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
    ...(binding.resourceKind === undefined ? {} : { resourceKind: binding.resourceKind }),
    ...(binding.resourceId === undefined ? {} : { resourceId: binding.resourceId }),
  };
}

function clientIAMServicePrincipal(
  servicePrincipal: Readonly<ServicePrincipal>,
): Record<string, unknown> {
  return { id: servicePrincipal.id, namespaceId: servicePrincipal.namespaceId };
}

export const iamHandlers = {
  async getNamespaceAgentOperatorProfile({ controller, context, request, reply, namespaceId }) {
    const profile = await controller.getNamespaceAgentOperatorProfile(
      policyActor(context),
      namespaceId,
    );
    reply.header("cache-control", "no-store");
    reply.send({
      data: profile ?? { namespaceId, status: "off", generation: null },
      meta: { requestId: request.id },
    });
  },
  async stageNamespaceAgentOperatorProfile({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
    transactIAM,
  }) {
    const profile = await transactIAM(async (unit) => {
      const staged = await controller.stageNamespaceAgentOperatorProfile(
        policyActor(context),
        namespaceId,
        body as StageNamespaceAgentOperatorProfileBody,
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "namespace", id: namespaceId, namespaceId },
          profileAuditDetails(staged),
        ),
      );
      return staged;
    });
    reply.header("cache-control", "no-store");
    reply.send({ data: profile, meta: { requestId: request.id } });
  },
  async withdrawNamespaceAgentOperatorProfile({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
    transactIAM,
  }) {
    const previousGeneration = body?.expectedGeneration as string;
    const profile = await transactIAM(async (unit) => {
      const withdrawn = await controller.withdrawNamespaceAgentOperatorProfile(
        policyActor(context),
        namespaceId,
        previousGeneration,
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "namespace", id: namespaceId, namespaceId },
          { ...profileAuditDetails(withdrawn), previousGeneration },
        ),
      );
      return withdrawn;
    });
    reply.header("cache-control", "no-store");
    reply.send({ data: profile, meta: { requestId: request.id } });
  },
  async listIAMRoles({ controller, context, request, reply, namespaceId }) {
    const roles = await controller.listIAMRoles(context.actorId, namespaceId);
    reply.send({ data: roles.map(clientIAMRole), meta: { requestId: request.id } });
  },
  async createIAMRole({
    controller,
    context,
    request,
    reply,
    body,
    namespaceId,
    mutationEvent,
    transactIAM,
  }) {
    const role = await transactIAM(async (unit) => {
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
  async deleteIAMRole({
    controller,
    context,
    reply,
    params,
    namespaceId,
    mutationEvent,
    transactIAM,
  }) {
    await transactIAM(async (unit) => {
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
    transactIAM,
  }) {
    const binding = await transactIAM(async (unit) => {
      const created = await controller.createIAMAccessBinding(context.actorId, {
        namespaceId,
        subjectKind: body?.subjectKind as "identity",
        subjectId: body?.subjectId as string,
        roleId: body?.roleId as string,
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
  async deleteIAMAccessBinding({
    controller,
    context,
    reply,
    params,
    namespaceId,
    mutationEvent,
    transactIAM,
  }) {
    await transactIAM(async (unit) => {
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
  async listIAMServicePrincipals({ controller, context, request, reply, namespaceId }) {
    const principals = await controller.listIAMServicePrincipals(context.actorId, namespaceId);
    reply.send({
      data: principals.map(clientIAMServicePrincipal),
      meta: { requestId: request.id },
    });
  },
  async createIAMServicePrincipal({
    controller,
    context,
    request,
    reply,
    namespaceId,
    mutationEvent,
    transactIAM,
  }) {
    const created = await transactIAM(async (unit) => {
      const servicePrincipal = await controller.createIAMServicePrincipal(
        context.actorId,
        namespaceId,
      );
      await unit.audit.append(
        mutationEvent(
          { kind: "namespace", id: namespaceId, namespaceId },
          { servicePrincipalId: servicePrincipal.id },
        ),
      );
      return clientIAMServicePrincipal(servicePrincipal);
    });
    reply.status(201).send({ data: created, meta: { requestId: request.id } });
  },
  async getIAMServicePrincipal({ controller, context, request, reply, params, namespaceId }) {
    const servicePrincipal = await controller.getIAMServicePrincipal(
      context.actorId,
      namespaceId,
      params.servicePrincipalId as string,
    );
    reply.send({
      data: clientIAMServicePrincipal(servicePrincipal),
      meta: { requestId: request.id },
    });
  },
} satisfies ResourceHandlers;
