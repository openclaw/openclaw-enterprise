import { story } from "./story.ts";

export default { title: "Pages/Credentials" };

export const CredentialSources = {
  ...story("credentialsSourceInventory", {
    instructions:
      "Open Create Credential Source. If you Tab to Cancel while templates load, focus should stay there when the form appears. Press Enter to close the dialog.",
  }),
  name: "Credentials",
};
export const CredentialSourcesMobile = story("credentialsSourceInventory", {
  name: "Credentials on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
export const CredentialSourcesEmpty = {
  ...story("credentialsSourceEmpty"),
  name: "No readable Credential Sources",
};
export const CredentialSourcesLoading = {
  ...story("credentialsSourceLoading"),
  name: "Credential Sources loading",
};
export const CredentialSourcesDenied = {
  ...story("credentialsSourceReadDenied"),
  name: "Credential Source inventory denied",
};
export const CreateCredentialSource = story("credentialsSourceCreate");
export const CreateStaticCredential = story("credentialsSourceStatic");
export const CreateCodexOAuthSource = story("credentialsSourceCodexOAuth");
export const CreateOAuthTemplateSource = story("credentialsSourceOAuthTemplate");
export const OAuthTemplateWithoutClient = story("credentialsSourceOAuthNoClient");
export const ReplaceStaticSourceValue = story("credentialsSourceReplaceValue");
export const SourceDeleteBlockedByReference = story("credentialsSourceDeleteReferenced");
export const OAuthDisconnectDenied = story("credentialsSourceDisconnectDenied");
export const OAuthAccountOwnerDisconnect = story("credentialsSourceOwnerDisconnect");
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
