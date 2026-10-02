/// <reference lib="es2024.string" />

import {
  asRecord,
  isNonEmptyString,
  numericErrorStatus,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import type { CoreV1Api, V1ObjectMeta, V1Secret } from "@kubernetes/client-node";
import type {
  JSONSchema,
  Secret,
  SecretBackendRef,
  SecretDriver,
  SecretIdentity,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import { resolveKubernetesControlNamespace } from "../../compute/kubernetes/index.ts";
import { createKubernetesClientConfiguration } from "../../kubernetes/client.ts";
import { OAUTH_PHASE_ANNOTATION } from "../../kubernetes/oauth-seal.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../compute/operation-context.ts";
import {
  createKubernetesAuthenticationOptionsSchema,
  validateKubernetesAuthentication,
  type KubernetesAuthentication,
} from "../../kubernetes/authentication.ts";

type KubernetesRecord = Record<string, unknown>;

export interface KubernetesSecretDriverOptions {
  readonly authentication: KubernetesAuthentication;
}

interface KubernetesSecretDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
}

export class SecretValidationError extends ScopeViolationError {}
export class SecretOwnershipError extends ScopeViolationError {}
export class SecretBackendUnavailableError extends DependencyUnavailableError {}
export class SecretConflictError extends ResourceConflictError {}
class SecretBackendMissingError extends SecretBackendUnavailableError {}

const MANAGER = "openclaw-enterprise";
const IMPLEMENTATION = "occ/kubernetes-secret";
const SECRET_KEY = "value";
const MAX_SECRET_VALUE_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_SECONDS = Math.ceil(REQUEST_TIMEOUT_MS / 1000);
const NAMESPACE_LABEL = "openclaw.dev/namespace";
const SECRET_LABEL = "openclaw.dev/secret";
const NAMESPACE_ANNOTATION = "openclaw.dev/namespace-id";
const SECRET_ANNOTATION = "openclaw.dev/secret-id";
const SECRET_NAME_ANNOTATION = "openclaw.dev/secret-name";
const DRIVER_ANNOTATION = "openclaw.dev/secret-driver-id";

function required(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new SecretValidationError(`${description} must be a nonempty string.`);
  }
  return value;
}

function kubernetesSecretName(identity: SecretIdentity): string {
  return `secret-${sha256Hex(identity.namespaceId, 12)}-${sha256Hex(identity.id, 12)}-${sha256Hex(randomUUID(), 12)}`;
}

function validateIdentity(identity: SecretIdentity): void {
  const value = asRecord(identity);
  if (value === undefined) {
    throw new SecretValidationError("Secret identity is required.");
  }
  const id = required(value.id, "Secret ID");
  const namespaceId = required(value.namespaceId, "Secret Namespace ID");
  required(value.name, "Secret name");
  if (!id.startsWith("sec_")) {
    throw new SecretValidationError("Secret IDs must use the sec_ prefix.");
  }
  if (!namespaceId.startsWith("ns_")) {
    throw new SecretValidationError("Secret Namespace IDs must use the ns_ prefix.");
  }
}

function validateValue(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretValidationError("Secret value must be a nonempty UTF-8 string.");
  }
  if (value.includes("\0")) {
    throw new SecretValidationError("Secret value cannot contain NUL.");
  }
  if (!value.isWellFormed()) {
    throw new SecretValidationError("Secret value must be well-formed UTF-16 for UTF-8 storage.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
    throw new SecretValidationError("Secret value exceeds the application Secret size limit.");
  }
}

function validateBackendRef(reference: SecretBackendRef): void {
  const value = asRecord(reference);
  if (value === undefined) {
    throw new SecretValidationError("Secret backend reference is required.");
  }
  required(value.namespaceName, "Secret backend namespace");
  required(value.name, "Secret backend name");
  const key = required(value.key, "Secret backend key");
  required(value.uid, "Secret backend UID");
  if (key !== SECRET_KEY) {
    throw new SecretOwnershipError("Secret backend key is unsupported.");
  }
}

function decodedValue(observed: V1Secret): string {
  const encoded = observed.data?.[SECRET_KEY];
  try {
    if (
      typeof encoded !== "string" ||
      encoded.length > 4 * Math.ceil(MAX_SECRET_VALUE_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new Error("Invalid encoding.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      throw new Error("Invalid encoding.");
    }
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    validateValue(value);
    return value;
  } catch {
    throw new SecretBackendUnavailableError("The Kubernetes Secret value is invalid.");
  }
}

function sanitizedFailure(error: unknown, action: string): Error {
  const code = numericErrorStatus(error);
  if (code === 404) {
    return new SecretBackendMissingError("The Kubernetes Secret backend is unavailable.");
  }
  if (code === 409) {
    return new SecretConflictError(`The Kubernetes Secret ${action} conflicted.`);
  }
  if (code === 401 || code === 403) {
    return new SecretBackendUnavailableError(
      "The Kubernetes Secret backend is not authorized for this operation.",
    );
  }
  return new SecretBackendUnavailableError(`The Kubernetes Secret ${action} failed.`);
}

function timeoutFailure(action: string): Error {
  return new SecretBackendUnavailableError(
    `The Kubernetes Secret ${action} outcome is unknown after timeout.`,
  );
}

export class KubernetesSecretDriver implements SecretDriver {
  static readonly configurationSchema: JSONSchema = createKubernetesAuthenticationOptionsSchema();

  static validateConfiguration(configuration: unknown): void {
    const value = asRecord(configuration);
    if (value === undefined) {
      throw new SecretValidationError("Kubernetes Secret options are required.");
    }
    if ("clients" in value || Object.keys(value).some((key) => key !== "authentication")) {
      throw new SecretValidationError(
        "Injected clients and unknown Kubernetes Secret options are not supported.",
      );
    }
    validateKubernetesAuthentication(
      value.authentication,
      (message) => new SecretValidationError(message),
    );
  }

  readonly id: string;
  readonly capability = "secret" as const;
  readonly implementation: string;
  private readonly options: KubernetesSecretDriverOptions;
  private client: Promise<CoreV1Api> | undefined;

  constructor(
    options: KubernetesSecretDriverOptions,
    selection: KubernetesSecretDriverSelection = {},
  ) {
    KubernetesSecretDriver.validateConfiguration(options);
    this.id = required(selection.id ?? "secret-kubernetes", "Secret Driver ID");
    this.implementation = selection.implementation ?? IMPLEMENTATION;
    if (this.implementation !== IMPLEMENTATION) {
      throw new SecretValidationError("Unsupported Kubernetes Secret implementation.");
    }
    this.options = Object.freeze({ authentication: Object.freeze({ ...options.authentication }) });
  }

  async create(identity: SecretIdentity, value: string): Promise<SecretBackendRef> {
    validateIdentity(identity);
    validateValue(value);
    const client = await this.core();
    const namespace = await this.readyNamespace(client, identity.namespaceId);

    const name = kubernetesSecretName(identity);
    const observed = await this.request(
      () =>
        client.createNamespacedSecret({
          namespace,
          body: this.manifest(identity, namespace, name, value),
        }),
      "create",
      { mutating: true },
    );
    return this.checkedBackendRef(observed, identity, namespace);
  }

  async update(secret: Secret, value: string): Promise<void> {
    validateValue(value);
    const { observed } = await this.readOwnedSecret(secret);
    if (observed.metadata?.annotations?.[OAUTH_PHASE_ANNOTATION] !== undefined) {
      throw new SecretConflictError("The Agent owns this OAuth credential; it cannot be updated.");
    }
    await this.replaceOwnedSecret(secret, observed, value);
  }

  async compareAndSwap(secret: Secret, expected: string, value: string): Promise<boolean> {
    validateValue(expected);
    validateValue(value);
    const { observed } = await this.readOwnedSecret(secret);
    if (
      observed.metadata?.annotations?.[OAUTH_PHASE_ANNOTATION] !== undefined ||
      decodedValue(observed) !== expected
    ) {
      return false;
    }
    try {
      await this.replaceOwnedSecret(secret, observed, value);
      return true;
    } catch (error) {
      if (error instanceof SecretConflictError) {
        return false;
      }
      throw error;
    }
  }

  private async replaceOwnedSecret(
    secret: Secret,
    existing: V1Secret,
    value: string,
  ): Promise<void> {
    const client = await this.core();
    const namespace = secret.backendRef.namespaceName;
    const desired: V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: this.retainedMetadata(existing.metadata, secret, namespace),
      type: "Opaque",
      immutable: false,
      stringData: { [SECRET_KEY]: value },
    };
    const observed = await this.request(
      () =>
        client.replaceNamespacedSecret({ namespace, name: secret.backendRef.name, body: desired }),
      "update",
      { mutating: true },
    );
    this.checkedBackendRef(observed, secret, namespace, secret.backendRef);
  }

  async delete(secret: Secret): Promise<void> {
    validateIdentity(secret);
    validateBackendRef(secret.backendRef);
    const client = await this.core();
    const namespace = await this.readyNamespace(client, secret.namespaceId);
    if (secret.backendRef.namespaceName !== namespace) {
      throw new SecretOwnershipError("Secret backend namespace no longer matches placement.");
    }
    let existing: V1Secret;
    try {
      existing = await this.request(
        () => client.readNamespacedSecret({ namespace, name: secret.backendRef.name }),
        "read",
      );
    } catch (error) {
      if (error instanceof SecretBackendMissingError) {
        return;
      }
      throw error;
    }
    this.checkedBackendRef(existing, secret, namespace, secret.backendRef);
    const resourceVersion = existing.metadata?.resourceVersion;
    if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
      throw new SecretOwnershipError("Secret resource version is required for delete.");
    }
    await this.request(
      () =>
        client.deleteNamespacedSecret({
          namespace,
          name: secret.backendRef.name,
          body: {
            preconditions: {
              uid: secret.backendRef.uid,
              resourceVersion,
            },
          },
        }),
      "delete",
      { mutating: true },
    );
  }

  async resolve(secret: Secret): Promise<SecretBackendRef> {
    const { reference } = await this.readOwnedSecret(secret);
    return reference;
  }

  async withValue<T>(secret: Secret, use: (value: string) => Promise<T>): Promise<T> {
    const { observed } = await this.readOwnedSecret(secret);
    return use(decodedValue(observed));
  }

  private async readOwnedSecret(
    secret: Secret,
  ): Promise<{ observed: V1Secret; reference: SecretBackendRef }> {
    validateIdentity(secret);
    validateBackendRef(secret.backendRef);
    if (secret.driverId !== this.id) {
      throw new SecretOwnershipError("Secret Driver identity changed.");
    }
    const client = await this.core();
    const namespace = await this.readyNamespace(client, secret.namespaceId);
    if (secret.backendRef.namespaceName !== namespace) {
      throw new SecretOwnershipError("Secret backend namespace no longer matches placement.");
    }
    const observed = await this.request(
      () => client.readNamespacedSecret({ namespace, name: secret.backendRef.name }),
      "read",
    );
    const reference = this.checkedBackendRef(observed, secret, namespace, secret.backendRef);
    return { observed, reference };
  }

  private manifest(
    identity: SecretIdentity,
    namespace: string,
    name: string,
    value: string,
  ): V1Secret {
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace,
        labels: this.labels(identity),
        annotations: this.annotations(identity),
      },
      immutable: false,
      type: "Opaque",
      stringData: { [SECRET_KEY]: value },
    };
  }

  private labels(identity: SecretIdentity): Record<string, string> {
    return {
      "app.kubernetes.io/managed-by": MANAGER,
      [NAMESPACE_LABEL]: identity.namespaceId,
      [SECRET_LABEL]: identity.id,
    };
  }

  private annotations(identity: SecretIdentity): Record<string, string> {
    return {
      [NAMESPACE_ANNOTATION]: identity.namespaceId,
      [SECRET_ANNOTATION]: identity.id,
      [SECRET_NAME_ANNOTATION]: identity.name,
      [DRIVER_ANNOTATION]: this.id,
    };
  }

  private retainedMetadata(
    existing: V1ObjectMeta | undefined,
    secret: Secret,
    namespace: string,
  ): V1ObjectMeta {
    if (existing === undefined || !isNonEmptyString(existing.resourceVersion)) {
      throw new SecretOwnershipError("Secret resource version is required for update.");
    }
    return {
      ...existing,
      name: secret.backendRef.name,
      namespace,
      uid: secret.backendRef.uid,
      resourceVersion: existing.resourceVersion,
      labels: { ...existing.labels, ...this.labels(secret) },
      annotations: { ...existing.annotations, ...this.annotations(secret) },
    };
  }

  private checkedBackendRef(
    observed: V1Secret,
    identity: SecretIdentity,
    namespace: string,
    expected?: SecretBackendRef,
  ): SecretBackendRef {
    const metadata = observed.metadata;
    const labels = metadata?.labels;
    const annotations = metadata?.annotations;
    const data = asRecord(observed.data);
    const name = required(metadata?.name, "Secret backend name");
    const uid = required(metadata?.uid, "Secret backend UID");
    if (
      observed.type !== "Opaque" ||
      observed.immutable === true ||
      metadata?.namespace !== namespace ||
      labels?.["app.kubernetes.io/managed-by"] !== MANAGER ||
      labels[NAMESPACE_LABEL] !== identity.namespaceId ||
      labels[SECRET_LABEL] !== identity.id ||
      annotations?.[NAMESPACE_ANNOTATION] !== identity.namespaceId ||
      annotations[SECRET_ANNOTATION] !== identity.id ||
      annotations[DRIVER_ANNOTATION] !== this.id ||
      data === undefined ||
      !Object.hasOwn(data, SECRET_KEY)
    ) {
      throw new SecretOwnershipError("Secret backend does not match exact OCC ownership.");
    }
    const resolved = Object.freeze({ namespaceName: namespace, name, key: SECRET_KEY, uid });
    if (
      expected !== undefined &&
      (expected.namespaceName !== resolved.namespaceName ||
        expected.name !== resolved.name ||
        expected.key !== resolved.key ||
        expected.uid !== resolved.uid)
    ) {
      throw new SecretOwnershipError("Secret backend identity changed.");
    }
    return resolved;
  }

  private async readyNamespace(client: CoreV1Api, namespaceId: string): Promise<string> {
    try {
      const placement = await this.request(
        () => resolveKubernetesControlNamespace(client, namespaceId),
        "namespace verification",
      );
      return placement.name;
    } catch (error) {
      throw sanitizedFailure(error, "namespace verification");
    }
  }

  private async request<T>(
    operation: () => Promise<T>,
    action: string,
    options: { readonly mutating?: boolean } = {},
  ): Promise<T> {
    const ownerSignal = currentComputeAbortSignal();
    for (let attempt = 1; ; attempt += 1) {
      ownerSignal?.throwIfAborted();
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal =
        ownerSignal === undefined ? deadline : AbortSignal.any([ownerSignal, deadline]);
      try {
        return await withComputeAbortSignal(signal, operation);
      } catch (error) {
        if (ownerSignal?.aborted) {
          throw new SecretBackendUnavailableError(`The Kubernetes Secret ${action} was cancelled.`);
        }
        if (deadline.aborted) {
          throw timeoutFailure(action);
        }
        const status = numericErrorStatus(error);
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500) ||
          (status === undefined &&
            !(error instanceof SecretValidationError) &&
            !(error instanceof SecretOwnershipError));
        if (!retryable || options.mutating === true || attempt >= 3) {
          throw sanitizedFailure(error, action);
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
  }

  private async core(): Promise<CoreV1Api> {
    if (this.client === undefined) {
      this.client = this.createCore();
    }
    return this.client;
  }

  private async createCore(): Promise<CoreV1Api> {
    const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
      this.options.authentication,
      (message) => new SecretValidationError(message),
    );
    return new sdk.CoreV1Api(clientConfiguration);
  }
}
