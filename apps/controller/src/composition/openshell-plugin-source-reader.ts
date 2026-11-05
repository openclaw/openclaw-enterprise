import type { Backend, CredentialGatewayDriver } from "@openclaw-enterprise/contracts";
import { ScopeViolationError, type ControllerOptions } from "@openclaw-enterprise/occ";
import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../backends/openshell.ts";
import {
  CODEX_ACCESS_TOKEN_ENV,
  CODEX_OAUTH_TYPE,
  codexAccountMetadata,
} from "../drivers/credential-refresh/codex-device-authorization.ts";

export function bindOpenShellPluginSourceReader(
  backend: Backend<OpenShellGateway>,
  gateway: CredentialGatewayDriver,
): NonNullable<ControllerOptions["pluginSourceReader"]> {
  if (backend.drivers.credential_gateway !== gateway.id) {
    throw new ScopeViolationError(
      "The OpenShell Backend is not paired with this Credential Gateway.",
    );
  }
  return {
    gateway,
    async withSourceToken({ namespace, source, signal }, use) {
      signal.throwIfAborted();
      if (
        source.ownerCapability !== "credential_gateway" ||
        source.type !== CODEX_OAUTH_TYPE ||
        source.driverId !== gateway.id ||
        source.namespaceId !== namespace.id ||
        source.state !== "ready"
      ) {
        throw new ScopeViolationError("The Codex OAuth source is not owned by this Gateway.");
      }
      const workspace = openShellWorkspaceName(namespace);
      const name = openShellProviderName(source.id);
      const provider = await backend.client
        .clientForNamespace(namespace.name)
        .getProvider(workspace, name, signal);
      if (
        provider?.name !== name ||
        provider.type !== name ||
        provider.labels["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
        provider.labels["openclaw.dev/credential-source-id"] !== source.id
      ) {
        throw new ScopeViolationError(
          "The OpenShell provider is not owned by this Codex OAuth source.",
        );
      }
      const account = codexAccountMetadata(provider.config);
      signal.throwIfAborted();
      const token = await backend.client
        .credentialClientForNamespace(namespace.name)
        .getProviderCredential(workspace, name, CODEX_ACCESS_TOKEN_ENV, signal);
      signal.throwIfAborted();
      return use({
        accessToken: token.value,
        accountId: account.accountId,
        ...(account.isFedramp === undefined ? {} : { isFedramp: account.isFedramp }),
      });
    },
  };
}
