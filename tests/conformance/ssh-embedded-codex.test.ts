import assert from "node:assert/strict";
import test from "node:test";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { deploymentSelection } from "../../packages/occ/src/configured-harness.ts";
import { options, tenant } from "./ssh-compute-fixture.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

test("SSH separates the selected OpenAI turn runtime from embedded deployment only for a pinned local app-server", () => {
  const host = options();
  const path = "/opt/oce/bin/codex";
  host.hosts.stable.codexBinary = { path, sha256: "a".repeat(64) };
  const driver = new SshComputeDriver(host);
  const base = createHarnessConfiguration("openclaw", "gpt-test");
  const values = {
    ...base,
    agents: {
      defaults: {
        model: "openai/gpt-test",
        models: { "openai/gpt-test": { agentRuntime: { id: "codex" } } },
      },
    },
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              transport: "stdio",
              command: path,
              sandbox: "read-only",
              approvalPolicy: "on-request",
            },
          },
        },
      },
    },
  };
  const eligible = driver.supportsEmbeddedCodex(tenant, values);
  assert.equal(eligible, true);
  assert.deepEqual(deploymentSelection(values, eligible), {
    turnRuntime: "codex",
    harness: "openclaw",
  });
  const notQualified = new SshComputeDriver(options()).supportsEmbeddedCodex(tenant, values);
  assert.equal(notQualified, false);
  assert.throws(() => deploymentSelection(values, notQualified));
  assert.equal(driver.supportsEmbeddedCodex({ ...tenant, name: "other" }, values), false);
  for (const override of [
    { transport: "websocket" },
    { command: "/bin/sh" },
    { args: ["--version"] },
    { sandbox: "danger-full-access" },
  ]) {
    const codex = values.plugins.entries.codex;
    const changed = {
      ...values,
      plugins: {
        entries: {
          codex: { ...codex, config: { appServer: { ...codex.config.appServer, ...override } } },
        },
      },
    };
    assert.equal(driver.supportsEmbeddedCodex(tenant, changed), false);
  }
});

test("OCC saves and deploys an embedded revision without rewriting its turn engine", async () => {
  const { administrator, fixture } = await import("./configuration-occ-fixture.ts");
  const { resolveApprovedProductionHarness } =
    await import("../../apps/controller/src/composition/production-harness.ts");
  const { namespace, controller, agent, compute, saveConfiguration } = await fixture();
  const model = "openai/gpt-test";
  const pin = { path: "/opt/oce/bin/codex", sha256: "b".repeat(64) };
  const configured = options();
  configured.hosts.stable.codexBinary = pin;
  const driver = new SshComputeDriver({
    ...configured,
    hosts: { [namespace.name]: configured.hosts.stable },
  });
  compute.supportsEmbeddedCodex = driver.supportsEmbeddedCodex.bind(driver);
  const values = {
    agents: { defaults: { model, models: { [model]: { agentRuntime: { id: "codex" } } } } },
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              command: pin.path,
              transport: "stdio",
              sandbox: "read-only",
              approvalPolicy: "on-request",
            },
          },
        },
      },
    },
  };
  const configuration = await saveConfiguration(values);
  const target = { namespaceId: namespace.id, agentId: agent.id };
  await controller.updateAgent(
    administrator,
    { ...target, configurationId: configuration.id },
    resolveApprovedProductionHarness,
  );
  const revision = await controller.deployAgent(
    administrator,
    target,
    resolveApprovedProductionHarness,
  );
  assert.equal(revision.harness.id, "openclaw");
  assert.equal(revision.harness.mode, "embedded");
  assert.deepEqual(deploymentSelection(revision.configuration, true), {
    turnRuntime: "codex",
    harness: "openclaw",
  });
  assert.deepEqual(revision.configuration.plugins, values.plugins);
});
