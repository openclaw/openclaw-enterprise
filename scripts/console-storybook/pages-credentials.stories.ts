import { story } from "./story.ts";

export default { title: "Pages/Credentials" };

export const ConnectionTemplates = story("credentialsTemplateCatalog");
export const ManualOAuthTemplate = story("credentialsManualTemplate");
export const DiscoveredMcpTemplate = story("credentialsMcpDiscovery");
export const McpDiscoveryUnavailable = story("credentialsMcpDiscoveryError");
export const MemberAccess = story("credentialsMemberAccess");
