import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { repositoryGitRecipientFields } from "@openclaw-enterprise/contracts";
import type {
  EgressInstallation,
  ProxyPlan,
  CredentialPolicyEffects,
  CredentialPolicyReduction,
  ProxyRevisionContext,
} from "@openclaw-enterprise/contracts";
import type { InstalledDriver } from "./installed-driver.ts";
import type {
  CredentialPolicyReductionState,
  CredentialPolicyReductionStore,
  CredentialPolicyReductionUnitOfWork,
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
  if (admitted.policyReductionVersion === 3) {
    if (
      !admitted.repositoryGit ||
      !admitted.routes.length ||
      current.generation !== admitted.generation + 1 ||
      admitted.repositoryGitAuthorization !== "online-request" ||
      current.policyReductionVersion !== 3
    ) {
      return false;
    }
    // Exactly one grant may be removed. The surviving grant, its entire route set
    // and every execution/Driver field remain byte-for-byte admission facts.
    const { repositoryGit: _git, ...withoutGit } = admitted;
    return (
      isDeepStrictEqual(current, { ...withoutGit, generation: current.generation }) ||
      isDeepStrictEqual(current, { ...admitted, generation: current.generation, routes: [] })
    );
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

/** The sender proves the current recipient; OCC independently checks the grant it still owns.
 * Never treat a sender echo of an admitted grant as authority to fence or enroll. */
async function retainedGrantCurrent(
  unit: CredentialPolicyReductionUnitOfWork,
  context: ProxyRevisionContext,
  request: CredentialPolicyReduction,
) {
  if (request.version !== 3) {
    return true;
  }
  const { revision } = context;
  const { expected, retained, condition } = request;
  const j = expected.enforcement.joint;
  if (!j || !condition) {
    return false;
  }
  await unit.namespaces.lockNamespace(revision.namespaceId);
  const agent = await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
  const recorded = await unit.revisions.findRevision(
    revision.namespaceId,
    revision.agentId,
    revision.id,
  );
  if (
    agent?.status !== "active" ||
    agent.desiredRuntimeState !== "running" ||
    agent.activeRevisionId !== revision.id ||
    agent.servicePrincipalId !== expected.plan.execution.servicePrincipalId ||
    !isDeepStrictEqual(recorded?.egressPlan, expected.plan)
  ) {
    return false;
  }
  const git = retained.repositoryGit;
  if (!git) {
    const route = retained.routes[0];
    const b = route?.binding;
    if (
      !b ||
      !isDeepStrictEqual(condition.grant, j.model) ||
      condition.grant.id !== b.binding.id ||
      condition.grant.scope !== b.grantHash ||
      condition.grant.generation !== String(b.binding.generation) ||
      !agent.credentialSources?.some((s) => s.sourceId === b.source.source.id)
    ) {
      return false;
    }
    const source = await unit.credentialSources.findCredentialSource(
      revision.namespaceId,
      b.source.source.id,
    );
    const withdrawals = await unit.credentialSources.listCredentialWithdrawals(
      revision.namespaceId,
      revision.id,
    );
    return (
      source?.state === "ready" &&
      isDeepStrictEqual(source.egress?.key, b.source) &&
      !withdrawals.some((w) => w.credentialSourceId === b.source.source.id)
    );
  }
  const binding = git.bindings[0];
  if (
    !binding ||
    !agent.repositoryBindings?.some(
      (value) => value.repositoryRef === binding.repositoryRef && value.profile === binding.profile,
    ) ||
    !isDeepStrictEqual(condition.grant, j.git) ||
    !isDeepStrictEqual(context.currentGitGrant?.(), {
      id: j.git.id,
      generation: j.git.generation,
      scope: j.git.scope,
    }) ||
    binding.grant.grantId !== condition.grant.id ||
    !isDeepStrictEqual(recorded?.repositoryCredentials, git)
  ) {
    return false;
  }
  const owner = {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
  };
  const attempts = await unit.repositorySessions.listRevisionAttempts(owner);
  const active = attempts.filter(
    (a) =>
      a.liveRevisionId === revision.id &&
      a.phase === "open" &&
      a.sessionId &&
      a.deadlineWallMs > Date.now() &&
      isDeepStrictEqual(a.cleanupContext.binding, binding),
  );
  if (active.length !== 1) {
    return false;
  }
  if (!git.standingApprovalId) {
    return git.deadlineWallMs > Date.now();
  }
  const approval = await unit.repositorySessions.findStandingApproval(
    revision.namespaceId,
    revision.agentId,
    binding.repositoryRef,
  );
  const execution = await unit.repositorySessions.findStandingExecution(owner);
  return (
    approval?.id === git.standingApprovalId &&
    !approval.revokedAt &&
    approval.generation === git.standingApprovalGeneration &&
    String(approval.generation) === condition.grant.generation &&
    approval.scopeFingerprint === condition.grant.scope &&
    isDeepStrictEqual(approval.binding, binding) &&
    !!execution &&
    !execution.closed
  );
}

export function revisionPolicyEffects(
  state: CredentialPolicyReductionStore,
  ns: string,
  revision: string,
): CredentialPolicyEffects {
  return {
    read: (step) => state.transact((u) => u.credentialSources.readPolicyEffect(ns, revision, step)),
    compare: (step, prior, next) =>
      state.transact((u) =>
        u.credentialSources.comparePolicyEffect(ns, revision, step, prior, next),
      ),
  };
}

/** Compute checks source ownership; repository cleanup passes undefined after closing its sessions. */
export async function reduceCredentialPolicy(
  state: CredentialPolicyReductionStore,
  owner: InstalledDriver | undefined,
  context: ProxyRevisionContext,
  sourceId: string | undefined,
): Promise<"withdrawn" | "pending" | "retire-runtime"> {
  const reducer = owner?.require("credential_proxy").policyReduction;
  if (
    context.plan.policyReductionVersion !== 1 &&
    context.plan.policyReductionVersion !== 2 &&
    context.plan.policyReductionVersion !== 3
  ) {
    return "retire-runtime";
  }
  if (!reducer || context.plan.policyReductionVersion !== reducer.version) {
    return "pending";
  }
  if (
    sourceId === undefined &&
    ((reducer.version !== 2 && reducer.version !== 3) || !context.plan.repositoryGit)
  ) {
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
    if (reducer.version !== 1) {
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
    const condition =
      reducer.version === 3 ? await reducer.prepare(context, installation, retained) : undefined;
    if (
      reducer.version === 3 &&
      (!condition ||
        !/^[a-f0-9]{64}$/.test(condition.predecessorKeySha256) ||
        !condition.grant?.id ||
        !condition.grant.scope ||
        !condition.grant.recipient ||
        !/^[1-9][0-9]*$/.test(condition.grant.generation) ||
        !Object.keys(condition.remainingPolicy).length)
    ) {
      return undefined;
    }
    const next: CredentialPolicyReductionState = {
      bindingId,
      request: {
        version: reducer.version,
        operationId: randomUUID(),
        ...(condition && { condition }),
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
  const fresh = () =>
    request.version !== 3
      ? Promise.resolve(true)
      : state.transact((unit) => retainedGrantCurrent(unit, context, request));
  if (!(await fresh())) {
    return "pending";
  }
  if (dispatch) {
    // The committed operation consumes the sole dispatch opportunity. A lost response or
    // crash before sending is uncertainty, never permission to repeat an effect.
    await reducer.apply(context, request, fresh);
  }
  const custodyContext =
    request.version === 3
      ? {
          ...context,
          policyEffects: revisionPolicyEffects(state, revision.namespaceId, revision.id),
        }
      : context;
  if (reducer.version === 3 && !recorded.observed && reducer.advance) {
    await reducer.advance(custodyContext, request, fresh);
  }
  const observed = await reducer.observe(custodyContext, request);
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
  if (request.version === 3) {
    // The paired Driver has to re-read the original operation, authenticate today's
    // recipient and match the complete retained policy. An old operation receipt is
    // not a lease, including on subsequent worker passes after an earlier settlement.
    const prior = request.expected;
    const next = observed.installation;
    if (
      !request.condition ||
      !isDeepStrictEqual(observed.condition, request.condition) ||
      !isDeepStrictEqual(next.plan, request.retained) ||
      !verifiedPolicy(prior, next) ||
      next.sandboxId !== prior.sandboxId ||
      next.installedAt !== prior.installedAt ||
      !isDeepStrictEqual(next.sender, prior.sender) ||
      next.enforcement.authorityScope !== prior.enforcement.authorityScope ||
      next.enforcement.instanceId !== prior.enforcement.instanceId ||
      (next.plan.repositoryGit
        ? !prior.enforcement.repositoryGitRecipient ||
          next.enforcement.peerKeyId !== undefined ||
          !isDeepStrictEqual(
            next.enforcement.repositoryGitRecipient,
            prior.enforcement.repositoryGitRecipient,
          )
        : next.enforcement.repositoryGitRecipient !== undefined ||
          !next.enforcement.peerKeyId ||
          next.enforcement.peerKeyId === prior.enforcement.peerKeyId)
    ) {
      return "pending";
    }
  } else {
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
  }
  return state.transact(async (unit) => {
    await unit.namespaces.lockNamespace(revision.namespaceId);
    if (!(await retainedGrantCurrent(unit, context, request))) {
      return "pending";
    }
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
