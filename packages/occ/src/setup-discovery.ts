import type {
  ChannelDirectoryLookupInput,
  ChannelDirectoryResult,
  ChannelDriver,
  ComputeDriver,
  ConfigurationContext,
  CredentialSourceReference,
  DriverConfigurationDescriptor,
  SandboxFacet,
  StaticCredentialSource,
  CredentialServiceDriver,
} from "@openclaw-enterprise/contracts";
import {
  asRecord,
  hasControlCharacter,
  immutableCopy,
  isNonEmptyString,
} from "@openclaw-enterprise/utils";
import type { DriverConfigurationRegistry } from "./configuration-registry.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import type { DriverRegistry } from "./driver-registry.ts";
import {
  AgentDeletingError,
  ChannelDirectoryError,
  ModelDiscoveryError,
  NotImplementedError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { exactNamespace } from "./resource-scope.ts";
import { driverOperation } from "./driver-operation.ts";
import { PROTECTED_SOURCE_TIMEOUT_MS } from "./credential-source-drivers.ts";

export interface LookupChannelDirectoryInput {
  readonly sourceId: string;
  readonly kind: ChannelDirectoryLookupInput["kind"];
  readonly query?: string;
  readonly cursor?: string;
  readonly ids?: readonly string[];
  readonly agentId?: string;
  readonly configurationId?: string;
}

interface SetupDiscoveryDependencies {
  readonly installationId: string;
  readonly transactions: Pick<ControllerTransactions, "read">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "authorizationDecision">;
  readonly configurations: Pick<DriverConfigurationRegistry, "list">;
  readonly drivers: Pick<DriverRegistry, "configurationDriverSelected">;
  readonly getAgentSandboxPolicy: (
    principalId: string,
    namespaceId: string,
    agentId: string,
    facet: SandboxFacet,
  ) => Promise<{ readonly configuration: DriverConfigurationDescriptor | undefined }>;
  readonly selectCompute: () => ComputeDriver;
  readonly selectChannel: () => ChannelDriver;
  readonly ownedCredentialServiceDriver: (instanceId: string) => CredentialServiceDriver;
  readonly gatewayStartupSourceDelivery:
    ((compute: ComputeDriver, owner: CredentialServiceDriver) => boolean) | undefined;
}

function validateChannelDirectoryInput(
  input: LookupChannelDirectoryInput,
): readonly string[] | undefined {
  const ids = input.ids;
  // Lengths count code points, as the API contract's JSON Schema maxLength does.
  const characters = (value: string): number => Array.from(value).length;
  const bounded = (value: unknown, max: number, allowEmpty = false): value is string =>
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    characters(value) <= max &&
    !value.includes("\u0000");
  if (
    !bounded(input.sourceId, 200) ||
    (input.kind !== "users" && input.kind !== "channels") ||
    (input.query !== undefined && !bounded(input.query, 200, true)) ||
    (input.cursor !== undefined && !bounded(input.cursor, 2048)) ||
    (ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 20 ||
        ids.some(
          (id) =>
            typeof id !== "string" ||
            id.length === 0 ||
            characters(id) > 200 ||
            hasControlCharacter(id),
        ) ||
        new Set(ids).size !== ids.length ||
        input.query !== undefined ||
        input.cursor !== undefined)) ||
    (input.agentId !== undefined && !bounded(input.agentId, 200)) ||
    (input.configurationId !== undefined && !bounded(input.configurationId, 200)) ||
    (input.agentId !== undefined && input.configurationId !== undefined)
  ) {
    throw new ScopeViolationError("The channel directory lookup input is invalid.");
  }
  return ids;
}

function validChannelDirectoryResult(value: unknown): value is ChannelDirectoryResult {
  const result = asRecord(value);
  const bounded = (candidate: unknown, maxLength: number): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= maxLength &&
    !hasControlCharacter(candidate);
  if (
    result === undefined ||
    !bounded(result.workspaceId, 200) ||
    (result.workspaceName !== undefined && !bounded(result.workspaceName, 200)) ||
    !Array.isArray(result.candidates) ||
    result.candidates.length > 100 ||
    (result.nextCursor !== undefined && !bounded(result.nextCursor, 2048)) ||
    typeof result.complete !== "boolean"
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of result.candidates) {
    const entry = asRecord(candidate);
    if (
      entry === undefined ||
      !bounded(entry.id, 200) ||
      !bounded(entry.name, 200) ||
      (entry.displayName !== undefined && !bounded(entry.displayName, 200)) ||
      ids.has(entry.id)
    ) {
      return false;
    }
    ids.add(entry.id);
  }
  return true;
}

function safeChannelDirectoryResult(
  result: unknown,
  ids: readonly string[] | undefined,
  token: string,
): { value: ChannelDirectoryResult } | { error: ChannelDirectoryError } {
  if (
    !validChannelDirectoryResult(result) ||
    (ids !== undefined &&
      (!result.complete ||
        result.nextCursor !== undefined ||
        result.candidates.some((candidate) => !ids.includes(candidate.id))))
  ) {
    return { error: new ChannelDirectoryError("invalid_response") };
  }
  const safeResult = {
    workspaceId: result.workspaceId,
    ...(result.workspaceName === undefined ? {} : { workspaceName: result.workspaceName }),
    candidates: result.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      ...(candidate.displayName === undefined ? {} : { displayName: candidate.displayName }),
    })),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    complete: result.complete,
  };
  if (JSON.stringify(safeResult).includes(JSON.stringify(token).slice(1, -1))) {
    return { error: new ChannelDirectoryError("invalid_response") };
  }
  return { value: immutableCopy(safeResult) };
}

export class SetupDiscovery {
  private readonly dependencies: SetupDiscoveryDependencies;

  constructor(dependencies: SetupDiscoveryDependencies) {
    this.dependencies = dependencies;
  }

  async discoverAgentModels(
    principalId: string,
    namespaceId: string,
    input: {
      readonly provider: string;
      readonly authMethod: "api_key" | "codex_pat";
      readonly apiKey: string;
    },
  ) {
    await this.dependencies.authority.authorize(principalId, "create", {
      kind: "agent",
      id: namespaceId,
      namespaceId,
    });
    await this.dependencies.transactions.read((state) => exactNamespace(state, namespaceId));
    const driver = this.dependencies.selectCompute();
    if (!driver.discoverHarnessModels) {
      throw new NotImplementedError(
        "agent_models.discovery",
        "Model discovery is unavailable. Enter a model ID manually.",
      );
    }
    // Discovery performs no platform writes and must not hold a transaction over provider I/O.
    try {
      return await driver.discoverHarnessModels(input);
    } catch (error) {
      throw new ModelDiscoveryError(
        error instanceof ModelDiscoveryError ? error.reason : "unavailable",
      );
    }
  }

  async lookupChannelDirectory(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
    signal?: AbortSignal,
  ): Promise<ChannelDirectoryResult> {
    const ids = validateChannelDirectoryInput(input);
    const first = await this.channelDirectorySource(principalId, namespaceId, input);
    let driver: ChannelDriver;
    try {
      driver = this.dependencies.selectChannel();
    } catch {
      throw new NotImplementedError(
        "channel_directory.lookup",
        "Channel directory lookup is unavailable.",
      );
    }
    // Source metadata lookup is asynchronous. Repeat exact authority immediately before custody.
    await this.authorizeChannelDirectoryUse(principalId, namespaceId, input);
    let token: string;
    try {
      const timeout = AbortSignal.timeout(PROTECTED_SOURCE_TIMEOUT_MS);
      const resolved = await driverOperation(
        () =>
          first.owner.resolveCredential(
            {
              sourceRef: first.ref,
              credentialServiceInstanceId: first.source.credentialServiceInstanceId,
            },
            signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
          ),
        "CredentialService",
      );
      if (!isNonEmptyString(resolved.credential) || !isNonEmptyString(resolved.version)) {
        throw new ChannelDirectoryError("invalid_response");
      }
      token = resolved.credential;
    } catch {
      throw new ChannelDirectoryError("unavailable");
    }
    // Recheck both target and Source authority, readiness, selected owner, and delivery
    // qualification after owner I/O before the Channel Driver can contact Slack.
    const current = await this.channelDirectorySource(principalId, namespaceId, input);
    if (
      current.source.credentialServiceInstanceId !== first.source.credentialServiceInstanceId ||
      current.owner !== first.owner ||
      current.compute !== first.compute
    ) {
      throw new ResourceStateConflictError(
        "The channel directory credential changed. Refresh and retry.",
      );
    }
    await this.authorizeChannelDirectoryUse(principalId, namespaceId, input);
    let result: ChannelDirectoryResult;
    try {
      result = await driver.lookupDirectory(
        {
          token,
          kind: input.kind,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(ids === undefined ? {} : { ids }),
        },
        signal,
      );
    } catch (error) {
      throw new ChannelDirectoryError(
        error instanceof ChannelDirectoryError ? error.reason : "unavailable",
      );
    }
    const outcome = safeChannelDirectoryResult(result, ids, token);
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  private async authorizeChannelDirectoryUse(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
  ): Promise<void> {
    if (input.agentId !== undefined) {
      await this.dependencies.authority.authorize(principalId, "update", {
        kind: "agent",
        id: input.agentId,
        namespaceId,
      });
    } else if (input.configurationId !== undefined) {
      await this.dependencies.authority.authorize(principalId, "update", {
        kind: "configuration",
        id: input.configurationId,
        namespaceId,
      });
    } else {
      await this.dependencies.authority.authorize(principalId, "create", {
        kind: "agent",
        id: namespaceId,
        namespaceId,
      });
    }
    await this.dependencies.authority.authorize(principalId, "operate", {
      kind: "credential_source",
      id: input.sourceId,
      namespaceId,
    });
  }

  private async channelDirectorySource(
    principalId: string,
    namespaceId: string,
    input: LookupChannelDirectoryInput,
  ): Promise<{
    readonly ref: CredentialSourceReference;
    readonly source: Readonly<StaticCredentialSource>;
    readonly owner: CredentialServiceDriver;
    readonly compute: ComputeDriver;
  }> {
    await this.authorizeChannelDirectoryUse(principalId, namespaceId, input);
    return this.dependencies.transactions.read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      if (input.agentId !== undefined) {
        const agent = await state.agents.findAgent(namespace.id, input.agentId);
        if (agent === undefined) {
          throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
        }
        if (agent.status !== "active") {
          throw new AgentDeletingError();
        }
      } else if (input.configurationId !== undefined) {
        const configuration = await state.configurations.findConfiguration(
          namespace.id,
          input.configurationId,
        );
        if (configuration?.kind !== "agent") {
          throw new ScopeViolationError(
            "The Configuration does not belong to the exact Namespace.",
          );
        }
      }
      const source = await state.credentialSources.findCredentialSource(
        namespace.id,
        input.sourceId,
      );
      if (source === undefined) {
        throw new ScopeViolationError(
          "The Credential Source does not belong to the exact Namespace.",
        );
      }
      if (
        source.ownerCapability !== "credential_service" ||
        source.type !== "static" ||
        source.state !== "ready"
      ) {
        throw new ResourceStateConflictError(
          "Channel directory lookup requires a ready static CredentialService Credential Source.",
        );
      }
      const owner = this.dependencies.ownedCredentialServiceDriver(
        source.credentialServiceInstanceId,
      );
      const compute = this.dependencies.selectCompute();
      if (this.dependencies.gatewayStartupSourceDelivery?.(compute, owner) !== true) {
        throw new ResourceStateConflictError(
          "The selected Compute and CredentialService do not support Gateway Source delivery.",
        );
      }
      return {
        ref: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
        source,
        owner,
        compute,
      };
    });
  }

  async discoverConfigurations(
    principalId: string,
    context: ConfigurationContext,
  ): Promise<readonly DriverConfigurationDescriptor[]> {
    if (context.scope === "installation") {
      await this.dependencies.authority.authorize(principalId, "administer", {
        kind: "installation",
        id: this.dependencies.installationId,
      });
      return this.dependencies.configurations
        .list("installation")
        .filter((entry) =>
          this.dependencies.drivers.configurationDriverSelected(entry.capability, entry.driverId),
        )
        .map((entry) => ({
          capability: entry.capability,
          driverId: entry.driverId,
          implementation: entry.implementation,
          scope: entry.contribution.scope,
          key: entry.contribution.key,
          configurationSchema: entry.contribution.configurationSchema,
          ...(entry.startupConfiguration === undefined
            ? {}
            : { startupConfiguration: entry.startupConfiguration }),
          binding: entry.binding,
          actions: {},
        }));
    }
    if (context.scope !== "agent") {
      throw new ScopeViolationError("Unsupported configuration scope.");
    }
    const { namespaceId, agentId } = context;
    await this.dependencies.authority.authorize(principalId, "read", {
      kind: "agent",
      id: agentId,
      namespaceId,
    });
    await this.dependencies.transactions.read(async (state) => {
      await exactNamespace(state, namespaceId);
      if ((await state.agents.findAgent(namespaceId, agentId)) === undefined) {
        throw new ScopeViolationError("The Agent is unavailable in this Namespace.");
      }
    });
    const configurations: DriverConfigurationDescriptor[] = [];
    for (const entry of this.dependencies.configurations.list("agent")) {
      if (
        !this.dependencies.drivers.configurationDriverSelected(entry.capability, entry.driverId)
      ) {
        continue;
      }
      if (entry.binding === "sandbox-policy") {
        const decision = await this.dependencies.authority.authorizationDecision(
          principalId,
          "read",
          {
            kind: "sandbox_policy",
            id: `sbp_${agentId.slice(4)}`,
            namespaceId,
          },
        );
        if (!decision.decision.allowed) {
          continue;
        }
        const view = await this.dependencies.getAgentSandboxPolicy(
          principalId,
          namespaceId,
          agentId,
          "networking",
        );
        if (view.configuration !== undefined) {
          configurations.push(view.configuration);
        }
      }
    }
    return configurations;
  }
}
