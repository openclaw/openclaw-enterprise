import type {
  CredentialSourceContext,
  CredentialSourceTokenReader,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError } from "@openclaw-enterprise/occ";

import {
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellBackend,
} from "../../backends/openshell.ts";
import type { OpenShellProviderResponse } from "../sandbox/openshell-gateway-client.ts";
import {
  CODEX_ACCESS_TOKEN_ENV,
  CODEX_OAUTH_TYPE,
  codexAccountMetadata,
} from "./codex-device-authorization.ts";

/** Reads an enrolled source even when the Installation no longer offers new device logins. */
export function openShellSourceTokenReader(backend: OpenShellBackend): CredentialSourceTokenReader {
  return {
    async withSourceToken(context, use) {
      const provider = await ownedCodexProvider(backend, context);
      const account = codexAccountMetadata(provider.config);
      const token = await readCodexAccessToken(backend, context, provider);
      return use({
        accessToken: token.value,
        accountId: account.accountId,
        ...(account.isFedramp === undefined ? {} : { isFedramp: account.isFedramp }),
      });
    },
  };
}

/** Device login proves usability without returning the token to its caller. */
export async function confirmCodexAccessToken(
  backend: OpenShellBackend,
  context: CredentialSourceContext,
  provider: OpenShellProviderResponse,
): Promise<void> {
  await readCodexAccessToken(backend, context, provider);
}

/** Operator mTLS confines the read. OpenShell may refresh to satisfy the requested lifetime. */
function readCodexAccessToken(
  backend: OpenShellBackend,
  context: CredentialSourceContext,
  provider: OpenShellProviderResponse,
) {
  return backend.client
    .credentialClientForNamespace(context.namespace.name)
    .getProviderCredential(
      openShellWorkspaceName(context.namespace),
      provider.name,
      CODEX_ACCESS_TOKEN_ENV,
      context.signal,
    );
}

export async function ownedCodexProvider(
  backend: OpenShellBackend,
  context: CredentialSourceContext,
): Promise<OpenShellProviderResponse> {
  if (context.source.type !== CODEX_OAUTH_TYPE) {
    throw new ScopeViolationError("The Codex OAuth source is not owned by this gateway.");
  }
  const provider = await ownedProvider(backend, context);
  if (provider === undefined) {
    throw new ScopeViolationError(
      "The OpenShell provider is not owned by this Codex OAuth source.",
    );
  }
  return provider;
}

export async function ownedProvider(
  backend: OpenShellBackend,
  context: CredentialSourceContext,
): Promise<OpenShellProviderResponse | undefined> {
  if (
    context.source.driverId !== backend.credentialSources.id ||
    context.source.namespaceId !== context.namespace.id
  ) {
    throw new ScopeViolationError("The credential source is not owned by this gateway.");
  }
  const provider = await backend.client
    .clientForNamespace(context.namespace.name)
    .getProvider(
      openShellWorkspaceName(context.namespace),
      openShellProviderName(context.source.id),
      context.signal,
    );
  if (
    provider !== undefined &&
    (provider.type !== openShellProviderName(context.source.id) ||
      provider.labels["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
      provider.labels["openclaw.dev/credential-source-id"] !== context.source.id)
  ) {
    throw new ScopeViolationError("The OpenShell provider is not owned by this credential source.");
  }
  return provider;
}
