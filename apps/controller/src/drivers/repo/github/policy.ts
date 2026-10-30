import { hasControlCharacter } from "../credentials/client-contracts.ts";
import type {
  ErrorDetail,
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
  static validateConfiguration(configuration: unknown): readonly ErrorDetail[] {
    const value = configuration;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "sessionDurationSeconds") ||
      !("sessionDurationSeconds" in value) ||
      typeof value.sessionDurationSeconds !== "number" ||
      !Number.isSafeInteger(value.sessionDurationSeconds) ||
      value.sessionDurationSeconds < 1 ||
      value.sessionDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ) {
      return [
        {
          path: "",
          code: "INVALID_VALUE",
          message: "Repository policy configuration is invalid.",
        },
      ];
    }
    return [];
  }
  readonly capability = "repo" as const;
  readonly implementation = "github";
  readonly id: string;
  readonly #registry: GitHubRepositoryRegistry;
  readonly #duration: number;
  constructor(
    owner: { readonly driverId: string; readonly backendId: string },
    registry: GitHubRepositoryRegistry,
    options: { readonly sessionDurationSeconds: number },
  ) {
    const { driverId: id, backendId } = owner;
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 512 || hasControlCharacter(id)) {
      throw new Error("The GitHub Backend must declare its repository policy Driver.");
    }
    this.id = id;
    if (typeof backendId !== "string") {
      throw new Error("The GitHub repository policy must declare its owning Backend.");
    }
    this.#registry = validateGitHubRepositoryRegistry(registry, backendId);
    if (
      !Number.isSafeInteger(options.sessionDurationSeconds) ||
      options.sessionDurationSeconds < 1 ||
      options.sessionDurationSeconds > registry.maximumDurationSeconds
    ) {
      throw new Error("Repository credential session duration exceeds the registry policy.");
    }
    this.#duration = options.sessionDurationSeconds;
  }
  async listOptions(input: { readonly namespaceId: string }): Promise<RepositoryOptions> {
    const options: RepositoryOption[] = [];
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
    return Object.freeze({ options: Object.freeze(options) });
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
