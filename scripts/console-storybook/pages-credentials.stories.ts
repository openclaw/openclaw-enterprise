import { story } from "./story.ts";

export default { title: "Pages/Credentials" };

export const ConnectionTemplates = story("credentialsTemplateCatalog");
export const GoogleOAuthTemplate = story("credentialsGoogleTemplate");
export const ManualOAuthTemplate = story("credentialsManualTemplate");
export const ChooseTemplateAvailability = story("credentialsTemplateWithoutNamespace");
export const WithoutScopeLimit = story("credentialsWithoutScopeLimit");
export const DiscoveredMcpTemplate = story("credentialsMcpDiscovery");
export const McpDiscoveryUnavailable = story("credentialsMcpDiscoveryError");
export const OAuthClientCatalog = story("credentialsOAuthClientCatalog");
export const RegisterOAuthClient = story("credentialsRegisterOAuthClient");
export const RegisterMcpOAuthClient = story("credentialsRegisterFromMcp");
export const MemberAccess = story("credentialsMemberAccess");
