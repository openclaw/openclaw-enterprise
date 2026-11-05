import { randomUUID } from "node:crypto";

import type {
  Agent,
  AgentRevision,
  AuditEvent,
  IAMDriver,
  IAMPolicyManagementContext,
  SecretBindings,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError } from "./errors.ts";

type RevisionCredentialSources = Pick<
  AgentRevision,
  "id" | "secretBindings" | "harnessAuth" | "credentialSources"
>;

interface AgentCredentialGrantPort {
  readonly configurations: {
    findConfiguration(
      namespaceId: string,
      configurationId: string,
    ): Promise<{ readonly secretBindings?: SecretBindings } | undefined>;
  };
  readonly revisions: {
    listRevisionMetadata(
      namespaceId: string,
      agentId: string,
    ): Promise<readonly { readonly id: string }[]>;
    findRevision(
      namespaceId: string,
      agentId: string,
      revisionId: string,
    ): Promise<Readonly<RevisionCredentialSources> | undefined>;
  };
  readonly operations: {
    findWork(idempotencyKey: string): Promise<{ readonly state: string } | undefined>;
  };
  readonly audit: {
    append(event: AuditEvent): Promise<void>;
  };
}

/** Remove only OCC-generated grants, in the caller's Namespace-locked transaction. */
export async function removeUnusedAgentCredentialGrants(
  state: AgentCredentialGrantPort,
  agent: Readonly<Agent>,
  iam: IAMDriver,
  policy: IAMPolicyManagementContext,
  audit: { readonly installationId: string; readonly actorId: string; readonly occurredAt: string },
): Promise<void> {
  const generated = (await policy.policy.listAccessBindings(agent.namespaceId)).filter(
    (binding) => {
      const kind = binding.resourceKind;
      const id = binding.resourceId;
      return (
        binding.namespaceId === agent.namespaceId &&
        binding.subjectKind === "identity" &&
        binding.subjectId === agent.servicePrincipalId &&
        (kind === "secret" || kind === "credential_source") &&
        id !== undefined &&
        binding.roleId === `role_${agent.namespaceId}_agent_${kind}_operate` &&
        binding.id === `binding_${agent.id}_${id}_operate`
      );
    },
  );
  if (generated.length === 0) {
    return;
  }
  if (agent.activeRevisionId !== undefined) {
    const activation = await state.operations.findWork(
      `agent_revision:${agent.activeRevisionId}:reconcile`,
    );
    // The pointer is published before predecessor retirement. Until reconciliation succeeds,
    // retain existing grants: an interrupted or failed retirement can leave that runtime alive.
    if (activation?.state !== "succeeded") {
      return;
    }
  }
  const desired = new Set<string>();
  const add = (kind: "secret" | "credential_source", id: string): void => {
    desired.add(`${kind}\u0000${id}`);
  };
  const addSecrets = (bindings: SecretBindings | undefined): void => {
    for (const { source } of Object.values(bindings ?? {})) {
      add("secret", source.id);
    }
  };
  const addAgentSources = (
    value: Pick<Agent, "harnessAuth" | "credentialSources"> | Readonly<RevisionCredentialSources>,
  ): void => {
    const auth = value.harnessAuth;
    if (
      auth !== null &&
      (auth.method === "api_key" || auth.method === "codex_pat") &&
      auth.source.kind === "secret"
    ) {
      add("secret", auth.source.id);
    } else if (auth?.method === "credential_source") {
      add("credential_source", auth.sourceId);
    }
    for (const { sourceId } of value.credentialSources ?? []) {
      add("credential_source", sourceId);
    }
  };

  const configuration = await state.configurations.findConfiguration(
    agent.namespaceId,
    agent.configurationId,
  );
  if (configuration === undefined) {
    throw new DependencyUnavailableError(
      "The Agent's Configuration is unavailable during credential cleanup.",
    );
  }
  addSecrets(configuration.secretBindings);
  addAgentSources(agent);

  let foundActive = agent.activeRevisionId === undefined;
  for (const candidate of await state.revisions.listRevisionMetadata(agent.namespaceId, agent.id)) {
    const work = await state.operations.findWork(`agent_revision:${candidate.id}:reconcile`);
    if (
      candidate.id !== agent.activeRevisionId &&
      work?.state !== "queued" &&
      work?.state !== "claimed"
    ) {
      continue;
    }
    const revision = await state.revisions.findRevision(agent.namespaceId, agent.id, candidate.id);
    if (revision === undefined) {
      throw new DependencyUnavailableError(
        "A retained Agent revision is unavailable during credential cleanup.",
      );
    }
    foundActive ||= revision.id === agent.activeRevisionId;
    addSecrets(revision.secretBindings);
    addAgentSources(revision);
  }
  if (!foundActive) {
    throw new DependencyUnavailableError(
      "The Agent's active revision is unavailable during credential cleanup.",
    );
  }

  const stale = generated.filter(
    (binding) => !desired.has(`${binding.resourceKind}\u0000${binding.resourceId}`),
  );
  if (stale.length === 0) {
    return;
  }
  if (
    iam.namespacePolicyTransaction !== "platform-unit-of-work" ||
    typeof iam.deleteNamespaceAccessBinding !== "function"
  ) {
    throw new DependencyUnavailableError(
      "The selected IAM Driver cannot remove unused Agent credential grants transactionally.",
    );
  }
  for (const binding of stale) {
    if (!(await iam.deleteNamespaceAccessBinding(policy, agent.namespaceId, binding.id))) {
      throw new DependencyUnavailableError(
        "The selected IAM Driver did not remove an unused Agent credential grant.",
      );
    }
    await state.audit.append({
      id: `aud_${randomUUID()}`,
      ...audit,
      namespaceId: agent.namespaceId,
      kind: "mutation",
      source: "occ",
      action: "openclaw.iam.agent_credential_grant_removed",
      resource: {
        kind: binding.resourceKind as "secret" | "credential_source",
        id: binding.resourceId!,
        namespaceId: agent.namespaceId,
      },
      iamDriverId: iam.id,
      outcome: "success",
      details: {
        agentId: agent.id,
        servicePrincipalId: agent.servicePrincipalId,
        roleId: binding.roleId,
        bindingId: binding.id,
      },
    });
  }
}
