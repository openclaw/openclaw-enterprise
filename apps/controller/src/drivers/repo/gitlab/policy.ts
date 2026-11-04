import type {
  AdmittedRepositoryBinding,
  ErrorDetail,
  JSONSchema,
  RepositoryApprovalScope,
  RepositoryBindingRequest,
  RepositoryCredentialResolution,
  RepositoryOption,
  RepositoryOptions,
  RepositoryPolicyDriver,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import { hasControlCharacter } from "../credentials/client-contracts.ts";
import {
  resolveGitLabRepositoryBinding,
  resolveGitLabStandingApprovalScope,
  validateGitLabRepositoryRegistry,
  type GitLabRepositoryRegistry,
} from "./credentials/registry.ts";

/** Repository selection policy for GitLab.com projects, independent of credential transport. */
export class GitLabRepositoryPolicy implements RepositoryPolicyDriver {
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
  readonly implementation = "gitlab";
  readonly id: string;
  readonly #registry: GitLabRepositoryRegistry;
  readonly #duration: number;

  constructor(
    owner: { readonly driverId: string; readonly backendId: string },
    registry: GitLabRepositoryRegistry,
    options: { readonly sessionDurationSeconds: number },
  ) {
    const { driverId: id, backendId } = owner;
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 512 || hasControlCharacter(id)) {
      throw new Error("The GitLab Backend must declare its repository policy Driver.");
    }
    this.id = id;
    if (typeof backendId !== "string") {
      throw new Error("The GitLab repository policy must declare its owning Backend.");
    }
    this.#registry = validateGitLabRepositoryRegistry(registry, backendId);
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
    return this.listCatalog(input);
  }

  /** Provider catalog shared by the Installation picker and the Driver adapter. */
  async listCatalog(input: { readonly namespaceId: string }): Promise<RepositoryOptions> {
    const options: RepositoryOption[] = this.#registry.projects.flatMap((project) => {
      const policy = project.namespaces.find(
        (candidate) => candidate.namespaceId === input.namespaceId,
      );
      if (policy === undefined) {
        return [];
      }
      return [
        Object.freeze({
          repositoryRef: project.projectId,
          displayName: project.displayName ?? project.path,
          allowedProfiles: Object.freeze([...policy.profiles]),
        }),
      ];
    });
    return Object.freeze({ options: Object.freeze(options) });
  }

  standingApprovalScope(input: {
    namespaceId: string;
    binding: AdmittedRepositoryBinding;
  }): RepositoryApprovalScope | undefined {
    return resolveGitLabStandingApprovalScope(this.#registry, input);
  }

  allowsStandingApproval(input: {
    namespaceId: string;
    binding: AdmittedRepositoryBinding;
  }): boolean {
    return this.standingApprovalScope(input) !== undefined;
  }

  resolve(input: {
    readonly namespaceId: string;
    readonly bindings: readonly RepositoryBindingRequest[];
  }): RepositoryCredentialResolution {
    return this.resolveBindings(input);
  }

  resolveBindings(input: {
    readonly namespaceId: string;
    readonly bindings: readonly RepositoryBindingRequest[];
  }): RepositoryCredentialResolution {
    try {
      if (
        !Array.isArray(input.bindings) ||
        input.bindings.length === 0 ||
        input.bindings.length > 16 ||
        new Set(input.bindings.map((entry) => entry.repositoryRef)).size !== input.bindings.length
      ) {
        throw new Error("invalid-bindings");
      }
      return Object.freeze({
        bindings: Object.freeze(
          input.bindings.map((entry) =>
            resolveGitLabRepositoryBinding(this.#registry, {
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
