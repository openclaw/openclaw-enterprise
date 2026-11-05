import {
  createPluginFields as createProductionPluginFields,
  type CatalogEntry,
  type PluginFieldCatalog,
  type PluginFieldsOptions,
} from "/console/agents/plugin-fields.production.mjs";
import { scenarios } from "/storybook-fixtures/scenarios.mjs";

export { isPluginSelections } from "/console/agents/plugin-fields.production.mjs";

type DiscoveryPreview = {
  pages?: {
    initial?: {
      plugins: readonly (CatalogEntry & { remoteId: string })[];
      setup: NonNullable<PluginFieldCatalog["setup"]>;
    };
  };
  details?: Readonly<Record<string, CatalogEntry>>;
};

type Scenario =
  | { name: string; fixturePluginCatalog?: false }
  | {
      name: string;
      fixturePluginCatalog: true;
      fixturePluginCatalogMessage?: string;
      pluginDiscovery?: DiscoveryPreview;
      pluginCapabilities?: PluginFieldsOptions["capabilities"];
    };

const catalogScenarios: Readonly<Record<string, Scenario>> = scenarios;

function currentScenario() {
  const globals: object = globalThis;
  const story = "__consoleStory" in globals ? globals.__consoleStory : undefined;
  if (
    typeof story === "object" &&
    story !== null &&
    "id" in story &&
    typeof story.id === "string"
  ) {
    return Object.hasOwn(catalogScenarios, story.id) ? catalogScenarios[story.id] : undefined;
  }
}

export function createPluginFields(options: PluginFieldsOptions) {
  const scenario = currentScenario();
  const discovery = scenario?.fixturePluginCatalog ? scenario.pluginDiscovery : undefined;
  const initial = discovery?.pages?.initial;
  if (!scenario?.fixturePluginCatalog || !initial) {
    return createProductionPluginFields(options);
  }

  const fixtureCatalog = (): PluginFieldCatalog => {
    const entries = initial.plugins.map((entry) =>
      structuredClone(discovery?.details?.[entry.remoteId] ?? entry),
    );
    const message = scenario.fixturePluginCatalogMessage;
    const setup = structuredClone(initial.setup);
    return {
      status: "ready",
      setup: message ? { ...setup, message } : setup,
      entries,
      knownEntries: entries,
      nextCursor: null,
      pageNumber: 1,
      hasPrevious: false,
      canLoad: false,
      ...(message === undefined ? {} : { message }),
    };
  };
  const fixtureCapabilities = () => structuredClone(scenario.pluginCapabilities ?? null);
  const fields = createProductionPluginFields({
    ...options,
    catalog: fixtureCatalog(),
    capabilities: fixtureCapabilities(),
    onLoadPlugins: null,
    onLoadTools: null,
  });
  const { setCatalog, setCapabilities } = fields;
  fields.setCatalog = () => setCatalog(fixtureCatalog());
  fields.setCapabilities = () => setCapabilities(fixtureCapabilities());
  return fields;
}
