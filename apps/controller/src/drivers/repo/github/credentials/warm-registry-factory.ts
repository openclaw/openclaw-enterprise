import type { PreparedGitHubPullScope } from "@openclaw-enterprise/contracts";
import type {
  RequestPlan,
  PreparedRepositoryBackend,
  BoundPreparedRepositoryBackendFactory,
  ResolvedGrant,
} from "../../credentials/backend-contracts.ts";
import { sameBinding } from "../../credentials/sessions.ts";
import { githubProviderOrigin } from "./origin.ts";
import { createGatewayAuthentication } from "./gateway-authentication.ts";
import { resolveGitHubRepositoryBinding, validateGitHubRepositoryRegistry } from "./registry.ts";
import type { GitHubRepositoryRegistry } from "./registry.ts";
import { createRoutePolicy } from "./routes.ts";
import type { GitHubFactoryOptions } from "./types.ts";
import { planDraftPull } from "./prepared-draft-pull.ts";
import { authorizePreparedGitSend } from "./warm-use.ts";

type Options = Pick<GitHubFactoryOptions, "clock" | "limits" | "gatewayOrigin"> &
  Readonly<{
    registry: GitHubRepositoryRegistry;
    socketPath: string;
    gitOrigin?: string;
    apiOrigin?: string;
  }>;

/** Each exchange requires prepared material. Only an explicit draft grant adds the bounded create operation. */
export function createPreparedGitHubRegistryFactory(
  options: Options,
): BoundPreparedRepositoryBackendFactory & { trustedUpstreamOrigins: ReadonlySet<string> } {
  const registry = validateGitHubRepositoryRegistry(options.registry);
  const { socketPath, clock, limits } = options;
  const gitOrigin = githubProviderOrigin(options.gitOrigin ?? "https://github.com");
  const apiOrigin = githubProviderOrigin(options.apiOrigin ?? "https://api.github.com");
  const gatewayOrigin = githubProviderOrigin(options.gatewayOrigin);
  const entries = registry.repositories.flatMap(({ repository, repositoryRef, namespaces }) =>
    namespaces.map((policy) => {
      const [pushRef] = policy.pushRefAllowlist ?? [];
      const base = policy.transport === "git-and-draft-pr" ? policy.pullRequestBase : undefined;
      if (
        (policy.transport !== "git-only" && !base) ||
        policy.profiles[0] !== "git-write" ||
        !pushRef?.startsWith("refs/heads/") ||
        pushRef.includes("*") ||
        policy.pushRefAllowlist?.length !== 1
      ) {
        throw new Error("expected-exact-prepared-git-grant");
      }
      const profile = "git-write";
      const { namespaceId } = policy;
      const pushRefAllowlist = Object.freeze([pushRef]);
      const { grant } = resolveGitHubRepositoryBinding(registry, {
        namespaceId,
        repositoryRef,
        profile,
      });
      const route = createRoutePolicy({
        profile: "git-ref-write",
        pushRefAllowlist,
        repository,
        repositoryId: grant.repositoryId,
        gatewayOrigin,
        gitOrigin,
        apiOrigin: gitOrigin,
        limits,
      });
      const client = Object.freeze({
        repository,
        gatewayOrigin,
        gitRemote: gatewayOrigin + "/" + repository + ".git",
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: new URL(gatewayOrigin).hostname,
        pushRefAllowlist,
      });
      const pull = base
        ? {
            repository,
            repositoryId: grant.repositoryId,
            apiOrigin,
            head: pushRef.slice("refs/heads/".length),
            base,
          }
        : undefined;
      return { grant, route, client, namespaceId, repositoryRef, pushRef, profile, pull };
    }),
  );
  const selections = new WeakMap<ResolvedGrant, (typeof entries)[number]>();
  return Object.freeze<
    BoundPreparedRepositoryBackendFactory & { trustedUpstreamOrigins: ReadonlySet<string> }
  >({
    trustedUpstreamOrigins: new Set([
      gitOrigin,
      ...(entries.some((e) => e.pull) ? [apiOrigin] : []),
    ]),
    ...createGatewayAuthentication({
      isGitRoute: (head) => entries.some(({ route }) => !!route.route(head)),
    }),
    resolveBound(input) {
      const matches = entries.filter(
        ({ grant, namespaceId, repositoryRef, profile }) =>
          sameBinding(grant, input.expectedBinding) &&
          input.namespaceId === namespaceId &&
          input.repositoryRef === repositoryRef &&
          input.profile === profile,
      );
      if (matches.length !== 1) {
        throw new Error("INVALID_BINDING");
      }
      if (input.durationSeconds > registry.maximumDurationSeconds) {
        throw new Error("INVALID_DURATION");
      }
      const entry = matches[0]!;
      const selection = Object.freeze({ binding: entry.grant, client: entry.client });
      selections.set(selection, entry);
      return selection;
    },
    createPrepared(authority, selection) {
      const entry = selections.get(selection);
      if (!entry || !sameBinding(entry.grant, authority) || !authority.sessionId) {
        throw new Error("INVALID_BINDING");
      }
      selections.delete(selection);
      const { grant: binding, pushRef, route } = entry;
      const pulls = new WeakMap<RequestPlan, PreparedGitHubPullScope>();
      return Object.freeze<PreparedRepositoryBackend>({
        binding,
        plan({ head }) {
          if (entry.pull && head.rawTarget.startsWith("/repos/")) {
            return planDraftPull(head, entry.pull, (p, scope) => pulls.set(p, scope));
          }
          const plan = route.plan(head);
          if ("kind" in plan) {
            return plan;
          }
          if (plan.category === "api" || (plan.category === "git-push" && !plan.inputPolicy)) {
            return { kind: "denied", status: 400, code: "unsupported-request" };
          }
          // Unlike the ordinary streaming upload-pack path, authorize only after the
          // whole bounded body is available. Receive-pack's exact-ref policy runs there too.
          return Object.freeze({
            ...plan,
            bindRequestDigest: true,
            ...(plan.category === "git-fetch" ? { inputPolicy: () => true } : {}),
          });
        },
        authorize(plan, requestDigestSha256, bounds) {
          const pull = pulls.get(plan);
          const operation = pull
            ? "create-draft-pull"
            : plan.category === "git-discovery"
              ? plan.effect === "write"
                ? "advertise-receive-pack"
                : "advertise-upload-pack"
              : plan.effect === "write"
                ? "receive-pack"
                : "upload-pack";
          return authorizePreparedGitSend(
            socketPath,
            clock,
            {
              ...authority,
              operation,
              pushRef,
              ...(pull ? { pull } : {}),
              requestDigestSha256,
            },
            plan.requestHeaders,
            bounds,
          );
        },
      });
    },
  });
}
