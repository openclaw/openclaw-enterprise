import {
  asRecord,
  isNonEmptyString,
  numericErrorStatus,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import type { CoreV1Api, V1ConfigMap } from "@kubernetes/client-node";
import type {
  Configuration,
  ConfigurationDriver,
  ConfigurationReference,
  JSONSchema,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { ConfigurationValidationError, validateModelCredentialReferences } from "../model-auth.ts";
import { resolveKubernetesControlNamespace } from "../../compute/kubernetes/index.ts";
import { ResourceConflictError } from "@openclaw-enterprise/occ";
import {
  createKubernetesAuthenticationOptionsSchema,
  validateKubernetesAuthentication,
  type KubernetesAuthentication,
} from "../../kubernetes/authentication.ts";

export interface KubernetesConfigurationDriverOptions {
  readonly authentication: KubernetesAuthentication;
}

interface KubernetesConfigurationDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
}

export { ConfigurationValidationError } from "../model-auth.ts";
export class ConfigurationOwnershipError extends Error {}
export class ConfigurationConflictError extends ResourceConflictError {}

const MANAGER = "openclaw-enterprise";
const IMPLEMENTATION = "occ/kubernetes-configmap";
const NAMESPACE_ANNOTATION = "openclaw.dev/namespace-id";
const CONFIGURATION_ANNOTATION = "openclaw.dev/configuration-id";
const KIND_ANNOTATION = "openclaw.dev/configuration-kind";
const GENERATION_ANNOTATION = "openclaw.dev/configuration-generation";
const CREATED_AT_ANNOTATION = "openclaw.dev/configuration-created-at";
const NAMESPACE_LABEL = "openclaw.dev/namespace";
const CONFIGURATION_LABEL = "openclaw.dev/configuration";
const CONFIGURATION_DOCUMENT = "openclaw.json";
const MAX_CONFIGMAP_BYTES = 1_048_576;

function requiredString(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationValidationError(`${description} must be a nonempty string.`);
  }
  return value;
}

function validateReference(reference: ConfigurationReference): void {
  const value = asRecord(reference);
  if (value === undefined) {
    throw new ConfigurationValidationError("Configuration reference is required.");
  }
  const id = requiredString(value.id, "Configuration ID");
  if (!id.startsWith("cfg_")) {
    throw new ConfigurationValidationError("Configuration IDs must use the cfg_ prefix.");
  }
  requiredString(value.namespaceId, "Configuration Namespace ID");
}

export function kubernetesConfigurationName(configurationId: string): string {
  const id = requiredString(configurationId, "Configuration ID");
  if (!id.startsWith("cfg_")) {
    throw new ConfigurationValidationError("Configuration IDs must use the cfg_ prefix.");
  }
  const slug =
    id
      .slice(4)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 46)
      .replace(/-+$/g, "") || "config";
  return `cfg-${slug}-${sha256Hex(id, 12)}`;
}

export class KubernetesConfigurationDriver implements ConfigurationDriver {
  static readonly configurationSchema: JSONSchema = createKubernetesAuthenticationOptionsSchema();

  static validateConfiguration(configuration: unknown): void {
    const value = asRecord(configuration);
    if (value === undefined) {
      throw new ConfigurationValidationError("Kubernetes configuration options are required.");
    }
    if ("clients" in value || Object.keys(value).some((key) => key !== "authentication")) {
      throw new ConfigurationValidationError(
        "Injected clients and unknown Kubernetes configuration options are not supported.",
      );
    }
    validateKubernetesAuthentication(
      value.authentication,
      (message) => new ConfigurationValidationError(message),
    );
  }

  readonly id: string;
  readonly capability = "configuration" as const;
  readonly implementation: string;
  private readonly options: KubernetesConfigurationDriverOptions;
  private client: Promise<CoreV1Api> | undefined;

  constructor(
    options: KubernetesConfigurationDriverOptions,
    selection: KubernetesConfigurationDriverSelection = {},
  ) {
    KubernetesConfigurationDriver.validateConfiguration(options);
    this.id = requiredString(selection.id ?? "config-kubernetes", "Configuration Driver ID");
    this.implementation = selection.implementation ?? IMPLEMENTATION;
    if (this.implementation !== IMPLEMENTATION) {
      throw new ConfigurationValidationError(
        "Unsupported Kubernetes configuration implementation.",
      );
    }
    this.options = Object.freeze({ authentication: Object.freeze({ ...options.authentication }) });
  }

  async validate(configuration: Configuration): Promise<void> {
    const resource = asRecord(configuration);
    if (resource === undefined) {
      throw new ConfigurationValidationError("Configuration is required.");
    }
    validateReference(configuration);
    if (resource.kind !== "agent") {
      throw new ConfigurationValidationError("Configuration kind must identify an Agent.");
    }
    if (!Number.isSafeInteger(resource.generation) || Number(resource.generation) < 1) {
      throw new ConfigurationValidationError(
        "Configuration generation must be a positive safe integer.",
      );
    }
    const createdAt = requiredString(resource.createdAt, "Configuration creation time");
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new ConfigurationValidationError("Configuration creation time must be valid.");
    }
    await this.validateValues(configuration.values);
  }

  async validateValues(document: OpenClawConfigurationDocument): Promise<void> {
    const values = asRecord(document);
    if (values === undefined) {
      throw new ConfigurationValidationError("Configuration values must be a JSON object.");
    }
    validateModelCredentialReferences(document);
    if (Buffer.byteLength(JSON.stringify(values), "utf8") >= MAX_CONFIGMAP_BYTES) {
      throw new ConfigurationValidationError(
        "Configuration exceeds the Kubernetes ConfigMap size limit.",
      );
    }
  }

  async create(configuration: Configuration): Promise<Configuration> {
    await this.validate(configuration);
    const client = await this.core();
    const { name: namespace } = await resolveKubernetesControlNamespace(
      client,
      configuration.namespaceId,
    );
    const observed = await client.createNamespacedConfigMap({
      namespace,
      body: this.manifest(configuration, namespace),
    });
    return this.checkedConfiguration(observed, configuration, namespace);
  }

  async createExact(configuration: Configuration): Promise<Configuration> {
    await this.validate(configuration);
    const client = await this.core();
    const { name: namespace } = await resolveKubernetesControlNamespace(
      client,
      configuration.namespaceId,
    );
    try {
      const observed = await client.createNamespacedConfigMap({
        namespace,
        body: this.manifest(configuration, namespace),
      });
      return this.checkedConfiguration(observed, configuration, namespace);
    } catch (error) {
      if (numericErrorStatus(error) === 409) {
        throw new ConfigurationConflictError("The Kubernetes ConfigMap create conflicted.");
      }
      throw error;
    }
  }

  async inspectExact(configuration: Configuration): Promise<Configuration | undefined> {
    await this.validate(configuration);
    const client = await this.core();
    const { name: namespace } = await resolveKubernetesControlNamespace(
      client,
      configuration.namespaceId,
    );
    let recovered: Configuration;
    try {
      const observed = await client.readNamespacedConfigMap({
        name: kubernetesConfigurationName(configuration.id),
        namespace,
      });
      recovered = await this.checkedConfiguration(observed, configuration, namespace);
    } catch (error) {
      if (numericErrorStatus(error) === 404) {
        return undefined;
      }
      if (error instanceof ConfigurationOwnershipError) {
        throw new ConfigurationConflictError(
          "Existing ConfigMap does not match the requested Configuration identity.",
        );
      }
      throw error;
    }
    if (!isDeepStrictEqual(recovered.values, configuration.values)) {
      throw new ConfigurationConflictError(
        "Existing ConfigMap does not match the requested Configuration values.",
      );
    }
    return recovered;
  }

  async read(reference: ConfigurationReference): Promise<Configuration> {
    validateReference(reference);
    const client = await this.core();
    const { name: namespace } = await resolveKubernetesControlNamespace(
      client,
      reference.namespaceId,
    );
    const observed = await client.readNamespacedConfigMap({
      name: kubernetesConfigurationName(reference.id),
      namespace,
    });
    return this.checkedConfiguration(observed, reference, namespace);
  }

  async update(configuration: Configuration): Promise<Configuration> {
    await this.validate(configuration);
    const client = await this.core();
    const { name: namespace } = await resolveKubernetesControlNamespace(
      client,
      configuration.namespaceId,
    );
    const name = kubernetesConfigurationName(configuration.id);
    const existing = await client.readNamespacedConfigMap({ name, namespace });
    const current = await this.checkedConfiguration(
      existing,
      { id: configuration.id, namespaceId: configuration.namespaceId },
      namespace,
    );
    if (current.createdAt !== configuration.createdAt) {
      throw new ConfigurationOwnershipError("Configuration creation time cannot be changed.");
    }
    if (current.kind !== configuration.kind) {
      throw new ConfigurationOwnershipError("Configuration kind cannot be changed.");
    }
    if (Math.abs(current.generation - configuration.generation) !== 1) {
      throw new ConfigurationOwnershipError(
        "Configuration generation must advance or roll back exactly once.",
      );
    }
    const resourceVersion = existing.metadata?.resourceVersion;
    if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
      throw new ConfigurationOwnershipError(
        "Configuration resource version is required for update.",
      );
    }
    const desired = this.manifest(configuration, namespace);
    desired.metadata = { ...desired.metadata, resourceVersion };
    const observed = await client.replaceNamespacedConfigMap({ name, namespace, body: desired });
    return this.checkedConfiguration(observed, configuration, namespace);
  }

  async delete(reference: ConfigurationReference): Promise<void> {
    validateReference(reference);
    const client = await this.core();
    const { name: namespace } = await resolveKubernetesControlNamespace(
      client,
      reference.namespaceId,
    );
    const name = kubernetesConfigurationName(reference.id);
    const existing = await client.readNamespacedConfigMap({ name, namespace });
    await this.checkedConfiguration(existing, reference, namespace);
    const uid = existing.metadata?.uid;
    await client.deleteNamespacedConfigMap({
      name,
      namespace,
      ...(typeof uid === "string" ? { body: { preconditions: { uid } } } : {}),
    });
  }

  private manifest(configuration: Configuration, namespace: string): V1ConfigMap {
    return {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: kubernetesConfigurationName(configuration.id),
        namespace,
        labels: {
          "app.kubernetes.io/managed-by": MANAGER,
          [NAMESPACE_LABEL]: configuration.namespaceId,
          [CONFIGURATION_LABEL]: configuration.id,
        },
        annotations: {
          [NAMESPACE_ANNOTATION]: configuration.namespaceId,
          [CONFIGURATION_ANNOTATION]: configuration.id,
          [KIND_ANNOTATION]: configuration.kind,
          [GENERATION_ANNOTATION]: String(configuration.generation),
          [CREATED_AT_ANNOTATION]: configuration.createdAt,
        },
      },
      data: { [CONFIGURATION_DOCUMENT]: JSON.stringify(configuration.values) },
    };
  }

  private toConfiguration(
    observed: V1ConfigMap,
    reference: ConfigurationReference,
    namespace: string,
  ): Configuration {
    const metadata = observed.metadata;
    const labels = metadata?.labels;
    const annotations = metadata?.annotations;
    if (
      metadata?.name !== kubernetesConfigurationName(reference.id) ||
      metadata.namespace !== namespace ||
      labels?.["app.kubernetes.io/managed-by"] !== MANAGER ||
      labels[NAMESPACE_LABEL] !== reference.namespaceId ||
      labels[CONFIGURATION_LABEL] !== reference.id ||
      annotations?.[NAMESPACE_ANNOTATION] !== reference.namespaceId ||
      annotations[CONFIGURATION_ANNOTATION] !== reference.id
    ) {
      throw new ConfigurationOwnershipError(
        "ConfigMap does not belong to the exact requested Namespace configuration.",
      );
    }
    const createdAt = requiredString(
      annotations[CREATED_AT_ANNOTATION],
      "Configuration creation time",
    );
    if (annotations[KIND_ANNOTATION] !== "agent") {
      throw new ConfigurationOwnershipError("Configuration kind annotation is unsupported.");
    }
    const serializedGeneration = annotations[GENERATION_ANNOTATION];
    if (typeof serializedGeneration !== "string" || !/^[1-9]\d*$/.test(serializedGeneration)) {
      throw new ConfigurationOwnershipError("Configuration generation annotation is invalid.");
    }
    const generation = Number(serializedGeneration);
    if (!Number.isSafeInteger(generation)) {
      throw new ConfigurationOwnershipError("Configuration generation annotation is invalid.");
    }
    if (observed.binaryData !== undefined && Object.keys(observed.binaryData).length !== 0) {
      throw new ConfigurationOwnershipError("Configuration ConfigMaps cannot contain binary data.");
    }
    const data = asRecord(observed.data);
    if (
      data === undefined ||
      Object.keys(data).length !== 1 ||
      !Object.hasOwn(data, CONFIGURATION_DOCUMENT) ||
      typeof data[CONFIGURATION_DOCUMENT] !== "string"
    ) {
      throw new ConfigurationOwnershipError("Configuration ConfigMap data is missing or invalid.");
    }
    const document = data[CONFIGURATION_DOCUMENT];
    if (Buffer.byteLength(document, "utf8") >= MAX_CONFIGMAP_BYTES) {
      throw new ConfigurationOwnershipError("Configuration ConfigMap exceeds its size limit.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(document);
    } catch {
      throw new ConfigurationOwnershipError("Configuration ConfigMap contains malformed JSON.");
    }
    const values = asRecord(parsed);
    if (values === undefined) {
      throw new ConfigurationOwnershipError("Configuration ConfigMap document must be an object.");
    }
    return {
      id: reference.id,
      namespaceId: reference.namespaceId,
      kind: "agent",
      generation,
      values: values as Configuration["values"],
      createdAt,
    };
  }

  private async checkedConfiguration(
    observed: V1ConfigMap,
    reference: ConfigurationReference,
    namespace: string,
  ): Promise<Configuration> {
    const configuration = this.toConfiguration(observed, reference, namespace);
    const expected = reference as Partial<Configuration>;
    if (
      (expected.kind !== undefined && configuration.kind !== expected.kind) ||
      (expected.generation !== undefined && configuration.generation !== expected.generation) ||
      (expected.createdAt !== undefined && configuration.createdAt !== expected.createdAt)
    ) {
      throw new ConfigurationOwnershipError(
        "ConfigMap does not match its expected Configuration kind, generation, or creation time.",
      );
    }
    try {
      await this.validate(configuration);
    } catch {
      throw new ConfigurationOwnershipError(
        "The stored ConfigMap violates Configuration security boundaries.",
      );
    }
    return configuration;
  }

  private async core(): Promise<CoreV1Api> {
    if (this.client === undefined) {
      this.client = this.createCore();
    }
    return this.client;
  }

  private async createCore(): Promise<CoreV1Api> {
    const sdk = await import("@kubernetes/client-node");
    const configuration = new sdk.KubeConfig();
    const authentication = this.options.authentication;
    if (authentication.mode === "inCluster") {
      configuration.loadFromCluster();
    } else {
      configuration.loadFromFile(authentication.kubeconfigPath);
      const contexts = configuration
        .getContexts()
        .filter((context) => context.name === authentication.context);
      const selected = contexts[0];
      if (contexts.length !== 1 || selected === undefined) {
        throw new ConfigurationValidationError(
          "The kubeconfig must contain exactly the selected context.",
        );
      }
      if (
        configuration.getClusters().filter((cluster) => cluster.name === selected.cluster)
          .length !== 1
      ) {
        throw new ConfigurationValidationError(
          "The context must select exactly one Kubernetes cluster.",
        );
      }
      configuration.setCurrentContext(authentication.context);
      if (configuration.getCurrentContext() !== authentication.context) {
        throw new ConfigurationValidationError(
          "The selected Kubernetes context could not be activated.",
        );
      }
    }
    const cluster = configuration.getCurrentCluster();
    if (cluster === null || configuration.getCurrentUser() == null) {
      throw new ConfigurationValidationError(
        "The Kubernetes cluster or credential identity is missing.",
      );
    }
    let endpoint: URL;
    try {
      endpoint = new URL(cluster.server);
    } catch {
      throw new ConfigurationValidationError("The Kubernetes API server URL is invalid.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      cluster.skipTLSVerify === true
    ) {
      throw new ConfigurationValidationError("The Kubernetes API server must use verified HTTPS.");
    }
    return configuration.makeApiClient(sdk.CoreV1Api);
  }
}
