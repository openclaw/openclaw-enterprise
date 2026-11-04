import { randomUUID } from "node:crypto";
import type { createConsoleAppFixture } from "./console-app.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import type { PluginDriver } from "../../packages/contracts/src/index.ts";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type CatalogInput = Parameters<NonNullable<PluginDriver["discoverCatalog"]>>[0];
type DetailsInput = Parameters<NonNullable<PluginDriver["getCatalogPlugin"]>>[0];
type DiscoveryCall =
  { operation: "list"; input: CatalogInput } | { operation: "details"; input: DetailsInput };

export const accessToken = "at-plugin-discovery-private-fixture";
const pluginId = "codex-plugin:knowledge@openai-remote";
export const remoteId = "remote-knowledge";
export const catalogEntry = {
  id: pluginId,
  remoteId,
  name: "Knowledge",
  description: "Search shared knowledge.",
  available: true,
  tools: null,
};
export const pluginDetails = {
  ...catalogEntry,
  tools: [
    {
      id: "app_knowledge/search",
      name: "Search",
      ownerId: "app_knowledge",
      description: "Search knowledge documents.",
      available: false,
      unavailableReason: "Connect an account to use this tool.",
    },
  ],
};

export async function setUpPluginDiscovery(fixture: ConsoleFixture, supported = true) {
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Plugin discovery", { ready: true });
  const calls: DiscoveryCall[] = [];
  let failure: unknown;
  // Only the external Driver boundary is controlled: HTTP, IAM and OCC remain real.
  const driver = {
    id: "plugin-discovery-test",
    capability: "plugin",
    implementation: "test-plugin-catalog",
    async listCatalog() {
      throw new Error("Credential discovery must not use the runtime catalog.");
    },
    ...(supported
      ? {
          async discoverCatalog(input: CatalogInput) {
            calls.push({ operation: "list", input });
            if (failure) {
              throw failure;
            }
            return {
              plugins: input.cursor ? [] : [catalogEntry],
              nextCursor: input.cursor ? null : "second-page",
            };
          },
          async getCatalogPlugin(input: DetailsInput) {
            calls.push({ operation: "details", input });
            if (failure) {
              throw failure;
            }
            return pluginDetails;
          },
        }
      : {}),
  };
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  return {
    ...fixture,
    namespace,
    calls,
    path: `/namespaces/${namespace.id}/agents/plugins`,
    failWith(error: unknown) {
      failure = error;
    },
  };
}

export async function createSavedAgent(
  fixture: Awaited<ReturnType<typeof setUpPluginDiscovery>>,
  method = "codex_pat",
) {
  const secret = await fixture.createSecret(
    fixture.namespace.id,
    `Plugin discovery credential ${randomUUID()}`,
    accessToken,
  );
  const dedicated = method === "codex_pat";
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    `Stored credential Agent ${randomUUID()}`,
    createHarnessConfiguration(dedicated ? "codex" : "openclaw", "gpt-5.1"),
    {
      executionMode: dedicated ? "dedicated" : "embedded",
      harnessAuth: { method, source: secret.ref },
    },
  );
  if (method === "codex_pat") {
    // Discovery requires the Agent's own authority on its bound Secret.
    await fixture.grantAgentSecretOperate(agent, secret, { listed: false });
  }
  return { agent, secret, path: `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins` };
}
