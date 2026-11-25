import { story } from "./story.ts";

export default { title: "Pages/Credentials" };

export const CredentialSources = story("credentialsSourceInventory");
export const CredentialSourcesMobile = story("credentialsSourceInventory", {
  name: "Credential Sources on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
export const CredentialSourcesEmpty = story("credentialsSourceEmpty");
export const CredentialSourcesDenied = story("credentialsSourceReadDenied");
export const CreateCredentialSource = story("credentialsSourceCreate");
export const CredentialSourceCreatedUnreadable = story("credentialsSourceCreatedUnreadable");
export const CredentialSourceCreatedInventoryDenied = story(
  "credentialsSourceCreatedInventoryDenied",
);
export const CredentialSourceTemplatesUnavailable = story("credentialsSourceTemplatesUnavailable");
export const CredentialSourceCreateUnknown = story("credentialsSourceCreateUnknown");
export const CredentialSourceCreateConflictUnknown = story(
  "credentialsSourceCreateConflictUnknown",
);
export const CredentialSourceCreateDenied = story("credentialsSourceCreateDenied");

export const ConnectionTemplates = story("credentialsTemplateCatalog");
export const PluginTemplatePrefill = story("credentialsPluginTemplatePrefill");
export const PluginTemplateEdit = story("credentialsPluginTemplateEdit");
export const ConnectionTemplatesMobile = story("credentialsTemplateCatalog", {
  name: "Connection templates on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
export const CreateStaticBearerTemplate = story("credentialsStaticTemplateCreate");
export const EditStaticBearerTemplate = story("credentialsStaticTemplateEdit");
export const GoogleOAuthTemplate = story("credentialsGoogleTemplate");
export const UnconfirmedTemplateSave = story("credentialsUnconfirmedTemplate");
export const ManualOAuthTemplate = story("credentialsManualTemplate");
export const ChooseTemplateAvailability = story("credentialsTemplateWithoutNamespace");
export const ApprovedScopeLimit = story("credentialsApprovedScopeLimit");
export const DiscoveredMcpTemplate = story("credentialsMcpDiscovery");
export const McpDiscoveryUnavailable = story("credentialsMcpDiscoveryError");
export const OAuthClientCatalog = story("credentialsOAuthClientCatalog");
export const OAuthClientCatalogMobile = story("credentialsOAuthClientCatalog", {
  name: "Credential clients on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
export const DeleteConnectionTemplate = story("credentialsDeleteTemplate");
export const OAuthClientInUse = story("credentialsReferencedClient");
export const RegisterOAuthClient = story("credentialsRegisterOAuthClient");
export const RegisterGoogleOAuthClient = story("credentialsRegisterGoogleClient");
export const RegisterMcpOAuthClient = story("credentialsRegisterFromMcp");
export const RegisterGitHubApp = story("credentialsRegisterGitHubApp");
export const GitHubAppVerificationFailed = story("credentialsGitHubAppVerificationFailed");
export const RotateGitHubAppKey = story("credentialsRotateGitHubApp");
export const MemberAccess = story("credentialsMemberAccess");
