import type {
  JSONSchema,
  OpenRepositorySessionInput,
  OpenRepositorySessionResult,
  Backend,
  RepositoryBindingRequest,
  RepoDriver,
  RepositoryCredentialResolution,
  RepositoryCredentialSessionStatus,
  RepositoryOption,
  RepositoryOptions,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { isAbsolute, resolve } from "node:path";
import {
  RepositoryCredentialControlError,
  type RepositoryCredentialControlClient,
} from "../../../backends/repository-credentials/control-client.ts";
import {
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
  type GitHubRepositoryRegistry,
} from "./credentials/registry.ts";
import { encodeRepositoryCredentialSessionFiles } from "./credentials/client/config.ts";
import type { SessionStatus } from "../credentials/service-contracts.ts";
import { sameBinding } from "../credentials/sessions.ts";

function publicStatus(status: SessionStatus): RepositoryCredentialSessionStatus {
  return Object.freeze({
    sessionId: status.sessionId,
    state: status.state,
    deadlineWallMs: status.deadlineWallMs,
    binding: Object.freeze({
      providerInstanceId: status.binding.providerInstanceId,
      repositoryId: status.binding.repositoryId,
      grantId: status.binding.grantId,
    }),
  });
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export class GitHubRepoDriver implements RepoDriver {
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["controlSocket", "sessionDurationSeconds", "publicCaPath"],
    properties: {
      controlSocket: { type: "string", minLength: 1, maxLength: 103 },
      sessionDurationSeconds: {
        type: "integer",
        minimum: 1,
        maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
      },
      publicCaPath: { type: "string", minLength: 1 },
    },
  });

  static validateConfiguration(configuration: unknown): void {
    if (
      configuration === null ||
      typeof configuration !== "object" ||
      Array.isArray(configuration)
    ) {
      throw new Error("Repository credential Driver configuration is required.");
    }
    const value = configuration as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["controlSocket", "sessionDurationSeconds", "publicCaPath"].includes(key),
      ) ||
      typeof value.sessionDurationSeconds !== "number" ||
      !Number.isSafeInteger(value.sessionDurationSeconds) ||
      value.sessionDurationSeconds < 1 ||
      value.sessionDurationSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ) {
      throw new Error("Repository credential Driver configuration is invalid.");
    }
    for (const field of ["controlSocket", "publicCaPath"] as const) {
      const path = value[field];
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        resolve(path) !== path ||
        hasControlCharacters(path) ||
        (field === "controlSocket" && Buffer.byteLength(path) > 103)
      ) {
        throw new Error("Repository credential Driver paths must be absolute.");
      }
    }
  }

  readonly capability = "repo" as const;
  readonly implementation = "github";
  readonly maintenanceIntervalMs = 30_000;
  readonly durableBrokerReceipts = true as const;
  readonly id: string;
  readonly #backendId: string;
  readonly #registry: GitHubRepositoryRegistry;
  readonly #client: RepositoryCredentialControlClient;
  readonly #duration: number;
  readonly #publicCa: Uint8Array | undefined;

  constructor(
    backend: Backend<RepositoryCredentialControlClient>,
    registry: GitHubRepositoryRegistry,
    options: { readonly sessionDurationSeconds: number; readonly publicCa?: Uint8Array },
  ) {
    const id = backend.drivers.repo;
    if (
      typeof id !== "string" ||
      Buffer.byteLength(id) < 1 ||
      Buffer.byteLength(id) > 512 ||
      hasControlCharacters(id)
    ) {
      throw new Error("The GitHub Backend must declare its repository credential Driver.");
    }
    this.#registry = validateGitHubRepositoryRegistry(registry, backend.id);
    if (
      !Number.isSafeInteger(options.sessionDurationSeconds) ||
      options.sessionDurationSeconds < 1 ||
      options.sessionDurationSeconds > registry.maximumDurationSeconds
    ) {
      throw new Error("Repository credential session duration exceeds the registry policy.");
    }
    this.id = id;
    this.#backendId = backend.id;
    this.#client = backend.client;
    this.#duration = options.sessionDurationSeconds;
    if (options.publicCa !== undefined) {
      if (options.publicCa.byteLength === 0 || options.publicCa.byteLength > 64 * 1024) {
        throw new Error("Repository credential public CA is invalid.");
      }
      new TextDecoder("utf-8", { fatal: true }).decode(options.publicCa);
    }
    this.#publicCa = options.publicCa === undefined ? undefined : Uint8Array.from(options.publicCa);
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
    const descriptionRefs = (input.descriptionRefs ?? []).filter((ref) => approved.has(ref));
    if (descriptionRefs.length === 0) {
      return Object.freeze({ options: Object.freeze(options), descriptionsPending: false });
    }
    try {
      // Descriptions are optional: the approved registry remains usable if metadata is unavailable.
      const metadata = await this.#client.descriptions(
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

  async checkAdmissionReady(signal: AbortSignal): Promise<void> {
    await this.control(() => this.#client.checkAdmissionReady(signal));
  }

  async open(
    input: OpenRepositorySessionInput,
    signal: AbortSignal,
  ): Promise<OpenRepositorySessionResult> {
    if (input.recoverOnly !== true && input.binding.backendId !== this.#backendId) {
      throw new ScopeViolationError(
        "The repository binding does not belong to the selected Backend.",
      );
    }
    // Replay and cleanup must still reach retained correlation after local policy changes.
    const result = await this.control(() =>
      this.#client.open(
        {
          namespaceId: input.namespaceId,
          repositoryRef: input.binding.repositoryRef,
          expectedBinding: input.binding.grant,
          profile: input.binding.profile,
          durationSeconds: input.durationSeconds,
          deadlineWallMs: input.deadlineWallMs,
          durableAdmission: true,
          ...(input.recoverOnly === true ? { recoverOnly: true } : {}),
        },
        input.admissionId,
        signal,
      ),
    );
    if (result.kind === "missing") {
      return result;
    }
    const status = result.kind === "created" ? result.result.session : result.status;
    if (
      !sameBinding(status.binding, input.binding.grant) ||
      status.deadlineWallMs > input.deadlineWallMs ||
      (input.recoverOnly === true && result.kind === "created")
    ) {
      throw new DependencyUnavailableError(
        "Repository credential control returned an inconsistent session.",
      );
    }
    if (result.kind === "recovered") {
      return Object.freeze({ kind: "recovered", status: publicStatus(result.status) });
    }
    try {
      return Object.freeze({
        kind: "created",
        session: publicStatus(status),
        files: Object.freeze(encodeRepositoryCredentialSessionFiles(result.result, this.#publicCa)),
      });
    } catch {
      throw new DependencyUnavailableError("Repository credential client material is invalid.");
    }
  }

  async status(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialSessionStatus | undefined> {
    const status = await this.control(() => this.#client.status(sessionId, signal));
    return status === undefined ? undefined : publicStatus(status);
  }

  async close(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialSessionStatus | undefined> {
    const status = await this.control(() => this.#client.close(sessionId, signal));
    return status === undefined ? undefined : publicStatus(status);
  }

  private async control<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RepositoryCredentialControlError && !error.retryable) {
        throw new ScopeViolationError("The repository credential session request was rejected.");
      }
      throw new DependencyUnavailableError("Repository credential control is unavailable.");
    }
  }
}
