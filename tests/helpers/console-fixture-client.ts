import type {
  AccessBinding,
  Group,
  GroupMembership,
  Identity,
  Permission,
  Role,
  SecretBindings,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import type { IAMAccessBindingWire } from "../../packages/contracts/src/api/resources.ts";
import type { CreateAgentInput, OpenClawController } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "./console-app.mjs";

type ConsoleApp = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type CreatedAgent = Awaited<ReturnType<ConsoleApp["createAgent"]>>;
type ConfigurationOptions = { secretBindings?: SecretBindings | undefined };
type AgentOptions = ConfigurationOptions & {
  [Field in "backendId" | "harnessAuth" | "credentialSources" | "executionMode"]?:
    CreateAgentInput[Field] | undefined;
};

type ConsoleFixtureClient = Omit<
  ConsoleApp,
  | "request"
  | "createConfiguration"
  | "updateConfiguration"
  | "createAgent"
  | "addedAccessBindings"
  | "grantAgentSecretOperate"
  | "policy"
  | "controller"
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
  addedAccessBindings(namespaceId: string): Promise<IAMAccessBindingWire[]>;
  grantAgentSecretOperate(
    agent: CreatedAgent | Pick<CreatedAgent, "id" | "namespaceId" | "servicePrincipalId">,
    source: SecretReference | Pick<SecretReference, "id">,
    options?: { listed?: boolean | undefined; modelGrant?: boolean | undefined },
  ): Promise<void>;
  policy: Omit<
    ConsoleApp["policy"],
    "identities" | "groups" | "memberships" | "roles" | "bindings"
  > & {
    identities: Identity[];
    groups: Group[];
    memberships: GroupMembership[];
    roles: (Omit<Role, "permissions"> & { permissions: Permission[] })[];
    bindings: AccessBinding[];
  };
  controller: OpenClawController | undefined;
};

// The JS entry point also serves tests that still access raw JSON directly. Keep the same
// implementation and require the converted tests to validate JSON with fixtureResponse.
export function consoleFixtureClient(app: ConsoleApp): ConsoleFixtureClient {
  return app;
}
