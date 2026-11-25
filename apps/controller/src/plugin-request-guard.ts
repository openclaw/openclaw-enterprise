import { fileURLToPath } from "node:url";
import {
  tlsListenerConfiguration,
  type TlsListenerConfiguration,
} from "./composition/installation-fields.ts";
import { bindOpenShellMiddleware } from "./drivers/plugin/openshell-middleware.ts";
import { createOpenShellOnlineHttpAuthority } from "./drivers/plugin/openshell-online-authority.ts";
import {
  acceptsPluginRequestScope,
  allowsPluginRequest,
  managedPluginGuardVersion,
} from "./drivers/plugin/managed-request-policies.ts";
import {
  managedPluginMiddleware,
  managedPluginMiddlewareAudience,
  managedPluginMiddlewareImplementation,
} from "./drivers/plugin/managed-catalog.ts";

const mounts = {
  certificatePath: "/etc/openclaw/egress/tls/tls.crt",
  privateKeyPath: "/etc/openclaw/egress/tls/tls.key",
  issuerPublicKeyPath: "/etc/openclaw/egress/issuer/issuer.pub",
};

export async function startPluginRequestGuard(
  environment: Readonly<Record<string, string | undefined>>,
  files: Pick<
    TlsListenerConfiguration,
    "certificatePath" | "privateKeyPath" | "issuerPublicKeyPath"
  > = mounts,
) {
  const mode = environment.NODE_ENV === "production" ? "production" : "development";
  const port = environment.OCC_PLUGIN_REQUEST_AUTHORITY_PORT;
  const config = tlsListenerConfiguration(
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
