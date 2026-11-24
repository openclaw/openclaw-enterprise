import { click } from "../create-agent-form-data.mts";
import type { StoryAction } from "../../story-action.mts";

const editGoogle = { selector: '[aria-label="Edit Google OAuth"]', click: true } as const;
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
    name: "Connection templates",
    steps: [
      "Compare the authentication method, availability, details, and version for Google OAuth, Support MCP, and the static Bearer Reporting API template.",
      "Open Edit on Reporting API to inspect its HTTP method, host, port, and exact path or subtree. Static templates do not have OAuth clients.",
      "Switch the Namespace in the header. Installation-wide templates remain available in every Namespace.",
    ],
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    description:
      "A mixed catalog shows static Bearer and OAuth templates through the same resource workflow.",
  },
  credentialsStaticTemplateCreate: {
    group: "Pages/Credentials",
    name: "Create static Bearer template",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [
      click("Create connection template"),
      { selector: "#connection-template-authentication", value: "static_bearer" },
    ],
    description:
      "Configure each HTTP method, host, port, and exact path or subtree without registering an OAuth client.",
  },
  credentialsStaticTemplateEdit: {
    group: "Pages/Credentials",
    name: "Edit static Bearer template",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [{ selector: 'button[aria-label="Edit Reporting API"]', click: true }],
    description:
      "Review the current destination. Saving destination changes creates a new immutable version; renaming preserves the current version.",
  },
  credentialsOAuthClientCatalog: {
    group: "Pages/Credentials",
    name: "OAuth client catalog",
    path: "/console/credentials/oauth-clients",
    oauthCatalog: "ready",
    description: "Public and confidential OAuth clients with different issuers and availability.",
    steps: [
      "Compare each client’s issuer, availability, and token endpoint authentication method. Open a delete confirmation and check the name and availability, then cancel.",
      "Choose Register OAuth client. Confirm Reporting API is not offered; select an OAuth template that defines its issuer.",
    ],
  },
  credentialsDeleteTemplate: {
    group: "Pages/Credentials",
    name: "Delete connection template",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [
      { selector: 'button[aria-label="Delete Google OAuth (Installation-wide)"]', click: true },
    ],
    description:
      "Review the name and availability before deleting the template. Its OAuth clients stay registered.",
  },
  credentialsReferencedClient: {
    group: "Pages/Credentials",
    name: "OAuth client in use",
    path: "/console/credentials/oauth-clients",
    oauthCatalog: "ready",
    actions: [
      { selector: 'button[aria-label^="Delete Support service ("]', click: true },
      click("Delete OAuth client"),
    ],
    description:
      "A saved version of the Support MCP template references this client. Close the message to return to the client list.",
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
  credentialsRegisterGoogleClient: {
    group: "Pages/Credentials",
    name: "Register a Google OAuth client",
    path: "/console/credentials/oauth-clients",
    oauthCatalog: "ready",
    actions: [
      click("Register OAuth client"),
      {
        selector: "#oauth-registration-template",
        value: "ctp_00000000-0000-4000-8000-000000000003",
      },
    ],
    description:
      "The Google template defaults to client_secret_post for confidential clients. Selecting Public sets the method to none.",
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
      "This MCP server advertises client_secret_basic for confidential clients and none for public clients. Select a client type to see its method.",
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
    name: "Edit Google OAuth",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: [editGoogle],
    description:
      "Edit the Installation-wide Google template. Expand API destinations to change its HTTPS routes. This preview includes sample Gmail, Calendar and Drive routes.",
  },
  credentialsUnconfirmedTemplate: {
    group: "Pages/Credentials",
    name: "Unconfirmed template save",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "unconfirmed-save",
    actions: [editGoogle, click("Save new version")],
    description:
      "The catalog saved version 2 of Google OAuth, but the save response omitted the version.",
    steps: [
      "Check that the editor explains how to recover, Save new version is disabled and Close has focus.",
      "Press Enter on Close. Check that the refreshed catalog lists Google OAuth once at version 2.",
    ],
  },
  credentialsManualTemplate: {
    group: "Pages/Credentials",
    name: "Manual OAuth template",
    path: "/console/credentials/connection-templates",
    oauthCatalog: "ready",
    actions: openTemplate,
    description:
      "Enter the authorization server, add each destination as a host, port and path, then associate a compatible OAuth client or save a draft. Reopen a saved manual template to edit the destinations for accounts using that issuer.",
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
    oauthCatalog?: "ready" | "error" | "unconfirmed-save";
    readOnlyPermissionSummary?: true;
    description: string;
    steps?: readonly string[];
  }
>;
