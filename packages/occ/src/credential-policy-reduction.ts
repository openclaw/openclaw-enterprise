import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  EgressInstallation,
  ProxyPlan,
  ProxyRevisionContext,
} from "@openclaw-enterprise/contracts";
import type { InstalledDriver } from "./installed-driver.ts";
import type { CredentialPolicyReductionState, PlatformStateStore } from "./state/platform-state.ts";

/** A stored successor can only remove whole admitted routes, never change their grants. */
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
  if (
    admitted.policyReductionVersion !== 1 ||
    current.routes.length >= admitted.routes.length ||
    !isDeepStrictEqual(
      { ...current, generation: admitted.generation, routes: admitted.routes },
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

function sameRecipient(expected: EgressInstallation, observed: EgressInstallation): boolean {
  return (
    isDeepStrictEqual(
      {
        ...observed,
        plan: expected.plan,
        enforcement: {
          ...observed.enforcement,
          configurationId: expected.enforcement.configurationId,
          policyHash: expected.enforcement.policyHash,
        },
      },
      expected,
    ) &&
    observed.enforcement.configurationId.length > 0 &&
    /^[a-f0-9]{64}$/.test(observed.enforcement.policyHash) &&
    observed.enforcement.policyHash !== expected.enforcement.policyHash
  );
}

/** Called by Compute only after checking the source and selected Sandbox owner. */
export async function reduceCredentialPolicy(
  state: PlatformStateStore,
  owner: InstalledDriver | undefined,
  context: ProxyRevisionContext,
  sourceId: string,
): Promise<"withdrawn" | "pending" | "retire-runtime"> {
  const reducer = owner?.require("credential_proxy").policyReduction;
  if (!reducer || context.plan.policyReductionVersion !== reducer.version) {
    return "retire-runtime";
  }
  const { revision } = context;
  const prepared = await state.transact(async (unit) => {
    // Serialize all bindings of the recipient, including different withdrawal work items.
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
    const withdrawal = withdrawals.find((item) => item.credentialSourceId === sourceId);
    if (
      !agent ||
      agent.status !== "active" ||
      agent.desiredRuntimeState !== "running" ||
      agent.activeRevisionId !== revision.id ||
      !currentRevision ||
      !isDeepStrictEqual(currentRevision.egressPlan, context.plan) ||
      !installation ||
      !withdrawal ||
      !context.plan.driver ||
      !owner?.ownsProxyPlan(context.plan) ||
      !isReducedCredentialPlan(context.plan, installation.plan)
    ) {
      throw new Error("Credential policy reduction has no exact admitted owner or withdrawal.");
    }
    let recorded = withdrawal.policyReduction;
    if (recorded?.observed) {
      // A later reduction supersedes the old observation; inspect that operation's current
      // policy rather than treating an old receipt as a lease or reinstalling old routes.
      recorded =
        withdrawals
          .map((item) => item.policyReduction)
          .find((item) => item?.observed && isDeepStrictEqual(item.observed, installation)) ??
        recorded;
    }
    if (recorded) {
      return { recorded, dispatch: false };
    }
    if (withdrawals.some((item) => item.policyReduction && !item.policyReduction.observed)) {
      return undefined;
    }
    const routes = installation.plan.routes.filter(
      (route) => route.binding.source.source.id !== sourceId,
    );
    if (routes.length === installation.plan.routes.length) {
      throw new Error("Credential policy reduction does not remove an installed source.");
    }
    const next: CredentialPolicyReductionState = {
      request: {
        version: 1,
        operationId: randomUUID(),
        expected: installation,
        retained: { ...installation.plan, generation: installation.plan.generation + 1, routes },
      },
    };
    if (
      !(await unit.credentialSources.saveCredentialPolicyReduction(
        revision.namespaceId,
        revision.id,
        sourceId,
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
  const { recorded, dispatch } = prepared;
  const request = recorded.request;
  context.signal.throwIfAborted();
  if (dispatch) {
    // The committed operation consumes the sole dispatch opportunity. A lost response or
    // crash before sending is uncertainty, never permission to repeat an effect.
    await reducer.apply(context, request);
  }
  const observed = await reducer.observe(context, request);
  if (
    !observed ||
    observed.operationId !== request.operationId ||
    !isDeepStrictEqual(observed.installation.plan, request.retained) ||
    !sameRecipient(request.expected, observed.installation) ||
    observed.installation.plan.routes.some((route) => route.binding.source.source.id === sourceId)
  ) {
    return "pending";
  }
  return state.transact(async (unit) => {
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
        sourceId,
        recorded,
        { ...recorded, observed: observed.installation },
      )) ||
      !(await unit.credentialSources.reduceEgressInstallation(
        request.expected,
        observed.installation,
      ))
    ) {
      throw new Error("Credential policy reduction lost its installation fence.");
    }
    return "withdrawn";
  });
}
