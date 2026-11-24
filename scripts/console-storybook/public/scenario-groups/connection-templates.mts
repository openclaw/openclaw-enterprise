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
  credentialsPluginTemplatePrefill: {
    group: "Pages/Credentials",
    name: "Create an OAuth Template from a Plugin slot",
    path: "/console/credentials/connection-templates?namespace=ns_00000000-0000-4000-8000-000000000001&create=1&mcpServerUrl=https%3A%2F%2Fmcp.example.com%2Fmcp&issuer=https%3A%2F%2Fidentity.example.com",
    oauthCatalog: "ready",
    description:
      "An Installation admin arrives from a Plugin slot in a separate tab. The editor preselects this Namespace and the slot's MCP server URL without saving or discovering anything automatically.",
  },
  credentialsPluginTemplateEdit: {
    group: "Pages/Credentials",
    name: "Configure an existing OAuth Template from a Plugin slot",
    path: "/console/credentials/connection-templates?namespace=ns_00000000-0000-4000-8000-000000000001&edit=ctp_00000000-0000-4000-8000-000000000003",
    oauthCatalog: "ready",
    description:
      "An Installation admin follows the Plugin slot link to edit the existing installation-wide Google OAuth Template and can register or select a client without creating a duplicate.",
  },
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
    name: "Credential client catalog",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    description: "OAuth clients and a GitHub App share one administrator-only catalog.",
    steps: [
      "Compare each client's kind, issuer or App ID, availability, and authentication. Open a delete confirmation and check the identity, then cancel.",
      "Choose Register client. Switch between OAuth 2.0 and GitHub App and inspect the relevant write-only fields.",
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
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    actions: [
      { selector: 'button[aria-label^="Delete Support service ("]', click: true },
      click("Delete credential client"),
    ],
    description:
      "The simulated Source still references this client, so deletion is refused. Close the message to return to the catalog.",
  },
  credentialsRegisterOAuthClient: {
    group: "Pages/Credentials",
    name: "Register OAuth client",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    actions: [click("Register client")],
    description:
      "Register an OAuth client with its own scope, issuer, endpoints, and authentication method, independently of a Template.",
  },
  credentialsRegisterGoogleClient: {
    group: "Pages/Credentials",
    name: "Register a Google OAuth client",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    actions: [
      click("Register client"),
      { selector: "#credential-client-issuer", value: "https://accounts.google.com" },
      { selector: "#credential-client-token-url", value: "https://oauth2.googleapis.com/token" },
    ],
    description:
      "OAuth registration owns its provider endpoints. The authentication method controls whether a write-only secret is required.",
  },
  credentialsRegisterFromMcp: {
    group: "Pages/Credentials",
    name: "Register an MCP OAuth client",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    actions: [
      click("Register client"),
      { selector: "#credential-client-issuer", value: "https://identity.example.com" },
      { selector: "#credential-client-token-url", value: "https://identity.example.com/token" },
    ],
    description:
      "An MCP OAuth client can be registered before selecting it for consent against a compatible Template.",
  },
  credentialsRegisterGitHubApp: {
    group: "Pages/Credentials",
    name: "Register GitHub App",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    actions: [
      click("Register client"),
      { selector: "#credential-client-kind", value: "github-app" },
    ],
    description:
      "The App ID is immutable and the private key file contents are write-only. GitHub App registrations are Installation-wide.",
  },
  credentialsGitHubAppVerificationFailed: {
    group: "Pages/Credentials",
    name: "GitHub App verification failed",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "github-app-verification-failed",
    actions: [
      click("Register client"),
      { selector: "#credential-client-kind", value: "github-app" },
    ],
    description:
      "The simulated verifier refuses registration and leaves the form open for correction.",
    steps: [
      "Enter a sample client name and App ID. Select an inert .pem file and choose Register client.",
      "Read the verification message. The form stays open and clears the file before retry.",
    ],
  },
  credentialsRotateGitHubApp: {
    group: "Pages/Credentials",
    name: "Rotate GitHub App key",
    path: "/console/credentials/credential-clients",
    oauthCatalog: "ready",
    actions: [{ selector: 'button[aria-label="Rotate Repository automation"]', click: true }],
    description:
      "The administrator supplies a replacement key; the App ID and cached installation tokens remain unchanged.",
  },
  credentialsMemberAccess: {
    group: "Pages/Credentials",
    name: "Namespace member",
    path: "/console/secrets",
    readOnlyPermissionSummary: true,
    description:
      "A Namespace member can open Secrets. Only Installation administrators see Connection templates and Credential clients.",
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
      | `/console/credentials/connection-templates?${string}`
      | "/console/credentials/credential-clients";
    actions?: StoryAction[];
    emptyNamespaces?: true;
    oauthCatalog?: "ready" | "error" | "unconfirmed-save" | "github-app-verification-failed";
    readOnlyPermissionSummary?: true;
    description: string;
    steps?: readonly string[];
  }
>;
