import { story } from "./story.ts";

export default { title: "Pages/Credentials" };

export const ConnectionTemplates = story("credentialsTemplateCatalog");
export const ConnectedAccounts = story("credentialsConnectedAccounts");
export const ConnectedAccountsEmpty = story("credentialsConnectedAccountsEmpty");
export const FixedManualOAuthScopes = story("credentialsFixedConsentScopes");
export const ConnectAccountDenied = story("credentialsConnectedAccountsDenied");
export const ConsentStartUnavailable = story("credentialsConnectedAccountError");
export const ConsentTabDisconnected = story("credentialsConsentDisconnected");
export const ConnectedAccountsMobile = story("credentialsConnectedAccounts", {
  name: "Connected accounts on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
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
  name: "OAuth clients on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
export const DeleteConnectionTemplate = story("credentialsDeleteTemplate");
export const OAuthClientInUse = story("credentialsReferencedClient");
export const RegisterOAuthClient = story("credentialsRegisterOAuthClient");
export const RegisterGoogleOAuthClient = story("credentialsRegisterGoogleClient");
export const RegisterMcpOAuthClient = story("credentialsRegisterFromMcp");
export const MemberAccess = story("credentialsMemberAccess");
