import assert from "node:assert/strict";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { backendFixtures, createConsoleAppFixture } from "./console-app.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { staticEgressFixture } from "./static-egress.mjs";

function unexpectedIssuerWork() {
  assert.fail("a refused protected source create must not reach the prepared issuer");
}

/**
 * The create body of each protected source type that names its Agent in `config.agent_id`: the
 * Proxy's credential-free metadata and, with `githubMetadata`, the prepared GitHub metadata.
 */
export const protectedSourceInputs = {
  "credential-free-repository-metadata": (agentId) => ({
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
  "github-app-metadata": (agentId, issuer) => ({
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
 * Drivers; supplier wires are fixtures) with one Agent bound to a live-adopted protected source,
 * not yet deployed. `restart` opens the same platform state with a controller for the same
 * Installation after a change of its Driver selection, as a new API process would.
 */
export async function protectedSourceFixture(t, { githubMetadata = false, ...options } = {}) {
  let state;
  const f = await staticEgressFixture(t, {
    admitRevision: false,
    // `githubMetadata` enables the prepared github-app-metadata type. These refusals come before
    // any issuer work, so its lifecycle must never run.
    ...(githubMetadata && {
      preparedGitHub: {
        apiOrigin: "https://api.github.com",
        configure: unexpectedIssuerWork,
        readWarm: unexpectedIssuerWork,
        ready: unexpectedIssuerWork,
        withdraw: unexpectedIssuerWork,
        current: unexpectedIssuerWork,
      },
    }),
    ...options,
    appFactory: (context, appOptions) =>
      createConsoleAppFixture(context, { ...appOptions, wrapState: (base) => (state = base) }),
  });
  assert.ok(state);
  const administratorId = f.policy.identities[0].id;
  const namespaceId = f.namespace.id;
  const path = `/namespaces/${namespaceId}/credential-sources`;

  /**
   * A controller for the same state whose Installation selects the Drivers in `keep` (Compute,
   * Configuration, IAM and Secret always), registered as the running API registered them.
   */
  function restart(keep) {
    const sandbox = f.controller.selectedDriver("sandbox");
    const controller = new OpenClawController(f.controller.installation, {
      state,
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
    for (const capability of ["iam", "configuration", "compute", "secret", ...keep]) {
      const driver = f.controller.selectedDriver(capability);
      controller.registerDriver(driver);
      controller.selectDriver(capability, driver.id);
    }
    return controller;
  }

  /** The HTTP answer the API gives for what `work` throws. */
  async function answer(work) {
    try {
      await work();
    } catch (error) {
      const { status, code, message } = requestFailure(error);
      return { status, code, message };
    }
    assert.fail("the request must be refused");
  }

  /** A dedicated Agent whose deletion has started: the worker never runs here, so it stays. */
  async function deletingAgent(name) {
    const created = await f.request("POST", `/namespaces/${namespaceId}/agents`, {
      body: {
        name,
        configurationId: f.agent.configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "runtime" },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const deleted = await f.request(
      "DELETE",
      `/namespaces/${namespaceId}/agents/${created.data.id}`,
    );
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    return created.data;
  }

  /**
   * An embedded Agent saved before this Installation selected the OpenShell Sandbox, Gateway and
   * Proxy; save refuses an embedded Agent once a Sandbox is selected.
   */
  async function embeddedAgent(name) {
    const configuration = await f.createConfiguration(
      namespaceId,
      createHarnessConfiguration("openclaw", "gpt-4.1"),
    );
    const secret = await f.request("POST", `/namespaces/${namespaceId}/secrets`, {
      body: { name: `${name} key`, value: "synthetic-embedded-key" },
    });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));
    return restart([]).createAgent(
      administratorId,
      {
        namespaceId,
        name,
        configurationId: configuration.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: secret.data.ref },
      },
      resolveApprovedHarness,
    );
  }

  return {
    ...f,
    state,
    administratorId,
    path,
    restart,
    answer,
    deletingAgent,
    embeddedAgent,
    deploy: (controller, agentId) =>
      controller.deployAgent(administratorId, { namespaceId, agentId }, resolveApprovedHarness),
  };
}
