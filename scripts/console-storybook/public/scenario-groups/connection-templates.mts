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
      "Open Secrets, then Connection templates. Create a template and choose Installation-wide or a specific Namespace under Template availability. Select an OAuth client or expand Register a new OAuth client.",
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
    oauthCatalog?: "ready" | "error";
    readOnlyPermissionSummary?: true;
    description: string;
    steps?: readonly string[];
  }
>;
