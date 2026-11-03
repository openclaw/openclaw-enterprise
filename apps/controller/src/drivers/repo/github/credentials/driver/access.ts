import type {
  Clock,
  CredentialRef,
  PrivateUpstreamRequest,
  RepositoryBackend,
  RequestPlan,
} from "../../../credentials/backend-contracts.ts";
import type { GitHubDriverState } from "./state.ts";

type AuthenticationDependencies = Readonly<{
  state: GitHubDriverState;
  clock: Clock;
}>;

function assertAuthenticationAllowed(
  { state, clock }: Pick<AuthenticationDependencies, "state" | "clock">,
  credential: CredentialRef,
  plan: RequestPlan,
): void {
  const record = state.credentials.get(credential);
  if (
    state.finalized ||
    !state.plans.has(plan) ||
    !record ||
    clock.wallNow() >= record.expiresAt ||
    clock.monotonicNow() - record.observedMono >= record.expiresAt - record.observedWall
  ) {
    throw new Error("invalid-credential");
  }
}

async function sendAuthenticated<T>(
  bytes: Uint8Array,
  plan: RequestPlan,
  send: (request: PrivateUpstreamRequest) => Promise<T>,
): Promise<T> {
  const copy = Buffer.from(bytes);
  const basic = plan.category.startsWith("git-")
    ? Buffer.concat([Buffer.from("x-access-token:"), copy])
    : undefined;
  try {
    const authorization = basic
      ? `Basic ${basic.toString("base64")}`
      : `Bearer ${copy.toString("utf8")}`;
    return await send(
      Object.freeze({
        plan,
        headers: Object.freeze({ ...plan.requestHeaders, authorization }),
      }),
    );
  } finally {
    basic?.fill(0);
    copy.fill(0);
  }
}

export function createCredentialAuthentication(
  deps: AuthenticationDependencies,
): RepositoryBackend["prepareAuthentication"] {
  return (credential, plan) => {
    assertAuthenticationAllowed(deps, credential, plan);
    let used = false;
    return async (bytes, send) => {
      if (used) {
        throw new Error("authentication-used");
      }
      used = true;
      return sendAuthenticated(bytes, plan, send);
    };
  };
}
