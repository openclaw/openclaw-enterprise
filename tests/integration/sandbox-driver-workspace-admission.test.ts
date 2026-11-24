import assert from "node:assert/strict";
import test from "node:test";

import type { KubernetesComputeDriverOptions } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { type AgentRevision } from "../../packages/contracts/src/index.ts";
import {
  captureOpenShellHarness,
  providerEndpointFixture,
} from "../fixtures/kubernetes-provider-endpoint.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { openShellSandbox } from "../helpers/openshell-sandbox.mjs";

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

test("OpenShell pins an explicit main Agent workspace to the Sandbox data mount", () => {
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
