// A credential source field its type's catalog does not list, or a required one that is missing:
// `field` is the request path, such as "secrets.api_key".
export const credentialSourceFieldUnknown = (
  type: string,
  field: string,
  group: string,
  allowed: string,
): string =>
  `Credential source type ${type} has no field ${field}: remove it. Its ${group} fields: ${allowed}.`;
export const credentialSourceFieldRequired = (type: string, field: string): string =>
  field.startsWith("secrets.")
    ? `Credential source type ${type} requires ${field}: add a reference to a Secret in this Namespace.`
    : `Credential source type ${type} requires ${field}: add it.`;
// A bound live-adopted or Proxy-owned source after the Installation dropped its Credential Proxy.
export const CREDENTIAL_PROXY_SOURCES_WITHOUT_PROXY =
  "This Agent binds credential sources admitted under a Credential Proxy, and this Installation no longer selects one. Bind Credential Gateway sources instead, or ask an Installation administrator to select drivers.credential_proxy again.";
export const PROTECTED_SOURCE_EMBEDDED_AGENT =
  "config.agent_id names an embedded Agent, and a protected credential source serves only a dedicated Agent. Name a dedicated Agent in this Namespace.";
export const protectedSourceTypeRefused = (type: string, types: string): string =>
  `The selected Credential Proxy cannot protect ${type} sources. Ask an Installation administrator, or create a type it protects: ${types}.`;
export const CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES =
  "Credential source Secrets cannot cross Namespaces.";
// Withdrawal of a source the Agent's active revision does not use (409).
export const WITHDRAWAL_SOURCE_NOT_USED =
  "The Agent's active version does not use this credential source, so there is nothing to withdraw. Withdraw a source that the deployed version uses.";
// Update and rotation of a prepared or credential-free source (409 RESOURCE_CONFLICT).
export const PROTECTED_SOURCE_UPDATE_REFUSED =
  "This credential source holds a prepared or credential-free protected grant, which cannot change in place. Create a new source with the new values, bind it in place of this one, then delete this one.";
export const PROTECTED_SOURCE_ROTATE_REFUSED =
  "This credential source holds a prepared or credential-free protected grant, which is not rotated in place. To replace it, create a new source, bind it in place of this one, then delete this one.";
export const registrationFenceRetry = (seconds: number): string =>
  `This credential source was registered moments ago, and its registration may still be completing. Retry the deletion in ${seconds === 1 ? "1 second" : `${seconds} seconds`}; nothing else needs to change.`;
// Standing repository approval refusals (409 RESOURCE_CONFLICT); none names the approval.
export const STANDING_APPROVAL_BINDING_LOCKED =
  "A standing repository approval holds this Agent's repository binding, so the binding cannot change. Remove the approval first (this needs Agent administer on the Agent), then save again.";
export const STANDING_APPROVAL_ONE_BINDING =
  "A standing repository approval needs exactly one repository binding on the Agent. Keep one binding, then approve again.";
export const STANDING_APPROVAL_NOT_PERMITTED =
  "Team policy does not permit this standing approval: it must last until removed and name one of the Agent's repository bindings that the Installation allows standing approval for. Ask an Installation administrator to allow it.";
export const STANDING_APPROVAL_SCOPE_CHANGED =
  "The standing approval scope changed since you reviewed it. Read the current scope from repository-approval-scopes, review it, then approve again with its scopeFingerprint as expectedScopeFingerprint.";
export const STANDING_APPROVAL_POLICY_CHANGED =
  "This Agent's standing repository approval no longer matches team policy. Remove it (this needs Agent administer on the Agent) and approve the current scope again, or deploy after an Installation administrator restores the policy.";
// A rejected model credential for a caller whose permission answer denies the Agent update that
// fixes it names the grant it lacks, the grants that fix it and who gives them (finding D750): the
// failure banner, the draft's deploy line, the deployment record and the Agents list (D752). A
// Secret-backed credential can also be replaced in place with Secret update on its Secret.
// Deploying needs Agent deploy, and Secret operate on that Secret, unless the answer denies deploy.
const CREDENTIAL_CHOICE_NEEDS = {
  update: "Agent update on this Agent, which your access does not include",
  configurationRead:
    "Configuration read on this Agent's Configuration, which your access does not include",
  sources:
    "operate on each Secret and credential source this Agent and its Configuration bind, which your access does not include",
  serviceAccount:
    "operate on each Secret and credential source this Agent and its Configuration bind, and read on the ServiceAccount it uses for Harness authentication; your access does not include all of them",
};
export interface CredentialRejectionAccess {
  gap: keyof typeof CREDENTIAL_CHOICE_NEEDS;
  secretBacked: boolean;
  deploy?: boolean;
}

const credentialFixGrants = (
  { secretBacked, gap, deploy }: CredentialRejectionAccess,
  then: "deploy a new version" | "deploy again",
): string => {
  const choose = `another credential needs ${CREDENTIAL_CHOICE_NEEDS[gap]}.`;
  const fix = secretBacked
    ? `Replacing its Secret's value needs Secret update on that Secret; choosing ${choose}`
    : `Choosing ${choose}`;
  const deploying =
    deploy === false
      ? "Deploying needs Agent deploy on this Agent, which your access does not include."
      : deploy === true
        ? `Then ${then}${secretBacked ? ", which also needs Secret operate on that Secret" : ""}.`
        : `Then ${then}, which needs Agent deploy on this Agent${secretBacked ? " and Secret operate on that Secret" : ""}.`;
  return `${fix} ${deploying} Ask an Installation administrator for whichever of these grants your access does not include.`;
};
export const modelCredentialRejectedAsk = (access: CredentialRejectionAccess): string =>
  `The model provider rejected this version's credential (HTTP 401 or 403). ${credentialFixGrants(access, "deploy a new version")}`;
export const modelCredentialRejectedReadOnly = (access: CredentialRejectionAccess): string =>
  `The last deployment's model credential was rejected. ${credentialFixGrants(access, "deploy again")}`;
// The recorded failure once the Agent binds another credential than the failed version (D752).
export const MODEL_CREDENTIAL_REJECTED_REPLACED =
  "The model provider rejected this version's credential (HTTP 401 or 403). The Agent now uses a different credential, which the next deployment uses.";
export const SERVICE_ACCOUNT_NO_BACKEND_BINDING =
  "ChatGPT service-account authentication needs the Agent's Backend set to the Installation's ChatGPT Backend and an account credential issued there. Set the Agent's backendId, or bind a service account with an issued credential.";
export const SERVICE_ACCOUNT_BACKEND_MISMATCH =
  "This service account's credential was not issued by the Agent's ChatGPT Backend, Driver and workspace, or was never issued. Bind a service account with a credential issued there, or ask an Installation administrator to restore that Backend.";
// GET .../credential-sources/{id}/withdrawal on a readable Agent (404).
export const WITHDRAWAL_NO_ACTIVE_VERSION =
  "The Agent has no active version, so it has no credential withdrawals. Deploy the Agent first.";
export const WITHDRAWAL_NOT_FOUND =
  "The Agent's active version has no withdrawal for this credential source: either the version does not use it, or no withdrawal was requested for it.";
// Credential Gateway refusals that name the Installation setting and who changes it (D763).
export const CREDENTIAL_GATEWAY_NOT_CONFIGURED =
  "This Installation has no Credential Gateway, so credential sources are unavailable. An Installation administrator must select the OpenShell Credential Gateway Driver; see https://docs-enterprise.openclaw.org/reference/credential-sources/";
export const CREDENTIAL_SOURCE_DRIVER_CHANGED =
  "The selected Credential Gateway Driver did not register this credential source. Bind a replacement registered through the selected driver. To update or delete this source, an Installation administrator must first re-select the driver that registered it.";
