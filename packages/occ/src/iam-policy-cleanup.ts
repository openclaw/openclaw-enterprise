import type {
  AccessBinding,
  Agent,
  ResourceKind,
  Restriction,
} from "@openclaw-enterprise/contracts";
import type { PlatformReadView, PlatformUnitOfWork } from "./state/platform-state.ts";

/** An AccessBinding removed as a side effect, as recorded in the audit of the removal. */
export interface RemovedAccessBinding {
  readonly id: string;
  readonly subjectKind: AccessBinding["subjectKind"];
  readonly subjectId: string;
  readonly roleId: string;
  readonly resourceKind?: ResourceKind;
  readonly resourceId?: string;
}

function removedAccessBinding(binding: Readonly<AccessBinding>): RemovedAccessBinding {
  return Object.freeze({
    id: binding.id,
    subjectKind: binding.subjectKind,
    subjectId: binding.subjectId,
    roleId: binding.roleId,
    ...(binding.resourceKind === undefined ? {} : { resourceKind: binding.resourceKind }),
    ...(binding.resourceId === undefined ? {} : { resourceId: binding.resourceId }),
  });
}

/**
 * Lists the Namespace AccessBindings that target one exact resource. Deleting the resource
 * removes them, so callers record the list in that deletion's audit event.
 */
export async function accessBindingsTargeting(
  state: Pick<PlatformReadView, "iamPolicy">,
  namespaceId: string,
  resourceKind: ResourceKind,
  resourceId: string,
): Promise<readonly RemovedAccessBinding[]> {
  return Object.freeze(
    (await state.iamPolicy.listAccessBindings(namespaceId))
      .filter(
        (binding) => binding.resourceKind === resourceKind && binding.resourceId === resourceId,
      )
      .map(removedAccessBinding),
  );
}

/**
 * Lists the AccessBindings that completing an Agent's deletion removes: those that target
 * the Agent or one of its AgentRevisions, and those whose subject is the Agent's
 * ServicePrincipal (the same three groups the deletion finalizer deletes). A deleting
 * Agent refuses new bindings of each kind, so the list is final unless a binding is
 * deleted explicitly first. The finalizer's DELETE is not Namespace-scoped, but policy
 * admission keeps every such binding in the Agent's Namespace, so reading that
 * Namespace's bindings sees all of them.
 */
export async function accessBindingsRemovedWithAgent(
  state: Pick<PlatformReadView, "iamPolicy" | "revisions">,
  agent: Pick<Agent, "namespaceId" | "id" | "servicePrincipalId">,
): Promise<readonly RemovedAccessBinding[]> {
  const revisionIds = new Set(await agentRevisionIds(state, agent));
  return Object.freeze(
    (await state.iamPolicy.listAccessBindings(agent.namespaceId))
      .filter(
        (binding) =>
          (binding.subjectKind === "identity" && binding.subjectId === agent.servicePrincipalId) ||
          (binding.resourceKind === "agent" && binding.resourceId === agent.id) ||
          (binding.resourceKind === "agent_revision" &&
            binding.resourceId !== undefined &&
            revisionIds.has(binding.resourceId)),
      )
      .map(removedAccessBinding),
  );
}

/**
 * Lists the IAM Restrictions that completing an Agent's deletion removes: those on the
 * Agent or one of its AgentRevisions, in any scope (the same two groups the deletion
 * finalizer deletes). OCC has no API that writes Restrictions; they come from the
 * Installation's IAM seed, so the list stays final unless an operator edits them directly.
 */
export async function restrictionsRemovedWithAgent(
  state: Pick<PlatformReadView, "iamPolicy" | "revisions">,
  agent: Pick<Agent, "namespaceId" | "id">,
): Promise<readonly Readonly<Restriction>[]> {
  const restrictions = [
    ...(await state.iamPolicy.listRestrictionsTargeting("agent", [agent.id])),
    ...(await state.iamPolicy.listRestrictionsTargeting(
      "agent_revision",
      await agentRevisionIds(state, agent),
    )),
  ];
  return Object.freeze(
    restrictions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  );
}

async function agentRevisionIds(
  state: Pick<PlatformReadView, "revisions">,
  agent: Pick<Agent, "namespaceId" | "id">,
): Promise<readonly string[]> {
  return (await state.revisions.listRevisions(agent.namespaceId, agent.id)).map(
    (revision) => revision.id,
  );
}

/**
 * Removes a deleted Namespace's own policy (its AccessBindings, then its Roles) in the
 * tombstoning transaction, so no grant outlives the Namespace. Returns what was removed
 * for the lifecycle audit event.
 */
export async function removeNamespacePolicy(
  state: Pick<PlatformUnitOfWork, "iamPolicy">,
  namespaceId: string,
): Promise<{
  readonly accessBindings: readonly RemovedAccessBinding[];
  readonly roleIds: readonly string[];
}> {
  const accessBindings: RemovedAccessBinding[] = [];
  for (const binding of await state.iamPolicy.listAccessBindings(namespaceId)) {
    if (await state.iamPolicy.deleteAccessBinding(namespaceId, binding.id)) {
      accessBindings.push(removedAccessBinding(binding));
    }
  }
  const roleIds: string[] = [];
  for (const role of await state.iamPolicy.listRoles(namespaceId)) {
    if (await state.iamPolicy.deleteRole(namespaceId, role.id)) {
      roleIds.push(role.id);
    }
  }
  return Object.freeze({
    accessBindings: Object.freeze(accessBindings),
    roleIds: Object.freeze(roleIds),
  });
}

/** Audit details for removed Namespace policy; empty when nothing was removed. */
export function removedPolicyDetails(
  removed:
    | {
        readonly accessBindings: readonly RemovedAccessBinding[];
        readonly roleIds: readonly string[];
      }
    | undefined,
): Readonly<Record<string, unknown>> {
  return {
    ...(removed === undefined || removed.accessBindings.length === 0
      ? {}
      : { removedAccessBindings: removed.accessBindings }),
    ...(removed === undefined || removed.roleIds.length === 0
      ? {}
      : { removedRoleIds: removed.roleIds }),
  };
}
