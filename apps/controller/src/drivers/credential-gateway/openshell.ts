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
import { CredentialSourceRevisionError, ScopeViolationError } from "@openclaw-enterprise/occ";
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
  type OpenShellRefreshStrategy,
} from "../sandbox/openshell-gateway-client.ts";

export interface OpenShellCredentialGatewayOptions {
  /** Absolute paths of the Harness binaries allowed to reach model endpoints. */
  readonly binaries: readonly string[];
  /**
   * Absolute paths of the Sandbox binaries allowed to reach non-model sources' endpoints.
   * Without it the catalog omits `bearer-token`.
   */
  readonly toolBinaries?: readonly string[];
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

/** How the paired Credential Refresh Driver configures one `refresh` type. */
export interface OpenShellRefreshSourceType {
  readonly strategy: OpenShellRefreshStrategy;
  /** Non-secret config fields sent as refresh material under the same names. */
  readonly configMaterial: readonly string[];
}

interface OpenShellSourceType {
  readonly catalog: CredentialSourceType;
  /** Present for `refresh` types: the gateway stores no static value for them. */
  readonly refresh?: OpenShellRefreshSourceType;
  /** Rejects invalid non-secret configuration before any gateway effect. */
  validate(config: Readonly<Record<string, string>>): void;
  /** Catalog secret field → the provider credential key OpenShell exposes. */
  credentials(config: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
  /** Shared by every source of the type, or owned by one source and removed with it. */
  readonly profileScope: "type" | "source";
  profileId(sourceId: string): string;
  profile(
    sourceId: string,
    config: Readonly<Record<string, string>>,
    options: OpenShellCredentialGatewayOptions,
  ): Omit<OpenShellProviderProfile, "annotations">;
}

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ENDPOINT_PATH = /^\/[A-Za-z0-9/._~*-]{0,255}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENVIRONMENT = new Set(["HOME", "LANG", "OPENAI_API_KEY", "PATH", "SHELL", "USER"]);
const RESERVED_ENVIRONMENT_PREFIXES = ["CODEX_", "OCE_", "OPENCLAW_", "OPENSHELL_"];

/** An absolute HTTPS URL without credentials, query, or fragment; OpenShell requires HTTPS. */
const TOKEN_URL = /^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/;
/** RFC 6749 scope tokens separated by single spaces. */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;

const ENDPOINT_CONFIG = Object.freeze([
  Object.freeze({
    name: "host",
    required: true,
    description: "Exact DNS name of the protected API.",
  }),
  Object.freeze({ name: "port", required: false, description: "Port; defaults to 443." }),
  Object.freeze({
    name: "path",
    required: false,
    description: "Path pattern the token may reach; defaults to /**.",
  }),
  Object.freeze({
    name: "env_var",
    required: true,
    description: "Environment variable that holds the token placeholder in the Sandbox.",
  }),
]);

const OAUTH2_CONFIG = Object.freeze([
  ...ENDPOINT_CONFIG,
  Object.freeze({
    name: "token_url",
    required: true,
    description: "HTTPS token endpoint of the OAuth2 issuer.",
  }),
  Object.freeze({ name: "client_id", required: true, description: "OAuth2 client ID." }),
  Object.freeze({
    name: "scope",
    required: false,
    description: "Space-separated scopes to request; defaults to the issuer's.",
  }),
]);

/** Checks the protected endpoint and placeholder variable shared by every non-model type. */
function validateEndpointConfig(type: string, config: Readonly<Record<string, string>>): void {
  const { host, port, path } = bearerTokenEndpoint(config);
  const name = config.env_var ?? "";
  if (!HOST.test(host) || /^[0-9.]+$/.test(host)) {
    throw new ScopeViolationError(`The ${type} host must be an exact DNS name.`);
  }
  if ((config.port !== undefined && !/^[1-9][0-9]{0,4}$/.test(config.port)) || port > 65_535) {
    throw new ScopeViolationError(`The ${type} port must be 1 to 65535.`);
  }
  if (!ENDPOINT_PATH.test(path)) {
    throw new ScopeViolationError(`The ${type} path must be an absolute path pattern.`);
  }
  if (
    !ENVIRONMENT_NAME.test(name) ||
    RESERVED_ENVIRONMENT.has(name) ||
    RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    throw new ScopeViolationError(
      `The ${type} env_var must be an unreserved upper-case environment variable name.`,
    );
  }
}

function validateOAuth2Config(type: string, config: Readonly<Record<string, string>>): void {
  validateEndpointConfig(type, config);
  if (!TOKEN_URL.test(config.token_url ?? "") || !URL.canParse(config.token_url ?? "")) {
    throw new ScopeViolationError(
      `The ${type} token_url must be an HTTPS URL without credentials, query, or fragment.`,
    );
  }
  if (!CLIENT_ID.test(config.client_id ?? "")) {
    throw new ScopeViolationError(`The ${type} client_id must be 1 to 256 visible characters.`);
  }
  if (config.scope !== undefined && (config.scope.length > 1024 || !SCOPE.test(config.scope))) {
    throw new ScopeViolationError(`The ${type} scope must be space-separated OAuth2 scopes.`);
  }
}

/** A per-source profile that injects one bearer token at the protected endpoint. */
function bearerProfile(
  sourceId: string,
  config: Readonly<Record<string, string>>,
  options: OpenShellCredentialGatewayOptions,
  displayName: string,
  credential: Pick<OpenShellProviderProfile["credentials"][number], "name" | "refresh">,
): Omit<OpenShellProviderProfile, "annotations"> {
  return {
    id: openShellProviderName(sourceId),
    displayName,
    category: "PROVIDER_PROFILE_CATEGORY_OTHER" as const,
    credentials: [
      {
        ...credential,
        envVars: [config.env_var ?? ""],
        required: true,
        authStyle: "bearer",
        headerName: "authorization",
      },
    ],
    endpoints: [{ ...bearerTokenEndpoint(config), protocol: "rest" }],
    binaries: requiredToolBinaries(options),
    inferenceCapable: false,
  };
}

function oauth2SourceType(
  type: "oauth2-client-credentials" | "oauth2-refresh-token",
  strategy: OpenShellRefreshStrategy,
  secrets: CredentialSourceType["secrets"],
  material: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly secret: boolean;
  }[],
): OpenShellSourceType {
  return {
    catalog: Object.freeze({
      type,
      config: OAUTH2_CONFIG,
      secrets,
      rotation: "refresh",
    }),
    refresh: Object.freeze({ strategy, configMaterial: Object.freeze(["client_id", "scope"]) }),
    validate: (config) => validateOAuth2Config(type, config),
    credentials: (config) => Object.freeze({ access_token: config.env_var ?? "" }),
    profileScope: "source",
    profileId: (sourceId) => openShellProviderName(sourceId),
    // The token endpoint lives only in the profile: OpenShell refuses it as refresh material.
    profile: (sourceId, config, options) =>
      bearerProfile(sourceId, config, options, `OAuth2 ${type} (OpenClaw Enterprise)`, {
        name: "access_token",
        refresh: {
          strategy,
          tokenUrl: config.token_url ?? "",
          scopes: [],
          material: [
            { name: "client_id", required: true, secret: false },
            { name: "scope", required: false, secret: false },
            ...material,
          ],
        },
      }),
  };
}

function bearerTokenEndpoint(config: Readonly<Record<string, string>>): {
  readonly host: string;
  readonly port: number;
  readonly path: string;
} {
  return {
    host: config.host ?? "",
    port: config.port === undefined ? 443 : Number(config.port),
    path: config.path ?? "/**",
  };
}

const SOURCE_TYPES: readonly OpenShellSourceType[] = Object.freeze([
  {
    catalog: Object.freeze({
      type: "openai",
      config: Object.freeze([]),
      secrets: Object.freeze([
        Object.freeze({ name: "api_key", required: true, description: "OpenAI API key." }),
      ]),
      rotation: "none",
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "api_key" }),
    }),
    validate: () => {},
    credentials: () => Object.freeze({ api_key: "OPENAI_API_KEY" }),
    profileScope: "type",
    profileId: () => "oce-openai",
    profile: (_sourceId, _config, options) => ({
      id: "oce-openai",
      displayName: "OpenAI API key (OpenClaw Enterprise)",
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
      endpoints: [{ host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" }],
      binaries: options.binaries,
      inferenceCapable: true,
    }),
  },
  {
    catalog: Object.freeze({
      type: "bearer-token",
      config: ENDPOINT_CONFIG,
      secrets: Object.freeze([
        Object.freeze({ name: "token", required: true, description: "Static bearer token." }),
      ]),
      rotation: "none",
    }),
    validate: (config) => validateEndpointConfig("bearer-token", config),
    credentials: (config) => Object.freeze({ token: config.env_var ?? "" }),
    profileScope: "source",
    profileId: (sourceId) => openShellProviderName(sourceId),
    profile: (sourceId, config, options) =>
      bearerProfile(sourceId, config, options, "Bearer token (OpenClaw Enterprise)", {
        name: "token",
      }),
  },
  oauth2SourceType(
    "oauth2-client-credentials",
    "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_CLIENT_CREDENTIALS",
    Object.freeze([
      Object.freeze({
        name: "client_secret",
        required: true,
        description: "OAuth2 client secret.",
      }),
    ]),
    [{ name: "client_secret", required: true, secret: true }],
  ),
  oauth2SourceType(
    "oauth2-refresh-token",
    "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
    Object.freeze([
      Object.freeze({
        name: "refresh_token",
        required: true,
        description: "OAuth2 refresh token from a completed sign-in.",
      }),
      Object.freeze({
        name: "client_secret",
        required: false,
        description: "OAuth2 client secret, for a confidential client.",
      }),
    ]),
    [
      { name: "refresh_token", required: true, secret: true },
      { name: "client_secret", required: false, secret: true },
    ],
  ),
]);

/**
 * OpenShell lets any binary use a profile with an empty binary list, so a bearer-token profile is
 * never written without `toolBinaries`. Never reconcile existing profiles to an empty list.
 */
function requiredToolBinaries(options: OpenShellCredentialGatewayOptions): readonly string[] {
  if (options.toolBinaries === undefined || options.toolBinaries.length === 0) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell bearer-token profiles require configured toolBinaries.",
    );
  }
  return options.toolBinaries;
}

function validateOptions(options: OpenShellCredentialGatewayOptions): void {
  const record = asRecord(options);
  if (record === undefined) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell Credential Gateway configuration is required.",
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "binaries" && key !== "toolBinaries") {
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
  if (
    options.toolBinaries !== undefined &&
    (!Array.isArray(options.toolBinaries) ||
      options.toolBinaries.length === 0 ||
      options.toolBinaries.some((path) => !isNonEmptyString(path) || !isAbsolute(path)))
  ) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell Credential Gateway toolBinaries must be a nonempty list of absolute paths.",
    );
  }
}

/**
 * Non-model types need tool binaries to reach their endpoints; `refresh` types also need the
 * Backend's Credential Refresh Driver to mint their tokens.
 */
function catalogTypes(
  options: OpenShellCredentialGatewayOptions,
  refresh: boolean,
): readonly OpenShellSourceType[] {
  return SOURCE_TYPES.filter(
    (entry) =>
      entry.catalog.harnessAuth !== undefined ||
      (options.toolBinaries !== undefined && (entry.refresh === undefined || refresh)),
  );
}

/** A type the current configuration offers: registration, update and attach need one. */
function sourceType(
  type: string,
  options: OpenShellCredentialGatewayOptions,
  refresh: boolean,
): OpenShellSourceType {
  return findSourceType(catalogTypes(options, refresh), type);
}

/**
 * Any type this driver ever registered. Status and removal of an existing source must not
 * depend on the current configuration: a source registered before `toolBinaries` was removed,
 * or before the refresh role was deselected, still has to be deletable.
 */
function knownSourceType(type: string): OpenShellSourceType {
  return findSourceType(SOURCE_TYPES, type);
}

function findSourceType(types: readonly OpenShellSourceType[], type: string): OpenShellSourceType {
  const found = types.find((entry) => entry.catalog.type === type);
  if (found === undefined) {
    throw new ScopeViolationError("The OpenShell Credential Gateway does not support this type.");
  }
  return found;
}

/** The refresh configuration of a `refresh` type, for the paired Credential Refresh Driver. */
export function openShellRefreshSourceType(type: string):
  | (OpenShellRefreshSourceType & {
      readonly credentialKey: (config: Readonly<Record<string, string>>) => string;
    })
  | undefined {
  const found = SOURCE_TYPES.find((entry) => entry.catalog.type === type);
  if (found?.refresh === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...found.refresh,
    credentialKey: (config: Readonly<Record<string, string>>) =>
      Object.values(found.credentials(config))[0] ?? "",
  });
}

function ownedBy(
  provider: OpenShellProviderResponse,
  sourceId: string,
  type: OpenShellSourceType,
): boolean {
  return (
    provider.labels[MANAGED_BY_LABEL] === MANAGED_BY &&
    provider.labels[SOURCE_ID_LABEL] === sourceId &&
    provider.type === type.profileId(sourceId)
  );
}

/** Stores OCC credential sources as OpenShell providers; the supervisor injects them. */
export class OpenShellCredentialGatewayDriver implements CredentialGatewayDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    required: ["binaries"],
    additionalProperties: false,
    properties: {
      binaries: { type: "array", items: { type: "string" }, minItems: 1 },
      toolBinaries: { type: "array", items: { type: "string" }, minItems: 1 },
    },
  });

  static validateConfiguration(configuration: unknown): void {
    validateOptions(configuration as OpenShellCredentialGatewayOptions);
  }

  readonly id: string;
  readonly capability = "credential_gateway" as const;
  readonly implementation: string;
  private readonly options: OpenShellCredentialGatewayOptions;
  private readonly backend: Backend<OpenShellGateway>;
  /** Whether the Backend declares a Credential Refresh Driver for `refresh` types. */
  private readonly refresh: boolean;

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
    this.options = Object.freeze({
      binaries: Object.freeze([...options.binaries]),
      ...(options.toolBinaries === undefined
        ? {}
        : { toolBinaries: Object.freeze([...options.toolBinaries]) }),
    });
    this.backend = selection.backend;
    this.refresh = selection.backend.drivers.credential_refresh !== undefined;
  }

  async listSourceTypes(
    _context: CredentialGatewayContext,
  ): Promise<readonly CredentialSourceType[]> {
    return catalogTypes(this.options, this.refresh).map((entry) => entry.catalog);
  }

  async registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type, this.options, this.refresh);
    type.validate(input.config);
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const credentials = providerCredentials(type, input);
    await this.ensureProfile(
      client,
      workspace,
      type,
      context.source.id,
      input.config,
      context.signal,
    );
    const name = openShellProviderName(context.source.id);
    try {
      await client.createProvider(
        {
          workspace,
          name,
          type: type.profileId(context.source.id),
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
      if (existing === undefined || !ownedBy(existing, context.source.id, type)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
    }
    return { state: "ready" };
  }

  /**
   * Replaces the stored static values. OpenShell gives them only to processes started after
   * the update, so a running Harness keeps its value until its next deployment. Also rewrites
   * the source's profile when the configured binaries changed since it was written.
   */
  async updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type, this.options, this.refresh);
    if (type.refresh !== undefined) {
      throw new ScopeViolationError(
        "A refresh-type source has no static value; reconfigure its refresh material instead.",
      );
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const name = openShellProviderName(context.source.id);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing === undefined) {
      return { state: "absent" };
    }
    if (!ownedBy(existing, context.source.id, type)) {
      throw new ScopeViolationError(
        "An OpenShell provider with this source's name is not owned by the source.",
      );
    }
    // The profile follows the current configuration, so a narrowed binary list applies here.
    // Narrow first: if the credential update then fails, the old token is only less reachable.
    await this.ensureProfile(
      client,
      workspace,
      type,
      context.source.id,
      context.source.config,
      context.signal,
    );
    await client.updateProviderCredentials(
      workspace,
      name,
      providerCredentials(type, input),
      context.signal,
    );
    return { state: "ready" };
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
    if (!ownedBy(provider, context.source.id, knownSourceType(context.source.type))) {
      return { state: "failed", reason: "The OpenShell provider is not owned by this source." };
    }
    return { state: "ready" };
  }

  async removeSource(context: CredentialSourceContext): Promise<void> {
    const workspace = openShellWorkspaceName(context.namespace);
    const name = openShellProviderName(context.source.id);
    const client = this.client(context);
    const type = knownSourceType(context.source.type);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      if (!ownedBy(existing, context.source.id, type)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
      await client.deleteProvider(workspace, name, context.signal);
      if ((await client.getProvider(workspace, name, context.signal)) !== undefined) {
        throw new OpenShellCredentialGatewayFailure("The OpenShell provider was not deleted.");
      }
    }
    // Workspace deletion requires no profiles: a source-owned profile goes with its source, and
    // the last source of a type removes the type's shared profile.
    const profileId = type.profileId(context.source.id);
    const remaining =
      type.profileScope === "source" ? [] : await client.listProviders(workspace, context.signal);
    if (!remaining.some((provider) => provider.type === profileId)) {
      await client.deleteProviderProfile(workspace, profileId, context.signal);
    }
  }

  async attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]> {
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const attachments: CredentialSourceAttachment[] = [];
    const environment = new Set<string>();
    for (const source of context.sources) {
      if (source.driverId !== this.id || source.namespaceId !== context.namespace.id) {
        throw new ScopeViolationError("The credential source is not owned by this gateway.");
      }
      const type = sourceType(source.type, this.options, this.refresh);
      // Two sources cannot place their placeholders in the same Sandbox variable.
      for (const name of Object.values(type.credentials(source.config))) {
        if (environment.has(name)) {
          throw new CredentialSourceRevisionError(
            "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
            "Two credential sources bound to the revision use the same environment variable.",
          );
        }
        environment.add(name);
      }
      const name = openShellProviderName(source.id);
      const provider = await client.getProvider(workspace, name, context.signal);
      if (provider === undefined || !ownedBy(provider, source.id, type)) {
        throw new OpenShellCredentialGatewayFailure(
          "The OpenShell provider for a bound credential source is unavailable.",
        );
      }
      // Each deployment applies the current binary lists to the profiles it attaches. OpenShell
      // composes Sandbox policy from the stored profile, so attached Sandboxes narrow too.
      await this.ensureProfile(client, workspace, type, source.id, source.config, context.signal);
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
    if (context.recheck === true) {
      // A recorded revocation needs a new detach only if the Sandbox lists the provider again,
      // for example after a create that OpenShell accepted before the withdrawal landed after it.
      const existing = await client.getSandbox({ name: sandbox, workspace }, context.signal);
      if (existing === undefined) {
        return Object.freeze({ sourceId: context.sourceId, state: "absent" });
      }
      const providers = existing.spec?.providers;
      if (!Array.isArray(providers) || !providers.includes(provider)) {
        return Object.freeze({ sourceId: context.sourceId, state: "revoked" });
      }
    }
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
    sourceId: string,
    config: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<void> {
    const base = type.profile(sourceId, config, this.options);
    const digest = sha256Hex(JSON.stringify(base));
    const profile: OpenShellProviderProfile = {
      ...base,
      annotations: { [PROFILE_DIGEST_ANNOTATION]: digest },
    };
    const existing = await client.getProviderProfile(workspace, base.id, signal);
    if (existing?.annotations[PROFILE_DIGEST_ANNOTATION] === digest) {
      return;
    }
    try {
      if (existing === undefined) {
        await client.importProviderProfile(workspace, profile, signal);
      } else {
        await client.updateProviderProfile(workspace, profile, existing.resourceVersion, signal);
      }
    } catch (error) {
      // A concurrent writer with the same configuration (another deployment, or a replay)
      // already stored this exact profile.
      const current = await client
        .getProviderProfile(workspace, base.id, signal)
        .catch(() => undefined);
      if (current?.annotations[PROFILE_DIGEST_ANNOTATION] !== digest) {
        throw error;
      }
    }
  }
}

function providerCredentials(
  type: OpenShellSourceType,
  input: CredentialSourceInput,
): Record<string, string> {
  // OpenShell mints a refresh type's token; its secrets are refresh material, not credentials.
  if (type.refresh !== undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(type.credentials(input.config)).map(([field, key]) => {
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
