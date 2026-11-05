import type {
  AcquireOutcome,
  AttemptContext,
  AuthorityIdentity,
  CredentialRef,
  DriverCustody,
  FinalizeOutcome,
  OriginalOutcome,
  RequestPlan,
  RepositoryBackend,
  RetireOutcome,
} from "../../../credentials/backend-contracts.ts";
import type { RoutePolicy } from "../routes.ts";

type OutcomePayload<T> = T extends OriginalOutcome ? Omit<T, keyof OriginalOutcome> : never;
type ProviderOutcomePayload = OutcomePayload<AcquireOutcome | RetireOutcome | FinalizeOutcome>;

type DriverStateDependencies = Readonly<{
  authority: AuthorityIdentity;
  custody: DriverCustody;
  routes: RoutePolicy;
}>;

export function sameAuthority(a: AuthorityIdentity, b: AuthorityIdentity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.providerInstanceId === b.providerInstanceId &&
    a.repositoryId === b.repositoryId &&
    a.grantId === b.grantId
  );
}

interface CredentialRecord {
  expiresAt: number;
  observedWall: number;
  observedMono: number;
}

export interface GitHubDriverState extends Pick<RepositoryBackend, "finalize" | "settle" | "plan"> {
  readonly credentials: WeakMap<CredentialRef, CredentialRecord>;
  readonly plans: WeakSet<RequestPlan>;
  readonly finalized: boolean;
  admit(attempt: AttemptContext, action: AttemptContext["action"]): void;
  outcome<T extends ProviderOutcomePayload>(
    attempt: AttemptContext,
    value: T,
  ): Readonly<T> & OriginalOutcome;
}

export function createGitHubDriverState({
  authority,
  custody,
  routes,
}: DriverStateDependencies): GitHubDriverState {
  const plans = new WeakSet<RequestPlan>();
  const credentials = new WeakMap<CredentialRef, CredentialRecord>();
  const unsettledOutcomes = new WeakSet<object>();
  const admittedAttempts = new WeakSet<AttemptContext>();
  let finalized = false;
  function admit(attempt: AttemptContext, action: AttemptContext["action"]) {
    custody.assertAttempt(attempt, action);
    if (
      !sameAuthority(attempt.authority, authority) ||
      attempt.action !== action ||
      admittedAttempts.has(attempt)
    ) {
      throw new Error("foreign-attempt");
    }
    admittedAttempts.add(attempt);
  }
  function outcome<T extends ProviderOutcomePayload>(
    attempt: AttemptContext,
    value: T,
  ): Readonly<T> & OriginalOutcome {
    const result = Object.freeze({ ...value, attemptId: attempt.id }) as Readonly<T> &
      OriginalOutcome;
    unsettledOutcomes.add(result);
    return result;
  }
  return {
    credentials,
    plans,
    admit,
    outcome,
    get finalized() {
      return finalized;
    },
    async finalize(attempt): Promise<FinalizeOutcome> {
      admit(attempt, "finalize");
      try {
        attempt.assertAdmitted();
        finalized = true;
        return outcome(attempt, { kind: "finalized" });
      } catch {
        return outcome(attempt, { kind: "cleanup-pending", reason: "not-dispatched" });
      }
    },
    async settle(original) {
      if (!unsettledOutcomes.has(original)) {
        throw new Error("foreign-outcome");
      }
      unsettledOutcomes.delete(original);
    },
    plan(request) {
      if (finalized || !sameAuthority(request.authority, authority)) {
        return Object.freeze({ kind: "denied" as const, status: 403, code: "invalid-binding" });
      }
      const plan = routes.plan(request.head);
      if (!("kind" in plan)) {
        plans.add(plan);
      }
      return plan;
    },
  };
}
