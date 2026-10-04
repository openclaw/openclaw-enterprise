import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { Denied } from "../../credentials/backend-contracts.ts";
import { sameBinding } from "../../credentials/sessions.ts";
import { createGitHubDriverFactory } from "./factory.ts";
import { resolveGitHubRepositoryBinding, validateGitHubRepositoryRegistry } from "./registry.ts";
import type { GitHubRepositoryRegistry, GitHubRepositoryRegistration } from "./registry.ts";
import type { GitHubDriverFactory, GitHubFactoryOptions, GitHubProfile } from "./types.ts";

type RegistryFactoryOptions = Omit<GitHubFactoryOptions, "configuration" | "binding"> &
  Readonly<{
    registry: GitHubRepositoryRegistry;
    privateKeyFile: string;
  }>;

const identityKey = (binding: RepositoryCredentialGrantIdentity) =>
  JSON.stringify([binding.providerInstanceId, binding.repositoryId, binding.grantId]);

/** Registry admission and routing share the same immutable configured repository set. */
export function createGitHubRegistryDriverFactory(
  options: RegistryFactoryOptions,
): GitHubDriverFactory {
  // The registry is the production path; only a GitHub App authority may back it.
  if (options.authority?.kind !== "github-app") {
    throw new Error("invalid-configuration");
  }
  const registry = validateGitHubRepositoryRegistry(options.registry);
  const grants = new Map<
    string,
    Readonly<{
      repository: GitHubRepositoryRegistration;
      profile: GitHubProfile;
      identity: RepositoryCredentialGrantIdentity;
      pushRefAllowlist?: readonly string[];
    }>
  >();
  const factories = new Map<string, GitHubDriverFactory>();
  for (const repository of registry.repositories) {
    for (const policy of repository.namespaces) {
      for (const profile of policy.profiles) {
        const { grant } = resolveGitHubRepositoryBinding(registry, {
          namespaceId: policy.namespaceId,
          repositoryRef: repository.repositoryRef,
          profile,
        });
        grants.set(identityKey(grant), {
          repository,
          profile,
          identity: grant,
          ...(policy.pushRefAllowlist === undefined
            ? {}
            : { pushRefAllowlist: policy.pushRefAllowlist }),
        });
      }
    }
  }
  const factoryFor = (identity: RepositoryCredentialGrantIdentity) => {
    const key = identityKey(identity);
    const grant = grants.get(key);
    if (!grant) {
      throw new Error("INVALID_BINDING");
    }
    let factory = factories.get(key);
    if (!factory) {
      factory = createGitHubDriverFactory({
        authority: options.authority,
        gatewayOrigin: options.gatewayOrigin,
        limits: options.limits,
        clock: options.clock,
        ...(options.trustedEndpoints === undefined
          ? {}
          : { trustedEndpoints: options.trustedEndpoints }),
        binding: {
          profile: grant.profile,
          identity: grant.identity,
          ...(grant.pushRefAllowlist === undefined
            ? {}
            : { pushRefAllowlist: grant.pushRefAllowlist }),
        },
        configuration: {
          kind: "github-app",
          providerInstanceId: registry.providerInstanceId,
          configVersion: "registry",
          appId: registry.appId,
          installationId: registry.githubInstallationId,
          repositoryId: grant.repository.repositoryId,
          repository: grant.repository.repository,
          privateKeyFile: options.privateKeyFile,
        },
      });
      factories.set(key, factory);
    }
    return factory;
  };
  // Authentication syntax is selected across every configured repository; final
  // routing still belongs to the exact bearer session's profile-pinned backend.
  const authentication = registry.repositories.map((repository) => {
    const policy = repository.namespaces[0]!;
    const { grant } = resolveGitHubRepositoryBinding(registry, {
      namespaceId: policy.namespaceId,
      repositoryRef: repository.repositoryRef,
      profile: policy.profiles[0]!,
    });
    return factoryFor(grant);
  });
  const denied: Denied = Object.freeze({ kind: "denied", status: 401, code: "invalid-credential" });
  return Object.freeze<GitHubDriverFactory>({
    trustedUpstreamOrigins: new Set(
      authentication.flatMap((factory) => [...factory.trustedUpstreamOrigins]),
    ),
    resolve() {
      throw new Error("BOUND_SESSION_REQUIRED");
    },
    resolveBound(input) {
      let binding;
      try {
        binding = resolveGitHubRepositoryBinding(registry, {
          namespaceId: input.namespaceId,
          repositoryRef: input.repositoryRef,
          profile: input.profile,
        });
      } catch {
        throw new Error("INVALID_BINDING");
      }
      if (!sameBinding(binding.grant, input.expectedBinding)) {
        throw new Error("INVALID_BINDING");
      }
      if (input.durationSeconds > registry.maximumDurationSeconds) {
        throw new Error("INVALID_DURATION");
      }
      return factoryFor(binding.grant).resolve(binding.profile);
    },
    create(input) {
      return factoryFor(input.authority).create(input);
    },
    parseAuthentication(head, authorization) {
      const selected = authentication.find(
        (factory) => factory.unauthenticated(head).kind === "challenge",
      );
      return (selected ?? authentication[0]!).parseAuthentication(head, authorization);
    },
    unauthenticated(head) {
      for (const factory of authentication) {
        const result = factory.unauthenticated(head);
        if (result.kind === "challenge") {
          return result;
        }
      }
      return denied;
    },
  });
}
