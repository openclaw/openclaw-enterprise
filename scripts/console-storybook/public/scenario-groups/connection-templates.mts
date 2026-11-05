import { click } from "../create-agent-form-data.mts";
import type { StoryAction } from "../../story-action.mts";

const openTemplate = [click("Create connection template")];
const discoverMcp = [
  ...openTemplate,
  { selector: "#connection-template-mode", value: "mcp_discovery" },
  { selector: "#connection-template-server", value: "https://mcp.example.com/mcp" },
  click("Discover OAuth settings"),
];
export const connectionTemplateScenarios = {
  credentialsTemplateCatalog: {
    group: "Pages/Credentials",
    name: "OAuth connection templates",
    steps: [
      "Open Secrets, then Connection templates. Create a template. Check its current Namespace under Template availability, or choose Installation-wide to share it across Namespaces. Choose a scope limit. Select an existing OAuth client or enter credentials issued by the provider.",
    ],
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    description:
      "Create an OAuth template manually or discover a server’s metadata. The OAuth client and approved scopes are selected separately.",
  },
  credentialsMemberAccess: {
    group: "Pages/Credentials",
    name: "Namespace member",
    path: "/console/secrets",
    readOnlyPermissionSummary: true,
    description:
      "A Namespace member can open Secrets. Only Installation administrators see Connection templates.",
  },
  credentialsManualTemplate: {
    group: "Pages/Credentials",
    name: "Manual OAuth template",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: openTemplate,
    description:
      "Enter the authorization server and recipient, then associate a compatible OAuth client or save a draft.",
  },
  credentialsTemplateWithoutNamespace: {
    group: "Pages/Credentials",
    name: "Choose template availability",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    emptyNamespaces: true,
    actions: openTemplate,
    description:
      "An administrator without a current Namespace must choose availability before saving a template or registering its OAuth client.",
  },
  credentialsWithoutScopeLimit: {
    group: "Pages/Credentials",
    name: "No template scope limit",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [
      ...openTemplate,
      { selector: "#connection-template-scope-limit", value: "unrestricted" },
    ],
    description:
      "The administrator explicitly removes the template's scope limit. The provider and the consent request determine which scopes the account grants.",
  },
  credentialsMcpDiscovery: {
    group: "Pages/Credentials",
    name: "Discovered MCP authorization",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: discoverMcp,
    description:
      "Review the observed server metadata. Choose the OAuth scopes and client before saving. Provider discovery and persistence are simulated.",
  },
  credentialsMcpDiscoveryError: {
    group: "Pages/Credentials",
    name: "MCP discovery unavailable",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "error",
    actions: discoverMcp,
    description: "The simulated MCP server fails discovery. No template is created.",
  },
} satisfies Record<
  string,
  {
    group: "Pages/Credentials";
    name: string;
    path: "/console/secrets" | "/console/credentials/connection-templates";
    actions?: StoryAction[];
    emptyNamespaces?: true;
    oauthCatalog?: "ready" | "error";
    readOnlyPermissionSummary?: true;
    description: string;
    steps?: readonly string[];
  }
>;
