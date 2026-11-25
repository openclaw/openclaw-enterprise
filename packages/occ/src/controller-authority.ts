import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Agent,
  AuthorizationDecision,
  AuthorizationRequest,
  IAMDriver,
  ResourceRef,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  AgentPrincipalAuthorizationError,
  AuthorizationDeniedError,
  CallerStateDeniedError,
  DependencyUnavailableError,
} from "./errors.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

/** Holds the caller's authority in a unit of work; throws when it is no longer current. */
export type AuthorityFence = (state: PlatformUnitOfWork) => Promise<void>;

export interface AuthorizationSnapshot {
  readonly request: Readonly<AuthorizationRequest>;
  readonly decision: Readonly<AuthorizationDecision>;
}

/**
 * A resource to authorize. For an `agent_revision`, OCC also names the Agent that owns it, taken
 * from stored state or from the route whose later lookups are scoped to that Agent; IAM then
 * applies that Agent's exact bindings to the revision (RFC-0026).
 */
export type AuthorizationTarget = ResourceRef & { readonly parentAgentId?: string };

function authorizationResource({ kind, id, namespaceId }: AuthorizationTarget): ResourceRef {
  return namespaceId === undefined ? { kind, id } : { kind, id, namespaceId };
}

/**
 * The Agent that owns the target. A sandbox policy's ID derives from its Agent's ID, which the
 * database enforces (migration 0058), so OCC supplies its parent without a lookup.
 */
function authorizationParentAgentId(target: AuthorizationTarget): string | undefined {
  if (target.kind === "agent_revision") {
    return target.parentAgentId;
  }
  if (target.kind === "sandbox_policy" && /^sbp_[0-9a-f-]{36}$/.test(target.id)) {
    return `agt_${target.id.slice(4)}`;
  }
  return undefined;
}

function snapshotIds(entries: unknown): readonly string[] | undefined {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const result: string[] = [];
  const length = entries.length;
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(entries, index)) {
      return undefined;
    }
    const id: unknown = entries[index];
    if (!isNonEmptyString(id)) {
      return undefined;
    }
    result.push(id);
  }
  return Object.freeze(result);
}

function snapshotDecision(decision: AuthorizationDecision): Readonly<AuthorizationDecision> {
  const allowed = decision?.allowed;
  const reason = decision?.reason;
  const driverId = decision?.driverId;
  const evidence = decision?.evidence;
  const identityId = evidence?.identityId;
  const groupIds = snapshotIds(evidence?.groupIds);
  const bindingIds = snapshotIds(evidence?.bindingIds);
  const roleIds = snapshotIds(evidence?.roleIds);
  const restrictionIds = snapshotIds(evidence?.restrictionIds);
  if (
    typeof allowed !== "boolean" ||
    typeof reason !== "string" ||
    !isNonEmptyString(driverId) ||
    !evidence ||
    (identityId !== undefined && !isNonEmptyString(identityId)) ||
    !groupIds ||
    !bindingIds ||
    !roleIds ||
    !restrictionIds
  ) {
    throw new DependencyUnavailableError(
      "The selected authorization Driver returned an invalid decision.",
    );
  }
  return Object.freeze({
    allowed,
    reason,
    driverId,
    evidence: Object.freeze({
      ...(identityId === undefined ? {} : { identityId }),
      groupIds,
      bindingIds,
      roleIds,
      restrictionIds,
    }),
  });
}

export type ControllerAuthorizationOverride = (
  request: AuthorizationRequest,
) => AuthorizationDecision | Promise<AuthorizationDecision>;

interface ControllerAuthorityDependencies {
  readonly selectedIAM: () => IAMDriver;
  readonly authorizeOverride: ControllerAuthorizationOverride | undefined;
}

export function createControllerAuthority({
  selectedIAM,
  authorizeOverride,
}: ControllerAuthorityDependencies) {
  const authorityFence = new AsyncLocalStorage<AuthorityFence>();

  function authorizationAuthority(principalId: string): IAMDriver {
    if (!isNonEmptyString(principalId)) {
      throw new CallerStateDeniedError("The acting identity is unavailable.");
    }
    try {
      return selectedIAM();
    } catch {
      throw new DependencyUnavailableError("The selected authorization Driver is unavailable.");
    }
  }

  async function authorizationDecision(
    principalId: string,
    action: AuthorizationRequest["action"],
    target: AuthorizationTarget,
    selected: IAMDriver = authorizationAuthority(principalId),
    driverAuthorize?: IAMDriver["authorize"],
  ): Promise<Readonly<AuthorizationSnapshot>> {
    const parentAgentId = authorizationParentAgentId(target);
    const request: AuthorizationRequest = Object.freeze({
      principalId,
      action,
      resource: Object.freeze(authorizationResource(target)),
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
    });
    let decision: AuthorizationDecision;
    try {
      decision = authorizeOverride
        ? await authorizeOverride(request)
        : await Reflect.apply(driverAuthorize ?? selected.authorize, selected, [request]);
    } catch {
      throw new DependencyUnavailableError(
        "The selected authorization Driver could not verify the operation.",
      );
    }
    const snapshot = snapshotDecision(decision);
    if (snapshot.driverId !== selected.id || authorizationAuthority(principalId) !== selected) {
      throw new DependencyUnavailableError("The authorization decision belongs to another Driver.");
    }
    return Object.freeze({ request, decision: snapshot });
  }

  async function authorize(
    principalId: string,
    action: AuthorizationRequest["action"],
    target: AuthorizationTarget,
    selected?: IAMDriver,
    driverAuthorize?: IAMDriver["authorize"],
  ): Promise<Readonly<AuthorizationSnapshot>> {
    const authorization = await authorizationDecision(
      principalId,
      action,
      target,
      selected,
      driverAuthorize,
    );
    if (!authorization.decision.allowed) {
      throw new AuthorizationDeniedError(
        isNonEmptyString(authorization.decision.reason)
          ? authorization.decision.reason
          : "The exact operation was denied.",
        authorization.decision.evidence,
        { action, resource: authorizationResource(target) },
        principalId,
      );
    }
    return authorization;
  }

  /**
   * Authorizes an Agent's own service principal and names it and the grant when denied. The
   * resource comes from the Agent's stored bindings, so the denial records whether the caller
   * may read both it and the Agent: HTTP names it only then, or when the request sent its ID
   * (finding 2592). Secret read alone does not show that this Agent uses the Secret; the binding
   * is part of the Agent record.
   */
  async function authorizeAgentPrincipal(
    callerId: string,
    agent: Pick<Agent, "id" | "namespaceId" | "servicePrincipalId">,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<void> {
    try {
      await authorize(agent.servicePrincipalId, action, resource);
    } catch (error) {
      if (
        error instanceof AuthorizationDeniedError &&
        !(error instanceof DependencyUnavailableError)
      ) {
        // An outage while checking the caller's reads only hides the ID.
        const callerMayReadResource =
          (await canRead(callerId, {
            kind: "agent",
            id: agent.id,
            namespaceId: agent.namespaceId,
          }).catch(() => false)) && (await canRead(callerId, resource).catch(() => false));
        throw new AgentPrincipalAuthorizationError(
          agent.servicePrincipalId,
          action,
          resource,
          error.evidence,
          { agentId: agent.id, callerMayReadResource },
        );
      }
      throw error;
    }
  }

  async function readableListRows<Row extends { readonly id: string }>(
    principalId: string,
    namespaceId: string,
    kind: "agent" | "service_account" | "preset",
    rows: readonly Row[],
  ): Promise<readonly Row[]> {
    const readable: Row[] = [];
    for (const row of rows) {
      if (await canRead(principalId, { kind, id: row.id, namespaceId })) {
        readable.push(row);
      }
    }
    return Object.freeze(readable);
  }

  async function canRead(principalId: string, target: AuthorizationTarget): Promise<boolean> {
    return (await authorizationDecision(principalId, "read", target)).decision.allowed;
  }

  function withAuthorityFence<T>(fence: AuthorityFence, work: () => Promise<T>): Promise<T> {
    return authorityFence.run(fence, work);
  }

  /**
   * Fences a transaction that writes durable authority (an Owner binding or deploy-time grants)
   * before it authorizes. It applies the caller's session fence, if any, then holds the IAM
   * configuration lock shared. Applying a changed `iam` configuration takes that lock
   * exclusively, so it commits either before this, and the authorization below sees it, or
   * after this COMMIT.
   */
  async function holdAuthority(state: PlatformUnitOfWork): Promise<void> {
    await authorityFence.getStore()?.(state);
    await state.installations.holdIAMConfiguration("shared");
  }

  return {
    authorizationAuthority,
    authorizationDecision,
    authorize,
    authorizeAgentPrincipal,
    readableListRows,
    canRead,
    withAuthorityFence,
    holdAuthority,
  };
}

export type ControllerAuthority = ReturnType<typeof createControllerAuthority>;
