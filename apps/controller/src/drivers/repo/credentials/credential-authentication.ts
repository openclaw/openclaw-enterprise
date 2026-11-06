import type {
  Clock,
  CredentialRef,
  PrivateUpstreamRequest,
  RepositoryBackend,
  RequestPlan,
} from "./backend-contracts.ts";
import type { RepositoryDriverState } from "./driver-state.ts";

type AuthenticationDependencies = Readonly<{
  state: RepositoryDriverState;
  clock: Clock;
  apiAuthentication: "bearer" | "private-token";
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
  apiAuthentication: AuthenticationDependencies["apiAuthentication"],
): Promise<T> {
  const copy = Buffer.from(bytes);
  const basic = plan.category.startsWith("git-")
    ? Buffer.concat([Buffer.from("x-access-token:"), copy])
    : undefined;
  const bearer = basic === undefined && plan.category === "api" && apiAuthentication === "bearer";
  try {
    const authorization = basic
      ? `Basic ${basic.toString("base64")}`
      : bearer
        ? `Bearer ${copy.toString("utf8")}`
        : undefined;
    const privateToken =
      basic === undefined && plan.category === "api" && apiAuthentication === "private-token"
        ? copy.toString("utf8")
        : undefined;
    return await send(
      Object.freeze({
        plan,
        headers: Object.freeze({
          ...plan.requestHeaders,
          ...(authorization === undefined ? {} : { authorization }),
          ...(privateToken === undefined ? {} : { "private-token": privateToken }),
        }),
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
      return sendAuthenticated(bytes, plan, send, deps.apiAuthentication);
    };
  };
}
