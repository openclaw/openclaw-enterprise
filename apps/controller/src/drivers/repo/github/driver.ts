import type { ErrorDetail } from "@openclaw-enterprise/contracts";
import type {
  JSONSchema,
  OpenRepositorySessionInput,
  OpenRepositorySessionResult,
  Backend,
  NativeRepositorySender,
  RepositoryCredentialSessionStatus,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { isAbsolute, resolve } from "node:path";
import {
  RepositoryCredentialControlError,
  type RepositoryCredentialControlClient,
} from "../../../backends/repository-credentials/control-client.ts";
import { isInstallationRepositoryProfile } from "@openclaw-enterprise/contracts";
import { encodeRepositoryCredentialSessionFiles } from "./credentials/client/config.ts";
import type { SessionStatus } from "../credentials/service-contracts.ts";
import { sameBinding } from "../credentials/grant-identity.ts";
import { hasControlCharacter } from "../credentials/client-contracts.ts";

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

export class GitHubNativeRepositorySender implements NativeRepositorySender {
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["sessionDurationSeconds", "controlSocket", "publicCaPath"],
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

  static validateConfiguration(
    configuration: Readonly<Record<string, unknown>>,
  ): readonly ErrorDetail[] {
    for (const field of ["controlSocket", "publicCaPath"] as const) {
      const path = configuration[field];
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        resolve(path) !== path ||
        hasControlCharacter(path) ||
        (field === "controlSocket" && Buffer.byteLength(path) > 103)
      ) {
        return [
          {
            path: "",
            code: "INVALID_VALUE",
            message: "Configuration violates the Driver's constraints.",
          },
        ];
      }
    }
    return [];
  }

  readonly id: string;
  readonly implementation = "github";
  readonly maintenanceIntervalMs = 30_000;
  readonly durableBrokerReceipts = true;
  readonly checkAdmissionReady: (signal: AbortSignal) => Promise<void>;
  readonly #backendId: string;
  readonly #client: RepositoryCredentialControlClient;
  readonly #publicCa: Uint8Array | undefined;

  constructor(
    backend: Backend<RepositoryCredentialControlClient | undefined>,
    options: { readonly publicCa?: Uint8Array },
  ) {
    const id = backend.drivers.repo;
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 512 || hasControlCharacter(id)) {
      throw new Error("Native repository sender requires its exact policy owner identity.");
    }
    this.id = id;
    if (!backend.client) {
      throw new Error("Native repository sender requires a broker client.");
    }
    this.#backendId = backend.id;
    const client = backend.client;
    this.#client = client;
    this.checkAdmissionReady = (signal) => this.control(() => client.checkAdmissionReady(signal));
    if (options.publicCa !== undefined) {
      if (options.publicCa.byteLength === 0 || options.publicCa.byteLength > 64 * 1024) {
        throw new Error("Repository credential public CA is invalid.");
      }
      new TextDecoder("utf-8", { fatal: true }).decode(options.publicCa);
    }
    this.#publicCa = options.publicCa === undefined ? undefined : Uint8Array.from(options.publicCa);
  }

  async open(
    input: OpenRepositorySessionInput,
    signal: AbortSignal,
  ): Promise<OpenRepositorySessionResult> {
    if (isInstallationRepositoryProfile(input.binding.profile)) {
      throw new ScopeViolationError(
        "GitHub installation access requires the protected Credential Proxy.",
      );
    }
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
          ...(input.recoverOnly !== true || input.preparedOnly === true
            ? { preparedOnly: true as const }
            : {}),
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
