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
      "Open Credentials → OAuth clients → Register OAuth client. Choose a saved connection template from the list or use Create connection template. Save the template to return to registration. Enter the client details issued for the displayed redirect URI.",
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
  credentialsRegisterWithoutTemplates: {
    group: "Pages/Credentials",
    name: "Register with no connection templates",
    path: "/console/credentials/oauth-clients",
    actions: [click("Register OAuth client")],
    description: "An administrator with no saved templates starts with Create connection template.",
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
      "Expand API destinations to edit the proposed HTTPS routes before saving. This preview includes sample Gmail, Calendar and Drive routes.",
  },
  credentialsManualTemplate: {
    group: "Pages/Credentials",
    name: "Manual OAuth template",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: openTemplate,
    description:
      "Enter the authorization server, add each destination as a host, port and path, then associate a compatible OAuth client or save a draft.",
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
  credentialsApprovedScopeLimit: {
    group: "Pages/Credentials",
    name: "Limit to approved scopes",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [
      ...openTemplate,
      { selector: "#connection-template-scope-limit", value: "restricted" },
    ],
    description: "Select Limit to approved scopes to enter the OAuth scopes callers may request.",
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
