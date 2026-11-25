import type { CredentialSourceResponse } from "@openclaw-enterprise/contracts";
import { click, create, form } from "../create-agent-form-data.mts";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const sourceId = "cs_00000000-0000-4000-8000-000000000020";
const replacementId = "cs_00000000-0000-4000-8000-000000000021";
const codexPatId = "cs_00000000-0000-4000-8000-000000000023";
type StaticSource = Extract<CredentialSourceResponse["data"], { type: "static" }>;
type OAuthSource = Extract<CredentialSourceResponse["data"], { type: "oauth2-refresh-token" }>;
const source = (id: string, name: string): StaticSource => ({
  id,
  namespaceId,
  name,
  type: "static",
  config: { provider_preset: "openai" },
  state: "ready",
  ref: { kind: "credential_source", namespaceId, id },
  createdAt: "2026-09-01T12:00:00.000Z",
});

// Public metadata only. Storybook never receives TokenService material.
export const previewModelSources = [
  source(sourceId, "Research model"),
  source(replacementId, "Replacement model"),
] as const;
const templateSourceId = "cs_00000000-0000-4000-8000-000000000022";
const previewTemplateSource: StaticSource = {
  ...source(templateSourceId, "Reporting credential"),
  config: {},
  connectionTemplateId: "ctp_00000000-0000-4000-8000-000000000005",
};
const oauthSourceId = "cs_00000000-0000-4000-8000-000000000024";
const previewOAuthSource: OAuthSource = {
  id: oauthSourceId,
  namespaceId,
  name: "Support OAuth",
  type: "oauth2-refresh-token",
  connectionTemplateId: "ctp_00000000-0000-4000-8000-000000000004",
  consent: {
    kind: "connection_template",
    version: 1,
    ownerPrincipalId: "storybook-operator",
    oauthClientId: "ccr_00000000-0000-4000-8000-000000000006",
    issuer: "https://identity.example.com",
    tokenUrl: "https://identity.example.com/token",
    clientId: "support-demo",
    requestedScopes: ["messages.read"],
    grantedScopes: ["messages.read"],
    destinations: [{ host: "mcp.example.com", port: 443, path: "/mcp" }],
  },
  state: "ready",
  ref: { kind: "credential_source", namespaceId, id: oauthSourceId },
  createdAt: "2026-09-01T12:00:00.000Z",
};
const previewInventory = [...previewModelSources, previewTemplateSource, previewOAuthSource];
const previewCodexPatSource: StaticSource = {
  ...source(codexPatId, "Codex PAT"),
  config: { provider_preset: "codex-pat" },
};
const codexOAuthId = "cs_00000000-0000-4000-8000-000000000028";
const previewCodexOAuthSource: OAuthSource = {
  id: codexOAuthId,
  namespaceId,
  name: "Saved ChatGPT login",
  type: "oauth2-refresh-token",
  state: "ready",
  ref: { kind: "credential_source", namespaceId, id: codexOAuthId },
  createdAt: "2026-09-01T12:00:00.000Z",
  consent: {
    kind: "builtin_codex",
    ownerPrincipalId: "storybook-operator",
    requestedScopes: ["openid"],
    grantedScopes: ["openid"],
    issuer: "https://auth.openai.com",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "storybook-codex-client",
    account: { accountId: "storybook-account", planType: "demo", isFedramp: false },
  },
};

const path = `/console/secrets?namespace=${namespaceId}`;
const createInventorySource = [
  click("Create Source"),
  { selector: "#credential-source-name", value: "Inventory model" },
  { selector: "#credential-source-purpose", value: "model:openai" },
  { selector: "#credential-source-value", value: "dummy-story-credential" },
  { selector: 'button[form="credential-source-form"]', click: true },
] as const;
export const credentialSourceScenarios = {
  credentialsSourceInventory: {
    group: "Pages/Credentials",
    name: "Credentials",
    path,
    oauthCatalog: "ready",
    initialCredentialSources: previewInventory,
    description:
      "Inspect the single Credentials tab with readable static, OAuth and protected Proxy Source metadata alongside Namespace Secrets. The fixture contains no credential values, and the page does not show OAuth consent or Proxy configuration.",
  },
  credentialsSourceEmpty: {
    group: "Pages/Credentials",
    name: "No readable Credential Sources",
    path,
    initialCredentialSources: [],
    description:
      "The simulated inventory is empty. Create Source remains available when the Namespace is ready.",
  },
  credentialsSourceLoading: {
    group: "Pages/Credentials",
    name: "Credential Sources loading",
    path,
    rules: [{ suffix: "/credential-sources", method: "GET", hold: true }],
    description:
      "The Source collection is still loading. Namespace Secrets remain available in the same Credentials tab.",
  },
  credentialsSourceReadDenied: {
    group: "Pages/Credentials",
    name: "Credential Source inventory denied",
    path,
    rules: [
      {
        suffix: "/credential-sources",
        method: "GET",
        status: 403,
        code: "FORBIDDEN",
        message: `Not authorized: this needs Namespace read on Namespace ${namespaceId}. Ask an Installation administrator to grant it.`,
      },
    ],
    description:
      "The simulated Source read is denied because Namespace access was revoked. The entire Credentials page clears, including Secret metadata.",
  },
  credentialsSourceCreate: {
    group: "Pages/Credentials",
    name: "Create a Credential Source",
    path,
    oauthCatalog: "ready",
    initialCredentialSources: previewInventory,
    actions: [click("Create Source")],
    description:
      "Choose an approved model preset or static Bearer Template and enter a dummy credential. The simulated API saves only public metadata in the list.",
  },
  credentialsSourceCreatedUnreadable: {
    group: "Pages/Credentials",
    name: "Created Source without exact read access",
    path,
    oauthCatalog: "ready",
    rules: [{ suffix: "/credential-sources", method: "GET", data: [] }],
    actions: createInventorySource,
    description:
      "The simulated create succeeds, but the separately filtered inventory omits the new Source. The page confirms creation and explains that exact Source read is required before reuse.",
  },
  credentialsSourceCreatedInventoryDenied: {
    group: "Pages/Credentials",
    name: "Source created but inventory access denied",
    path,
    oauthCatalog: "ready",
    initialCredentialSources: previewInventory,
    rules: [
      {
        suffix: "/credential-sources",
        method: "GET",
        skip: 1,
        status: 403,
        code: "FORBIDDEN",
        message: `Not authorized: this needs Namespace read on Namespace ${namespaceId}. Ask an Installation administrator to grant it.`,
      },
    ],
    actions: createInventorySource,
    description:
      "The simulated create succeeds, then Namespace access is denied on the inventory read. The page states that creation succeeded, clears both inventories, and shows the exact denial.",
  },
  createExistingSourceLoading: {
    group: "Pages/Create Agent",
    name: "Existing Source list loading",
    path: create,
    modelCredentialSourcePresets: ["openai"],
    rules: [{ suffix: "/credential-sources", method: "GET", hold: true }],
    actions: form,
    description:
      "The simulated Source inventory read is pending. The picker displays a loading state and cannot select an unconfirmed Source.",
  },
  createExistingSourceListFailure: {
    group: "Pages/Create Agent",
    name: "Retry an unavailable Source list",
    path: create,
    modelCredentialSourcePresets: ["openai"],
    initialCredentialSources: previewModelSources,
    rules: [
      {
        suffix: "/credential-sources",
        method: "GET",
        status: 503,
        code: "DEPENDENCY_UNAVAILABLE",
        once: true,
      },
    ],
    actions: form,
    description:
      "The first simulated inventory read fails. Retry Source list makes another read without creating a Source or Agent.",
    steps: ["Select Retry Source list and confirm Research model becomes available."],
  },
  createExistingSourceNoMatch: {
    group: "Pages/Create Agent",
    name: "No eligible model Credential Source",
    path: create,
    modelCredentialSourcePresets: ["openai"],
    initialCredentialSources: [previewTemplateSource],
    actions: form,
    description:
      "The simulated inventory contains a Template Source. The model picker excludes it and explains that no matching ready static model Source is readable.",
  },
  createWithExistingCredentialSource: {
    group: "Pages/Create Agent",
    name: "Reuse an existing Credential Source",
    path: create,
    modelCredentialSourcePresets: ["openai"],
    initialCredentialSources: previewModelSources,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Source reuse example" },
      click("Enter model ID manually"),
      { selector: "#agent-model-manual", value: "gpt-5.1" },
      { selector: "#agent-model-credential", value: sourceId },
    ],
    description:
      "Select an existing ready model Source. Create Agent saves its exact ID on the draft without enrolling another Source.",
    steps: [
      "Select Refresh Source list and confirm Research model stays selected before creating the Agent.",
    ],
  },
  createExistingSourceUnsupportedDestination: {
    group: "Pages/Create Agent",
    name: "Existing Source destination mismatch",
    path: create,
    modelCredentialSourcePresets: ["openai"],
    initialCredentialSources: previewModelSources,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
      { selector: "#execution-mode", value: "dedicated" },
      { selector: "#agent-name", value: "Custom destination Agent" },
      click("Enter model ID manually"),
      { selector: "#agent-model-manual", value: "gpt-5.1" },
      { selector: "#agent-model-credential", value: sourceId },
      { selector: ".launch-advanced summary", click: true },
      {
        selector: "#configuration-json",
        value: JSON.stringify(
          {
            gateway: { mode: "local" },
            agents: {
              defaults: {
                model: "openai/gpt-5.1",
                models: { "openai/gpt-5.1": { agentRuntime: { id: "openclaw" } } },
              },
            },
            models: {
              providers: {
                openai: {
                  api: "openai-responses",
                  baseUrl: "https://models.example.test/v1",
                  models: [{ id: "gpt-5.1" }],
                },
              },
            },
          },
          null,
          2,
        ),
      },
      click("Create Agent"),
    ],
    description:
      "The selected Source preset does not authorize the custom destination in Advanced settings. The form refuses the save before writing Configuration or Agent state.",
  },
  createExistingSourceDenied: {
    group: "Pages/Create Agent",
    name: "Existing Source operate denied after Configuration save",
    path: create,
    modelCredentialSourcePresets: ["openai"],
    initialCredentialSources: previewModelSources,
    rules: [
      {
        suffix: "/agents",
        method: "POST",
        status: 403,
        code: "FORBIDDEN",
        message: `Not authorized: this needs CredentialSource operate on CredentialSource ${sourceId}. Ask an Installation administrator to grant it.`,
      },
    ],
    actions: [
      ...form,
      { selector: "#agent-name", value: "Denied Source example" },
      click("Enter model ID manually"),
      { selector: "#agent-model-manual", value: "gpt-5.1" },
      { selector: "#agent-model-credential", value: sourceId },
      click("Create Agent"),
    ],
    description:
      "The simulated Agent create is refused after Configuration was saved. The form names the missing Source operate grant and reports the retained Configuration honestly; no Agent was saved.",
  },
  credentialsReplaceExistingSource: {
    group: "Components/Credentials",
    name: "Replace an existing Credential Source",
    path: `/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=${namespaceId}&revision=draft&tab=credentials`,
    auth: "api-source",
    initialCredentialSources: previewModelSources,
    actions: [{ selector: "#harness-auth-existing-source", value: replacementId }],
    description:
      "Choose another ready Source and save authentication. The simulated Agent PATCH replaces the Harness Source Reference without enrolling another Source. An active Agent must complete Stop before deployment of the replacement.",
  },
  credentialsFirstManagedSource: {
    group: "Components/Credentials",
    name: "Select a first managed Source for Codex",
    path: `/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=${namespaceId}&revision=draft&tab=credentials`,
    harnessId: "codex",
    auth: null,
    initialCredentialSources: previewModelSources,
    actions: [{ selector: "#harness-auth-method", value: "credential_source" }],
    description:
      "The draft explains that an active Agent must complete Stop before deploying the managed Source, and that the effective Codex destination is checked at deployment.",
  },
  credentialsCodexPatFixedDestination: {
    group: "Components/Credentials",
    name: "Codex PAT Source with a previous model provider override",
    path: `/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=${namespaceId}&revision=draft&tab=credentials`,
    harnessId: "codex",
    auth: "api-source",
    deployed: true,
    harnessOverrides: {
      modelProvider: {
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai-responses",
        supportsStandaloneWebSearch: false,
      },
    },
    initialCredentialSources: [previewCodexPatSource],
    actions: [
      { selector: "#harness-auth-existing-source", value: codexPatId },
      click("Save authentication source"),
      {
        selector: '.agent-harness-settings:has(option[value="custom"]:disabled) > summary',
        click: true,
      },
    ],
    description:
      "The previous simulated version used an OpenAI Source with a model provider override. After the draft switches to a Codex PAT Source, its exact metadata read identifies the fixed destination. Harness settings selects Use Installation default, does not retain the old model provider override, and disables a new override. Deployment is not exercised.",
  },
  credentialsCodexOAuthFixedDestination: {
    group: "Components/Credentials",
    name: "Saved Codex OAuth Source with a previous model provider override",
    path: `/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=${namespaceId}&revision=draft&tab=credentials`,
    harnessId: "codex",
    auth: "api-source",
    deployed: true,
    harnessOverrides: {
      modelProvider: {
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai-responses",
        supportsStandaloneWebSearch: false,
      },
    },
    initialCredentialSources: [previewCodexOAuthSource],
    actions: [
      { selector: "#harness-auth-existing-source", value: codexOAuthId },
      click("Save authentication source"),
      {
        selector: '.agent-harness-settings:has(option[value="custom"]:disabled) > summary',
        click: true,
      },
    ],
    description:
      "The simulated draft replaces an OpenAI Source with a saved built-in Codex OAuth Source. Harness settings drops the old model provider override, selects Use Installation default, and disables a new override. Deployment is not exercised.",
  },
  credentialsUnsupportedModelSource: {
    group: "Components/Credentials",
    name: "Model Source unavailable without an approved destination",
    path: `/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=${namespaceId}&revision=draft&tab=credentials`,
    harnessId: "openclaw",
    modelProviderBaseUrl: "https://models.example.test/v1",
    auth: "api-source",
    initialCredentialSources: previewModelSources,
    description:
      "This simulated OpenClaw Configuration uses a custom destination. The current Source is preserved, but Source replacement is unavailable because no approved model preset matches the destination.",
  },
  credentialsReplaceSourceDenied: {
    group: "Components/Credentials",
    name: "Credential Source replacement denied",
    path: `/console/agents/agt_00000000-0000-4000-8000-000000000001?namespace=${namespaceId}&revision=draft&tab=credentials`,
    auth: "api-source",
    initialCredentialSources: previewModelSources,
    rules: [
      {
        suffix: "/agents/agt_00000000-0000-4000-8000-000000000001",
        method: "PATCH",
        status: 403,
        code: "FORBIDDEN",
        message: `Not authorized: this needs CredentialSource operate on CredentialSource ${replacementId}. Ask an Installation administrator to grant it.`,
      },
    ],
    actions: [
      { selector: "#harness-auth-existing-source", value: replacementId },
      click("Save authentication source"),
    ],
    description:
      "The simulated API refuses the Agent update. The selected replacement remains visible for correction, while the saved Agent keeps its previous Source.",
  },
  credentialsSourceTemplatesUnavailable: {
    group: "Pages/Credentials",
    name: "Model Source creation when Templates are unavailable",
    path,
    rules: [
      {
        suffix: "/connection-templates",
        method: "GET",
        status: 503,
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Template discovery unavailable.",
      },
    ],
    actions: [click("Create Source")],
    description:
      "Template discovery fails in the simulated API. The form still offers model presets and leaves Source authorization and owner support to the actual registration request.",
  },
  credentialsSourceCreateUnknown: {
    group: "Pages/Credentials",
    name: "Credential Source create outcome unknown",
    path,
    oauthCatalog: "ready",
    rules: [{ suffix: "/credential-sources", method: "POST", lostAnswer: true, once: true }],
    actions: [
      click("Create Source"),
      { selector: "#credential-source-name", value: "Uncertain model" },
      { selector: "#credential-source-purpose", value: "model:openai" },
      { selector: "#credential-source-value", value: "dummy-story-credential" },
      { selector: 'button[form="credential-source-form"]', click: true },
    ],
    description:
      "The simulated API saves a Source and loses its reply. The cleared form and Create Source action remain blocked until Refresh checks the inventory.",
    steps: [
      "Close the dialog, select Refresh, and confirm Uncertain model appears in the inventory.",
    ],
  },
  credentialsSourceCreateConflictUnknown: {
    group: "Pages/Credentials",
    name: "Credential Source conflict outcome unknown",
    path,
    oauthCatalog: "ready",
    rules: [
      {
        suffix: "/credential-sources",
        method: "POST",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message: "The requested platform resource already exists.",
      },
    ],
    actions: createInventorySource,
    description:
      "A simulated 409 response cannot confirm whether the credential owner took custody. The form clears the value, blocks another create, and directs the reviewer to Refresh the inventory and ask an operator to inspect the owner if the Source is absent.",
    steps: [
      "Close the dialog and select Refresh. The simulated inventory remains empty; the preview does not establish whether the credential owner holds the value.",
    ],
  },
  credentialsSourceCreateDenied: {
    group: "Pages/Credentials",
    name: "Credential Source creation denied",
    path,
    oauthCatalog: "ready",
    initialCredentialSources: previewModelSources,
    rules: [
      {
        suffix: "/credential-sources",
        method: "POST",
        status: 403,
        code: "FORBIDDEN",
        message: `Not authorized: this needs CredentialSource create in Namespace ${namespaceId}. Ask an Installation administrator to grant it.`,
      },
    ],
    actions: [
      click("Create Source"),
      { selector: "#credential-source-name", value: "Denied model" },
      { selector: "#credential-source-purpose", value: "model:openai" },
      { selector: "#credential-source-value", value: "dummy-story-credential" },
      { selector: 'button[form="credential-source-form"]', click: true },
    ],
    description:
      "The simulated API refuses this exact Source create. The form shows the denial without adding a Source to the inventory.",
  },
} as const;
