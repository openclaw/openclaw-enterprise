import assert from "node:assert/strict";

import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

export function verifyMainWorkspaceMount({
  driver,
  readGatewayWorkspace,
}: {
  driver: OpenShellSandboxDriver;
  readGatewayWorkspace: (
    configured: ReturnType<OpenShellSandboxDriver["configureAgent"]>,
    harness: Parameters<OpenShellSandboxDriver["configureAgent"]>[1],
  ) => unknown;
}): void {
  const harness: Parameters<OpenShellSandboxDriver["configureAgent"]>[1] = {
    id: "openclaw",
    version: "1.0.0",
    mode: "dedicated",
    overrides: {},
    configuration: {},
  };
  const configuration = {
    agents: {
      defaults: { model: "openai/gpt-5", workspace: "/home/node/.openclaw/workspace" },
      entries: {
        main: { model: "openai/gpt-5", workspace: "/home/node/elsewhere" },
        helper: { workspace: "/sandbox/enterprise/helper" },
      },
    },
  };
  const configured = driver.configureAgent(configuration, harness);
  assert.deepEqual(configured.agents, {
    defaults: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" },
    entries: {
      main: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" },
      helper: { workspace: "/sandbox/enterprise/helper" },
    },
  });
  assert.equal(configuration.agents.entries.main.workspace, "/home/node/elsewhere");
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

  // The setup snapshot retains the admitted Harness mount. Compute separately
  // projects a local logical workspace into a dedicated Codex Gateway's ConfigMap.
  assert.equal(readGatewayWorkspace(configured, harness), "/sandbox/enterprise");
}

export function verifyInitialWorkspaceAdmission(driver: OpenShellSandboxDriver): void {
  for (const id of ["codex", "openclaw"]) {
    const harness: Parameters<OpenShellSandboxDriver["configureAgent"]>[1] = {
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
}
