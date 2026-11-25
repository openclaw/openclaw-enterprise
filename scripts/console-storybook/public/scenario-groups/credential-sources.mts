import type { CredentialSourceResponse } from "@openclaw-enterprise/contracts";
import { click, create, form } from "../create-agent-form-data.mts";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const sourceId = "cs_00000000-0000-4000-8000-000000000020";
const replacementId = "cs_00000000-0000-4000-8000-000000000021";
type StaticSource = Extract<CredentialSourceResponse["data"], { type: "static" }>;
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
const previewInventory = [...previewModelSources, previewTemplateSource];

const path = `/console/credentials/sources?namespace=${namespaceId}`;
const openExistingSource = [
  ...form,
  { selector: "#model-credential-storage", value: "existing_source" },
] as const;
export const credentialSourceScenarios = {
  credentialsSourceInventory: {
    group: "Pages/Credentials",
    name: "Credential Sources",
    path,
    oauthCatalog: "ready",
    initialCredentialSources: previewInventory,
    description:
      "Inspect the public Source name, type, state and purpose. TokenService material is absent from the preview data and is never read by this page.",
  },
  credentialsSourceEmpty: {
    group: "Pages/Credentials",
    name: "No readable managed Credential Sources",
    path,
    initialCredentialSources: [],
    description:
      "The simulated inventory is empty. Create Source remains available when the Namespace is ready.",
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
      "The simulated inventory read is denied. No Source names or credential material are disclosed.",
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
  createExistingSourceLoading: {
    group: "Pages/Create Agent",
    name: "Existing Source list loading",
    path: create,
    rules: [{ suffix: "/credential-sources", method: "GET", hold: true }],
    actions: openExistingSource,
    description:
      "The simulated Source inventory read is pending. The picker displays a loading state and cannot select an unconfirmed Source.",
  },
  createExistingSourceListFailure: {
    group: "Pages/Create Agent",
    name: "Retry an unavailable Source list",
    path: create,
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
    actions: openExistingSource,
    description:
      "The first simulated inventory read fails. Retry Source list makes another read without creating a Source or Agent.",
    steps: ["Select Retry Source list and confirm Research model becomes available."],
  },
  createExistingSourceNoMatch: {
    group: "Pages/Create Agent",
    name: "No eligible model Credential Source",
    path: create,
    initialCredentialSources: [previewTemplateSource],
    actions: openExistingSource,
    description:
      "The simulated inventory contains a Template Source. The model picker excludes it and explains that no matching ready static model Source is readable.",
  },
  createWithExistingCredentialSource: {
    group: "Pages/Create Agent",
    name: "Reuse an existing Credential Source",
    path: create,
    initialCredentialSources: previewModelSources,
    actions: [
      ...form,
      { selector: "#agent-name", value: "Source reuse example" },
      click("Enter model ID manually"),
      { selector: "#agent-model-manual", value: "gpt-5.1" },
      { selector: "#model-credential-storage", value: "existing_source" },
      { selector: "#agent-model-existing-source", value: sourceId },
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
    initialCredentialSources: previewModelSources,
    actions: [
      ...form,
      { selector: "#agent-harness", value: "openclaw" },
      { selector: ".launch-runtime summary", click: true },
      { selector: "#execution-mode", value: "dedicated" },
      { selector: "#agent-name", value: "Custom destination Agent" },
      click("Enter model ID manually"),
      { selector: "#agent-model-manual", value: "gpt-5.1" },
      { selector: "#model-credential-storage", value: "existing_source" },
      { selector: "#agent-model-existing-source", value: sourceId },
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
      { selector: "#model-credential-storage", value: "existing_source" },
      { selector: "#agent-model-existing-source", value: sourceId },
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
