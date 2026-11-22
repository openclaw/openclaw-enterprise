import type { IAMPolicyOperations } from "./iam-policy-operations.ts";
import { normalizeAgentPluginApprovers } from "./agent-plugin-validation.ts";
import { isDeepStrictEqual } from "node:util";
import {
  isName,
  NAME_RULE,
  normalizePresetTemplate,
  presetTemplateDefaultsWithPlaceholders,
  presetValueHasVariables,
  PresetValidationError,
  type BackendRef,
  type ConfigurationDriver,
  type ConfigurationValidationOptions,
  type Namespace,
  type OpenClawConfigurationDocument,
  type Preset,
  type PresetDraftDefinition,
  type PresetDraftTemplate,
  type PresetSummary,
  type PresetTemplate,
  type ResourceRef,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import type { DriverRegistry } from "./driver-registry.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  PluginPolicyValidationError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { accessBindingsTargeting, type RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

/** One shipped version of a bundled default Preset (`deploy/presets/archive/versions.json`). */
export interface BundledPresetVersion extends PresetDraftDefinition {
  /** Bundled file this version shipped as, for example `standard-codex.json`. */
  readonly file: string;
  /** Canonical-JSON digest that names this version in the archive. */
  readonly version: string;
  /** True for the version the running release ships. */
  readonly current: boolean;
}

/**
 * Which refusals of a default Preset refresh startup skips instead of failing on.
 * `restricted`: a deny Restriction, which binds every principal alike. `denied`: any refusal.
 * Either also skips creating a missing default that a deny Restriction refuses; a creation
 * refused for any other reason still fails.
 */
export type DefaultPresetRefreshSkip = "none" | "restricted" | "denied";

/** A superseded default Preset copy left in place because the policy refused its refresh. */
export interface SkippedDefaultPresetRefresh {
  readonly operation: "update";
  readonly namespaceId: string;
  readonly presetId: string;
  readonly presetName: string;
  readonly reason: string;
  readonly restrictionIds: readonly string[];
}

/** A missing default Preset left uncreated because a deny Restriction refused its creation. */
export interface SkippedDefaultPresetCreation {
  readonly operation: "create";
  readonly namespaceId: string;
  readonly presetName: string;
  readonly reason: string;
  readonly restrictionIds: readonly string[];
}

export type SkippedDefaultPreset = SkippedDefaultPresetRefresh | SkippedDefaultPresetCreation;

export interface CreatePresetInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly template: PresetTemplate;
}

export interface UpdatePresetInput {
  readonly namespaceId: string;
  readonly presetId: string;
  readonly name?: string;
  readonly template?: PresetTemplate;
}

interface PresetDefaults {
  readonly defaultPresets?: readonly PresetDraftDefinition[];
  readonly bundledPresetVersions?: readonly BundledPresetVersion[];
  readonly refreshBundledDefaultPresets?: boolean;
}

interface PresetDependencies {
  readonly installationId: string;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority" | "readableListRows">;
  readonly bindCreator: IAMPolicyOperations["bindCreator"];
  getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>>;
  nextPresetId(): string;
  timestamp(): string;
  configurationDriver(): Pick<ConfigurationDriver, "validateValues">;
  validateConfigurationContent(
    values: OpenClawConfigurationDocument,
    options: ConfigurationValidationOptions,
  ): void;
  validateAgentBackend(backendId: BackendRef): void;
  readonly drivers: Pick<DriverRegistry, "hasPluginDrivers" | "enabledPluginDrivers">;
}

export function createPresetOperations(options: PresetDefaults, dependencies: PresetDependencies) {
  const { read, transact } = dependencies.transactions;
  const { authorize, holdAuthority, readableListRows } = dependencies.authority;
  const defaultPresets = immutableCopy(options.defaultPresets ?? []);
  const presetNames = new Set<string>();
  for (const preset of defaultPresets) {
    if (!isName(preset.name) || presetNames.has(preset.name)) {
      throw new PresetValidationError(
        `Default Presets require distinct names that follow the Name rule: ${NAME_RULE}.`,
      );
    }
    presetNames.add(preset.name);
  }
  const bundledPresetVersions = immutableCopy(options.bundledPresetVersions ?? []);
  const refreshBundledDefaultPresets = options.refreshBundledDefaultPresets === true;

  /**
   * Apply trusted Installation defaults: create missing names and refresh copies still equal
   * to a superseded bundled version. Edited copies are never replaced.
   */
  async function initializeDefaultPresets(
    principalId: string,
    options: { readonly skipRefusedRefresh?: DefaultPresetRefreshSkip } = {},
  ): Promise<readonly SkippedDefaultPreset[]> {
    const skipped: SkippedDefaultPreset[] = [];
    if (defaultPresets.length === 0) {
      return skipped;
    }
    const skip = options.skipRefusedRefresh ?? "none";
    await transact(async (state) => {
      await holdAuthority(state);
      await authorize(principalId, "administer", {
        kind: "installation",
        id: dependencies.installationId,
      });
      const namespaces = [...(await state.namespaces.listNamespaces())].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      for (const namespace of namespaces) {
        const current = await state.namespaces.lockNamespace(namespace.id);
        if (current && ["provisioning", "ready"].includes(current.status)) {
          await ensureNamespaceDefaultPresets(state, principalId, current, {
            skip,
            skipped,
          });
        }
      }
    });
    return Object.freeze(skipped);
  }

  async function ensureNamespaceDefaultPresets(
    state: PlatformUnitOfWork,
    principalId: string,
    namespace: Readonly<Namespace>,
    refresh: {
      readonly skip: DefaultPresetRefreshSkip;
      readonly skipped: SkippedDefaultPreset[];
    } = { skip: "none", skipped: [] },
  ): Promise<void> {
    if (defaultPresets.length === 0) {
      return;
    }
    const existing = refreshBundledDefaultPresets
      ? new Map(
          (await state.presets.listPresets(namespace.id)).map((preset) => [preset.name, preset]),
        )
      : undefined;
    const existingNames = existing
      ? undefined
      : new Set((await state.presets.listPresetSummaries(namespace.id)).map(({ name }) => name));
    for (const preset of defaultPresets) {
      const copy = existing?.get(preset.name);
      if (copy !== undefined) {
        await refreshSupersededDefaultPreset(state, principalId, namespace, preset, copy, refresh);
        continue;
      }
      if (existingNames?.has(preset.name)) {
        continue;
      }
      try {
        await authorize(principalId, "create", {
          kind: "preset",
          id: namespace.id,
          namespaceId: namespace.id,
        });
      } catch (error) {
        // A deny Restriction binds every administrator alike, for example one set to freeze
        // a Namespace's Presets after an operator removed a default, so startup leaves the
        // default missing instead of failing. A missing grant still fails, so another
        // administrator can create it. Outages still fail.
        if (
          !(error instanceof AuthorizationDeniedError) ||
          error instanceof DependencyUnavailableError
        ) {
          throw error;
        }
        const restrictionIds = error.evidence?.restrictionIds ?? [];
        if (refresh.skip === "none" || restrictionIds.length === 0) {
          throw error;
        }
        refresh.skipped.push(
          Object.freeze({
            operation: "create",
            namespaceId: namespace.id,
            presetName: preset.name,
            reason: error.message,
            restrictionIds: Object.freeze([...restrictionIds]),
          }),
        );
        continue;
      }
      const template = await admitPresetTemplate(preset.template, namespace.id);
      const created = await state.presets.createPreset({
        id: dependencies.nextPresetId(),
        namespaceId: namespace.id,
        name: preset.name,
        template,
        createdAt: dependencies.timestamp(),
      });
      await dependencies.bindCreator(state, principalId, {
        kind: "preset",
        id: created.id,
        namespaceId: namespace.id,
      });
      await state.audit.append({
        id: `aud_${crypto.randomUUID()}`,
        installationId: dependencies.installationId,
        namespaceId: namespace.id,
        occurredAt: dependencies.timestamp(),
        kind: "mutation",
        actorId: principalId,
        source: "occ",
        action: "openclaw.presets.create",
        resource: { kind: "preset", id: created.id, namespaceId: namespace.id },
        outcome: "success",
        details: { source: "installation-defaults" },
      });
    }
  }

  /**
   * Replace a bundled default's Namespace copy that still equals a superseded shipped
   * version of it, keeping its ID and grants. Any other content is an operator edit and stays.
   */
  async function refreshSupersededDefaultPreset(
    state: PlatformUnitOfWork,
    principalId: string,
    namespace: Readonly<Namespace>,
    seeded: PresetDraftDefinition,
    copy: Readonly<Preset>,
    refresh: {
      readonly skip: DefaultPresetRefreshSkip;
      readonly skipped: SkippedDefaultPreset[];
    },
  ): Promise<void> {
    // Only bundled defaults have a history. Even with refresh enabled, a `presets.files`
    // entry is refreshed only if it equals the current bundled version of its name.
    const current = bundledPresetVersions.find(
      (version) =>
        version.current &&
        version.name === seeded.name &&
        isDeepStrictEqual(version.template, seeded.template),
    );
    // A file reverted to an earlier version lists it as superseded too; current wins.
    if (current === undefined || presetMatchesTemplate(copy, current.template)) {
      return;
    }
    const superseded = bundledPresetVersions.find(
      (version) =>
        !version.current &&
        version.file === current.file &&
        version.name === copy.name &&
        presetMatchesTemplate(copy, version.template),
    );
    if (superseded === undefined) {
      return;
    }
    try {
      await authorize(principalId, "update", {
        kind: "preset",
        id: copy.id,
        namespaceId: namespace.id,
      });
    } catch (error) {
      // A refusal is the policy's answer, for example a Restriction an administrator set to
      // freeze Presets, so startup keeps the copy instead of failing. Outages still fail.
      if (
        !(error instanceof AuthorizationDeniedError) ||
        error instanceof DependencyUnavailableError
      ) {
        throw error;
      }
      const restrictionIds = error.evidence?.restrictionIds ?? [];
      if (
        refresh.skip === "none" ||
        (refresh.skip === "restricted" && restrictionIds.length === 0)
      ) {
        throw error;
      }
      refresh.skipped.push(
        Object.freeze({
          operation: "update",
          namespaceId: namespace.id,
          presetId: copy.id,
          presetName: copy.name,
          reason: error.message,
          restrictionIds: Object.freeze([...restrictionIds]),
        }),
      );
      return;
    }
    const template = await admitPresetTemplate(seeded.template, namespace.id);
    const updated = await state.presets.updatePreset(namespace.id, copy.id, { template });
    if (!updated) {
      throw new ResourceStateConflictError("The Preset changed during default refresh.");
    }
    await state.audit.append({
      id: `aud_${crypto.randomUUID()}`,
      installationId: dependencies.installationId,
      namespaceId: namespace.id,
      occurredAt: dependencies.timestamp(),
      kind: "mutation",
      actorId: principalId,
      source: "occ",
      action: "openclaw.presets.update",
      resource: { kind: "preset", id: copy.id, namespaceId: namespace.id },
      outcome: "success",
      details: {
        source: "installation-defaults-refresh",
        previousVersion: superseded.version,
        version: current.version,
      },
    });
  }

  async function createPreset(
    principalId: string,
    input: CreatePresetInput,
  ): Promise<Readonly<Preset>> {
    if (!isName(input.name)) {
      throw new PresetValidationError("The Preset name is invalid.");
    }
    namespaceIdentity(input.namespaceId);
    return transact(async (state) => {
      await holdAuthority(state);
      const target: ResourceRef = {
        kind: "preset",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await authorize(principalId, "create", target);
      const namespace = await lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await authorize(principalId, "create", target);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const template = await admitPresetTemplate(input.template, namespace.id);
      const preset = await state.presets.createPreset({
        id: dependencies.nextPresetId(),
        namespaceId: namespace.id,
        name: input.name,
        template,
        createdAt: dependencies.timestamp(),
      });
      await dependencies.bindCreator(state, principalId, {
        kind: "preset",
        id: preset.id,
        namespaceId: namespace.id,
      });
      return preset;
    });
  }

  /** Return readable Preset summaries. */
  async function listPresets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<PresetSummary>[]> {
    const namespace = await dependencies.getNamespace(principalId, namespaceId);
    return read(async (state) =>
      readableListRows(
        principalId,
        namespace.id,
        "preset",
        await state.presets.listPresetSummaries(namespace.id),
      ),
    );
  }

  async function getPreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<Readonly<Preset>> {
    await authorize(principalId, "read", {
      kind: "preset",
      id: presetId,
      namespaceId,
    });
    return read(async (state) => {
      await exactNamespace(state, namespaceId);
      const preset = await state.presets.findPreset(namespaceId, presetId);
      if (!preset) {
        throw new ScopeViolationError("The Preset does not belong to the exact Namespace.");
      }
      return preset;
    });
  }

  /**
   * Check the collection grant for a create or the exact Preset grant for an update.
   * The HTTP layer calls this before reading the body. Both writes repeat the check in
   * their transaction.
   */
  async function authorizePresetWrite(
    principalId: string,
    namespaceId: string,
    presetId?: string,
  ): Promise<void> {
    namespaceIdentity(namespaceId);
    await authorize(principalId, presetId === undefined ? "create" : "update", {
      kind: "preset",
      id: presetId ?? namespaceId,
      namespaceId,
    });
  }

  async function updatePreset(
    principalId: string,
    input: UpdatePresetInput,
  ): Promise<Readonly<Preset>> {
    if (input.name !== undefined && !isName(input.name)) {
      throw new PresetValidationError("The Preset name is invalid.");
    }
    namespaceIdentity(input.namespaceId);
    return transact(async (state) => {
      await authorize(principalId, "update", {
        kind: "preset",
        id: input.presetId,
        namespaceId: input.namespaceId,
      });
      const namespace = await lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (!(await state.presets.lockPreset(namespace.id, input.presetId))) {
        throw new ScopeViolationError("The Preset does not belong to the exact Namespace.");
      }
      const template =
        input.template === undefined
          ? undefined
          : await admitPresetTemplate(input.template, namespace.id);
      const updated = await state.presets.updatePreset(namespace.id, input.presetId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(template === undefined ? {} : { template }),
      });
      if (!updated) {
        throw new ResourceStateConflictError("The Preset changed during update.");
      }
      return updated;
    });
  }

  /** Returns the AccessBindings removed with the Preset, for its deletion audit. */
  async function deletePreset(
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    namespaceIdentity(namespaceId);
    return transact(async (state) => {
      // Authorize before any lookup to conceal target existence. Check again under the
      // Namespace lock to catch concurrent revocation.
      await authorize(principalId, "delete", {
        kind: "preset",
        id: presetId,
        namespaceId,
      });
      const namespace = await lockNamespace(state, namespaceId);
      return deletePresetInState(state, principalId, namespace.id, presetId);
    });
  }

  async function deletePresetInState(
    state: PlatformUnitOfWork,
    principalId: string,
    namespaceId: string,
    presetId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    await authorize(principalId, "delete", {
      kind: "preset",
      id: presetId,
      namespaceId,
    });
    if (!(await state.presets.lockPreset(namespaceId, presetId))) {
      throw new ScopeViolationError("The Preset does not belong to the exact Namespace.");
    }
    const removed = await accessBindingsTargeting(state, namespaceId, "preset", presetId);
    for (const binding of removed) {
      await state.iamPolicy.deleteAccessBinding(namespaceId, binding.id);
    }
    if (!(await state.presets.deletePreset(namespaceId, presetId))) {
      throw new ResourceStateConflictError("The Preset changed during deletion.");
    }
    return removed;
  }

  /**
   * True when a Preset still equals, by name and template, an Installation default or any
   * shipped version of a bundled default, so it is release content rather than an operator's.
   */
  function isUnmodifiedDefaultPreset(preset: Readonly<Preset>): boolean {
    return [...defaultPresets, ...bundledPresetVersions].some(
      (known) => known.name === preset.name && presetMatchesTemplate(preset, known.template),
    );
  }

  function presetMatchesTemplate(preset: Readonly<Preset>, template: PresetDraftTemplate): boolean {
    try {
      return isDeepStrictEqual(
        normalizePresetTemplate(template, preset.namespaceId),
        preset.template,
      );
    } catch {
      return false;
    }
  }

  async function admitPresetTemplate(
    input: PresetDraftTemplate,
    namespaceId: string,
  ): Promise<PresetTemplate> {
    const template = normalizePresetTemplate(input, namespaceId);
    const { settings, unresolved, unresolvedType } =
      presetTemplateDefaultsWithPlaceholders(template);
    validatePresetLaunchFields(template);
    const values = settings.configuration?.values;
    if (values !== undefined) {
      const driver = dependencies.configurationDriver();
      if (!driver.validateValues) {
        throw new DependencyUnavailableError(
          "The selected Configuration Driver cannot validate Preset values.",
        );
      }
      // Use the same content rules as Configuration writes. Defer unresolved variables
      // only at paths identified by the renderer. Escaped tokens remain literal text.
      const options: ConfigurationValidationOptions = { unresolved, unresolvedType };
      dependencies.validateConfigurationContent(values, options);
      // Validation owns native credential rules; Preset CRUD never creates runtime resources.
      await driver.validateValues(values, options);
    }
    return template;
  }

  /**
   * Apply Agent creation rules to literal fields at save time. Fields with variable tokens
   * wait until launch because launch can override defaults. Check literal plugin approvers
   * when a Plugin Driver is selected.
   */
  function validatePresetLaunchFields(template: PresetTemplate): void {
    const agent = template.agent;
    if (agent === undefined) {
      return;
    }
    const literal = (field: string) =>
      Object.hasOwn(agent, field) &&
      !presetValueHasVariables(agent[field], template.variables ?? {}, `agent.${field}`);
    const refuse = (field: string, requirement: string): never => {
      throw new PresetValidationError(`Preset agent.${field}: ${requirement}`);
    };
    if (literal("name") && !isName(agent.name)) {
      refuse("name", `must be ${NAME_RULE}.`);
    }
    if (
      literal("executionMode") &&
      !["embedded", "dedicated"].includes(agent.executionMode as string)
    ) {
      refuse("executionMode", 'must be "embedded" or "dedicated".');
    }
    const checked = (field: string, check: () => unknown) => {
      try {
        check();
      } catch (error) {
        // Only create's own refusals: the base scope miss (an unconfigured Backend or one of
        // another kind) and the Plugin Driver's policy refusal, never a subclass.
        if (
          error?.constructor === ScopeViolationError ||
          error instanceof PluginPolicyValidationError
        ) {
          refuse(field, error.message);
        }
        throw error;
      }
    };
    if (literal("backendId") && agent.backendId !== null) {
      checked("backendId", () => dependencies.validateAgentBackend(agent.backendId as BackendRef));
    }
    if (literal("pluginApprovers") && dependencies.drivers.hasPluginDrivers()) {
      checked("pluginApprovers", () => {
        const approvers = normalizeAgentPluginApprovers(agent.pluginApprovers);
        // The Harness can be filled in at launch. Reject a literal here only when
        // every enabled catalog would refuse it.
        let refusal: PluginPolicyValidationError | undefined;
        for (const driver of dependencies.drivers.enabledPluginDrivers()) {
          try {
            driver.validatePolicies({}, approvers);
            return;
          } catch (error) {
            if (!(error instanceof PluginPolicyValidationError)) {
              throw error;
            }
            refusal ??= error;
          }
        }
        throw refusal;
      });
    }
  }

  return {
    initializeDefaultPresets,
    ensureNamespaceDefaultPresets,
    createPreset,
    listPresets,
    getPreset,
    authorizePresetWrite,
    updatePreset,
    deletePreset,
    deletePresetInState,
    isUnmodifiedDefaultPreset,
  };
}
