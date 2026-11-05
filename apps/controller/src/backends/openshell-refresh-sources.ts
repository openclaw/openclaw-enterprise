import type { OpenShellRefreshStrategy } from "../drivers/sandbox/openshell-gateway-client.ts";

export const CODEX_OAUTH_TYPE = "codex-oauth";
export const CODEX_ACCESS_TOKEN_ENV = "CODEX_ACCESS_TOKEN";

/** Shared inert refresh metadata for the paired OpenShell Drivers. */
interface OpenShellRefreshSourceType {
  readonly strategy: OpenShellRefreshStrategy;
  readonly configMaterial: readonly string[];
  readonly credentialKey: (config: Readonly<Record<string, string>>) => string;
}

export const OPEN_SHELL_REFRESH_SOURCE_TYPES = Object.freeze({
  "oauth2-client-credentials": Object.freeze({
    strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_CLIENT_CREDENTIALS",
    configMaterial: Object.freeze(["client_id", "scope"]),
    credentialKey: (config: Readonly<Record<string, string>>) => config.env_var ?? "",
  }),
  "oauth2-refresh-token": Object.freeze({
    strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
    configMaterial: Object.freeze(["client_id", "scope"]),
    credentialKey: (config: Readonly<Record<string, string>>) => config.env_var ?? "",
  }),
  [CODEX_OAUTH_TYPE]: Object.freeze({
    strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN",
    configMaterial: Object.freeze(["client_id"]),
    credentialKey: (_config: Readonly<Record<string, string>>) => CODEX_ACCESS_TOKEN_ENV,
  }),
} satisfies Record<string, OpenShellRefreshSourceType>);

export function openShellRefreshSourceType(type: string): OpenShellRefreshSourceType | undefined {
  return Object.hasOwn(OPEN_SHELL_REFRESH_SOURCE_TYPES, type)
    ? OPEN_SHELL_REFRESH_SOURCE_TYPES[type as keyof typeof OPEN_SHELL_REFRESH_SOURCE_TYPES]
    : undefined;
}
