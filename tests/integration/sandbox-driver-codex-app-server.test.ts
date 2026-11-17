import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  AgentRevision,
  OpenClawConfigurationValue,
} from "../../packages/contracts/src/index.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";

const harness: AgentRevision["harness"] = {
  id: "codex",
  version: "1.0.0",
  mode: "dedicated",
  overrides: {},
  configuration: {},
};

function openShellDriver() {
  const installation = buildSandboxInstallation();
  const [backend] = installation.backend;
  assert.ok(backend);
  return new OpenShellSandboxDriver(installation.drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: {
      id: backend.id,
      drivers: backend.drivers,
      client: new OpenShellGateway(backend.configuration),
    },
  });
}

function codexPlugin(appServer: Readonly<Record<string, OpenClawConfigurationValue>>) {
  return {
    plugins: { allow: ["codex"], entries: { codex: { enabled: true, config: { appServer } } } },
  };
}

test("OpenShell pins the Codex sandbox and approval reviewer while preserving other app-server settings", () => {
  const driver = openShellDriver();
  for (const approvalsReviewer of [undefined, "auto_review", "guardian_subagent", "user"]) {
    const appServer = {
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      transport: "websocket",
      url: "${APP_SERVER_URL}",
      authToken: "${APP_SERVER_TOKEN}",
      ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    };
    const configuration = codexPlugin(appServer);
    const configured = driver.configureAgent(configuration, harness);
    const expectedAppServer = {
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      transport: "websocket",
      url: "${APP_SERVER_URL}",
      authToken: "${APP_SERVER_TOKEN}",
      approvalsReviewer: "user",
    };
    const expectedPlugins = {
      allow: ["codex"],
      entries: { codex: { enabled: true, config: { appServer: expectedAppServer } } },
    };
    assert.deepEqual(configured.plugins, expectedPlugins);
    assert.equal(configuration.plugins.entries.codex.config.appServer, appServer);
    assert.equal(appServer.sandbox, "read-only");
    // A disabled Codex plugin entry is enabled: the dedicated Codex Harness runs through it.
    configuration.plugins.entries.codex.enabled = false;
    assert.deepEqual(driver.configureAgent(configuration, harness).plugins, expectedPlugins);
    // Reapplying the configuration hook must preserve the pinned settings.
    assert.deepEqual(driver.configureAgent(configured, harness), configured);
  }
});

test("OpenShell drops the Codex network proxy so it cannot replace full access", () => {
  const driver = openShellDriver();
  // The Standard Codex Preset's shape: an enabled proxy in the bridge wins over the
  // full-access profile and selects a restricted profile OpenShell cannot run.
  const networkProxy = {
    enabled: true,
    mode: "limited",
    allowLocalBinding: false,
    domains: { "registry.npmjs.org": "allow" },
  };
  for (const proxy of [networkProxy, { enabled: false }, { readOnlyPaths: ["/app"] }]) {
    const appServer = Object.freeze({
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
      networkProxy: proxy,
    });
    const configured = driver.configureAgent(codexPlugin(appServer), harness);
    const expectedAppServer = {
      mode: "guardian",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    };
    const expectedPlugins = {
      allow: ["codex"],
      entries: { codex: { enabled: true, config: { appServer: expectedAppServer } } },
    };
    assert.deepEqual(configured.plugins, expectedPlugins);
    // Reapplying the configuration hook must keep the proxy absent.
    assert.deepEqual(driver.configureAgent(configured, harness), configured);
  }
});
