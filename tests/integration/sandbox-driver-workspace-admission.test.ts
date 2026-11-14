import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  OpenShellGateway,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import type {
  KubernetesComputeDriver,
  KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { OpenShellSandboxCreateRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  CredentialGatewayDriver,
  CredentialSource,
  CredentialSourceLoginMode,
} from "../../packages/contracts/src/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { inspectOpenShellCodexCommand } from "../fixtures/openshell-codex-command.ts";
import {
  captureOpenShellHarness,
  providerEndpointFixture,
  tlsPinnedWorkspaceSetupCode,
} from "../fixtures/kubernetes-provider-endpoint.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { admitRevisionHarness as admitRevisionHarnessFixture } from "../helpers/kubernetes-routed-scenarios.mjs";
import { openShellSandbox } from "../helpers/openshell-sandbox.mjs";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";

const admitRevisionHarness: (driver: KubernetesComputeDriver, revision: AgentRevision) => void =
  admitRevisionHarnessFixture;

type HarnessCapture = Omit<ReturnType<typeof captureOpenShellHarness>, "request"> & {
  readonly request: unknown;
};

type ProviderEndpointOptions<Fields extends keyof AgentRevision> = NonNullable<
  Parameters<typeof providerEndpointFixture>[0]
> & {
  servicePrincipalCredentials: KubernetesComputeDriverOptions["servicePrincipalCredentials"];
  revisionOverrides: Pick<AgentRevision, "id" | "agentId" | "servicePrincipalId" | Fields>;
};

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type ComputeFixtureRevision = Mutable<Omit<AgentRevision, "compute">> & {
  compute: Mutable<AgentRevision["compute"]>;
};

function capturedRequest(value: unknown): Pick<OpenShellSandboxCreateRequest, "name" | "spec"> {
  const request = asRecord(value);
  assert.ok(request);
  assert.ok(typeof request.name === "string");
  const spec = asRecord(request.spec);
  assert.ok(spec);
  return { name: request.name, spec };
}

function commandArguments(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  const args: unknown[] = value;
  assert.ok(args.every((arg): arg is string => typeof arg === "string"));
  return args;
}

function requestWorkspaceMounts(spec: OpenShellSandboxCreateRequest["spec"]): readonly unknown[] {
  const template = asRecord(spec.template);
  const config = asRecord(asRecord(template?.driver_config)?.fields);
  const fields = (value: unknown) => asRecord(asRecord(asRecord(value)?.structValue)?.fields);
  const kubernetes = fields(config?.kubernetes);
  const container = fields(fields(kubernetes?.containers)?.agent);
  const mounts = asRecord(asRecord(container?.volume_mounts)?.listValue)?.values;
  assert.ok(
    Array.isArray(mounts),
    "the CreateSandbox request must include Kubernetes volume mounts",
  );
  return mounts;
}

function pinEnrollmentFixture(compute: KubernetesComputeDriver): void {
  const enrollment = compute["nodeEnrollment"];
  assert.ok(enrollment);
  const createSetup = enrollment.createSetup;
  enrollment.createSetup = async (url: string, nodeUrl: string, signal: AbortSignal) => {
    const setup = await createSetup(url, nodeUrl, signal);
    return { ...setup, setupCode: tlsPinnedWorkspaceSetupCode(nodeUrl, setup.expiresAtMs) };
  };
}

function createCatalogDriver() {
  const installation = buildSandboxInstallation();
  const [backend] = installation.backend;
  assert.ok(backend);
  const gateway = installation.drivers.credential_gateway;
  return new OpenShellCredentialGatewayDriver(gateway.configuration, {
    id: gateway.id,
    backend: {
      id: backend.id,
      // OpenShell advertises Codex OAuth only when its Backend provides credential refresh.
      drivers: { ...backend.drivers, credential_refresh: "openshell-refresh" },
      client: new OpenShellGateway(backend.configuration),
    },
  });
}

test("OpenShell pins an explicit main Agent workspace to the Sandbox data mount", async (t) => {
  const options: ProviderEndpointOptions<"harness" | "configuration"> = {
    servicePrincipalCredentials: { mode: "disabled" },
    revisionOverrides: {
      id: "rev_00000000-0000-4000-8000-000000000001",
      agentId: "agt_00000000-0000-4000-8000-000000000001",
      servicePrincipalId: "spn_00000000-0000-4000-8000-000000000001",
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
      configuration: {
        ...createHarnessConfiguration("openclaw", "gpt-5"),
        logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
        diagnostics: { otel: { logs: false } },
      },
    },
  };
  const fixture = providerEndpointFixture(options);
  const revision: ComputeFixtureRevision = fixture.revision;
  const capture: HarnessCapture = captureOpenShellHarness(fixture, fixture.sandbox);
  const driver = capture.openshell;
  Object.assign(fixture.sandbox, {
    facets: driver.facets,
    supportsHarnessExecutionMode: driver.supportsHarnessExecutionMode,
  });
  // The API observes completion and removal of the short-lived native workspace
  // preparer. Compute and Sandbox still build and admit all workload requests.
  type ObjectApi = {
    create(resource: {
      kind: string;
      metadata: { name: string; namespace: string; labels?: Record<string, string> };
    }): Promise<unknown>;
    delete(resource: {
      kind: string;
      metadata: { name: string; namespace: string };
    }): Promise<void>;
    list(): Promise<{ items: readonly unknown[] }>;
  };
  const preparationApi: ObjectApi = {
    async create(resource) {
      assert.equal(
        resource.metadata.labels?.["openclaw.dev/workload-role"],
        "workspace-preparation",
      );
      const ready = {
        ...resource,
        metadata: { ...resource.metadata, uid: "preparation-uid", generation: 1 },
        status: { availableReplicas: 1, observedGeneration: 1 },
      };
      fixture.save(ready);
      return ready;
    },
    async delete(resource) {
      assert.equal(
        fixture.objects.delete(
          fixture.key(resource.kind, resource.metadata.name, resource.metadata.namespace),
        ),
        true,
      );
    },
    async list() {
      return { items: [] };
    },
  };
  Object.assign(fixture.clients.objects, preparationApi);
  const harness = revision.harness;
  const configuration = {
    agents: {
      defaults: { model: "openai/gpt-5", workspace: "/home/node/.openclaw/workspace" },
      entries: {
        main: { model: "openai/gpt-5", workspace: "/home/node/elsewhere" },
        helper: { workspace: "/sandbox/enterprise/helper" },
      },
    },
  };
  const original = structuredClone(configuration);
  const configured = driver.configureAgent(configuration, harness);
  assert.deepEqual(configured.agents, {
    defaults: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" },
    entries: {
      main: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" },
      helper: { workspace: "/sandbox/enterprise/helper" },
    },
  });
  assert.deepEqual(configuration, original);
  // Status reads rerun the hook on stored work, so pinning must be idempotent.
  assert.deepEqual(driver.configureAgent(configured, harness), configured);
  // OpenClaw resolves entry keys case-insensitively, and an entry without a path is pinned too.
  assert.deepEqual(
    asRecord(driver.configureAgent({ agents: { entries: { Main: {} } } }, harness).agents)?.entries,
    { Main: { workspace: "/sandbox/enterprise" } },
  );
  assert.throws(
    () => driver.configureAgent({ agents: { entries: { main: "/home/node/elsewhere" } } }, harness),
    /OpenShell main Agent entry/,
  );

  // A private initializer admits only a main roster. Pass that admitted
  // Configuration through Compute and inspect the request sent to OpenShell.
  const mainOnly = driver.configureAgent(
    {
      ...revision.configuration,
      agents: { ...configuration.agents, entries: { main: configuration.agents.entries.main } },
    },
    harness,
  );
  driver.validateWorkspaceSetup(harness, mainOnly);
  const catalogDriver = createCatalogDriver();
  const catalog = await catalogDriver.listSourceTypes({ signal: t.signal });
  const sourceType = catalog.find((entry) => entry.type === "openai");
  assert.ok(sourceType);
  const source: CredentialSource = {
    id: "cs_00000000-0000-4000-8000-000000000001",
    namespaceId: revision.namespaceId,
    type: sourceType.type,
    name: "fixture model source",
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId: catalogDriver.id,
    state: "ready",
    createdAt: revision.createdAt,
  };
  const credentialGateway: Pick<
    CredentialGatewayDriver,
    "id" | "capability" | "implementation" | "listSourceTypes" | "attachForRevision"
  > = {
    id: catalogDriver.id,
    capability: "credential_gateway",
    implementation: "openshell",
    listSourceTypes: async () => [sourceType],
    attachForRevision: async () => [{ sourceId: source.id, ref: openShellProviderName(source.id) }],
  };
  assert.ok(Object.hasOwn(fixture.driver, "credentialGatewayDriver"));
  Object.assign(fixture.driver, { credentialGatewayDriver: credentialGateway });
  revision.harnessAuth = {
    method: "credential_source",
    sourceId: source.id,
    sourceType: source.type,
    credentialGatewayId: source.driverId,
    loginMode: "api_key",
  };
  revision.configuration = mainOnly;
  admitRevisionHarness(fixture.driver, revision);
  pinEnrollmentFixture(fixture.driver);
  const context: Pick<ComputeRevisionContext, "harnessAuth"> = {
    harnessAuth: { ...revision.harnessAuth, source },
  };
  await fixture.prepare(undefined, context);
  fixture.setGatewayServing();
  await assert.rejects(
    fixture.prepare(undefined, context),
    (error) => error === capture.provisioned,
  );
  const { spec } = capturedRequest(capture.request);
  assert.equal(asRecord(spec.environment)?.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  const mounts = requestWorkspaceMounts(spec);
  assert.ok(
    mounts.some((mount) => {
      const fields = asRecord(asRecord(asRecord(mount)?.structValue)?.fields);
      return (
        asRecord(fields?.mount_path)?.stringValue === "/sandbox/enterprise" &&
        asRecord(fields?.sub_path)?.stringValue === "workspace" &&
        asRecord(fields?.read_only)?.boolValue === false
      );
    }),
    "the initialized workspace must be backed by the writable data mount",
  );
});

test("OpenShell admits initial files only for its projected main workspace", (t) => {
  const { sandboxDriver: driver } = openShellSandbox(t, {
    sandboxDataMount: {
      subPath: "workspace",
      mountPath: "/sandbox/custom-workspace",
      readOnly: false,
    },
  });
  for (const id of ["codex", "openclaw"]) {
    const harness: AgentRevision["harness"] = {
      id,
      version: "1.0.0",
      mode: "dedicated",
      overrides: {},
      configuration: {},
    };
    // OCC projects configuration before admission; both Harnesses must use the same
    // operator-selected mount as the private initializer, even with omitted settings.
    const configured = driver.configureAgent({}, harness);
    assert.equal(
      asRecord(asRecord(configured.agents)?.defaults)?.workspace,
      "/sandbox/custom-workspace",
    );
    assert.doesNotThrow(() => driver.validateWorkspaceSetup(harness, configured));
    const explicit = driver.configureAgent(
      { agents: { entries: { Main: { workspace: "/home/node/elsewhere" } } } },
      harness,
    );
    assert.equal(
      asRecord(asRecord(asRecord(explicit.agents)?.entries)?.Main)?.workspace,
      "/sandbox/custom-workspace",
    );
    assert.doesNotThrow(() => driver.validateWorkspaceSetup(harness, explicit));
    // Admission must still refuse a snapshot that does not use the initialized mount,
    // or a roster whose other Agent cannot consume the four main-Agent setup files.
    assert.throws(
      () =>
        driver.validateWorkspaceSetup(harness, {
          agents: { defaults: { workspace: "/sandbox/other" } },
        }),
      /agents.defaults.workspace.*must be \/sandbox\/custom-workspace/,
    );
    assert.throws(
      () =>
        driver.validateWorkspaceSetup(
          harness,
          driver.configureAgent(
            {
              agents: { entries: { main: {}, helper: {} } },
            },
            harness,
          ),
        ),
      /agents.entries.*must hold only main/,
    );
    // A snapshot the hook never projected names the managed workspace, which is not the mount.
    assert.throws(
      () => driver.validateWorkspaceSetup(harness, {}),
      /agents.defaults.workspace.*must be \/sandbox\/custom-workspace/,
    );
    assert.throws(
      () => driver.validateWorkspaceSetup({ ...harness, mode: "embedded" }, configured),
      /require a dedicated/,
    );
    assert.throws(
      () => driver.validateWorkspaceSetup({ ...harness, id: "other" }, configured),
      /require a dedicated Codex or OpenClaw Harness/,
    );
  }
});

// The command budget applies after Compute adds the workspace verifier and
// OpenShell adds links, setup wait and any account bootstrap to CreateSandbox.
test("OpenShell composes immutable commands from admitted Compute revisions", async (t) => {
  const catalogDriver = createCatalogDriver();
  const catalog = await catalogDriver.listSourceTypes({ signal: t.signal });
  const cases: ReadonlyArray<{
    loginMode: Extract<CredentialSourceLoginMode, "codex_pat" | "chatgptAuthTokens">;
    hasSetup: boolean;
    admitted: boolean;
  }> = [
    { loginMode: "codex_pat", hasSetup: true, admitted: true },
    { loginMode: "codex_pat", hasSetup: false, admitted: true },
    { loginMode: "codex_pat", hasSetup: true, admitted: false },
    { loginMode: "codex_pat", hasSetup: false, admitted: false },
    { loginMode: "chatgptAuthTokens", hasSetup: true, admitted: true },
  ];
  for (const { loginMode, hasSetup, admitted } of cases) {
    await t.test(`${loginMode}, setup ${hasSetup}, new admission ${admitted}`, async (t) => {
      const options: ProviderEndpointOptions<never> = {
        servicePrincipalCredentials: { mode: "disabled" },
        revisionOverrides: {
          id: "rev_2c9250cd-6aa2-4493-a73e-2422ec6c1537",
          agentId: "agt_9bee809d-62ec-4d41-b68d-25ead74b3a4d",
          servicePrincipalId: "spn_02aa5adc-0b5c-417d-b8d4-1a1de5157809",
        },
      };
      const fixture = providerEndpointFixture(options);
      const { driver: compute, sandbox } = fixture;
      const revision: ComputeFixtureRevision = fixture.revision;
      const capture: HarnessCapture = captureOpenShellHarness(fixture, sandbox);
      const source: CredentialSource = {
        id: "cs_324fc26c-59b3-43e0-b057-53fce26a2f19",
        namespaceId: revision.namespaceId,
        type: loginMode === "codex_pat" ? "codex-pat" : "codex-oauth",
        name: "fixture source",
        config: {},
        secrets: {},
        ownerCapability: "credential_gateway",
        driverId: catalogDriver.id,
        state: "ready",
        createdAt: revision.createdAt,
      };
      const sourceType = catalog.find((entry) => entry.type === source.type);
      assert.ok(sourceType);
      const ref = openShellProviderName(source.id);
      revision.harnessAuth = {
        method: "credential_source",
        sourceId: source.id,
        sourceType: source.type,
        credentialGatewayId: source.driverId,
        loginMode,
      };
      const credentialGateway: Pick<
        CredentialGatewayDriver,
        "id" | "capability" | "implementation" | "listSourceTypes" | "attachForRevision"
      > = {
        id: source.driverId,
        capability: "credential_gateway",
        implementation: "openshell",
        listSourceTypes: async () => [sourceType],
        attachForRevision: async () => [
          {
            sourceId: source.id,
            ref,
            ...(loginMode === "chatgptAuthTokens" && {
              externalChatgptAuth: {
                accessTokenPlaceholder: `openshell:resolve:env:s${"1".repeat(64)}_CODEX_ACCESS_TOKEN`,
                accountId: "fixture-account",
                planType: "business",
              },
            }),
          },
        ],
      };
      assert.ok(Object.hasOwn(compute, "credentialGatewayDriver"));
      Object.assign(compute, { credentialGatewayDriver: credentialGateway });
      revision.configuration = capture.openshell.configureAgent(
        revision.configuration,
        revision.harness,
      );
      admitRevisionHarness(compute, revision);
      if (!admitted) {
        // Pre-upgrade PAT revisions did not save a Compute admission.
        delete revision.compute.admission;
      }
      const workspaceSetup = {
        id: "workspace-setup-1f8d6823-aa87-4cba-ae3e-62352e892d12",
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        defaultsId: WORKSPACE_DEFAULTS_ID,
        completed: false,
        files: { ...WORKSPACE_DEFAULTS, "AGENTS.md": "Private initial Agent instructions\n" },
      };
      const context: Pick<ComputeRevisionContext, "harnessAuth" | "workspaceSetup"> = {
        harnessAuth: { ...revision.harnessAuth, source },
        ...(hasSetup && { workspaceSetup }),
      };
      pinEnrollmentFixture(compute);

      await fixture.prepare(undefined, context);
      fixture.setGatewayServing();
      // Let the real Compute enrollment write the Agent-owned Secret.
      const provision = (input = context) =>
        assert.rejects(fixture.prepare(undefined, input), (error) => error === capture.provisioned);
      await provision();
      const { name, spec } = capturedRequest(capture.request);
      const command = commandArguments(spec.command);
      const { loader, supervisor, codex } = inspectOpenShellCodexCommand(t, command, {
        compact: admitted && (hasSetup || loginMode === "codex_pat"),
        current: admitted,
      });
      if (!admitted) {
        // Stock 0.1.6 Compute and OpenShell at 4d68b3b7 render these exact commands.
        // Revisions with initial setup embed that release's workspace verifier.
        assert.equal(
          createHash("sha256").update(JSON.stringify(command)).digest("hex"),
          hasSetup
            ? "b491545115bb907a872b0fe34b56cfc850dd684cd495ec280bb86e4a3f1cf3bc"
            : "a0d8025d10aeb7dbf26ca8271ad2cecb0eacb3ef1cd0bfafbf22ce251d9bd1fa",
        );
      }
      const startup = loader + supervisor;
      assert.equal(startup.includes(".oce-workspace-setup.json"), hasSetup);
      if (hasSetup) {
        assert.match(supervisor, new RegExp(workspaceSetup.id));
        assert.doesNotMatch(supervisor, /Private initial Agent instructions/);
      }
      assert.equal(
        codex.includes("unsupported_l7_protocol"),
        admitted && loginMode === "codex_pat",
      );
      const environment = asRecord(spec.environment);
      assert.ok(environment);
      assert.equal(environment.CODEX_LOGIN_MODE, loginMode);
      assert.equal(
        environment.OCE_CODEX_CREDENTIAL_SOURCE,
        loginMode === "codex_pat" ? "1" : undefined,
      );
      assert.equal(
        startup.includes("OCE_CODEX_CHATGPT_ACCOUNT"),
        loginMode === "chatgptAuthTokens",
      );

      if (!admitted && hasSetup) {
        // Completing setup keeps the legacy Sandbox adoptable, while even one
        // byte of command drift in its stored spec must be refused.
        await provision({
          ...context,
          workspaceSetup: { ...workspaceSetup, files: {}, completed: true },
        });
        const stored = capture.gateway.sandboxes.get(name);
        assert.ok(stored?.spec);
        const storedCommand = commandArguments(stored.spec.command);
        const loaderArgument = storedCommand[7];
        assert.equal(typeof loaderArgument, "string");
        storedCommand[7] = loaderArgument + " ";
        await assert.rejects(
          fixture.prepare(undefined, context),
          /without exact AgentRevision ownership and content/,
        );
      }
    });
  }
});
