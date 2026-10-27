import {
  managedGoogleInstall,
  managedPluginMiddleware,
  managedPluginMiddlewareAudience,
  managedPluginMiddlewareImplementation,
  type ManagedRequest,
} from "../plugin/managed-catalog.ts";
import {
  chartListeners,
  egressAuthorityConfiguration,
  type EgressAuthorityConfiguration,
} from "../../composition/installation-fields.ts";
import { bindOpenShellMiddleware } from "./openshell-exchange-binding.ts";
import {
  createOpenShellOnlineHttpAuthority,
  type OpenShellOnlineHttpAuthorityOptions,
  type OpenShellOnlineHttpRequest,
} from "./openshell-online-authority.ts";

// OpenShell removes routing, framing and credential headers before this RPC. Only these
// remaining client headers may accompany the request. Method and resource overrides refuse.
const clientHeaders = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "pragma",
  "sec-fetch-mode",
  "user-agent",
  "x-goog-api-client",
]);

function matches(rule: ManagedRequest, request: OpenShellOnlineHttpRequest): boolean {
  const target = request.target;
  const url = new URL(rule.url);
  return (
    target.reportedScheme === "https" &&
    target.host === url.hostname &&
    target.port === Number(url.port || 443) &&
    target.method === rule.method &&
    target.path === url.pathname &&
    target.query === new URLSearchParams(rule.query).toString()
  );
}

/** Checks the request shape. OpenShell owns the bearer, its destination and its withdrawal. */
export function createManagedPluginRequestAuthority(
  identity: OpenShellOnlineHttpAuthorityOptions["identity"],
) {
  const rules = [
    ...Object.values(managedGoogleInstall.credentials).flatMap((slot) => slot.requests),
    ...managedGoogleInstall.publicRequests,
  ];
  return createOpenShellOnlineHttpAuthority({
    identity,
    registrationName: managedPluginMiddleware,
    httpOnlyRelease: {
      implementation: managedPluginMiddlewareImplementation,
      releaseSha256: managedGoogleInstall.releaseSha256,
    },
    authorize: async (request) => {
      const names = request.headers.map(([name]) => name);
      if (
        request.body.byteLength !== 0 ||
        names.some((name) => !clientHeaders.has(name)) ||
        new Set(names).size !== names.length ||
        !rules.some((rule) => matches(rule, request))
      ) {
        return { reasonCode: "managed_plugin_request_denied" };
      }
      return "allow";
    },
  });
}

/** Both listeners share the chart's TLS and public issuer key. Only the API owns the port. */
export function managedPluginRequestListener(
  environment: Readonly<Record<string, string | undefined>>,
  mode: "production" | "development",
): EgressAuthorityConfiguration | undefined {
  const port = environment.OCC_PLUGIN_REQUEST_AUTHORITY_PORT;
  if (port === undefined) {
    return undefined;
  }
  const files = chartListeners.egressAuthority.files;
  return egressAuthorityConfiguration(
    {
      host: mode === "development" ? "127.0.0.1" : "0.0.0.0",
      port: /^[1-9][0-9]{0,4}$/.test(port) ? Number(port) : 0,
      certificatePath: files.certificatePath[0],
      privateKeyPath: files.privateKeyPath[0],
      issuerPublicKeyPath: files.issuerPublicKeyPath[0],
      issuer: environment.OCC_PLUGIN_REQUEST_AUTHORITY_ISSUER,
      keyId: environment.OCC_PLUGIN_REQUEST_AUTHORITY_KEY_ID,
      audience: managedPluginMiddlewareAudience,
    },
    mode,
    "egressAuthority.pluginRequests",
  );
}

export function bindManagedPluginRequestAuthority(config: EgressAuthorityConfiguration) {
  return bindOpenShellMiddleware(config, (publicKey) =>
    createManagedPluginRequestAuthority({
      issuer: config.issuer,
      audience: config.audience,
      keyId: config.keyId,
      publicKey,
    }),
  );
}
