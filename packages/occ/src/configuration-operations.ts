import {
  isSecretHarnessAuth,
  normalizeSecretBindings,
  type Configuration,
  type ConfigurationDriver,
  type ConfigurationValidationOptions,
  type HarnessAuthBinding,
  type Namespace,
  type OpenClawConfigurationDocument,
  type ResourceRef,
  type Secret,
  type SecretBindings,
  type SecretDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { normalizeRequestSecretBindings } from "./agent-provisioning.ts";
import type { ModelPolicyAgent } from "./configured-harness.ts";
import {
  freezeConfigurationValues,
  validateConfigurationSettings,
} from "./configuration-settings.ts";
import {
  ConfigurationGenerationConflictError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretBindingDriverError,
  SecretBindingValidationError,
  type SecretDriverOwnershipError,
} from "./errors.ts";
import { accessBindingsTargeting, type RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import { validateModelProviderSettings } from "./model-provider-settings.ts";
import { requireDeployableRoster } from "./openclaw-roster.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export interface CreateConfigurationInput {
  readonly namespaceId: string;
  readonly kind: Configuration["kind"];
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
}

export interface UpdateConfigurationInput {
  readonly namespaceId: string;
  readonly configurationId: string;
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
  /** Refuses the update unless the Configuration is still at this generation. */
  readonly expectedGeneration?: number;
}

/**
 * How far a stored Configuration may run ahead of its record and still count as a leftover of
 * failed writes (finding 1396). Each failed update whose compensation could not run adds one, and
 * update advances the record once per skipped generation, so the bound also caps that work.
 * A document further ahead fails closed, as any other mismatch does.
 */
const MAX_CONFIGURATION_LEFTOVER_LEAD = 100;

/**
 * Rejects requested Secret references (bindings and Harness authentication) that name
 * another Namespace. It compares only the request against its route Namespace, so it
 * reveals nothing about other Namespaces and can run before any Secret lookup.
 */
export function rejectCrossNamespaceSecretSources(
  namespaceId: string,
  secretBindings: SecretBindings | undefined,
  harnessAuth: HarnessAuthBinding | null | undefined,
): void {
  const sources = Object.values(secretBindings ?? {}).map(({ source }) => source);
  if (isSecretHarnessAuth(harnessAuth)) {
    sources.push(harnessAuth.source);
  }
  if (sources.some((source) => source.namespaceId !== namespaceId)) {
    throw new SecretBindingValidationError("Secret references cannot cross Namespaces.");
  }
}

interface ConfigurationOperationsDependencies
  extends
    Pick<ControllerAuthority, "authorize" | "holdAuthority">,
    Pick<ControllerTransactions, "read" | "transact" | "registerRollback"> {
  readonly lockNamespaceForPolicyDelete: (
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ) => Promise<Readonly<Namespace>>;
  readonly guardProvisioningConfiguration: (
    state: PlatformReadView,
    namespaceId: string,
    configurationId: string,
    readOnly?: boolean,
  ) => Promise<void>;
  readonly configurationDriver: () => ConfigurationDriver;
  readonly validateComputeConfiguration: (
    values: Readonly<OpenClawConfigurationDocument>,
    options?: ConfigurationValidationOptions,
  ) => void;
  readonly requireBundledChannelBindings: (
    values: Readonly<OpenClawConfigurationDocument>,
    secretBindings: SecretBindings,
  ) => void;
  readonly ownedSecretDriver: (
    driverId: string,
    failure: () => SecretDriverOwnershipError,
  ) => SecretDriver;
  readonly bindCreator: (
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ) => Promise<void>;
  readonly nextIdentifier: (kind: "configuration") => string;
  readonly timestamp: () => string;
  readonly driverOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function exactConfiguration(
  configuration: Configuration,
  expected: Pick<
    Configuration,
    "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
  >,
): Readonly<Configuration> {
  if (
    !configuration ||
    configuration.id !== expected.id ||
    configuration.namespaceId !== expected.namespaceId ||
    configuration.kind !== expected.kind ||
    configuration.generation !== expected.generation ||
    configuration.createdAt !== expected.createdAt
  ) {
    throw new DependencyUnavailableError(
      "The Configuration Driver returned a resource outside its exact ownership scope.",
    );
  }
  return Object.freeze({
    id: expected.id,
    namespaceId: expected.namespaceId,
    kind: expected.kind,
    generation: expected.generation,
    values: freezeConfigurationValues(configuration.values),
    ...(expected.secretBindings === undefined
      ? {}
      : { secretBindings: storedSecretBindings(expected.secretBindings) }),
    createdAt: expected.createdAt,
  });
}

export function storedSecretBindings(input: unknown): SecretBindings {
  try {
    return normalizeSecretBindings(input);
  } catch {
    throw new ScopeViolationError(
      "Secret bindings require supported exact sources and non-reserved environment destinations.",
    );
  }
}

type ConfigurationRecord = NonNullable<
  Awaited<ReturnType<PlatformReadView["configurations"]["findConfiguration"]>>
>;

async function requireConfigurationRecord(
  lookup: Promise<ConfigurationRecord | undefined>,
): Promise<ConfigurationRecord> {
  const record = await lookup;
  if (!record) {
    throw new ScopeViolationError("The Configuration does not belong to the exact Namespace.");
  }
  return record;
}

function requestSecretBindings(
  namespaceId: string,
  input: SecretBindings | undefined,
): SecretBindings {
  const bindings = normalizeRequestSecretBindings(input);
  rejectCrossNamespaceSecretSources(namespaceId, bindings, undefined);
  return bindings;
}

export function createConfigurationOperations(deps: ConfigurationOperationsDependencies) {
  async function authorizeConfigurationWrite(
    principalId: string,
    namespaceId: string,
    configurationId?: string,
  ): Promise<void> {
    if (configurationId === undefined) {
      namespaceIdentity(namespaceId);
    } else {
      configurationIdentity(namespaceId, configurationId);
    }
    await deps.authorize(principalId, configurationId === undefined ? "create" : "update", {
      kind: "configuration",
      id: configurationId ?? namespaceId,
      namespaceId,
    });
  }

  async function createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    if (input.kind !== "agent") {
      throw new ScopeViolationError("The Configuration kind must identify an Agent.");
    }
    const values = freezeConfigurationValues(input.values);
    namespaceIdentity(input.namespaceId);
    return deps.transact(async (state) => {
      await deps.holdAuthority(state);
      const target: ResourceRef = {
        kind: "configuration",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await deps.authorize(principalId, "create", target);
      const namespace = await lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await deps.authorize(principalId, "create", target);
      // Checked after authorization: the conflict names the Namespace state.
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceStateConflictError("The Namespace does not accept new Configurations.");
      }
      if (namespace.existingNamespace !== undefined && namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const secretBindings = requestSecretBindings(namespace.id, input.secretBindings);
      await authorizeBindings(state, principalId, namespace.id, secretBindings);
      const driver = deps.configurationDriver();
      const configuration: Configuration = Object.freeze({
        id: deps.nextIdentifier("configuration"),
        namespaceId: namespace.id,
        kind: input.kind,
        generation: 1,
        values,
        createdAt: deps.timestamp(),
      });
      await validateConfigurationWrite(driver, configuration, secretBindings);
      const metadata = await state.configurations.createConfiguration({
        id: configuration.id,
        namespaceId: namespace.id,
        kind: configuration.kind,
        generation: configuration.generation,
        ...(Object.keys(secretBindings).length === 0 ? {} : { secretBindings }),
        createdAt: configuration.createdAt,
      });
      await deps.bindCreator(state, principalId, {
        kind: "configuration",
        id: metadata.id,
        namespaceId: namespace.id,
      });
      // Registered before the write: a create that applied but answered with an error (a
      // timeout, a lost response) would otherwise leave a ConfigMap without metadata (finding
      // 916). The rollback deletes only this exact Configuration (identity, generation, creation
      // time and values); an absent one means the create never applied, and a Driver that cannot
      // inspect it is compensated only after a create it saw succeed.
      let created = false;
      deps.registerRollback(async () => {
        if (driver.inspectExact === undefined) {
          if (!created) {
            return;
          }
        } else if (
          (await deps.driverOperation(() => driver.inspectExact!(configuration))) === undefined
        ) {
          return;
        }
        await deps.driverOperation(() =>
          driver.delete({ id: configuration.id, namespaceId: configuration.namespaceId }),
        );
      });
      const result = await deps.driverOperation(() => driver.create(configuration));
      created = true;
      return exactConfiguration(result, metadata);
    });
  }

  async function getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>> {
    configurationIdentity(namespaceId, configurationId);
    await deps.authorize(principalId, "read", {
      kind: "configuration",
      id: configurationId,
      namespaceId,
    });
    const driver = deps.configurationDriver();
    return deps.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const metadata = await requireConfigurationRecord(
        state.configurations.findConfiguration(namespace.id, configurationId),
      );
      await deps.guardProvisioningConfiguration(state, namespace.id, configurationId, true);
      const configuration = await deps.driverOperation(() =>
        driver.read({ id: metadata.id, namespaceId: namespace.id }),
      );
      return exactConfiguration(configuration, metadata);
    });
  }

  // The Configuration an Agent save names, read from the Configuration Driver at most once and
  // only when a check needs its values.
  function savedConfigurationReader(
    metadata: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): () => Promise<Readonly<Configuration>> {
    let read: Promise<Readonly<Configuration>> | undefined;
    return () => {
      read ??= (async () => {
        const driver = deps.configurationDriver();
        return exactConfiguration(
          await deps.driverOperation(() =>
            driver.read({ id: metadata.id, namespaceId: metadata.namespaceId }),
          ),
          metadata,
        );
      })();
      return read;
    };
  }

  async function getConfigurationSecretBindingSources(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Record<string, Readonly<ResourceRef>>>> {
    configurationIdentity(namespaceId, configurationId);
    await deps.authorize(principalId, "read", {
      kind: "configuration",
      id: configurationId,
      namespaceId,
    });
    return deps.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      const metadata = await requireConfigurationRecord(
        state.configurations.findConfiguration(namespace.id, configurationId),
      );
      return Object.freeze(
        Object.fromEntries(
          Object.entries(storedSecretBindings(metadata.secretBindings)).map(
            ([name, { source }]) => [name, source],
          ),
        ),
      );
    });
  }

  async function updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>> {
    configurationIdentity(input.namespaceId, input.configurationId);
    if (Object.hasOwn(input, "kind")) {
      throw new ScopeViolationError("The Configuration kind cannot be changed.");
    }
    const values = freezeConfigurationValues(input.values);
    return deps.transact(async (state) => {
      await deps.authorize(principalId, "update", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId: input.namespaceId,
      });
      const namespace = await lockNamespace(state, input.namespaceId);
      const driver = deps.configurationDriver();
      const metadata = await requireConfigurationRecord(
        state.configurations.lockConfiguration(namespace.id, input.configurationId),
      );
      await deps.guardProvisioningConfiguration(state, namespace.id, input.configurationId);
      // Compared under the row lock, so a save that read an older generation cannot replace a
      // newer one (finding 1505).
      if (
        input.expectedGeneration !== undefined &&
        input.expectedGeneration !== metadata.generation
      ) {
        throw new ConfigurationGenerationConflictError();
      }
      const previous = await lockedConfiguration(driver, metadata);
      const secretBindings =
        input.secretBindings === undefined
          ? storedSecretBindings(metadata.secretBindings)
          : requestSecretBindings(namespace.id, input.secretBindings);
      await authorizeBindings(state, principalId, namespace.id, secretBindings);
      let advanced = await state.configurations.advanceConfigurationGeneration(
        namespace.id,
        metadata.id,
        metadata.generation,
        secretBindings,
      );
      // A stored document ahead of the record holds content that was never recorded. The
      // replacement skips past every generation it went through, one advance at a time (the
      // record moves by exactly one per write), so no number names two documents.
      while (advanced && advanced.generation <= previous.generation) {
        advanced = await state.configurations.advanceConfigurationGeneration(
          namespace.id,
          metadata.id,
          advanced.generation,
          secretBindings,
        );
      }
      if (!advanced) {
        throw new ResourceStateConflictError(
          "The Configuration generation changed during its update.",
        );
      }
      const configuration: Configuration = Object.freeze({
        id: advanced.id,
        namespaceId: advanced.namespaceId,
        kind: advanced.kind,
        generation: advanced.generation,
        values,
        createdAt: advanced.createdAt,
      });
      await validateConfigurationWrite(driver, configuration, secretBindings);
      // Registered before the write: a replace that applied but answered with an error (a
      // timeout, a lost response) would otherwise leave the stored Configuration one generation
      // ahead of the rolled-back metadata (finding 911). A write that never applied is left alone,
      // and so is a stored generation another update committed after the lock was released. A
      // replacement of a leftover ahead of the record restores that leftover, which a retry can
      // replace again (finding 1396).
      deps.registerRollback(async () => {
        const stored = await driver.read({ id: previous.id, namespaceId: previous.namespaceId });
        if (
          stored.generation === configuration.generation &&
          (await configurationRecordUnchanged(metadata))
        ) {
          await driver.update(previous);
        }
      });
      const updated = await deps.driverOperation(() => driver.update(configuration));
      return exactConfiguration(updated, advanced);
    });
  }

  async function deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    configurationIdentity(namespaceId, configurationId);
    return deps.transact(async (state) => {
      const namespace = await deps.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "configuration",
        id: configurationId,
        namespaceId,
      });
      const driver = deps.configurationDriver();
      const configuration = await requireConfigurationRecord(
        state.configurations.lockConfiguration(namespace.id, configurationId),
      );
      const agents = await state.agents.listAgents(namespace.id);
      if (agents.some((agent) => agent.configurationId === configuration.id)) {
        throw new ResourceStateConflictError(
          "An Agent still references the Configuration. Delete the Agent or select another Configuration first.",
        );
      }
      // A provisioning record references the Configuration it created. Once its Agent has
      // succeeded and selects another Configuration (checked above), the record releases it.
      if (
        (await state.provisioning.findByConfiguration(namespace.id, configuration.id)) !==
          undefined &&
        !(await state.provisioning.releaseConfiguration(namespace.id, configuration.id))
      ) {
        throw new ResourceStateConflictError(
          "An Agent provisioning request that has not succeeded still references the Configuration. Let it finish or retry it, or delete the Agent it provisioned, first.",
        );
      }
      // A record whose document a failed delete already removed has nothing left to delete or
      // restore (finding 1396); only a Driver that confirms the absence lets it go.
      const previous = await lockedConfiguration(driver, configuration).catch(
        async (error: unknown) => {
          if (await configurationAbsent(driver, configuration)) {
            return undefined;
          }
          throw error;
        },
      );
      if (previous !== undefined) {
        // Registered before the write: a delete that applied but answered with an error would
        // otherwise leave the metadata without its ConfigMap (finding 916). The rollback
        // recreates the previous Configuration only when it is gone and its record is still the
        // one locked here; one still stored exactly means the delete never applied, and a record
        // another request deleted or changed in the meantime is that request's (finding 945). A
        // Driver that cannot inspect it is compensated only after a delete it saw succeed.
        let deleted = false;
        deps.registerRollback(async () => {
          if (driver.inspectExact === undefined) {
            if (!deleted) {
              return;
            }
          } else if (
            (await deps.driverOperation(() => driver.inspectExact!(previous))) !== undefined
          ) {
            return;
          }
          if (await configurationRecordUnchanged(configuration)) {
            await deps.driverOperation(() => driver.create(previous));
          }
        });
        await deps.driverOperation(() =>
          driver.delete({ id: configuration.id, namespaceId: namespace.id }),
        );
        deleted = true;
      }
      const removed = await accessBindingsTargeting(
        state,
        namespace.id,
        "configuration",
        configuration.id,
      );
      if (!(await state.configurations.deleteConfiguration(namespace.id, configuration.id))) {
        throw new ResourceStateConflictError("The Configuration changed during deletion.");
      }
      return removed;
    });
  }

  function configurationIdentity(namespaceId: string, configurationId: string): void {
    namespaceIdentity(namespaceId);
    if (!isNonEmptyString(configurationId)) {
      throw new ScopeViolationError("The exact Configuration identity is missing.");
    }
  }

  /**
   * Compensations run after the failed transaction's ROLLBACK released its row locks, so another
   * request may have deleted or updated the Configuration in between (finding 945). A
   * compensation restores the previous document only while the record is still the one the
   * failed request locked; otherwise that later write owns the backend state. A state read that
   * fails counts as unchanged: the failure is usually the same outage that failed the request,
   * when no other request can commit either, and skipping would leave the metadata without its
   * ConfigMap (finding 916).
   */
  async function configurationRecordUnchanged(
    expected: Pick<Configuration, "id" | "namespaceId" | "generation" | "createdAt">,
  ): Promise<boolean> {
    const current = await deps
      .read((state) => state.configurations.findConfiguration(expected.namespaceId, expected.id))
      .catch(() => "unreadable" as const);
    if (current === "unreadable") {
      return true;
    }
    return (
      current !== undefined &&
      current.generation === expected.generation &&
      current.createdAt === expected.createdAt
    );
  }

  /**
   * The stored Configuration behind a record that update or delete holds locked. A failed update
   * whose compensation could not run (a crash, a lost COMMIT acknowledgement that hid a rollback,
   * or a compensation read that failed in the same outage) leaves the stored document one
   * generation ahead of the record, and each such failure during recovery one more (finding
   * 1396). The record lock keeps other requests out, so a document up to
   * MAX_CONFIGURATION_LEFTOVER_LEAD generations ahead is a leftover, not a write in flight; it is
   * returned at its own generation, for update to replace and delete to remove. Another
   * request's compensation runs without the lock, but the Kubernetes Driver refuses a replace
   * that does not move the generation by exactly one from the document it read, or whose
   * resource version changed since, so the later of two writes fails and rolls back. Reads and
   * deploys keep refusing the leftover, so unrecorded content is never served or recorded.
   */
  async function lockedConfiguration(
    driver: ConfigurationDriver,
    record: Pick<
      Configuration,
      "id" | "namespaceId" | "kind" | "generation" | "createdAt" | "secretBindings"
    >,
  ): Promise<Readonly<Configuration>> {
    const stored = await deps.driverOperation(() =>
      driver.read({ id: record.id, namespaceId: record.namespaceId }),
    );
    const lead = Number.isSafeInteger(stored?.generation)
      ? stored.generation - record.generation
      : 0;
    return exactConfiguration(
      stored,
      lead > 0 && lead <= MAX_CONFIGURATION_LEFTOVER_LEAD
        ? { ...record, generation: stored.generation }
        : record,
    );
  }

  /**
   * Whether the Driver confirms that nothing is stored for a record: a failed delete whose
   * compensation could not run leaves the record without its document (finding 1396). Only exact
   * inspection tells absence from an unreachable backend: it answers undefined only when nothing
   * is stored, and any stored document answers or conflicts with the placeholder values. A Driver
   * without it, or one that fails, does not confirm absence.
   */
  async function configurationAbsent(
    driver: ConfigurationDriver,
    record: Pick<Configuration, "id" | "namespaceId" | "kind" | "generation" | "createdAt">,
  ): Promise<boolean> {
    if (driver.inspectExact === undefined) {
      return false;
    }
    const placeholder: Configuration = {
      id: record.id,
      namespaceId: record.namespaceId,
      kind: record.kind,
      generation: record.generation,
      values: {},
      createdAt: record.createdAt,
    };
    try {
      return (await driver.inspectExact(placeholder)) === undefined;
    } catch {
      return false;
    }
  }

  /**
   * The Configuration content rules every write runs, in one order, so a value one refuses is
   * refused, with the same message, wherever it is written: Configuration create and update,
   * Agent provisioning and Preset defaults (finding 1311). A Preset save passes `options`,
   * locating its unfilled variables. The model provider settings; the Codex approval policy and
   * a literal Gateway password; the agents shape, fallback provider and Gateway roster rules
   * (findings 1305 and 1308); then the selected Compute Driver's rules. A write that saves Secret
   * bindings with the values passes them: on the bundled Kubernetes Compute, which delivers
   * channel credentials only from bindings, a channel credential reference without one is then
   * refused with the rule its deployment admission applies (finding 2319). Agent provisioning,
   * whose Configuration serves only the new Agent, passes that `agent` for the model policy
   * refusals' offers (finding 3036).
   */
  function validateConfigurationContent(
    values: OpenClawConfigurationDocument,
    options?: ConfigurationValidationOptions,
    secretBindings?: SecretBindings,
    agent?: ModelPolicyAgent,
  ): void {
    validateModelProviderSettings(values, options);
    validateConfigurationSettings(values, options);
    requireDeployableRoster(values, options, agent);
    deps.validateComputeConfiguration(values, options);
    if (secretBindings !== undefined) {
      deps.requireBundledChannelBindings(values, secretBindings);
    }
  }

  async function validateConfigurationWrite(
    driver: ConfigurationDriver,
    configuration: Configuration,
    secretBindings: SecretBindings,
  ): Promise<void> {
    // Reject an oversized document before traversing it for content validation.
    await driver.validateSize?.(configuration.values);
    validateConfigurationContent(configuration.values, undefined, secretBindings);
    await driver.validate(configuration);
  }

  /** Called under the Namespace lock, also taken by deletion and assignment. */
  async function authorizeBindings(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    bindings: SecretBindings,
  ): Promise<readonly Secret[]> {
    const secrets = new Map<string, Secret>();
    for (const { source } of Object.values(bindings)) {
      if (source.namespaceId !== namespaceId) {
        throw new ScopeViolationError("Secret references cannot cross Namespaces.");
      }
      await deps.authorize(principalId, "operate", source);
      const secret = await state.secrets.lockSecret(namespaceId, source.id);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      deps.ownedSecretDriver(secret.driverId, () => new SecretBindingDriverError());
      secrets.set(secret.id, secret);
    }
    return Object.freeze([...secrets.values()]);
  }

  return {
    authorizeBindings,
    authorizeConfigurationWrite,
    createConfiguration,
    getConfiguration,
    savedConfigurationReader,
    getConfigurationSecretBindingSources,
    updateConfiguration,
    deleteConfiguration,
    configurationIdentity,
    validateConfigurationContent,
  };
}
