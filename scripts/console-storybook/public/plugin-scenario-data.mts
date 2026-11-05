import type { PluginFieldsOptions } from "../../../apps/controller/src/console/agents/plugin-fields.mts";
import type {
  PluginCatalogEntry,
  PluginCatalogPage,
  PluginDesiredState,
} from "../../../packages/contracts/src/index.ts";
import type { servePluginDiscovery } from "./plugin-discovery-fixture.mts";

// A plugin tool-deny refusal as the API words it, naming the selected plugin.
export const pluginToolRefusal =
  'Configuration setting agents.entries.research_assistant.tools.deny denies every tool, so every turn of that Agent fails with plugin codex-plugin:calendar@openai-curated-remote selected; remove "*" or move the Agent to a Configuration without plugins.';

export const pluginCapabilities = {
  driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
  approvers: { agent: true, plugin: false, tools: false },
  toolDefaults: {
    enabled: true,
    approval: ["provider_default", "all_actions", "write_actions", "none"],
    reviewer: ["human", "auto"],
  },
  tools: {
    enabled: true,
    approval: ["provider_default", "all_actions", "write_actions", "none"],
    reviewer: [],
  },
  driverPolicySchema: {
    type: "object",
    properties: {
      destructiveEnabled: { type: "boolean", title: "Destructive tools" },
    },
    additionalProperties: false,
  },
} satisfies NonNullable<PluginFieldsOptions["capabilities"]>;

const manageWorkspacePlugins = {
  label: "Manage workspace plugins",
  url: "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
};

const ocePluginSetup = {
  label: "OCE plugin setup",
  url: "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
};

export const pluginSetup = {
  message:
    "App connection status is not verified. Catalog availability does not confirm linked credentials. In ChatGPT admin, select the same workspace as this credential and enable plugin and app access for its user or service account. For service-account plugin credentials, open Service accounts, choose the account, and configure its app connections. Workspace administrator access is required. OCE policies do not grant access or configure credentials. Reload plugins after changes.",
  links: [
    manageWorkspacePlugins,
    { label: "Service account credentials", url: "https://admin.openai.com/" },
    ocePluginSetup,
  ],
} satisfies NonNullable<PluginCatalogPage["setup"]>;

const unavailablePlugins = [
  {
    id: "codex-plugin:archive@openai-curated-remote",
    remoteId: "plugin_demo_archive",
    name: "Archive",
    available: false,
    unavailableReason:
      "This plugin requires local components or skills that OCE hosted discovery does not support. Changing ChatGPT access will not enable it here.",
    unavailableHelp: ocePluginSetup,
    tools: null,
  },
  {
    id: "codex-plugin:team-chat@openai-curated-remote",
    remoteId: "plugin_demo_team_chat",
    name: "Team chat",
    available: false,
    unavailableReason:
      "Disabled by a ChatGPT workspace administrator. Ask one to enable access for the user or service account behind this token.",
    unavailableHelp: manageWorkspacePlugins,
    tools: null,
  },
  {
    id: "codex-plugin:analytics@openai-curated-remote",
    remoteId: "plugin_demo_analytics",
    name: "Analytics",
    available: false,
    unavailableReason:
      "This workspace's plan is not eligible for this plugin. Ask a ChatGPT workspace administrator to review plan availability.",
    unavailableHelp: manageWorkspacePlugins,
    tools: null,
  },
] satisfies PluginCatalogEntry[];

export const calendarPlugin = {
  id: "codex-plugin:calendar@openai-curated-remote",
  remoteId: "plugin_demo_calendar",
  name: "Calendar",
  logoUrl: "/storybook-fixtures/plugin-logos/calendar.svg",
  websiteUrl: "https://example.com/calendar",
  privacyPolicyUrl: "https://example.com/calendar/privacy",
  termsOfServiceUrl: "https://example.com/calendar/terms",
  description: "Find events and manage a team calendar.",
  available: true,
  tools: [
    {
      id: "app_calendar/list_events",
      name: "List events",
      ownerId: "app_calendar",
      description: "Find events in a calendar and date range.",
    },
    {
      id: "app_calendar/create_event",
      name: "Create event",
      ownerId: "app_calendar",
      description: "Create a calendar event with a title, time, and attendees.",
    },
    {
      id: "app_calendar/delete_event",
      name: "Delete event",
      ownerId: "app_calendar",
      description: "Remove an existing calendar event.",
    },
  ],
} satisfies PluginCatalogEntry;

export const projectTrackerPlugin = {
  id: "codex-plugin:project-tracker@openai-curated-remote",
  remoteId: "plugin_demo_project_tracker",
  name: "Project tracker",
  logoUrl: "/storybook-fixtures/plugin-logos/missing.svg",
  tools: null,
} satisfies PluginCatalogEntry;

export const pluginCatalog = {
  status: "ready",
  setup: pluginSetup,
  entries: [
    calendarPlugin,
    {
      id: "codex-plugin:documents@openai-curated-remote",
      remoteId: "plugin_demo_documents",
      name: "Documents",
      logoUrl: "/storybook-fixtures/plugin-logos/documents.svg",
      websiteUrl: "https://example.com/documents",
      available: true,
      tools: [
        {
          id: "app_documents/search_documents",
          name: "Search documents",
          ownerId: "app_documents",
        },
        {
          id: "app_documents/update_document",
          name: "Update document",
          ownerId: "app_documents",
        },
      ],
    },
    projectTrackerPlugin,
    ...unavailablePlugins,
  ],
} satisfies NonNullable<PluginFieldsOptions["catalog"]>;

export const pluginSelectionState = {
  "codex-plugin:calendar@openai-curated-remote": {
    enabled: true,
    toolDefaults: { approval: "write_actions", reviewer: "auto" },
    tools: {
      "app_calendar/create_event": { approval: "all_actions" },
      "app_calendar/delete_event": { enabled: false },
    },
  },
} satisfies PluginDesiredState;

export const pluginSelections = JSON.stringify(pluginSelectionState, null, 2);

export const pluginDiscovery = {
  pages: {
    initial: {
      plugins: [...unavailablePlugins, { ...calendarPlugin, tools: null }],
      nextCursor: "demo-page-2",
      setup: pluginSetup,
    },
    "demo-page-2": {
      plugins: pluginCatalog.entries.slice(1, 3).map((entry) => ({ ...entry, tools: null })),
      nextCursor: null,
      setup: pluginSetup,
    },
  },
  details: Object.fromEntries<PluginCatalogEntry>(
    pluginCatalog.entries.map((entry): [string, PluginCatalogEntry] => [entry.remoteId, entry]),
  ),
} satisfies Parameters<typeof servePluginDiscovery>[0];
