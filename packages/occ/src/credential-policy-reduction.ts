import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { repositoryGitRecipientFields } from "@openclaw-enterprise/contracts";
import type {
  EgressInstallation,
  ProxyPlan,
  ProxyRevisionContext,
} from "@openclaw-enterprise/contracts";
import type { InstalledDriver } from "./installed-driver.ts";
import type {
  CredentialPolicyReductionState,
  CredentialPolicyReductionStore,
} from "./ports/credential-policy-reduction.ts";

/** A stored successor only removes whole routes; v2 can also remove the Git binding. */
export function isReducedCredentialPlan(
  admitted: ProxyPlan | undefined,
  current: ProxyPlan,
): boolean {
  if (
    !admitted ||
    !Number.isSafeInteger(current.generation) ||
    !Number.isSafeInteger(admitted.generation) ||
    admitted.generation < 1 ||
    current.generation < admitted.generation ||
    new Set(current.routes.map(({ route }) => JSON.stringify([route.id, route.generation])))
      .size !== current.routes.length
  ) {
    return false;
  }
  if (current.generation === admitted.generation) {
    return isDeepStrictEqual(current, admitted);
  }
  const gitRemoved =
    admitted.policyReductionVersion === 2 &&
    admitted.repositoryGit !== undefined &&
    current.repositoryGit === undefined;
  if (
    (admitted.policyReductionVersion !== 1 && admitted.policyReductionVersion !== 2) ||
    (current.routes.length >= admitted.routes.length && !gitRemoved) ||
    !isDeepStrictEqual(
      {
        ...current,
        generation: admitted.generation,
        routes: admitted.routes,
        ...(gitRemoved && { repositoryGit: admitted.repositoryGit }),
      },
      admitted,
    )
  ) {
    return false;
  }
  let next = 0;
  for (const route of admitted.routes) {
    if (next < current.routes.length && isDeepStrictEqual(route, current.routes[next])) {
      next++;
    }
  }
  return next === current.routes.length;
}

function recipientIdentity(installation: EgressInstallation): readonly unknown[] {
  return [
    installation.sandboxId,
    installation.sender?.id,
    installation.sender?.generation,
    installation.enforcement?.instanceId,
    installation.enforcement?.peerKeyId,
    ...repositoryGitRecipientFields.map(
      (field) => installation.enforcement?.repositoryGitRecipient?.[field],
    ),
  ];
}

function verifiedPolicy(expected: EgressInstallation, observed: EgressInstallation): boolean {
  return (
    typeof observed.enforcement.configurationId === "string" &&
    observed.enforcement.configurationId.trim().length > 0 &&
    /^[a-f0-9]{64}$/.test(observed.enforcement.policyHash) &&
    observed.enforcement.policyHash !== expected.enforcement.policyHash
  );
}

/** Compute checks source ownership; repository cleanup passes undefined after closing its sessions. */
export async function reduceCredentialPolicy(
  state: CredentialPolicyReductionStore,
  owner: InstalledDriver | undefined,
  context: ProxyRevisionContext,
  sourceId: string | undefined,
): Promise<"withdrawn" | "pending" | "retire-runtime"> {
  const reducer = owner?.require("credential_proxy").policyReduction;
  if (context.plan.policyReductionVersion !== 1 && context.plan.policyReductionVersion !== 2) {
    return "retire-runtime";
  }
  if (!reducer || context.plan.policyReductionVersion !== reducer.version) {
    return "pending";
  }
  if (sourceId === undefined && (reducer.version !== 2 || !context.plan.repositoryGit)) {
    return "retire-runtime";
  }
  const { revision } = context;
  const bindingId = sourceId === undefined ? "policy:repository-git" : `policy:source:${sourceId}`;
  const prepared = await state.transact(async (unit) => {
    // Serialize all bindings of the recipient, including different withdrawal work items.
    await unit.namespaces.lockNamespace(revision.namespaceId);
    const agent = await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
    const currentRevision = await unit.revisions.findRevision(
      revision.namespaceId,
      revision.agentId,
      revision.id,
    );
    const installation = await unit.credentialSources.findRevisionEgressInstallation(
      revision.namespaceId,
      revision.id,
    );
    const withdrawals = await unit.credentialSources.listCredentialWithdrawals(
      revision.namespaceId,
      revision.id,
    );
    const reductions = await unit.credentialSources.listCredentialPolicyReductions(
      revision.namespaceId,
      revision.id,
    );
    const withdrawal = withdrawals.find((item) => item.credentialSourceId === sourceId);
    // Only the active revision's policy is ever reduced. A recorded source withdrawal on any
    // other revision (an unretired predecessor, or a later candidate that failed or is still
    // deploying) cannot settle here, so require runtime retirement instead of an error that
    // retries on every pass (finding 2235). The withdrawal stays pending, and egress refused,
    // until that revision is retired or a replay finds it active. A recorded reduction is
    // neither observed nor repeated here.
    if (
      withdrawal &&
      agent?.activeRevisionId !== undefined &&
      agent.activeRevisionId !== revision.id
    ) {
      return "retire-runtime" as const;
    }
    // Repository cleanup has already closed authority. Do not turn an arbitrary call into withdrawal.
    const attempts =
      sourceId === undefined
        ? await unit.repositorySessions.listRevisionAttempts({
            namespaceId: revision.namespaceId,
            agentId: revision.agentId,
            revisionId: revision.id,
          })
        : [];
    const gitWithdrawn =
      attempts.length > 0 && !attempts.some(({ phase }) => phase === "open" || phase === "opening");
    if (
      !agent ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      agent.activeRevisionId !== revision.id ||
      !currentRevision ||
      !isDeepStrictEqual(currentRevision.egressPlan, context.plan) ||
      !installation ||
      (sourceId === undefined ? !gitWithdrawn : !withdrawal) ||
      !context.plan.driver ||
      !owner?.ownsProxyPlan(context.plan) ||
      !isReducedCredentialPlan(context.plan, installation.plan)
    ) {
      throw new Error("Credential policy reduction has no exact admitted owner or withdrawal.");
    }
    let recorded = reductions.find((item) => item.bindingId === bindingId);
    if (recorded?.observed) {
      // A later reduction supersedes the old observation; inspect that operation's current
      // policy rather than treating an old receipt as a lease or reinstalling old routes.
      recorded =
        reductions.find(
          (item) => item.observed && isDeepStrictEqual(item.observed, installation),
        ) ?? recorded;
    }
    if (recorded) {
      return { recorded, dispatch: false };
    }
    if (reductions.some((item) => !item.observed)) {
      return undefined;
    }
    // Discovery gates a new effect only. Recovery must still observe the committed request.
    if (reducer.version === 2) {
      await reducer.assertAvailable(context.signal);
    }
    const routes = installation.plan.routes.filter(
      (route) => route.binding.source.source.id !== sourceId,
    );
    if (sourceId !== undefined && routes.length === installation.plan.routes.length) {
      throw new Error("Credential policy reduction does not remove an installed source.");
    }
    const { repositoryGit, ...withoutGit } = installation.plan;
    if (sourceId === undefined && !repositoryGit) {
      throw new Error("Repository Git policy was removed without recorded reduction custody.");
    }
    const retained = {
      ...(sourceId === undefined ? withoutGit : installation.plan),
      generation: installation.plan.generation + 1,
      routes,
    };
    if (!isReducedCredentialPlan(installation.plan, retained)) {
      throw new Error("Credential policy reduction does not reduce the current policy.");
    }
    const next: CredentialPolicyReductionState = {
      bindingId,
      request: {
        version: reducer.version,
        operationId: randomUUID(),
        expected: installation,
        retained,
      },
    };
    if (
      !(await unit.credentialSources.saveCredentialPolicyReduction(
        revision.namespaceId,
        revision.id,
        bindingId,
        undefined,
        next,
      ))
    ) {
      throw new Error("Credential policy reduction changed before dispatch.");
    }
    return { recorded: next, dispatch: true };
  });
  if (!prepared) {
    return "pending";
  }
  if (prepared === "retire-runtime") {
    return prepared;
  }
  const { recorded, dispatch } = prepared;
  const request = recorded.request;
  context.signal.throwIfAborted();
  if (dispatch) {
    // The committed operation consumes the sole dispatch opportunity. A lost response or
    // crash before sending is uncertainty, never permission to repeat an effect.
    await reducer.apply(context, request);
  }
  const observed = await reducer.observe(context, request);
  if (!observed || observed.operationId !== request.operationId) {
    return "pending";
  }
  // An incomplete witness cannot establish replacement. Authenticate the operation first,
  // then compare stable recipient identity independently of policy configuration evidence.
  if (!observed.installation) {
    return "pending";
  }
  if (
    !isDeepStrictEqual(observed.installation.plan, request.expected.plan) &&
    !isDeepStrictEqual(observed.installation.plan, request.retained)
  ) {
    return "pending";
  }
  const expectedIdentity = recipientIdentity(request.expected);
  const observedIdentity = recipientIdentity(observed.installation);
  if (
    expectedIdentity.some(
      (value, index) =>
        value !== undefined &&
        (typeof observedIdentity[index] !== typeof value ||
          (typeof observedIdentity[index] === "string" &&
            !String(observedIdentity[index]).trim()) ||
          (typeof observedIdentity[index] === "number" &&
            (!Number.isSafeInteger(observedIdentity[index]) ||
              Number(observedIdentity[index]) < 1))),
    )
  ) {
    return "pending";
  }
  if (
    expectedIdentity.some(
      (value, index) => value !== undefined && value !== observedIdentity[index],
    )
  ) {
    return "retire-runtime";
  }
  if (
    !isDeepStrictEqual(observed.installation.plan, request.retained) ||
    !verifiedPolicy(request.expected, observed.installation) ||
    !isDeepStrictEqual(
      {
        ...observed.installation,
        plan: request.expected.plan,
        enforcement: {
          ...observed.installation.enforcement,
          configurationId: request.expected.enforcement.configurationId,
          policyHash: request.expected.enforcement.policyHash,
        },
      },
      request.expected,
    )
  ) {
    return "pending";
  }
  return state.transact(async (unit) => {
    await unit.namespaces.lockNamespace(revision.namespaceId);
    const agent = await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
    if (
      agent?.activeRevisionId !== revision.id ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running"
    ) {
      return "pending";
    }
    const current = await unit.credentialSources.findRevisionEgressInstallation(
      revision.namespaceId,
      revision.id,
    );
    if (recorded.observed) {
      return isDeepStrictEqual(current, observed.installation) ? "withdrawn" : "pending";
    }
    if (!isDeepStrictEqual(current, request.expected)) {
      return "pending";
    }
    if (
      !(await unit.credentialSources.saveCredentialPolicyReduction(
        revision.namespaceId,
        revision.id,
        recorded.bindingId,
        recorded,
        { ...recorded, observed: observed.installation },
      ))
    ) {
      throw new Error("Credential policy reduction lost its installation fence.");
    }
    return "withdrawn";
  });
}
