import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { TestContext } from "node:test";

import { createOccLogger, type OccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type {
  CredentialGatewayDriver,
  Identity,
  PluginCatalogEntry,
  PluginDriver,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  type ControllerOptions,
} from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

export const accessToken = "at-plugin-discovery-private-fixture";
export const remoteId = "remote-knowledge";
export const catalogEntry: PluginCatalogEntry = {
  id: "codex-plugin:knowledge@openai-remote",
  remoteId,
  name: "Knowledge",
  description: "Search shared knowledge.",
  available: true,
  tools: null,
};
export const pluginDetails: PluginCatalogEntry = {
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

type DiscoveryCall =
  | { operation: "list"; input: Parameters<NonNullable<PluginDriver["discoverCatalog"]>>[0] }
  | { operation: "details"; input: Parameters<NonNullable<PluginDriver["getCatalogPlugin"]>>[0] };

type TestSecretDriver = ReturnType<typeof createTestSecretDriver>;
type ConsoleOptions = {
  state?: InMemoryPlatformState;
  auditSink?: InMemoryAuditSink;
  secretDriver?: TestSecretDriver;
  logger?: OccLogger;
  onSend?: (request: { raw: IncomingMessage }) => Promise<void>;
  credentialGatewayDriver?: CredentialGatewayDriver;
  pluginSourceReader?: ControllerOptions["pluginSourceReader"];
  sandboxDriver?: SandboxDriver;
};

export interface DiscoveryResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export async function createDiscoveryConsole(t: TestContext, options: ConsoleOptions = {}) {
  const fixture = await createConsoleAppFixture(t, options);
  const identities: Identity[] = fixture.policy.identities;

  async function request(...args: Parameters<typeof fixture.request>): Promise<DiscoveryResponse> {
    return fixture.request(...args);
  }

  return {
    ...fixture,
    policy: { ...fixture.policy, identities },
    request,
    get controller() {
      const controller: unknown = fixture.controller;
      assert.ok(controller instanceof OpenClawController, "Bootstrap the Console fixture first");
      return controller;
    },
  };
}

export type ConsoleFixture = Awaited<ReturnType<typeof createDiscoveryConsole>>;

type DiscoveryOptions = Omit<ConsoleOptions, "state" | "auditSink"> & {
  supported?: boolean;
  additionalPluginDriver?: PluginDriver;
  onCatalogDetails?: () => Promise<void>;
};

export async function createFixture(
  t: TestContext,
  {
    supported = true,
    additionalPluginDriver,
    onCatalogDetails,
    secretDriver = createTestSecretDriver(),
    ...options
  }: DiscoveryOptions = {},
) {
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  const fixture = await createDiscoveryConsole(t, { ...options, state, auditSink, secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Plugin discovery", { ready: true });
  const calls: DiscoveryCall[] = [];
  let failure: Error | undefined;
  // Only the external Driver boundary is controlled: HTTP, IAM and OCC remain real.
  const driver: PluginDriver = {
    id: "plugin-discovery-test",
    harnessId: "codex",
    capability: "plugin",
    implementation: "test-plugin-catalog",
    policyCapabilities: {
      toolDefaults: { enabled: false, approval: [], reviewer: [] },
      tools: { enabled: false, approval: [], reviewer: [] },
      driverPolicySchema: {},
    },
    validatePolicies(selections) {
      assert.deepEqual(selections, {}, "This fixture does not admit plugin selections");
    },
    async listCatalog() {
      throw new Error("Credential discovery must not use the runtime catalog.");
    },
    ...(supported
      ? {
          async discoverCatalog(
            input: Parameters<NonNullable<PluginDriver["discoverCatalog"]>>[0],
          ) {
            calls.push({ operation: "list", input });
            if (failure) {
              throw failure;
            }
            return {
              plugins: input.cursor ? [] : [catalogEntry],
              nextCursor: input.cursor ? null : "second-page",
            };
          },
          async getCatalogPlugin(
            input: Parameters<NonNullable<PluginDriver["getCatalogPlugin"]>>[0],
          ) {
            calls.push({ operation: "details", input });
            await onCatalogDetails?.();
            if (failure) {
              throw failure;
            }
            return pluginDetails;
          },
        }
      : {}),
  };
  fixture.controller.installPluginDrivers(
    additionalPluginDriver ? [driver, additionalPluginDriver] : [driver],
  );
  return {
    ...fixture,
    state,
    namespace,
    calls,
    auditSink,
    secretDriver,
    path: `/namespaces/${namespace.id}/agents/plugins`,
    failWith(error: Error) {
      failure = error;
    },
  };
}

export async function createSavedAgent(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  method: "codex_pat" | "api_key" = "codex_pat",
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
  // Runtime and discovery both need the Agent's own authority to operate its bound Secret.
  if (method === "codex_pat") {
    await fixture.grantAgentSecretOperate(agent, secret.ref, { listed: false });
  }
  return { agent, secret, path: `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins` };
}

export function secretValueReadCount(driver: TestSecretDriver): number {
  return driver.calls.filter(({ operation }) => operation === "withValue").length;
}

export function createDiscoveryLogger() {
  const logs: string[] = [];
  const logger = createOccLogger({
    component: "plugin-discovery-test",
    destination: {
      write(chunk) {
        logs.push(String(chunk));
        return true;
      },
    },
  });
  return { logger, logs };
}

export function boundPort(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Console fixture must bind a TCP port");
  return address.port;
}

export function fetchUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}
