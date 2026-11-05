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
      "Open Secrets, then Connection templates. Create a template. Check its current Namespace under Template availability, or choose Installation-wide to share it across Namespaces. Choose a scope limit. Select a compatible client, or use Create template and register OAuth client to register provider-issued credentials.",
    ],
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    description:
      "Create an OAuth template manually or discover a server’s metadata. The OAuth client and approved scopes are selected separately.",
  },
  credentialsOAuthClientCatalog: {
    group: "Pages/Credentials",
    name: "OAuth client catalog",
    path: "/console/credentials/oauth-clients",
    oauthCatalog: "ready",
    description:
      "Register provider-issued OAuth clients for the availability and endpoints of a saved connection template.",
    steps: [
      "Open Credentials → OAuth clients → Register OAuth client. Select a saved connection template, or create one and return to the registration. Enter the client details issued for the displayed redirect URI.",
    ],
  },
  credentialsRegisterOAuthClient: {
    group: "Pages/Credentials",
    name: "Register OAuth client",
    path: "/console/credentials/oauth-clients",
    oauthCatalog: "ready",
    actions: [click("Register OAuth client")],
    description:
      "Choose a saved template or create one. Its availability and OAuth endpoints determine where OCE can use the registration.",
  },
  credentialsRegisterFromMcp: {
    group: "Pages/Credentials",
    name: "Register an MCP OAuth client",
    path: "/console/credentials/oauth-clients",
    oauthCatalog: "ready",
    actions: [
      click("Register OAuth client"),
      {
        selector: "#oauth-registration-template",
        value: "ctp_00000000-0000-4000-8000-000000000004",
      },
    ],
    description:
      "The template supplies the callback context and limits client authentication to the methods its authorization server advertised.",
  },
  credentialsMemberAccess: {
    group: "Pages/Credentials",
    name: "Namespace member",
    path: "/console/secrets",
    readOnlyPermissionSummary: true,
    description:
      "A Namespace member can open Secrets. Only Installation administrators see Connection templates and OAuth clients.",
  },
  credentialsGoogleTemplate: {
    group: "Pages/Credentials",
    name: "Set up Google OAuth",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [click("Set up Google OAuth")],
    description:
      "The built-in Google template selects Google APIs. The administrator chooses the scope limit and their registered Google client.",
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
    path:
      | "/console/secrets"
      | "/console/credentials/connection-templates"
      | "/console/credentials/oauth-clients";
    actions?: StoryAction[];
    emptyNamespaces?: true;
    oauthCatalog?: "ready" | "error";
    readOnlyPermissionSummary?: true;
    description: string;
    steps?: readonly string[];
  }
>;
