import { hasControlCharacter } from "../credentials/client-contracts.ts";
import type {
  Backend,
  JSONSchema,
  RepositoryPolicyDriver,
  RepositoryBindingRequest,
  RepositoryCredentialResolution,
  RepositoryOption,
  RepositoryOptions,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import {
  githubInstallationProfile,
  resolveGitHubRepositoryBinding,
  resolveGitHubStandingApprovalScope,
  validateGitHubRepositoryRegistry,
  type GitHubRepositoryRegistry,
} from "./credentials/registry.ts";
import type { RepositoryCredentialControlClient } from "../../../backends/repository-credentials/control-client.ts";

/** Repository selection and approval policy, independent of credential transport. */
export class GitHubRepositoryPolicy implements RepositoryPolicyDriver {
  static readonly configurationSchema: JSONSchema = {
    type: "object",
    additionalProperties: false,
    required: ["sessionDurationSeconds"],
    properties: {
      sessionDurationSeconds: {
        type: "integer",
        minimum: 1,
        maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
      },
    },
  };
  static validateConfiguration(configuration: unknown): void {
    const value = configuration as Record<string, unknown> | null;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "sessionDurationSeconds") ||
      !Number.isSafeInteger(value.sessionDurationSeconds) ||
      (value.sessionDurationSeconds as number) < 1 ||
      (value.sessionDurationSeconds as number) > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ) {
      throw new Error("Repository policy configuration is invalid.");
    }
  }
  readonly capability = "repo" as const;
  readonly implementation = "github";
  readonly id: string;
  readonly #registry: GitHubRepositoryRegistry;
  readonly #duration: number;
  readonly #metadata: Pick<RepositoryCredentialControlClient, "descriptions"> | undefined;
  constructor(
    backend: Backend<Pick<RepositoryCredentialControlClient, "descriptions"> | undefined>,
    registry: GitHubRepositoryRegistry,
    options: { readonly sessionDurationSeconds: number },
  ) {
    const id = backend.drivers.repo;
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 512 || hasControlCharacter(id)) {
      throw new Error("The GitHub Backend must declare its repository policy Driver.");
    }
    this.id = id;
    this.#registry = validateGitHubRepositoryRegistry(registry, backend.id);
    if (
      !Number.isSafeInteger(options.sessionDurationSeconds) ||
      options.sessionDurationSeconds < 1 ||
      options.sessionDurationSeconds > registry.maximumDurationSeconds
    ) {
      throw new Error("Repository credential session duration exceeds the registry policy.");
    }
    this.#duration = options.sessionDurationSeconds;
    this.#metadata = backend.client;
  }
  async listOptions(input: {
    readonly namespaceId: string;
    readonly descriptionRefs?: readonly string[];
  }): Promise<RepositoryOptions> {
    const options: RepositoryOption[] = [];
    const approved = new Map<string, string>();
    this.#registry.repositories.forEach((repository) => {
      const policy = repository.namespaces.find(
        (candidate) => candidate.namespaceId === input.namespaceId,
      );
      if (policy === undefined) {
        return;
      }
      options.push(
        Object.freeze({
          repositoryRef: repository.repositoryRef,
          displayName: repository.repository,
          allowedProfiles: Object.freeze([...policy.profiles]),
        }),
      );
      approved.set(repository.repositoryRef, repository.repositoryId);
    });
    const installation = this.#registry.installationAccess;
    if (installation?.namespaces.some((policy) => policy.namespaceId === input.namespaceId)) {
      options.push(
        Object.freeze({
          repositoryRef: installation.repositoryRef,
          displayName: "All repositories and permissions available to this GitHub App installation",
          allowedProfiles: Object.freeze([githubInstallationProfile]),
        }),
      );
    }
    const descriptionRefs = (input.descriptionRefs ?? []).filter((ref) => approved.has(ref));
    if (descriptionRefs.length === 0 || !this.#metadata) {
      return Object.freeze({ options: Object.freeze(options), descriptionsPending: false });
    }
    try {
      // Descriptions are optional: the approved registry remains usable if metadata is unavailable.
      const metadata = await this.#metadata.descriptions(
        input.namespaceId,
        descriptionRefs,
        AbortSignal.timeout(2_000),
      );
      if (
        metadata.providerInstanceId !== this.#registry.providerInstanceId ||
        metadata.appId !== this.#registry.appId ||
        metadata.githubInstallationId !== this.#registry.githubInstallationId
      ) {
        throw new Error("unexpected-repository-provider");
      }
      const requested = new Set(descriptionRefs);
      const descriptions = new Map(
        metadata.descriptions
          .filter(
            (entry) =>
              requested.has(entry.repositoryRef) &&
              approved.get(entry.repositoryRef) === entry.repositoryId,
          )
          .map((entry) => [entry.repositoryRef, entry.description]),
      );
      return Object.freeze({
        options: Object.freeze(
          options.map((option) => {
            const description = descriptions.get(option.repositoryRef);
            return Object.freeze({
              ...option,
              ...(description === undefined ? {} : { description }),
            });
          }),
        ),
        descriptionsPending: metadata.pending,
      });
    } catch {
      return Object.freeze({ options: Object.freeze(options), descriptionsPending: false });
    }
  }

  standingApprovalScope(input: {
    namespaceId: string;
    binding: import("@openclaw-enterprise/contracts").AdmittedRepositoryBinding;
  }): import("@openclaw-enterprise/contracts").RepositoryApprovalScope | undefined {
    return resolveGitHubStandingApprovalScope(this.#registry, input);
  }

  allowsStandingApproval(input: {
    namespaceId: string;
    binding: import("@openclaw-enterprise/contracts").AdmittedRepositoryBinding;
  }): boolean {
    return this.standingApprovalScope(input) !== undefined;
  }

  resolve(input: {
    readonly namespaceId: string;
    readonly bindings: readonly RepositoryBindingRequest[];
  }): RepositoryCredentialResolution {
    try {
      if (
        !Array.isArray(input.bindings) ||
        input.bindings.length > 16 ||
        new Set(input.bindings.map((entry) => entry.repositoryRef)).size !== input.bindings.length
      ) {
        throw new Error("invalid-bindings");
      }
      return Object.freeze({
        bindings: Object.freeze(
          input.bindings.map((entry) =>
            resolveGitHubRepositoryBinding(this.#registry, {
              ...entry,
              namespaceId: input.namespaceId,
            }),
          ),
        ),
        sessionDurationSeconds: this.#duration,
      });
    } catch {
      throw new ScopeViolationError(
        "The requested repository bindings are not permitted for this Namespace.",
      );
    }
  }
}
