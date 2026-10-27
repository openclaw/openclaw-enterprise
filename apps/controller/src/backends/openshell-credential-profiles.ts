import {
  ConfigurationValidationError,
  requireConfiguration,
  type CredentialSourceType,
  type ErrorDetail,
} from "@openclaw-enterprise/contracts";
import {
  CredentialSourceConfigError,
  ScopeViolationError,
  StoredCredentialSourceConfigError,
} from "@openclaw-enterprise/occ";
import {
  asRecord,
  isNonEmptyString,
  numericLastLabel,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";
import {
  normalizeOpenAiBaseUrl,
  openAiBaseUrlSpellingMessage,
} from "../drivers/openai-endpoint.ts";
import {
  CODEX_OAUTH_TYPE,
  CODEX_ACCESS_TOKEN_ENV,
  CODEX_OAUTH_TOKEN_URL,
} from "../drivers/credential-refresh/codex-device-authorization.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderProfile,
  OpenShellProviderResponse,
  OpenShellRefreshStrategy,
} from "../drivers/sandbox/openshell-gateway-client.ts";
import { openShellProviderName, type OpenShellGatewayPlacement } from "./openshell.ts";

export interface OpenShellCredentialProfileOptions {
  /** Absolute paths of the Harness binaries allowed to reach model endpoints. */
  readonly binaries: readonly string[];
  /**
   * Absolute paths of the Sandbox binaries allowed to reach non-model sources' endpoints.
   * Without it the catalog omits `bearer-token`.
   */
  readonly toolBinaries?: readonly string[];
}

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "openclaw-enterprise";
export const SOURCE_ID_LABEL = "openclaw.dev/credential-source-id";
export const NAMESPACE_ID_LABEL = "openclaw.dev/namespace-id";
const PROFILE_DIGEST_ANNOTATION = "openclaw.dev/profile-digest";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_BASE_URL_CONFIG = "base_url";

const SOURCE_ENDPOINT_REQUIREMENTS =
  "The OpenShell endpoint requires HTTPS, a DNS host name, a nonzero port, and a /v1 path. Wildcards, IP addresses, bracketed IPv6 hosts, empty hostname labels, braces, URL credentials, query, and fragment are unsupported.";

/** How the paired Credential Refresh Driver configures one `refresh` type. */
export interface OpenShellRefreshSourceType {
  readonly strategy: OpenShellRefreshStrategy;
  /** Non-secret config fields sent as refresh material under the same names. */
  readonly configMaterial: readonly string[];
}

export interface OpenShellSourceType {
  readonly catalog: CredentialSourceType;
  /** Present for `refresh` types: the gateway stores no static value for them. */
  readonly refresh?: OpenShellRefreshSourceType;
  /**
   * Rejects invalid non-secret configuration before any gateway effect. Returns the
   * configuration to store when it differs from the written one, such as a normalized URL.
   * `gateway` is where the gateway runs, when the Backend configuration names it.
   */
  validate(
    config: Readonly<Record<string, string>>,
    gateway?: OpenShellGatewayPlacement,
  ): Readonly<Record<string, string>> | void;
  /** Catalog secret field → the provider credential key OpenShell exposes. */
  credentials(config: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
  /** The source's own profile, named like its provider and removed with it. */
  profile(
    sourceId: string,
    config: Readonly<Record<string, string>>,
    options: OpenShellCredentialProfileOptions,
    gateway?: OpenShellGatewayPlacement,
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

/**
 * A lowercase DNS name: no IP address, wildcard, `_`, or label edge `-`. A host whose last label
 * is a decimal or `0x` number (`10.0.0.5`, `0xa000005`, `0x7f.0x1`, `example.123`) is an IPv4
 * address to the URL parser and to `inet_aton`-style resolvers, so it is refused (finding 1360).
 */
function exactDnsName(host: string): boolean {
  return HOST.test(host) && !numericLastLabel(host);
}

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

function validateOAuth2Config(
  type: string,
  config: Readonly<Record<string, string>>,
  gateway: OpenShellGatewayPlacement | undefined,
): Readonly<Record<string, string>> | void {
  validateEndpointConfig(type, config);
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
  options: OpenShellCredentialProfileOptions,
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
    validate: (config, gateway) => validateOAuth2Config(type, config, gateway),
    credentials: (config) => Object.freeze({ access_token: config.env_var ?? "" }),
    // The token endpoint lives only in the profile: OpenShell refuses it as refresh material.
    profile: (sourceId, config, options, gateway) => {
      checkStoredHost(config);
      // A source stored before the token_url host rules fails here until it is replaced.
      if (
        !tokenUrlHostAllowed(config.token_url ?? "") ||
        !tokenUrlHostOutsideGateway(config.token_url ?? "", gateway) ||
        !tokenUrlPortAllowed(config.token_url ?? "")
      ) {
        throw new StoredCredentialSourceConfigError("token_url");
      }
      return bearerProfile(sourceId, config, options, `OAuth2 ${type} (OpenClaw Enterprise)`, {
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
      });
    },
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
      type: CODEX_OAUTH_TYPE,
      config: Object.freeze([]),
      secrets: Object.freeze([]),
      rotation: "refresh",
      deviceAuthorization: Object.freeze({ harnessId: "codex" }),
      harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "chatgptAuthTokens" }),
    }),
    refresh: Object.freeze({
      strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
      configMaterial: Object.freeze(["client_id"]),
    }),
    validate() {},
    credentials: () => Object.freeze({ access_token: CODEX_ACCESS_TOKEN_ENV }),
    profile: (sourceId, _config, options) => ({
      id: openShellProviderName(sourceId),
      displayName: "Codex OAuth (Experimental)",
      category: "PROVIDER_PROFILE_CATEGORY_INFERENCE" as const,
      credentials: [
        {
          name: "access_token",
          envVars: [CODEX_ACCESS_TOKEN_ENV],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
          refresh: {
            strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
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
    validate: (config) => {
      const written = config[OPENAI_BASE_URL_CONFIG];
      const spelling =
        written === undefined
          ? undefined
          : openAiBaseUrlSpellingMessage(`The openai ${OPENAI_BASE_URL_CONFIG}`, written);
      if (spelling !== undefined) {
        throw new CredentialSourceConfigError(OPENAI_BASE_URL_CONFIG, spelling);
      }
      const baseUrl = matchableSourceBaseUrl(config);
      if (baseUrl === undefined) {
        throw new CredentialSourceConfigError(OPENAI_BASE_URL_CONFIG, SOURCE_ENDPOINT_REQUIREMENTS);
      }
      if (!exactDnsName(new URL(baseUrl).hostname)) {
        throw new CredentialSourceConfigError(
          OPENAI_BASE_URL_CONFIG,
          `The openai ${OPENAI_BASE_URL_CONFIG} host must be an exact DNS name.`,
        );
      }
      // Store the endpoint the profile, the manifest and config.toml use, not the written
      // spelling (finding 1292).
      return written === undefined
        ? undefined
        : Object.freeze({ ...config, [OPENAI_BASE_URL_CONFIG]: baseUrl });
    },
    credentials: () => Object.freeze({ api_key: "OPENAI_API_KEY" }),
    profile: (sourceId, config, options) => {
      const baseUrl = sourceBaseUrl(config);
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
      ],
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
    profile: (sourceId, config, options) => {
      checkStoredHost(config);
      return bearerProfile(sourceId, config, options, "Bearer token (OpenClaw Enterprise)", {
        name: "token",
      });
    },
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
function requiredToolBinaries(options: OpenShellCredentialProfileOptions): readonly string[] {
  if (options.toolBinaries === undefined || options.toolBinaries.length === 0) {
    throw new Error("OpenShell bearer-token profiles require configured toolBinaries.");
  }
  return options.toolBinaries;
}

function validateOptions(options: OpenShellCredentialProfileOptions): void {
  const record = asRecord(options);
  if (record === undefined) {
    throw new Error("OpenShell Credential Gateway configuration is required.");
  }
  for (const key of Object.keys(record)) {
    if (key !== "binaries" && key !== "toolBinaries") {
      throw new Error(
        `OpenShell Credential Gateway configuration contains unsupported option ${key}.`,
      );
    }
  }
  if (
    !Array.isArray(options.binaries) ||
    options.binaries.length === 0 ||
    options.binaries.some((path) => !isNonEmptyString(path) || !isAbsolute(path))
  ) {
    throw new Error(
      "OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.",
    );
  }
  if (
    options.toolBinaries !== undefined &&
    (!Array.isArray(options.toolBinaries) ||
      options.toolBinaries.length === 0 ||
      options.toolBinaries.some((path) => !isNonEmptyString(path) || !isAbsolute(path)))
  ) {
    throw new Error(
      "OpenShell Credential Gateway toolBinaries must be a nonempty list of absolute paths.",
    );
  }
}

/**
 * Non-model types need tool binaries to reach their endpoints; `refresh` types also need the
 * Backend's Credential Refresh Driver to mint their tokens.
 */
function catalogTypes(
  options: OpenShellCredentialProfileOptions,
  refresh: boolean,
): readonly OpenShellSourceType[] {
  return SOURCE_TYPES.filter(
    (entry) =>
      (entry.catalog.harnessAuth !== undefined || options.toolBinaries !== undefined) &&
      (entry.refresh === undefined || refresh),
  );
}

/**
 * Any type this driver ever registered. Status and removal of an existing source must not
 * depend on the current configuration: a source registered before `toolBinaries` was removed,
 * or before the refresh role was deselected, still has to be deletable.
 */
export function knownSourceType(type: string): OpenShellSourceType {
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

export function ownedBy(provider: OpenShellProviderResponse, sourceId: string): boolean {
  return (
    provider.labels[MANAGED_BY_LABEL] === MANAGED_BY &&
    provider.labels[SOURCE_ID_LABEL] === sourceId &&
    provider.type === openShellProviderName(sourceId)
  );
}

/** The normalized endpoint when OpenShell's host matcher can use it, whatever names the host. */
function matchableSourceBaseUrl(config: Readonly<Record<string, string>>): string | undefined {
  const baseUrl = normalizeOpenAiBaseUrl(config[OPENAI_BASE_URL_CONFIG] ?? OPENAI_DEFAULT_BASE_URL);
  if (baseUrl === undefined) {
    return undefined;
  }
  const hostname = new URL(baseUrl).hostname;
  // Match OpenShell's HostPattern requirements before storing the source.
  // IPv6 brackets are interpreted as pattern syntax, not literal URI brackets.
  if (
    hostname.startsWith("[") ||
    hostname.includes("{") ||
    hostname.includes("}") ||
    hostname.split(".").some((label) => label.length === 0)
  ) {
    return undefined;
  }
  return baseUrl;
}

/**
 * The endpoint registration and attachment use. Like a `bearer-token` host, it must be an exact
 * DNS name: no IP address (in any spelling the URL parser accepts), `_` or label edge `-`
 * (finding 1293). A source stored before that rule fails here until it is replaced.
 */
function normalizedSourceBaseUrl(config: Readonly<Record<string, string>>): string | undefined {
  const baseUrl = matchableSourceBaseUrl(config);
  return baseUrl !== undefined && exactDnsName(new URL(baseUrl).hostname) ? baseUrl : undefined;
}

/** Only a stored source fails here: registration checks the request first (finding 2536). */
export function sourceBaseUrl(config: Readonly<Record<string, string>>): string {
  const baseUrl = normalizedSourceBaseUrl(config);
  if (baseUrl === undefined) {
    throw new StoredCredentialSourceConfigError(OPENAI_BASE_URL_CONFIG);
  }
  return baseUrl;
}

/** The installed binary and endpoint policy for this Backend's source providers. */
export class OpenShellCredentialProfiles {
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
    configuration: Readonly<OpenShellCredentialProfileOptions>,
  ): readonly ErrorDetail[] {
    try {
      validateOptions(configuration as OpenShellCredentialProfileOptions);

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
  private readonly options: OpenShellCredentialProfileOptions;
  private readonly refresh: boolean;

  constructor(
    options: OpenShellCredentialProfileOptions,
    selection: { id: string; refresh: boolean },
  ) {
    options = requireConfiguration(OpenShellCredentialProfiles, options);
    this.id = selection.id;
    this.refresh = selection.refresh;
    this.options = Object.freeze({
      binaries: Object.freeze([...options.binaries]),
      ...(options.toolBinaries === undefined
        ? {}
        : { toolBinaries: Object.freeze([...options.toolBinaries]) }),
    });
  }

  catalog(): readonly CredentialSourceType[] {
    return catalogTypes(this.options, this.refresh).map((entry) => entry.catalog);
  }

  sourceType(type: string): OpenShellSourceType {
    return findSourceType(catalogTypes(this.options, this.refresh), type);
  }

  async ensure(
    client: OpenShellGatewayClient,
    workspace: string,
    type: OpenShellSourceType,
    sourceId: string,
    config: Readonly<Record<string, string>>,
    gateway: OpenShellGatewayPlacement | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const base = type.profile(sourceId, config, this.options, gateway);
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
