import type { SecretBindings } from "../../packages/contracts/src/index.ts";
import type { CreateAgentInput, OpenClawController } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "./console-app.mjs";

type ConsoleApp = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type ConfigurationOptions = { secretBindings?: SecretBindings | undefined };
type AgentOptions = ConfigurationOptions & {
  [Field in "backendId" | "harnessAuth" | "credentialSources" | "executionMode"]?:
    CreateAgentInput[Field] | undefined;
};

type ConsoleFixtureClient = Omit<
  ConsoleApp,
  "request" | "createConfiguration" | "updateConfiguration" | "createAgent" | "controller"
> & {
  request(
    ...args: Parameters<ConsoleApp["request"]>
  ): Promise<{ status: number; headers: Headers; body: unknown; data: unknown }>;
  createConfiguration(
    namespaceId: string,
    values?: object,
    options?: ConfigurationOptions,
  ): ReturnType<ConsoleApp["createConfiguration"]>;
  updateConfiguration(
    namespaceId: string,
    configurationId: string,
    values?: object,
    options?: ConfigurationOptions,
  ): ReturnType<ConsoleApp["updateConfiguration"]>;
  createAgent(
    namespaceId: string,
    name: string,
    values?: object,
    options?: AgentOptions,
  ): ReturnType<ConsoleApp["createAgent"]>;
  controller: OpenClawController | undefined;
};

// The JS entry point also serves tests that still access raw JSON directly. Keep the same
// implementation and require the converted tests to validate JSON with fixtureResponse.
export function consoleFixtureClient(app: ConsoleApp): ConsoleFixtureClient {
  return app;
}
