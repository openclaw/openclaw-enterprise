import {
  bearerTokenEndpoint,
  OpenShellCredentialAttachments,
  OpenShellCredentialGatewayFailure,
} from "../sandbox/openshell-credential-attachments.ts";
import { ConfigurationValidationError, type ErrorDetail } from "@openclaw-enterprise/contracts";
import { requireConfiguration } from "@openclaw-enterprise/contracts";
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
import {
  CredentialSourceConfigError,
  CredentialSourceRegistrationConfigError,
  ScopeViolationError,
  StoredCredentialSourceConfigError,
} from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";
import { managedMcpProviderEndpoint } from "../sandbox/openshell-managed-mcp-policy.ts";
import { managedMcpInstallForSourceConfig } from "../plugin/managed-catalog.ts";

import {
  modelProviderBaseUrl,
  requireModelSourceDestination,
  type ModelProviderConfiguration,
} from "../compute/model-provider.ts";
import { exactDnsName, validateOpenAiSourceBaseUrl } from "../credential-source-endpoint.ts";

import {
  ensureOpenShellProviderProfile,
  MANAGED_BY_LABEL,
  MANAGED_BY,
  SOURCE_ID_LABEL,
  openShellOwnedBy,
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
  type OpenShellGatewayPlacement,
} from "../../backends/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
} from "../sandbox/openshell-gateway-client.ts";

import {
  CODEX_OAUTH_TYPE,
  OPEN_SHELL_REFRESH_SOURCE_TYPES,
} from "../../backends/openshell-refresh-sources.ts";
import {
  CODEX_ACCOUNT_CONFIG,
  CODEX_OAUTH_TOKEN_URL,
} from "../credential-refresh/codex-device-authorization.ts";

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
  readonly modelProvider?: ModelProviderConfiguration;
  readonly id?: string;
  readonly implementation?: string;
  readonly backend: Backend<OpenShellGateway>;
}

const NAMESPACE_ID_LABEL = "openclaw.dev/namespace-id";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_AUTHORIZED_BASE_URL_CONFIG = "authorized_base_url";

interface OpenShellSourceType {
  readonly catalog: CredentialSourceType;
  /**
   * Rejects invalid non-secret configuration before any gateway effect. Returns the
   * configuration to store when it differs from the written one, such as a normalized URL.
   * `gateway` resolves placement only for validators that need it.
   */
  validate(
    config: Readonly<Record<string, string>>,
    options: OpenShellCredentialGatewayOptions,
    gateway: () => OpenShellGatewayPlacement | undefined,
  ): Readonly<Record<string, string>> | void;
  /** Catalog secret field → the provider credential key OpenShell exposes. */
  credentials(config: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
  /** The source's own profile, named like its provider and removed with it. */
  profile(
    sourceId: string,
    config: Readonly<Record<string, string>>,
    options: OpenShellCredentialGatewayOptions,
    gateway: () => OpenShellGatewayPlacement | undefined,
    modelProvider?: ModelProviderConfiguration,
  ): Omit<OpenShellProviderProfile, "annotations">;
}

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

const BEARER_TOKEN_CONFIG = Object.freeze([
  ...ENDPOINT_CONFIG,
  Object.freeze({
    name: "protocol",
    required: false,
    description: "Use mcp for a reviewed managed MCP connection. If omitted, the protocol is REST.",
  }),
]);

const OAUTH2_CONFIG = Object.freeze([
  ...ENDPOINT_CONFIG,
  Object.freeze({
    name: "binary",
    required: false,
    description: "Restrict this source to one executable from the installation toolBinaries.",
  }),
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

/**
 * Last labels that hosts files map to loopback: `localhost` (RFC 6761) and the
 * `localhost.localdomain`, `localhost4.localdomain4` and `localhost6.localdomain6` aliases.
 */
const LOOPBACK_LAST_LABELS = new Set(["localhost", "localdomain", "localdomain4", "localdomain6"]);

/**
 * The OAuth2 token endpoint host. The OpenShell gateway, not the Sandbox, posts the source's
 * client secret and refresh token there from its own network position, so the parsed hostname
 * follows the protected host's DNS-name rule (no IP address in any spelling the URL parser
 * accepts) and is not a `localhost` name (finding 1348). The gateway resolves it through its
 * Pod's `/etc/hosts` first, whose loopback, link-local and own-hostname aliases are single-label
 * names (`ip6-localhost`, `ip6-allnodes`, the Pod's hostname) or end in `localdomain`, so those
 * shapes are refused too; in-cluster issuers keep their Service names
 * (`keycloak.idp.svc.cluster.local`) (finding 1354).
 */
function tokenUrlHostAllowed(tokenUrl: string): boolean {
  if (!URL.canParse(tokenUrl)) {
    return false;
  }
  const host = new URL(tokenUrl).hostname;
  const labels = host.split(".");
  return exactDnsName(host) && labels.length > 1 && !LOOPBACK_LAST_LABELS.has(labels.at(-1) ?? "");
}

function tokenUrlHostMessage(type: string): string {
  return `The ${type} token_url host must be a DNS name with at least two labels, not an IP address or a localhost or localdomain name.`;
}

/**
 * Whether the token endpoint host stays out of the gateway's own Kubernetes names (finding 1356).
 * A StatefulSet Pod's `/etc/hosts` maps its full name (`<pod>.<service>-peer.<namespace>.svc.<cluster
 * domain>`) to the Pod itself, and cluster DNS answers the gateway's Service and Pod names, so the
 * gateway would connect to its own Pod, which no egress NetworkPolicy polices. Refused, when the
 * Backend configuration names the gateway's namespace:
 * - any name in that namespace's `svc` or `pod` zone, whatever the cluster domain;
 * - the names the Pod's DNS search list completes into it: `<x>.<namespace>`,
 *   `<x>.<y>.<namespace>`, and any name of up to three labels ending in the gateway Service or
 *   `<gateway Service>-*` (its peer Service). CoreDNS reads one leading label as an endpoint and
 *   two as a port and protocol (`grpc.tcp.<service>`, matched case-insensitively). The label
 *   count decides, not the port name, so any port the gateway's Services name is covered
 *   (finding 1366).
 * Always refused: a `pod` zone name (`<a-b-c-d>.<namespace>.pod...`), which CoreDNS's default
 * `pods insecure` answers with the written address in any namespace, the Pod's own included.
 * CoreDNS also answers it behind one or two leading labels (an endpoint, or a port and protocol)
 * and ignores them, so any `pod` label after the second is refused, whatever precedes it and
 * whatever cluster domain follows (finding 1359). In-cluster issuers in other namespaces keep
 * their Service names.
 */
function tokenUrlHostOutsideGateway(
  tokenUrl: string,
  gateway: OpenShellGatewayPlacement | undefined,
): boolean {
  if (!URL.canParse(tokenUrl)) {
    return false;
  }
  const labels = new URL(tokenUrl).hostname.split(".");
  if (labels.slice(2).includes("pod")) {
    return false;
  }
  if (gateway === undefined) {
    return true;
  }
  const { namespace, service } = gateway;
  const last = labels.at(-1) ?? "";
  const zone = labels.some(
    (label, index) =>
      label === namespace && (labels[index + 1] === "svc" || labels[index + 1] === "pod"),
  );
  const searched =
    last === namespace ||
    (labels.length <= 3 && (last === service || last.startsWith(`${service}-`)));
  return !zone && !searched;
}

function tokenUrlGatewayMessage(type: string): string {
  return `The ${type} token_url host must not be a Kubernetes Pod name or a name in the OpenShell gateway's namespace.`;
}

/** Like the protected endpoint's port: 0 names no endpoint. */
function tokenUrlPortAllowed(tokenUrl: string): boolean {
  return URL.canParse(tokenUrl) && new URL(tokenUrl).port !== "0";
}

function tokenUrlPortMessage(type: string): string {
  return `The ${type} token_url port must be 1 to 65535.`;
}

/** Checks the protected endpoint and placeholder variable shared by every non-model type. */
function validateEndpointConfig(type: string, config: Readonly<Record<string, string>>): void {
  const { host, port, path } = bearerTokenEndpoint(config);
  const name = config.env_var ?? "";
  if (!exactDnsName(host)) {
    throw new CredentialSourceConfigError("host", `The ${type} host must be an exact DNS name.`);
  }
  if ((config.port !== undefined && !/^[1-9][0-9]{0,4}$/.test(config.port)) || port > 65_535) {
    throw new CredentialSourceConfigError("port", `The ${type} port must be 1 to 65535.`);
  }
  if (!ENDPOINT_PATH.test(path)) {
    throw new CredentialSourceConfigError(
      "path",
      `The ${type} path must be an absolute path pattern.`,
    );
  }
  if (
    !ENVIRONMENT_NAME.test(name) ||
    RESERVED_ENVIRONMENT.has(name) ||
    RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    throw new CredentialSourceConfigError(
      "env_var",
      `The ${type} env_var must be an unreserved upper-case environment variable name.`,
    );
  }
}

function allowsOAuthBinary(options: OpenShellCredentialGatewayOptions, binary: string): boolean {
  // OpenShell treats '*' in a binary path as a glob. A per-source selection names one executable.
  return !binary.includes("*") && options.toolBinaries?.includes(binary) === true;
}

function validateOAuth2Config(
  type: string,
  config: Readonly<Record<string, string>>,
  options: OpenShellCredentialGatewayOptions,
  gateway: OpenShellGatewayPlacement | undefined,
): Readonly<Record<string, string>> | void {
  validateEndpointConfig(type, config);
  if (config.binary !== undefined && !allowsOAuthBinary(options, config.binary)) {
    throw new CredentialSourceConfigError(
      "binary",
      "The OAuth2 binary must be an executable in the installation toolBinaries.",
    );
  }
  if (!TOKEN_URL.test(config.token_url ?? "") || !URL.canParse(config.token_url ?? "")) {
    throw new CredentialSourceConfigError(
      "token_url",
      `The ${type} token_url must be an HTTPS URL without credentials, query, or fragment.`,
    );
  }
  if (!tokenUrlHostAllowed(config.token_url ?? "")) {
    throw new CredentialSourceConfigError("token_url", tokenUrlHostMessage(type));
  }
  if (!tokenUrlHostOutsideGateway(config.token_url ?? "", gateway)) {
    throw new CredentialSourceConfigError("token_url", tokenUrlGatewayMessage(type));
  }
  if (!tokenUrlPortAllowed(config.token_url ?? "")) {
    throw new CredentialSourceConfigError("token_url", tokenUrlPortMessage(type));
  }
  if (!CLIENT_ID.test(config.client_id ?? "")) {
    throw new CredentialSourceConfigError(
      "client_id",
      `The ${type} client_id must be 1 to 256 visible characters.`,
    );
  }
  if (config.scope !== undefined && (config.scope.length > 1024 || !SCOPE.test(config.scope))) {
    throw new CredentialSourceConfigError(
      "scope",
      `The ${type} scope must be space-separated OAuth2 scopes.`,
    );
  }
  // Store the URL as parsed here, so the gateway's parser reads the checked spelling.
  const tokenUrl = new URL(config.token_url ?? "").href;
  return tokenUrl === config.token_url
    ? undefined
    : Object.freeze({ ...config, token_url: tokenUrl });
}

/**
 * Re-checks a stored source's protected `host` before its profile is written, first as at save.
 * A source stored before the host rules (finding 1360) fails here until it is replaced
 * (finding 1363). Registration checks the request first (`registerSource`), so only a stored
 * source reaches this: a 409 that names the replacement (finding 2536).
 */
function checkStoredHost(config: Readonly<Record<string, string>>): void {
  if (!exactDnsName(config.host ?? "")) {
    throw new StoredCredentialSourceConfigError("host");
  }
}

/** A per-source profile that injects one bearer token at the protected endpoint. */
function bearerProfile(
  sourceId: string,
  config: Readonly<Record<string, string>>,
  options: OpenShellCredentialGatewayOptions,
  displayName: string,
  credential: Pick<OpenShellProviderProfile["credentials"][number], "name" | "refresh">,
  credentialKey: string = config.env_var ?? "",
): Omit<OpenShellProviderProfile, "annotations"> {
  return {
    id: openShellProviderName(sourceId),
    displayName,
    category: "PROVIDER_PROFILE_CATEGORY_OTHER" as const,
    credentials: [
      {
        ...credential,
        envVars: [credentialKey],
        required: true,
        authStyle: "bearer",
        headerName: "authorization",
      },
    ],
    endpoints: [{ ...bearerTokenEndpoint(config), protocol: "rest" }],
    binaries: requiredToolBinaries(options, credential.refresh ? config.binary : undefined),
    inferenceCapable: false,
  };
}

function oauth2SourceType(
  type: "oauth2-client-credentials" | "oauth2-refresh-token",
  secrets: CredentialSourceType["secrets"],
  material: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly secret: boolean;
  }[],
): OpenShellSourceType {
  const refresh = OPEN_SHELL_REFRESH_SOURCE_TYPES[type];
  return {
    catalog: Object.freeze({
      type,
      config: OAUTH2_CONFIG,
      secrets,
      rotation: "refresh",
    }),
    validate: (config, options, gateway) => validateOAuth2Config(type, config, options, gateway()),
    credentials: (config) => Object.freeze({ access_token: refresh.credentialKey(config) }),
    // The token endpoint lives only in the profile: OpenShell refuses it as refresh material.
    profile: (sourceId, config, options, gateway) => {
      const placement = gateway();
      checkStoredHost(config);
      // A source stored before the token_url host rules fails here until it is replaced.
      if (
        !tokenUrlHostAllowed(config.token_url ?? "") ||
        !tokenUrlHostOutsideGateway(config.token_url ?? "", placement) ||
        !tokenUrlPortAllowed(config.token_url ?? "")
      ) {
        throw new StoredCredentialSourceConfigError("token_url");
      }
      return bearerProfile(
        sourceId,
        config,
        options,
        `OAuth2 ${type} (OpenClaw Enterprise)`,
        {
          name: "access_token",
          refresh: {
            strategy: refresh.strategy,
            tokenUrl: config.token_url ?? "",
            scopes: [],
            material: [
              { name: "client_id", required: true, secret: false },
              { name: "scope", required: false, secret: false },
              ...material,
            ],
          },
        },
        refresh.credentialKey(config),
      );
    },
  };
}

const SOURCE_TYPES: readonly OpenShellSourceType[] = Object.freeze([
  {
    catalog: Object.freeze({
      type: CODEX_OAUTH_TYPE,
      config: Object.freeze([]),
      secrets: Object.freeze([]),
      rotation: "refresh",
      deviceAuthorization: Object.freeze({ harnessId: "codex" }),
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "chatgptAuthTokens" }),
    }),
    validate() {},
    credentials: (config) =>
      Object.freeze({
        access_token: OPEN_SHELL_REFRESH_SOURCE_TYPES[CODEX_OAUTH_TYPE].credentialKey(config),
      }),
    profile: (sourceId, config, options) => ({
      id: openShellProviderName(sourceId),
      displayName: "Codex OAuth (Experimental)",
      category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" as const,
      credentials: [
        {
          name: "access_token",
          envVars: [OPEN_SHELL_REFRESH_SOURCE_TYPES[CODEX_OAUTH_TYPE].credentialKey(config)],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
          refresh: {
            strategy: OPEN_SHELL_REFRESH_SOURCE_TYPES[CODEX_OAUTH_TYPE].strategy,
            tokenUrl: CODEX_OAUTH_TOKEN_URL,
            scopes: [],
            refreshBeforeSeconds: 300,
            material: [
              { name: "client_id", required: true, secret: false },
              { name: "refresh_token", required: true, secret: true },
            ],
          },
        },
      ],
      endpoints: [
        { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/**" },
        { host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" },
      ],
      binaries: options.binaries,
      inferenceCapable: true,
    }),
  },
  {
    catalog: Object.freeze({
      type: "openai",
      config: Object.freeze([
        Object.freeze({
          name: OPENAI_AUTHORIZED_BASE_URL_CONFIG,
          required: false,
          description:
            "Immutable destination authorization. Must match the Installation model provider; omission authorizes only the default OpenAI endpoint.",
        }),
      ]),
      secrets: Object.freeze([
        Object.freeze({ name: "api_key", required: true, description: "OpenAI API key." }),
      ]),
      rotation: "none",
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "api_key" }),
    }),
    validate: (config) => {
      if (config.base_url !== undefined) {
        throw new CredentialSourceConfigError(
          "base_url",
          "Set runtime.modelProvider on the Installation; source base_url is unsupported.",
        );
      }
      const written = config[OPENAI_AUTHORIZED_BASE_URL_CONFIG];
      const result = validateOpenAiSourceBaseUrl(written ?? OPENAI_DEFAULT_BASE_URL);
      if (result.error !== undefined) {
        throw new CredentialSourceConfigError(OPENAI_AUTHORIZED_BASE_URL_CONFIG, result.error);
      }
      const baseUrl = result.baseUrl;
      // Store the endpoint the profile, the manifest and config.toml use, not the written
      // spelling (finding 1292).
      return written === undefined
        ? undefined
        : Object.freeze({ ...config, [OPENAI_AUTHORIZED_BASE_URL_CONFIG]: baseUrl });
    },
    credentials: () => Object.freeze({ api_key: "OPENAI_API_KEY" }),
    profile: (sourceId, config, options, _gateway, modelProvider) => {
      requireModelSourceDestination(config, modelProvider);
      const baseUrl = modelProviderBaseUrl(modelProvider);
      const endpoint = new URL(baseUrl);
      return {
        id: openShellProviderName(sourceId),
        displayName:
          baseUrl === OPENAI_DEFAULT_BASE_URL
            ? "OpenAI API key (OpenClaw Enterprise)"
            : "OpenAI-compatible API key (OpenClaw Enterprise)",
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
        binaries: options.binaries,
        inferenceCapable: true,
      };
    },
  },
  {
    catalog: Object.freeze({
      type: "codex-pat",
      config: Object.freeze([]),
      secrets: Object.freeze([
        Object.freeze({
          name: "access_token",
          required: true,
          description: "Codex personal access token.",
        }),
      ]),
      rotation: "none",
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "codex_pat" }),
    }),
    validate: () => {},
    credentials: () => Object.freeze({ access_token: "CODEX_ACCESS_TOKEN" }),
    profile: (sourceId, _config, options) => ({
      id: openShellProviderName(sourceId),
      displayName: "Codex personal access token (OpenClaw Enterprise)",
      category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" as const,
      credentials: [
        {
          name: "access_token",
          envVars: ["CODEX_ACCESS_TOKEN"],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
        },
      ],
      endpoints: [
        {
          host: "auth.openai.com",
          port: 443,
          protocol: "rest",
          path: "/api/accounts/v1/user-auth-credential/whoami",
        },
        ...[
          "/backend-api/codex/**",
          // Native PAT startup loads managed configuration before any model turn.
          "/backend-api/wham/config/bundle",
          // Workspace discovery gates native inference; attribution is loaded per turn.
          "/backend-api/wham/accounts/check",
          "/backend-api/wham/settings/user",
          // The Gateway reads native rate limits when recovering a usage-limit error.
          "/backend-api/wham/usage",
        ].map((path) => ({ host: "chatgpt.com", port: 443, protocol: "rest", path })),
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/ps/plugins/**",
          // Shared by this source's Agents: catalog/detail reads and installation only.
          // Bundle downloads remain credential-free and need their own egress allowance.
          rules: [
            { allow: { method: "GET", path: "/backend-api/ps/plugins/*" } },
            { allow: { method: "POST", path: "/backend-api/ps/plugins/*/install" } },
          ],
        },
        // Native app metadata and hosted tools use separate POST endpoints.
        // The shared source profile does not replace managed app/tool policy.
        ...["/backend-api/ps/apps/batch", "/backend-api/ps/mcp"].map((path) => ({
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path,
          rules: [{ allow: { method: "POST", path } }],
        })),
      ],
      binaries: options.binaries,
      inferenceCapable: true,
    }),
  },
  {
    catalog: Object.freeze({
      type: "bearer-token",
      config: BEARER_TOKEN_CONFIG,
      secrets: Object.freeze([
        Object.freeze({ name: "token", required: true, description: "Static bearer token." }),
      ]),
      rotation: "none",
    }),
    validate: (config, options) => {
      validateEndpointConfig("bearer-token", config);
      if (config.protocol === undefined) {
        return;
      }
      const install = managedMcpInstallForSourceConfig(config);
      if (!install) {
        throw new CredentialSourceConfigError(
          "protocol",
          "Use the reviewed settings for a managed MCP connection.",
        );
      }
      if (!allowsOAuthBinary(options, install.binaryPath)) {
        throw new CredentialSourceConfigError(
          "protocol",
          "Managed MCP requires the worker Node executable in the installation toolBinaries.",
        );
      }
    },
    credentials: (config) => Object.freeze({ token: config.env_var ?? "" }),
    profile: (sourceId, config, options) => {
      checkStoredHost(config);
      const profile = bearerProfile(
        sourceId,
        config,
        options,
        "Bearer token (OpenClaw Enterprise)",
        {
          name: "token",
        },
      );
      if (config.protocol === undefined) {
        return profile;
      }
      const install = managedMcpInstallForSourceConfig(config);
      if (!install) {
        throw new StoredCredentialSourceConfigError("protocol");
      }
      return {
        ...profile,
        // The provider projects the access token at the exact endpoint. Only the
        // revision's Sandbox rule grants access to selected tools.
        endpoints: [managedMcpProviderEndpoint(install)],
        binaries: requiredToolBinaries(options, install.binaryPath),
      };
    },
  },
  oauth2SourceType(
    "oauth2-client-credentials",
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
    Object.freeze([
      Object.freeze({
        name: "refresh_token",
        required: true,
        description: "OAuth2 refresh token from a completed sign-in.",
        issuerRotated: true,
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
function requiredToolBinaries(
  options: OpenShellCredentialGatewayOptions,
  binary?: string,
): readonly string[] {
  if (options.toolBinaries === undefined || options.toolBinaries.length === 0) {
    throw new OpenShellCredentialGatewayFailure(
      "OpenShell bearer-token profiles require configured toolBinaries.",
    );
  }
  if (binary === undefined) {
    return options.toolBinaries;
  }
  if (!allowsOAuthBinary(options, binary)) {
    throw new StoredCredentialSourceConfigError("binary");
  }
  return [binary];
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
      (entry.catalog.harnessAuth !== undefined || options.toolBinaries !== undefined) &&
      (entry.catalog.rotation !== "refresh" || refresh),
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

/** Stores OCC credential sources as OpenShell providers; the supervisor injects them. */
export class OpenShellCredentialGatewayDriver implements CredentialGatewayDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    required: ["binaries"],
    additionalProperties: false,
    properties: {
      binaries: { type: "array", items: { type: "string" }, minItems: 1 },
      toolBinaries: { type: "array", items: { type: "string", pattern: "^/" }, minItems: 1 },
    },
  });

  static validateConfiguration(
    configuration: Readonly<OpenShellCredentialGatewayOptions>,
  ): readonly ErrorDetail[] {
    try {
      validateOptions(configuration as OpenShellCredentialGatewayOptions);

      return [];
    } catch (error) {
      return error instanceof ConfigurationValidationError
        ? error.error.details
        : [
            {
              path: "",
              code: "INVALID_VALUE",
              message: "Configuration violates the Driver's constraints.",
            },
          ];
    }
  }

  readonly id: string;
  readonly capability = "credential_gateway" as const;
  readonly implementation: string;
  private readonly options: OpenShellCredentialGatewayOptions;
  private readonly modelProvider: ModelProviderConfiguration | undefined;
  private readonly backend: Backend<OpenShellGateway>;
  /** Whether the Backend declares a Credential Refresh Driver for `refresh` types. */
  private readonly refresh: boolean;
  /** @internal Shared attachment implementation for the built-in composition only. */
  readonly attachments: OpenShellCredentialAttachments;

  constructor(
    options: OpenShellCredentialGatewayOptions,
    selection: OpenShellCredentialGatewaySelection,
  ) {
    options = requireConfiguration(OpenShellCredentialGatewayDriver, options);
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
    this.modelProvider =
      selection.modelProvider === undefined
        ? undefined
        : Object.freeze({
            ...selection.modelProvider,
            baseUrl: modelProviderBaseUrl(selection.modelProvider),
          });
    this.backend = selection.backend;
    this.refresh = selection.backend.drivers.credential_refresh !== undefined;
    const attachmentOptions = this.options;
    const modelProvider = this.modelProvider;
    const refresh = this.refresh;
    this.attachments = new OpenShellCredentialAttachments(
      this.id,
      this.backend,
      this.modelProvider,
      {
        sourceType: (name) => {
          const type = sourceType(name, attachmentOptions, refresh);
          return {
            catalog: type.catalog,
            credentials: type.credentials,
            profile: (sourceId, config, gateway) =>
              type.profile(sourceId, config, attachmentOptions, gateway, modelProvider),
          };
        },
        requiredToolBinaries: (binary) => requiredToolBinaries(attachmentOptions, binary),
      },
    );
  }

  async listSourceTypes(
    _context: CredentialGatewayContext,
  ): Promise<readonly CredentialSourceType[]> {
    return catalogTypes(this.options, this.refresh).map((entry) => entry.catalog);
  }

  validateSourceConfig(
    input: Pick<CredentialSourceInput, "type" | "config">,
  ): Readonly<Record<string, string>> | void {
    // A gateway in each tenant namespace is known only with the tenant's Kubernetes namespace:
    // registration's profile check refuses those names before any gateway write.
    const normalized = sourceType(input.type, this.options, this.refresh).validate(
      input.config,
      this.options,
      () => this.backend.client.placement(),
    );
    if (input.type === "openai") {
      const authorized = validateOpenAiSourceBaseUrl(
        input.config.authorized_base_url ?? OPENAI_DEFAULT_BASE_URL,
      );
      if (authorized.baseUrl !== modelProviderBaseUrl(this.modelProvider)) {
        throw new CredentialSourceConfigError(
          "authorized_base_url",
          "Credential destination authorization must match the Installation model provider.",
        );
      }
    }
    return normalized;
  }

  async registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus> {
    const type = sourceType(input.type, this.options, this.refresh);
    // validateSourceConfig sees no tenant Namespace, so a gateway in each tenant namespace is
    // known only here. Refuse the request's own value before any gateway write, by field, as
    // validateSourceConfig does (400); OCC passes this ScopeViolationError through, while a
    // CredentialSourceConfigError would surface as a 503 (finding 2536).
    try {
      type.validate(input.config, this.options, () => this.placement(context));
    } catch (error) {
      if (error instanceof CredentialSourceConfigError) {
        throw new CredentialSourceRegistrationConfigError(error.field, error.message);
      }
      throw error;
    }
    if (input.type === "openai") {
      requireModelSourceDestination(input.config, this.modelProvider);
    }
    const workspace = openShellWorkspaceName(context.namespace);
    const client = this.client(context);
    const credentials = providerCredentials(type, input);
    const name = openShellProviderName(context.source.id);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined && !openShellOwnedBy(existing, context.source.id)) {
      throw new ScopeViolationError(
        "An OpenShell provider with this source's name is not owned by the source.",
      );
    }
    // Reject known collisions before changing the profile. These are separate RPCs:
    // orphan profiles and provider replacement after this read remain outside this check.
    await this.ensureProfile(
      client,
      workspace,
      type,
      context.source.id,
      input.config,
      () => this.placement(context),
      context.signal,
    );
    try {
      await client.createProvider(
        {
          workspace,
          name,
          type: name,
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
      if (existing === undefined || !openShellOwnedBy(existing, context.source.id)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
    }
    return { state: input.type === CODEX_OAUTH_TYPE ? "pending" : "ready" };
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
    if (type.catalog.rotation === "refresh") {
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
    if (!openShellOwnedBy(existing, context.source.id)) {
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
      () => this.placement(context),
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
    knownSourceType(context.source.type);
    const provider = await this.client(context).getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
    if (provider === undefined) {
      return { state: "absent" };
    }
    if (!openShellOwnedBy(provider, context.source.id)) {
      return { state: "failed", reason: "The OpenShell provider is not owned by this source." };
    }
    if (context.source.type === CODEX_OAUTH_TYPE && !provider.config[CODEX_ACCOUNT_CONFIG]) {
      return { state: "pending" };
    }
    return { state: "ready" };
  }

  async removeSource(context: CredentialSourceContext): Promise<void> {
    knownSourceType(context.source.type);
    const workspace = openShellWorkspaceName(context.namespace);
    const name = openShellProviderName(context.source.id);
    const client = this.client(context);
    const existing = await client.getProvider(workspace, name, context.signal);
    if (existing !== undefined) {
      if (!openShellOwnedBy(existing, context.source.id)) {
        throw new ScopeViolationError(
          "An OpenShell provider with this source's name is not owned by the source.",
        );
      }
      await client.deleteProvider(workspace, name, context.signal);
      if ((await client.getProvider(workspace, name, context.signal)) !== undefined) {
        throw new OpenShellCredentialGatewayFailure("The OpenShell provider was not deleted.");
      }
    }
    // Workspace deletion requires no profiles, and each source's profile goes with it.
    await client.deleteProviderProfile(workspace, name, context.signal);
  }

  async attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]> {
    return this.attachments.attachForRevision(context);
  }

  async attachmentStatus(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialAttachmentStatus[]> {
    return this.attachments.attachmentStatus(context);
  }

  async withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus> {
    return this.attachments.withdraw(context);
  }

  private client(context: CredentialGatewayContext & { readonly namespace: { name: string } }) {
    return this.backend.client.clientForNamespace(context.namespace.name);
  }

  private placement(
    context: CredentialGatewayContext & { readonly namespace: { name: string } },
  ): OpenShellGatewayPlacement | undefined {
    return this.backend.client.placement(context.namespace.name);
  }

  private async ensureProfile(
    client: OpenShellGatewayClient,
    workspace: string,
    type: OpenShellSourceType,
    sourceId: string,
    config: Readonly<Record<string, string>>,
    gateway: () => OpenShellGatewayPlacement | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const base = type.profile(sourceId, config, this.options, gateway, this.modelProvider);
    await ensureOpenShellProviderProfile(client, workspace, base, signal);
  }
}

function providerCredentials(
  type: OpenShellSourceType,
  input: CredentialSourceInput,
): Record<string, string> {
  // OpenShell mints a refresh type's token; its secrets are refresh material, not credentials.
  if (type.catalog.rotation === "refresh") {
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
