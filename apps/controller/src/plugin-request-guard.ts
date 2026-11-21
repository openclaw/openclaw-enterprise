import { fileURLToPath } from "node:url";
import {
  chartListeners,
  egressAuthorityConfiguration,
  type EgressAuthorityConfiguration,
} from "./composition/installation-fields.ts";
import { createOpenShellOnlineHttpAuthority } from "./drivers/egress-proxy/openshell-online-authority.ts";
import {
  acceptsPluginRequestScope,
  allowsPluginRequest,
  managedPluginGuardVersion,
} from "./drivers/plugin/managed-request-policies.ts";
import { bindOpenShellMiddleware } from "./drivers/egress-proxy/openshell-exchange-binding.ts";
import {
  managedPluginMiddleware,
  managedPluginMiddlewareAudience,
  managedPluginMiddlewareImplementation,
} from "./drivers/plugin/managed-catalog.ts";

const mounts = chartListeners.egressAuthority.files;

export async function startPluginRequestGuard(
  environment: Readonly<Record<string, string | undefined>>,
  files: Pick<
    EgressAuthorityConfiguration,
    "certificatePath" | "privateKeyPath" | "issuerPublicKeyPath"
  > = {
    certificatePath: mounts.certificatePath[0],
    privateKeyPath: mounts.privateKeyPath[0],
    issuerPublicKeyPath: mounts.issuerPublicKeyPath[0],
  },
) {
  const mode = environment.NODE_ENV === "production" ? "production" : "development";
  const port = environment.OCC_PLUGIN_REQUEST_AUTHORITY_PORT;
  const config = egressAuthorityConfiguration(
    {
      ...files,
      host: mode === "production" ? "0.0.0.0" : "127.0.0.1",
      port: port && /^[1-9][0-9]{0,4}$/.test(port) ? Number(port) : undefined,
      issuer: environment.OCC_PLUGIN_REQUEST_AUTHORITY_ISSUER,
      keyId: environment.OCC_PLUGIN_REQUEST_AUTHORITY_KEY_ID,
      audience: managedPluginMiddlewareAudience,
    },
    mode,
    "pluginRequestGuard",
  );
  return bindOpenShellMiddleware(config, (publicKey) =>
    createOpenShellOnlineHttpAuthority({
      identity: {
        issuer: config.issuer,
        audience: config.audience,
        keyId: config.keyId,
        publicKey,
      },
      registrationName: managedPluginMiddleware,
      httpPolicySet: {
        implementation: managedPluginMiddlewareImplementation,
        version: managedPluginGuardVersion,
        validateBindingConfig: acceptsPluginRequestScope,
      },
      authorize: async (request) =>
        allowsPluginRequest(request) ? "allow" : { reasonCode: "managed_plugin_request_denied" },
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const guard = await startPluginRequestGuard(process.env);
  process.once("SIGINT", guard.close);
  process.once("SIGTERM", guard.close);
  process.stderr.write(
    `Plugin request guard listening on port ${process.env.OCC_PLUGIN_REQUEST_AUTHORITY_PORT}\n`,
  );
}
