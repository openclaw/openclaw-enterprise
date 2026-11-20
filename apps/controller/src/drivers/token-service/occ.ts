import { randomUUID } from "node:crypto";

import { SecretValue } from "@openclaw-enterprise/contracts";
import type {
  CredentialRefreshStatus,
  CredentialSourceReference,
  CredentialSourceType,
  ErrorDetail,
  InstallationSecretRef,
  InstallationSecretStore,
  JSONSchema,
  RegisteredTokenServiceSource,
  ResolvedCredential,
  SourceLifecycleConfig,
  SourceRefreshOperation,
  SourceRegistrationInput,
  SourceUpdate,
  TokenServiceDriver,
  TokenServiceRegistration,
  TokenServiceSourceInstance,
} from "@openclaw-enterprise/contracts";
import {
  ResourceStateConflictError,
  ScopeViolationError,
  TokenServiceRegistrationRefusedError,
  TokenServiceSourceInputError,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import { withoutMutationDeadline } from "../../admission/mutation-deadline.ts";
import { withComputeAbortSignal } from "../compute/operation-context.ts";

const openAiSourceType = Object.freeze({
  type: "openai",
  config: [],
  secrets: [{ name: "api_key", required: true }],
  rotation: "none",
  harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
} as const satisfies CredentialSourceType);

const maxSecretValueBytes: number = Reflect.get(SecretValue, "maxLength");

function checkLifecycle(config: SourceLifecycleConfig): void {
  if (config.type !== openAiSourceType.type || Object.keys(config.settings).length !== 0) {
    throw new TokenServiceSourceInputError("A static OpenAI source has no lifecycle settings.");
  }
}

function encodeCredential(secret: SourceRegistrationInput["secret"]): string {
  const value = secret.api_key;
  if (
    Object.keys(secret).length !== 1 ||
    !Object.hasOwn(secret, "api_key") ||
    !isNonEmptyString(value) ||
    value.includes("\0") ||
    !value.isWellFormed()
  ) {
    throw new TokenServiceSourceInputError("The source requires one nonempty UTF-8 api_key.");
  }
  const encoded = JSON.stringify({ credential: value, version: randomUUID() });
  if (Buffer.byteLength(encoded, "utf8") > maxSecretValueBytes) {
    throw new TokenServiceSourceInputError(
      "The encoded credential exceeds the Secret storage limit.",
    );
  }
  return encoded;
}

function decodeCredential(value: string): ResolvedCredential {
  let record: Record<string, unknown> | undefined;
  try {
    record = asRecord(JSON.parse(value));
  } catch {
    // Parsing failures must not expose a secret through an exception message.
  }
  if (!isNonEmptyString(record?.credential) || !isNonEmptyString(record?.version)) {
    throw new ResourceStateConflictError("The stored TokenService credential is invalid.");
  }
  return { credential: record.credential, version: record.version };
}

function validRegistration(registration: TokenServiceRegistration): boolean {
  return (
    registration.backendRef !== undefined &&
    Object.keys(registration.backendRef).length === 1 &&
    registration.backendRef.type === openAiSourceType.type
  );
}

function tokenServiceSecretRef(
  installationId: string,
  tokenServiceInstanceId: string,
  source: CredentialSourceReference,
): InstallationSecretRef {
  return {
    installationId,
    id: JSON.stringify([
      "token_service",
      tokenServiceInstanceId,
      source.kind,
      source.namespaceId,
      source.id,
    ]),
  };
}

export class OCCTokenServiceDriver implements TokenServiceDriver {
  static readonly configurationSchema: JSONSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  });

  static validateConfiguration(): readonly ErrorDetail[] {
    return [];
  }

  readonly capability = "token_service";
  readonly implementation = "occ/token-service";
  readonly id: string;
  private readonly installationId: string;
  private readonly store: InstallationSecretStore;
  private readonly tokenServiceInstanceId: string;

  constructor(
    id: string,
    installationId: string,
    store: InstallationSecretStore,
    tokenServiceInstanceId: string,
  ) {
    if (!isNonEmptyString(tokenServiceInstanceId)) {
      throw new ResourceStateConflictError("The TokenService instance identity is unavailable.");
    }
    this.id = id;
    this.installationId = installationId;
    this.store = store;
    this.tokenServiceInstanceId = tokenServiceInstanceId;
  }

  private ownedRef(source: TokenServiceSourceInstance): CredentialSourceReference {
    if (source.tokenServiceInstanceId !== this.tokenServiceInstanceId) {
      throw new ResourceStateConflictError("This source belongs to another TokenService instance.");
    }
    const ref = source.sourceRef;
    if (
      ref.kind !== "credential_source" ||
      !isNonEmptyString(ref.namespaceId) ||
      !isNonEmptyString(ref.id)
    ) {
      throw new ScopeViolationError("The OCC TokenService requires a Namespace source.");
    }
    return ref;
  }

  private registeredRef(source: RegisteredTokenServiceSource): CredentialSourceReference {
    const ref = this.ownedRef(source);
    if (!validRegistration(source.registration)) {
      throw new ResourceStateConflictError(
        "This registration does not belong to the OCC TokenService.",
      );
    }
    return ref;
  }

  private storageRef(ref: CredentialSourceReference): InstallationSecretRef {
    return tokenServiceSecretRef(this.installationId, this.tokenServiceInstanceId, ref);
  }

  async registerSource(
    input: SourceRegistrationInput,
    signal: AbortSignal,
  ): Promise<TokenServiceRegistration> {
    signal.throwIfAborted();
    let ref: CredentialSourceReference;
    let stored: string;
    try {
      ref = this.ownedRef(input);
      checkLifecycle(input.lifecycleConfig);
      stored = encodeCredential(input.secret);
    } catch (error) {
      if (error instanceof ScopeViolationError || error instanceof ResourceStateConflictError) {
        throw new TokenServiceRegistrationRefusedError(error.message);
      }
      throw error;
    }
    await withComputeAbortSignal(signal, () => this.store.create(this.storageRef(ref), stored));
    signal.throwIfAborted();
    return { backendRef: { type: openAiSourceType.type } };
  }

  async updateSource(
    source: RegisteredTokenServiceSource,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const ref = this.registeredRef(source);
    if (update.lifecycleConfig) {
      checkLifecycle(update.lifecycleConfig);
    }
    await withComputeAbortSignal(signal, () =>
      update.secret
        ? this.store.update(this.storageRef(ref), encodeCredential(update.secret))
        : this.store.withValue(this.storageRef(ref), async () => undefined),
    );
    signal.throwIfAborted();
  }

  async resolveCredential(
    source: RegisteredTokenServiceSource,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    signal.throwIfAborted();
    const ref = this.registeredRef(source);
    const resolved = await withComputeAbortSignal(signal, () =>
      this.store.withValue(this.storageRef(ref), async (value) => decodeCredential(value)),
    );
    signal.throwIfAborted();
    return resolved;
  }

  async forceRefresh(
    source: RegisteredTokenServiceSource<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation> {
    signal.throwIfAborted();
    this.registeredRef(source);
    throw new ResourceStateConflictError(
      "A static API key cannot be refreshed; update the source.",
    );
  }

  async getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus> {
    signal.throwIfAborted();
    this.ownedRef(operation);
    throw new ResourceStateConflictError("A static API key has no refresh operation.");
  }

  async removeSource(
    source: TokenServiceSourceInstance & { readonly registration?: TokenServiceRegistration },
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const ref = source.registration
      ? this.registeredRef({ ...source, registration: source.registration })
      : this.ownedRef(source);
    const stored = this.storageRef(ref);
    // Erase material before deletion; an installation Secret may remain terminating under a finalizer.
    await withoutMutationDeadline(() =>
      withComputeAbortSignal(signal, async () => {
        const tombstone = JSON.stringify({ removed: true });
        try {
          await this.store.update(stored, tombstone);
        } catch (updateError) {
          signal.throwIfAborted();
          try {
            await this.store.create(stored, tombstone);
          } catch {
            throw updateError;
          }
        }
        signal.throwIfAborted();
        await this.store.delete(stored);
      }),
    );
    signal.throwIfAborted();
  }
}
