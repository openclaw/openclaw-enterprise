import { randomUUID } from "node:crypto";

import { isName, SecretValue } from "@openclaw-enterprise/contracts";
import type {
  AccessBinding,
  CredentialRefreshStatus,
  CredentialProxyDriver,
  CredentialSource,
  CredentialSourceReference,
  ErrorDetail,
  InstallationSecretRef,
  InstallationSecretStore,
  JSONSchema,
  ResolvedCredential,
  SourceLifecycleConfig,
  SourceRefreshOperation,
  SourceRegistrationInput,
  SourceUpdate,
  TokenServiceDriver,
  TokenServiceSourceInstance,
} from "@openclaw-enterprise/contracts";
import {
  ResourceStateConflictError,
  CredentialDeliveryFailedError,
  ScopeViolationError,
  TokenServiceSourceInputError,
} from "@openclaw-enterprise/occ";
import type { PlatformStateStore } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import { withoutMutationDeadline } from "../../admission/mutation-deadline.ts";
import { withComputeAbortSignal } from "../compute/operation-context.ts";

const maxSecretValueBytes: number = Reflect.get(SecretValue, "maxLength");

function checkLifecycle(config: SourceLifecycleConfig): void {
  if (config.type !== "static" || Object.keys(config.settings).length !== 0) {
    throw new TokenServiceSourceInputError("A static source has no lifecycle settings.");
  }
}

function encodeCredential(secret: SourceRegistrationInput["secret"]): {
  stored: string;
  version: string;
} {
  const fields = Object.values(secret);
  const value = fields[0];
  if (
    fields.length !== 1 ||
    !isNonEmptyString(value) ||
    value.includes("\0") ||
    !value.isWellFormed()
  ) {
    throw new TokenServiceSourceInputError(
      "A static source requires one nonempty UTF-8 credential value.",
    );
  }
  const version = randomUUID();
  const encoded = JSON.stringify({ credential: value, version });
  if (Buffer.byteLength(encoded, "utf8") > maxSecretValueBytes) {
    throw new TokenServiceSourceInputError(
      "The encoded credential exceeds the Secret storage limit.",
    );
  }
  return { stored: encoded, version };
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
  private readonly state: PlatformStateStore;
  private readonly credentialProxy:
    Pick<CredentialProxyDriver, "notifyCredentialUpdated"> | undefined;

  constructor(
    id: string,
    installationId: string,
    store: InstallationSecretStore,
    tokenServiceInstanceId: string,
    state: PlatformStateStore,
    credentialProxy?: Pick<CredentialProxyDriver, "notifyCredentialUpdated">,
  ) {
    if (!isNonEmptyString(tokenServiceInstanceId)) {
      throw new ResourceStateConflictError("The TokenService instance identity is unavailable.");
    }
    this.id = id;
    this.installationId = installationId;
    this.store = store;
    this.tokenServiceInstanceId = tokenServiceInstanceId;
    this.state = state;
    this.credentialProxy = credentialProxy;
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

  private ownedSource(found: CredentialSource | undefined): CredentialSource | undefined {
    if (
      found !== undefined &&
      (found.ownerCapability !== "token_service" ||
        found.tokenServiceInstanceId !== this.tokenServiceInstanceId)
    ) {
      throw new ResourceStateConflictError("This source belongs to another TokenService instance.");
    }
    return found;
  }

  private storageRef(ref: CredentialSourceReference): InstallationSecretRef {
    return {
      installationId: this.installationId,
      id: JSON.stringify([
        "token_service",
        this.tokenServiceInstanceId,
        ref.kind,
        ref.namespaceId,
        ref.id,
      ]),
    };
  }

  async createSource(
    input: SourceRegistrationInput,
    signal: AbortSignal,
  ): Promise<CredentialSource> {
    signal.throwIfAborted();
    if (!isNonEmptyString(input.namespaceId) || !isName(input.name)) {
      throw new ScopeViolationError("The credential source identity is invalid.");
    }
    checkLifecycle(input.lifecycleConfig);
    const stored = encodeCredential(input.secret);
    const id = `cs_${randomUUID()}`;
    const ref: CredentialSourceReference = {
      kind: "credential_source",
      namespaceId: input.namespaceId,
      id,
    };
    return this.state.transact(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(input.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      const source = await credentialSources.createCredentialSource({
        id,
        namespaceId: input.namespaceId,
        name: input.name,
        type: input.lifecycleConfig.type,
        ownerCapability: "token_service",
        tokenServiceInstanceId: this.tokenServiceInstanceId,
        state: "ready",
        config: input.config,
        secrets: {},
        createdAt: new Date().toISOString(),
      });
      await withComputeAbortSignal(signal, () =>
        this.store.create(this.storageRef(ref), stored.stored),
      );
      signal.throwIfAborted();
      return source;
    });
  }

  async updateSource(
    source: TokenServiceSourceInstance,
    update: SourceUpdate,
    signal: AbortSignal,
  ): Promise<CredentialSource> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    if (update.lifecycleConfig) {
      checkLifecycle(update.lifecycleConfig);
    }
    let version: string | undefined;
    const updated = await this.state.transact(async ({ namespaces, credentialSources }) => {
      const namespace = await namespaces.lockNamespace(ref.namespaceId);
      if (namespace?.status !== "ready") {
        throw new ResourceStateConflictError("The credential source Namespace is not ready.");
      }
      const found = this.ownedSource(
        await credentialSources.lockCredentialSource(ref.namespaceId, ref.id),
      );
      if (found?.state !== "ready") {
        throw new ResourceStateConflictError("The credential source is unavailable.");
      }
      if (update.secret) {
        const stored = encodeCredential(update.secret);
        await withComputeAbortSignal(signal, () =>
          this.store.update(this.storageRef(ref), stored.stored),
        );
        version = stored.version;
      } else if (update.lifecycleConfig) {
        await withComputeAbortSignal(signal, () =>
          this.store.withValue(this.storageRef(ref), async () => undefined),
        );
      }
      signal.throwIfAborted();
      return found;
    });
    if (version && this.credentialProxy) {
      if (!this.credentialProxy.notifyCredentialUpdated) {
        throw new CredentialDeliveryFailedError();
      }
      try {
        await this.credentialProxy.notifyCredentialUpdated(
          { sourceRef: ref, version },
          () => this.resolveCredential(source, signal),
          signal,
        );
      } catch {
        throw new CredentialDeliveryFailedError();
      }
    }
    return updated;
  }

  async resolveCredential(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<ResolvedCredential> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const found = this.ownedSource(
      await this.state.read(({ credentialSources }) =>
        credentialSources.findCredentialSource(ref.namespaceId, ref.id),
      ),
    );
    if (found?.state !== "ready") {
      throw new ResourceStateConflictError("The credential source is unavailable.");
    }
    const resolved = await withComputeAbortSignal(signal, () =>
      this.store.withValue(this.storageRef(ref), async (value) => decodeCredential(value)),
    );
    signal.throwIfAborted();
    return resolved;
  }

  async forceRefresh(
    source: TokenServiceSourceInstance<CredentialSourceReference>,
    signal: AbortSignal,
  ): Promise<SourceRefreshOperation> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    const found = this.ownedSource(
      await this.state.read(({ credentialSources }) =>
        credentialSources.findCredentialSource(ref.namespaceId, ref.id),
      ),
    );
    if (found?.state !== "ready") {
      throw new ResourceStateConflictError("The credential source is unavailable.");
    }
    throw new ResourceStateConflictError(
      "A static credential cannot be refreshed; update the source.",
    );
  }

  async getRefreshStatus(
    operation: SourceRefreshOperation,
    signal: AbortSignal,
  ): Promise<CredentialRefreshStatus> {
    signal.throwIfAborted();
    const ref = this.ownedRef(operation);
    const found = this.ownedSource(
      await this.state.read(({ credentialSources }) =>
        credentialSources.findCredentialSource(ref.namespaceId, ref.id),
      ),
    );
    if (found?.state !== "ready") {
      throw new ResourceStateConflictError("The credential source is unavailable.");
    }
    throw new ResourceStateConflictError("A static credential has no refresh operation.");
  }

  async removeSource(
    source: TokenServiceSourceInstance,
    signal: AbortSignal,
  ): Promise<readonly AccessBinding[]> {
    signal.throwIfAborted();
    const ref = this.ownedRef(source);
    return this.state.transact(async ({ namespaces, credentialSources, iamPolicy }) => {
      if (!(await namespaces.lockNamespace(ref.namespaceId))) {
        throw new ResourceStateConflictError("The credential source Namespace is unavailable.");
      }
      const found = this.ownedSource(
        await credentialSources.lockCredentialSource(ref.namespaceId, ref.id),
      );
      if (found?.state !== "deleting") {
        throw new ResourceStateConflictError("The credential source is not retiring.");
      }
      if (await credentialSources.findBlockingReference(ref.namespaceId, ref.id)) {
        throw new ResourceStateConflictError("The credential source is still referenced.");
      }
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
      const removedBindings = (await iamPolicy.listAccessBindings(ref.namespaceId)).filter(
        (binding) => binding.resourceKind === "credential_source" && binding.resourceId === ref.id,
      );
      if (!(await credentialSources.deleteCredentialSource(ref.namespaceId, ref.id))) {
        throw new ResourceStateConflictError("The credential source changed during deletion.");
      }
      return Object.freeze(removedBindings);
    });
  }
}
