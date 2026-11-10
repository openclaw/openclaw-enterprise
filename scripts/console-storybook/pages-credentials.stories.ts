import { story } from "./story.ts";

export default { title: "Pages/Credentials" };

export const ConnectionTemplates = story("credentialsTemplateCatalog");
export const ConnectionTemplatesMobile = story("credentialsTemplateCatalog", {
  name: "Connection templates on mobile",
  frameWidth: "390px",
  frameHeight: "844px",
});
export const GoogleOAuthTemplate = story("credentialsGoogleTemplate");
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
