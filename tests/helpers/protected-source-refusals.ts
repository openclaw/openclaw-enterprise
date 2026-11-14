import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import type { Server } from "node:net";
import type { TestContext } from "node:test";
import Type from "typebox";
import { Check } from "typebox/value";

import type { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import type { KubernetesAuthentication } from "../../apps/controller/src/drivers/kubernetes/authentication.ts";
import type { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import {
  AgentResponse,
  AgentSchema,
  CredentialSourceSchema,
  IAMAccessBindingSchema,
  NamespaceSchema,
  SecretResponse,
  SecretSchema,
  type AgentWire,
  type CredentialSourceWire,
  type NamespaceWire,
  type SecretWire,
} from "../../packages/contracts/src/api/resources.ts";
import type {
  PreparedTokenCurrentProof,
  PreparedTokenIssuer,
} from "../../packages/contracts/src/prepared-token.ts";
import type {
  CredentialProviderDefinition,
  DriverCapability,
  EgressResolution,
  SecretDriver,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import {
  OpenClawController,
  type CredentialProxyCapacity,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { backendFixtures, createConsoleAppFixture } from "./console-app.mjs";
import { consoleFixtureClient } from "./console-fixture-client.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { staticEgressFixture } from "./static-egress.mjs";

const staticEgressResources = Type.Object({
  namespace: NamespaceSchema,
  agent: AgentSchema,
  source: CredentialSourceSchema,
  secret: SecretSchema,
  legacySource: Type.Optional(CredentialSourceSchema),
});

function unexpectedIssuerWork(): never {
  assert.fail("a refused protected source create must not reach the prepared issuer");
}

type ConsoleFixture = ReturnType<typeof consoleFixtureClient>;
type PreparedGitHubOwner = Pick<
  PreparedTokenIssuer,
  "configure" | "resolve" | "ready" | "withdraw"
> & {
  apiOrigin: string;
};
type PreparedGitHub = PreparedGitHubOwner & PreparedTokenCurrentProof;
type PreparedGitHubFactory<Owner extends PreparedGitHubOwner> = (input: {
  secretDriver: SecretDriver;
  tokenService: TokenService;
}) => Owner | Promise<Owner>;

// The static fixture forwards current to the effective owner when its proof adapter is enabled.
// With the adapter disabled, the factory may register its own proof with TokenService.
type PreparedGitHubOptions =
  | {
      githubMetadata?: boolean | undefined;
      preparedGitHub?: PreparedGitHub | undefined;
      createPreparedGitHub?: PreparedGitHubFactory<PreparedGitHub> | undefined;
    }
  | ((
      | { githubMetadata?: false | undefined; preparedGitHub?: undefined }
      | { githubMetadata?: boolean | undefined; preparedGitHub: undefined }
    ) & {
      createPreparedGitHub?: PreparedGitHubFactory<PreparedGitHubOwner> | undefined;
    });
type AdmitSourceInput = {
  app: ConsoleFixture & { controller: OpenClawController };
  agent: AgentWire;
  namespace: NamespaceWire;
  secret: SecretWire;
  path: string;
  origin: string;
  countSecretReads: () => number;
  computeAuthentication: Extract<KubernetesAuthentication, { mode: "kubeconfig" }>;
};
type AdmittedSource = { agent: AgentWire; source: CredentialSourceWire };
type StaticEgressOptions<Provider extends Server> = NonNullable<
  Parameters<typeof staticEgressFixture<Provider>>[1]
>;

// The inferred JS signature excludes destructured fields without defaults. These fields still
// reach the static egress fixture through the original options spread.
type ProtectedSourceOptions<Provider extends Server> = {
  [Field in keyof StaticEgressOptions<Provider>]?: StaticEgressOptions<Provider>[Field] | undefined;
} & PreparedGitHubOptions & {
    admissionOnly?: boolean | undefined;
    gatewayOnly?: boolean | undefined;
    serviceTransport?:
      | Pick<
          GrpcOpenShellGatewayClient,
          "getServiceDocument" | "postServiceDocument" | "serviceWebSocketHandshake"
        >
      | undefined;
    resolutionFinished?: ((result: EgressResolution) => void) | undefined;
    configurePreparedTokens?:
      ((service: TokenService) => CredentialProviderDefinition | undefined) | undefined;
    secretValue?: string | undefined;
    admitSource?:
      ((input: AdmitSourceInput) => AdmittedSource | Promise<AdmittedSource>) | undefined;
    credentialProxyCapacity?: CredentialProxyCapacity | undefined;
  };
type ProtectedSourceResult<Provider extends Server> = Awaited<
  ReturnType<typeof buildProtectedSourceFixture<Provider>>
>;

/**
 * The create body of each protected source type that names its Agent in `config.agent_id`: the
 * Proxy's credential-free metadata and, with `githubMetadata`, the prepared GitHub metadata.
 */
export const protectedSourceInputs = {
  "credential-free-repository-metadata": (agentId: string) => ({
    name: "credential-free",
    type: "credential-free-repository-metadata",
    config: {
      origin: "https://api.github.com",
      repository_id: "7311",
      repository: "fixture/credential-free",
      agent_id: agentId,
      authority: "execution",
    },
  }),
  "github-app-metadata": (agentId: string, issuer: SecretReference) => ({
    name: "prepared-metadata",
    type: "github-app-metadata",
    config: {
      app_id: "11",
      installation_id: "22",
      repository_id: "7311",
      repository: "fixture/prepared",
      agent_id: agentId,
      authority: "execution",
    },
    secrets: { private_key: issuer },
  }),
};

/**
 * The static egress fixture (real app, IAM, controller, OpenShell Credential Proxy and Gateway
 * Drivers; supplier wires are fixtures) with one Agent bound to a live-adopted protected source.
 * By default it leaves the Agent undeployed. `restart` opens the same state with a controller for the same
 * Installation after a change of its Driver selection, as a new API process would.
 */
export function protectedSourceFixture<Provider extends Server = never>(
  t: TestContext,
  options?: ProtectedSourceOptions<Provider> & { admitRevision?: false },
): Promise<Extract<ProtectedSourceResult<Provider>, { fixtureKind: "undeployed" }>>;
export function protectedSourceFixture<Provider extends Server = never>(
  t: TestContext,
  options: ProtectedSourceOptions<Provider> & { admitRevision: true | undefined },
): Promise<Extract<ProtectedSourceResult<Provider>, { fixtureKind: "deployed" }>>;
export function protectedSourceFixture<Provider extends Server = never>(
  t: TestContext,
  options?: ProtectedSourceOptions<Provider>,
): Promise<ProtectedSourceResult<Provider>>;
export function protectedSourceFixture<Provider extends Server = never>(
  t: TestContext,
  options?: ProtectedSourceOptions<Provider>,
) {
  return buildProtectedSourceFixture(t, options);
}

async function buildProtectedSourceFixture<Provider extends Server>(
  t: TestContext,
  { githubMetadata = false, ...options }: ProtectedSourceOptions<Provider> = {},
) {
  const captured: {
    state?: PlatformStateStore;
    app?: ConsoleFixture;
  } = {};
  // Preserve the static fixture's deployment default when the caller explicitly passes undefined.
  const { admitRevision = true, ...fixtureOptions } = {
    admitRevision: false,
    // `githubMetadata` enables the prepared github-app-metadata type. These refusals come before
    // any issuer work, so its lifecycle must never run.
    ...(githubMetadata && {
      preparedGitHub: {
        apiOrigin: "https://api.github.com",
        configure: unexpectedIssuerWork,
        resolve: unexpectedIssuerWork,
        ready: unexpectedIssuerWork,
        withdraw: unexpectedIssuerWork,
        current: unexpectedIssuerWork,
      } satisfies PreparedGitHub,
    }),
    ...options,
  };
  const f = await staticEgressFixture<Provider>(t, {
    ...fixtureOptions,
    admitRevision,
    appFactory: async (context, appOptions) => {
      const app = await createConsoleAppFixture(context, {
        ...appOptions,
        wrapState(base: PlatformStateStore) {
          captured.state = base;
          return base;
        },
      });
      captured.app = consoleFixtureClient(app);
      return app;
    },
  });
  assert.ok(
    captured.state && captured.app,
    "the Console fixture must capture its application and platform state",
  );
  const { state, app } = captured;
  const { controller, request, fixtureResponse, createConfiguration } = app;
  assert.ok(controller, "the static egress fixture must bootstrap the controller");
  const runningController = controller;
  const resources: unknown = {
    namespace: f.namespace,
    agent: f.agent,
    source: f.source,
    secret: f.secret,
    legacySource: f.legacySource,
  };
  assert.ok(Check(staticEgressResources, resources), "expected seeded static egress resources");
  const { namespace, agent } = resources;
  // These captures contain supplier wire data, not validated OCC API resources.
  const providers: Map<string, unknown> = f.providers;
  const providerRequests: {
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    body: unknown;
    headers: IncomingHttpHeaders;
  }[] = f.providerRequests;
  const gatewayEffects: string[] = f.gatewayEffects;
  const administrator = app.policy.identities[0];
  assert.ok(administrator);
  const administratorId = administrator.id;
  const namespaceId = namespace.id;
  const path = `/namespaces/${namespaceId}/credential-sources`;

  /**
   * A controller for the same state whose Installation selects the Drivers in `keep` (Compute,
   * Configuration, IAM and Secret always), registered as the running API registered them.
   */
  function restart(keep: readonly DriverCapability[]) {
    const sandbox = runningController.selectedDriver("sandbox");
    const controller = new OpenClawController(runningController.installation, {
      state,
      namespaceLifecycleBindings: [
        sandboxNamespaceLifecycleBinding(runningController.selectedDriver("compute"), sandbox),
      ],
      backends: backendFixtures,
      defaultPresets: [],
      bundledPresetVersions: [],
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandbox.id,
          implementation: sandbox.implementation,
          definition: OpenShellSandboxDriver,
        },
      ],
    });
    for (const capability of ["iam", "configuration", "compute", "secret", ...keep] as const) {
      const driver = runningController.selectedDriver(capability);
      controller.registerDriver(driver);
      controller.selectDriver(capability, driver.id);
    }
    return controller;
  }

  /** A dedicated Agent whose deletion has started: the worker never runs here, so it stays. */
  async function deletingAgent(name: string) {
    const created = await request("POST", `/namespaces/${namespaceId}/agents`, {
      body: {
        name,
        configurationId: agent.configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "runtime" },
      },
    });
    const { data } = fixtureResponse(created, 201, AgentResponse, "create Agent for deletion");
    const deleted = await request("DELETE", `/namespaces/${namespaceId}/agents/${data.id}`);
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    return data;
  }

  /**
   * An embedded Agent saved before this Installation selected the OpenShell Sandbox, Gateway and
   * Proxy; save refuses an embedded Agent once a Sandbox is selected.
   */
  async function embeddedAgent(name: string) {
    const values = asRecord(createHarnessConfiguration("openclaw", "gpt-4.1"));
    assert.ok(values, "the embedded Agent fixture needs a Configuration object");
    const configuration = await createConfiguration(namespaceId, values);
    const secret = await request("POST", `/namespaces/${namespaceId}/secrets`, {
      body: { name: `${name} key`, value: "synthetic-embedded-key" },
    });
    const { data } = fixtureResponse(secret, 201, SecretResponse, "create embedded Agent Secret");
    return restart([]).createAgent(
      administratorId,
      {
        namespaceId,
        name,
        configurationId: configuration.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: data.ref },
      },
      resolveApprovedHarness,
    );
  }

  const common = {
    ...app,
    ...resources,
    providers,
    providerRequests,
    gatewayEffects,
    controller: runningController,
    state,
    administratorId,
    path,
    restart,
    deletingAgent,
    embeddedAgent,
    deploy: (controller: OpenClawController, agentId: string) =>
      controller.deployAgent(administratorId, { namespaceId, agentId }, resolveApprovedHarness),
  };
  if (f.fixtureKind === "undeployed") {
    const grant: unknown = f.grant;
    assert.ok(
      Check(IAMAccessBindingSchema, grant) && "resourceId" in grant,
      "the fixture grants use of the exact protected source",
    );
    const profiles: Map<string, unknown> = f.profiles;
    const gatewayRequests: { method: string; request: unknown; found?: boolean }[] =
      f.gatewayRequests;
    return { ...f, ...common, grant, profiles, gatewayRequests };
  }
  return { ...f, ...common };
}
