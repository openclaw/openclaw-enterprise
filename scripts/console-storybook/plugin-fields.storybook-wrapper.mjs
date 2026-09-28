import { createPluginFields as createProductionPluginFields } from "./plugin-fields.production.mjs";
import { scenarios } from "/storybook-fixtures/scenarios.mjs";

function currentScenario() {
  return scenarios[globalThis.__consoleStory?.id];
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fixtureCatalog(scenario) {
  if (!scenario?.fixturePluginCatalog) {
    return null;
  }
  const initial = scenario.pluginDiscovery?.pages?.initial;
  if (!initial) {
    return null;
  }
  const entries = initial.plugins.map((entry) =>
    clone(scenario.pluginDiscovery.details?.[entry.remoteId] ?? entry),
  );
  const setup = clone(initial.setup);
  if (scenario.fixturePluginCatalogMessage) {
    setup.message = scenario.fixturePluginCatalogMessage;
  }
  return {
    status: "ready",
    setup,
    entries,
    knownEntries: entries,
    nextCursor: null,
    pageNumber: 1,
    hasPrevious: false,
    canLoad: false,
    message: scenario.fixturePluginCatalogMessage ?? undefined,
  };
}

function fixtureCapabilities(scenario) {
  return scenario?.fixturePluginCatalog ? (clone(scenario.pluginCapabilities) ?? null) : null;
}

export function createPluginFields(options) {
  const scenario = currentScenario();
  const catalog = fixtureCatalog(scenario);
  const capabilities = fixtureCapabilities(scenario);
  if (!catalog) {
    return createProductionPluginFields(options);
  }
  const fields = createProductionPluginFields({
    ...options,
    catalog,
    capabilities,
    onLoadPlugins: null,
    onLoadTools: null,
  });
  const setCatalog = fields.setCatalog;
  fields.setCatalog = () => setCatalog(fixtureCatalog(scenario));
  const setCapabilities = fields.setCapabilities;
  fields.setCapabilities = () => setCapabilities(fixtureCapabilities(scenario));
  return fields;
}
