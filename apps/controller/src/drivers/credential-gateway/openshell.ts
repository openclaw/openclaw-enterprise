import type {
  Backend,
  CredentialAttachmentStatus,
  CredentialGatewayContext,
  CredentialGatewayDriver,
  CredentialRevisionContext,
  CredentialWithdrawalContext,
  CredentialSourceAttachment,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
  CredentialSourceType,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";

import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
} from "../sandbox/openshell-gateway-client.ts";

export interface OpenShellCredentialGatewayOptions {
  /** Absolute paths of the Harness binaries allowed to reach credentialed endpoints. */
  readonly binaries: readonly string[];
}

export interface OpenShellCredentialGatewaySelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly backend: Backend<OpenShellGateway>;
}

class OpenShellCredentialGatewayFailure extends Error {}

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY = "openclaw-enterprise";
const SOURCE_ID_LABEL = "openclaw.dev/credential-source-id";
const NAMESPACE_ID_LABEL = "openclaw.dev/namespace-id";
const PROFILE_DIGEST_ANNOTATION = "openclaw.dev/profile-digest";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BASE_URL_CONFIG = "base_url";

interface OpenShellSourceType {
  readonly catalog: CredentialSourceType;
  /** Catalog secret field → the provider credential key OpenShell exposes. */
  readonly credentials: Readonly<Record<string, string>>;
  profile(
    binaries: readonly string[],
    baseUrl: string,
  ): Omit<OpenShellProviderProfile, "annotations">;
}

// TODO(credential-gateway next slice): add external and OAuth2 gateway-refresh source types.
const SOURCE_TYPES: readonly OpenShellSourceType[] = Object.freeze([
  {
    catalog: Object.freeze({
      type: "openai",
      config: Object.freeze([
        Object.freeze({
          name: OPENAI_BASE_URL_CONFIG,
          required: false,
          description: "HTTPS base URL for the OpenAI-compatible endpoint.",
        }),
      ]),
      secrets: Object.freeze([
        Object.freeze({ name: "api_key", required: true, description: "OpenAI API key." }),
      ]),
      rotation: "none",
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "api_key" }),
    }),
    credentials: Object.freeze({ api_key: "OPENAI_API_KEY" }),
    profile: (binaries: readonly string[], baseUrl: string) => {
      const endpoint = new URL(baseUrl);
      return {
        id:
          baseUrl === OPENAI_DEFAULT_BASE_URL
            ? "oce-openai"
            : `oce-openai-${sha256Hex(baseUrl, 12)}`,
        displayName: "OpenAI-compatible API key (OpenClaw Enterprise)",
        category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" as const,
        credentials: [
          {
            name: "api_key",
            envVars: ["OPENAI_API_KEY"],
            required: true,
            authStyle: "bearer",
            headerName: "authorization",
          },
        ],
        endpoints: [
          {
            host: endpoint.hostname,
            port: Number(endpoint.port || 443),
            protocol: "rest",
            path: `${endpoint.pathname}/**`,
          },
        ],
        binaries,
        inferenceCapable: true,
      };
    },
  },
]);

function validateOptions(options: OpenShellCredentialGatewayOptions): void {
  const record = asRecord(options);
  if (record === undefined) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell Credential Gateway configuration is required.",
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "binaries") {
      throw new OpenShellCredentialGatewayFailure(
        `OpenShell Credential Gateway configuration contains unsupported option ${key}.`,
      );
    }
  }
  if (
    !Array.isArray(options.binaries) ||
    options.binaries.length === 0 ||
    options.binaries.some((path) => !isNonEmptyString(path) || !isAbsolute(path))
  ) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.",
    );
  }
}

function sourceType(type: string): OpenShellSourceType {
  const found = SOURCE_TYPES.find((entry) => entry.catalog.type === type);
  if (found === undefined) {
    throw new ScopeViolationError("The OpenShell Credential Gateway does not support this type.");
  }
  return found;
}

function ownedBy(
  provider: OpenShellProviderResponse,
  sourceId: string,
  profileId: string,
): boolean {
  return (
    provider.labels[MANAGED_BY_LABEL] === MANAGED_BY &&
    provider.labels[SOURCE_ID_LABEL] === sourceId &&
    provider.type === profileId
  );
}

function sourceBaseUrl(config: Readonly<Record<string, string>>): string {
  const value = config[OPENAI_BASE_URL_CONFIG] ?? OPENAI_DEFAULT_BASE_URL;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ScopeViolationError("The OpenAI-compatible endpoint must be a valid HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname.length === 0 ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !endpoint.pathname.replace(/\/$/u, "").endsWith("/v1") ||
    endpoint.pathname.includes("*") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ScopeViolationError(
      "The OpenAI-compatible endpoint must use HTTPS and a path ending in /v1 without wildcards, credentials, query, or fragment.",
    );
  }
  return `${endpoint.origin}${endpoint.pathname.replace(/\/$/u, "")}`;
}

function profileId(
  type: OpenShellSourceType,
  source: Pick<CredentialSourceContext["source"], "config">,
): string {
  return type.profile([], sourceBaseUrl(source.config)).id;
}

function revisionOpenAiBaseUrls(
  revision: CredentialRevisionContext["revision"],
): readonly string[] {
  const agents = asRecord(revision.configuration.agents);
  const defaults = asRecord(agents?.defaults);
  const selections = [
    defaults?.model,
    ...Object.values(asRecord(agents?.entries) ?? {}).map((entry) => asRecord(entry)?.model),
  ].filter((selection) => selection !== undefined);
  const models = selections.flatMap((selection) => {
    const record = asRecord(selection);
    return typeof selection === "string"
      ? [selection]
      : [record?.primary, ...(Array.isArray(record?.fallbacks) ? record.fallbacks : [])];
  });
  const providers = asRecord(asRecord(revision.configuration.models)?.providers);
  const openai = asRecord(providers?.openai);
  const entries = Array.isArray(openai?.models)
    ? openai.models.map((entry) => asRecord(entry))
    : [];
  return models.map((reference) => {
    if (typeof reference !== "string" || !reference.startsWith("openai/")) {
      throw new ScopeViolationError(
        "OpenShell OpenClaw credential sources require explicit openai/model references.",
      );
    }
    const id = reference.slice("openai/".length);
    const matches = entries.filter((entry) => entry?.id === id || entry?.id === reference);
    if (matches.length !== 1) {
      throw new ScopeViolationError(
        `OpenShell OpenClaw model metadata is missing or ambiguous for ${reference}.`,
      );
    }
    const baseUrl = matches[0]?.baseUrl ?? openai?.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
    if (typeof baseUrl !== "string") {
      throw new ScopeViolationError("The selected model endpoint must be a string.");
    }
    return sourceBaseUrl({ [OPENAI_BASE_URL_CONFIG]: baseUrl });
  });
}

/** Stores OCC credential sources as OpenShell providers; the supervisor injects them. */
export class OpenShellCredentialGatewayDriver implements CredentialGatewayDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    required: ["binaries"],
    additionalProperties: false,
    properties: { binaries: { type: "array", items: { type: "string" }, minItems: 1 } },
  });

  static validateConfiguration(configuration: unknown): void {
    validateOptions(configuration as OpenShellCredentialGatewayOptions);
  }

  readonly id: string;
  readonly capability = "credential_gateway" as const;
  readonly implementation: string;
  private readonly options: OpenShellCredentialGatewayOptions;
  private readonly backend: Backend<OpenShellGateway>;

  constructor(
    options: OpenShellCredentialGatewayOptions,
    selection: OpenShellCredentialGatewaySelection,
  ) {
    validateOptions(options);
    this.id = selection.id ?? "credential-gateway-openshell";
    this.implementation = selection.implementation ?? "openshell";
    if (this.implementation !== "openshell") {
      throw new OpenShellCredentialGatewayFailure(
        "OpenShell Credential Gateway implementation must be exactly openshell.",
      );
    }
    if (selection.backend.drivers.credential_gateway !== this.id) {
      throw new OpenShellCredentialGatewayFailure(
        "The OpenShell Backend does not declare this Credential Gateway Driver as a member.",
      );
    }
    this.options = Object.freeze({ binaries: Object.freeze([...options.binaries]) });
    this.backend = selection.backend;
  }

  async listSourceTypes(
    _context: CredentialGatewayContext,
  ): Promise<readonly CredentialSourceType[]> {
    return SOURCE_TYPES.map((entry) => entry.catalog);
  }

  async registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type);
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const baseUrl = sourceBaseUrl(context.source.config);
    const selectedProfileId = type.profile(this.options.binaries, baseUrl).id;
    await this.ensureProfile(client, workspace, type, baseUrl, context.signal);
    const name = openShellProviderName(context.source.id);
    const credentials = providerCredentials(type, input);
    try {
      await client.createProvider(
        {
          workspace,
          name,
          type: selectedProfileId,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY,
            [SOURCE_ID_LABEL]: context.source.id,
            [NAMESPACE_ID_LABEL]: context.namespace.id,
          },
          credentials,
        },
        context.signal,
      );
    } catch (error) {
      if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
        throw error;
      }
      // Replay after an uncertain create adopts only this exact source's provider.
      const existing = await client.getProvider(workspace, name, context.signal);
      if (existing === undefined || !ownedBy(existing, context.source.id, selectedProfileId)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
    }
    return { state: "ready" };
  }

  /**
   * Replaces the stored static values. OpenShell gives them only to processes started after
   * the update, so a running Harness keeps its value until its next deployment.
   */
  async updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type);
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const name = openShellProviderName(context.source.id);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing === undefined) {
      return { state: "absent" };
    }
    if (!ownedBy(existing, context.source.id, profileId(type, context.source))) {
      throw new ScopeViolationError(
        "An OpenShell provider with this source's name is not owned by the source.",
      );
    }
    await client.updateProviderCredentials(
      workspace,
      name,
      providerCredentials(type, input),
      context.signal,
    );
    return { state: "ready" };
  }

  async rotateSource(_context: CredentialSourceContext): Promise<CredentialSourceStatus> {
    // TODO(credential-gateway next slice): rotate gateway-refresh sources.
    throw new ScopeViolationError("OpenShell credential source rotation is not supported yet.");
  }

  async sourceStatus(context: CredentialSourceContext): Promise<CredentialSourceStatus> {
    const provider = await this.client(context).getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (provider === undefined) {
      return { state: "absent" };
    }
    if (
      !ownedBy(
        provider,
        context.source.id,
        profileId(sourceType(context.source.type), context.source),
      )
    ) {
      return { state: "failed", reason: "The OpenShell provider is not owned by this source." };
    }
    return { state: "ready" };
  }

  async removeSource(context: CredentialSourceContext): Promise<void> {
    const workspace = openShellWorkspaceName(context.namespace);
    const name = openShellProviderName(context.source.id);
    const client = this.client(context);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      const selectedProfileId = profileId(sourceType(context.source.type), context.source);
      if (!ownedBy(existing, context.source.id, selectedProfileId)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
      await client.deleteProvider(workspace, name, context.signal);
      if ((await client.getProvider(workspace, name, context.signal)) !== undefined) {
        throw new OpenShellCredentialGatewayFailure("The OpenShell provider was not deleted.");
      }
    }
    // Workspace deletion requires no profiles, so the last source of a type removes its profile.
    const selectedProfileId = profileId(sourceType(context.source.type), context.source);
    const remaining = await client.listProviders(workspace, context.signal);
    if (!remaining.some((provider) => provider.type === selectedProfileId)) {
      await client.deleteProviderProfile(workspace, selectedProfileId, context.signal);
    }
  }

  async attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]> {
    if (
      (context.revision.harness.id !== "codex" && context.revision.harness.id !== "openclaw") ||
      context.revision.harness.mode !== "dedicated"
    ) {
      throw new ScopeViolationError(
        "OpenShell OpenAI-compatible credential sources require a dedicated Harness.",
      );
    }
    const modelBaseUrls =
      context.revision.harness.id === "openclaw"
        ? revisionOpenAiBaseUrls(context.revision)
        : undefined;
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const attachments: CredentialSourceAttachment[] = [];
    for (const source of context.sources) {
      if (source.driverId !== this.id || source.namespaceId !== context.namespace.id) {
        throw new ScopeViolationError("The credential source is not owned by this gateway.");
      }
      const selectedProfileId = profileId(sourceType(source.type), source);
      const baseUrl = sourceBaseUrl(source.config);
      if (
        modelBaseUrls !== undefined &&
        (modelBaseUrls.length === 0 ||
          modelBaseUrls.some((modelBaseUrl) => modelBaseUrl !== baseUrl))
      ) {
        throw new ScopeViolationError(
          "The Agent model endpoint must match its OpenShell credential source endpoint.",
        );
      }
      const name = openShellProviderName(source.id);
      const provider = await client.getProvider(workspace, name, context.signal);
      if (provider === undefined || !ownedBy(provider, source.id, selectedProfileId)) {
        throw new OpenShellCredentialGatewayFailure(
          "The OpenShell provider for a bound credential source is unavailable.",
        );
      }
      attachments.push(Object.freeze({ sourceId: source.id, ref: name }));
    }
    return Object.freeze(attachments);
  }

  async attachmentStatus(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialAttachmentStatus[]> {
    if (context.sandbox === undefined) {
      throw new OpenShellCredentialGatewayFailure(
        "OpenShell attachment status requires the provisioned Sandbox.",
      );
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const statuses: CredentialAttachmentStatus[] = [];
    for (const source of context.sources) {
      const status = await client.getSandboxProviderStatus(
        workspace,
        context.sandbox.resourceName,
        openShellProviderName(source.id),
        context.signal,
      );
      statuses.push(
        Object.freeze({
          sourceId: source.id,
          state: attachmentState(status.state),
          ...(status.reason === undefined ? {} : { reason: status.reason }),
        }),
      );
    }
    return Object.freeze(statuses);
  }

  /**
   * Detaches the source's provider from the revision's Sandbox. Only a REVOKED receipt reports
   * `revoked`: the Sandbox's placeholders then stop resolving, even in running processes.
   */
  async withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus> {
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const provider = openShellProviderName(context.sourceId);
    const sandbox = context.sandbox.resourceName;
    // Detach is idempotent; a replay after an uncertain detach still returns a receipt.
    const detached = await client.detachSandboxProvider(
      workspace,
      sandbox,
      provider,
      context.signal,
    );
    // A missing Sandbox has no placeholders left to resolve.
    if (detached === undefined) {
      return Object.freeze({ sourceId: context.sourceId, state: "absent" });
    }
    const status = await client.getSandboxProviderStatus(
      workspace,
      sandbox,
      provider,
      context.signal,
      detached.receiptId,
    );
    const state = attachmentState(status.state);
    return Object.freeze({
      sourceId: context.sourceId,
      state: state === "revoked" ? "revoked" : "pending",
      ...(status.reason === undefined ? {} : { reason: status.reason }),
    });
  }

  private client(context: CredentialGatewayContext & { readonly namespace: { name: string } }) {
    return this.backend.client.clientForNamespace(context.namespace.name);
  }

  private async ensureProfile(
    client: OpenShellGatewayClient,
    workspace: string,
    type: OpenShellSourceType,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    const base = type.profile(this.options.binaries, baseUrl);
    const digest = sha256Hex(JSON.stringify(base));
    const profile: OpenShellProviderProfile = {
      ...base,
      annotations: { [PROFILE_DIGEST_ANNOTATION]: digest },
    };
    const existing = await client.getProviderProfile(workspace, base.id, signal);
    if (existing === undefined) {
      await client.importProviderProfile(workspace, profile, signal);
    } else if (existing.annotations[PROFILE_DIGEST_ANNOTATION] !== digest) {
      await client.updateProviderProfile(workspace, profile, existing.resourceVersion, signal);
    }
  }
}

function providerCredentials(
  type: OpenShellSourceType,
  input: CredentialSourceInput,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(type.credentials).map(([field, key]) => {
      const value = input.secrets[field];
      if (!isNonEmptyString(value)) {
        throw new ScopeViolationError(`The credential source secret ${field} is required.`);
      }
      return [key, value];
    }),
  );
}

function attachmentState(state: string): CredentialAttachmentStatus["state"] {
  switch (state) {
    case "PROVIDER_READINESS_STATE_READY":
      return "ready";
    case "PROVIDER_READINESS_STATE_WITHHELD":
      return "withheld";
    case "PROVIDER_READINESS_STATE_REVOKED":
      return "revoked";
    case "PROVIDER_READINESS_STATE_FAILED":
      return "failed";
    default:
      return "pending";
  }
}
