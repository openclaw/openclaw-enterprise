import { createHash } from "node:crypto";
import {
  CODEX_HARNESS_TEMPLATE_ID,
  CODEX_HARNESS_OAUTH_CLIENT_ID,
  CODEX_PUBLIC_CLIENT_ID,
  codexDeviceAuthorization,
  type CredentialSource,
  type SavedConnection,
} from "@openclaw-enterprise/contracts";

/** Only the completed native enrollment can establish an account identity for model delivery. */
export function savedCodexAccount(
  source: Readonly<CredentialSource>,
  account: Readonly<SavedConnection> | undefined,
) {
  if (
    source.ownerCapability === "credential_refresh" &&
    source.type === "codex-oauth" &&
    source.state === "ready" &&
    account?.credentialSourceId === source.id &&
    account.namespaceId === source.namespaceId &&
    !account.revocationRequestedBy &&
    account.connectionTemplateId === CODEX_HARNESS_TEMPLATE_ID &&
    account.oauthClientId === CODEX_HARNESS_OAUTH_CLIENT_ID &&
    account.clientId === CODEX_PUBLIC_CLIENT_ID &&
    account.issuer === codexDeviceAuthorization.issuer &&
    account.tokenUrl === codexDeviceAuthorization.tokenUrl
  ) {
    return account.codexAccount;
  }
  return undefined;
}

/** A profile is shared only by presentations with the same account, Agent, sender, and admitted slot configuration. */
export function accountDeliveryProfileId(
  sourceId: string,
  gatewayId: string,
  agentId: string,
  config: Readonly<Record<string, string>>,
): string {
  const identity = JSON.stringify([
    sourceId,
    gatewayId,
    agentId,
    Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return "account-" + createHash("sha256").update(identity).digest("hex");
}
