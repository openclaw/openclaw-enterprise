import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { NotImplementedError } from "../../packages/occ/src/index.ts";
import { context } from "./plugin-driver-fixtures.ts";

import "./plugin-driver-openclaw-policy-cases.ts";
import "./plugin-driver-openclaw-tool-denial-cases.ts";
import "./plugin-driver-codex-catalog-cases.ts";
import "./plugin-driver-codex-catalog-reader-cases.ts";
import "./plugin-driver-codex-configuration-cases.ts";

test("bundled Plugin Drivers enforce Harness identity", async () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();

  await assert.rejects(occ.listCatalog(context("dedicated")), NotImplementedError);
  await assert.rejects(codex.listCatalog(context("embedded")), NotImplementedError);
  await assert.rejects(
    occ.describeDeployment({
      plugin: {
        catalog: "codex-hosted",
        pluginId: "occ-plugin:diffs",
        remotePluginId: "hosted-diffs",
        appIds: ["diffs-app"],
        requiresSkillBundle: false,
      },
      selection: { enabled: true },
      connections: {},
    }),
    /OpenClaw deployment requires a Driver catalog selection/,
  );
});

test("credentialless Diffs keeps its pinned Gateway installation when its tool is disabled", async () => {
  const description = await new OCCPluginDriver().describeDeployment({
    plugin: { catalog: "driver", pluginId: "occ-plugin:diffs" },
    selection: { enabled: true, tools: { diffs: { enabled: false } } },
    connections: {},
  });
  assert.deepEqual(description.credentials, {});
  const [tool] = description.tools;
  assert.ok(tool);
  assert.equal(tool.kind, "installation");
  assert.equal(tool.role, "gateway");
  assert.deepEqual(tool.selectedTools, []);
  assert.ok(tool.installation.kind === "openclaw-package");
  assert.equal(tool.installation.package, "@openclaw/diffs@2026.8.2");
  assert.match(tool.installation.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.deepEqual(
    description.networkRequirements.map(({ toolId, purpose, match }) => [
      toolId,
      purpose,
      match.host,
    ]),
    [[tool.id, "installation", "registry.npmjs.org"]],
  );
});

test("OpenClaw reports selected credential Sources without validating the release", () => {
  const driver = new OCCPluginDriver();
  const pluginId = "occ-plugin:slack@1.0.0";
  const selection = {
    enabled: true,
    driverPolicy: { releaseSha256: "0".repeat(64), credentials: { account: "cs_selected" } },
  };
  const binding = { account: { default: "cs_selected" } };

  // An old selection must remain readable so an authorized edit can clear it.
  assert.deepEqual(driver.credentials.selectedBindings({ pluginId, selection }), binding);
  assert.throws(() => driver.validatePolicies({ [pluginId]: selection }), /release has changed/);
  assert.deepEqual(
    driver.credentials.selectedBindings({ pluginId: "occ-plugin:slack@0.9.0", selection }),
    binding,
  );
  assert.deepEqual(
    driver.credentials.selectedBindings({ pluginId, selection: { enabled: true } }),
    {},
  );
});

test("OpenClaw refuses malformed or disabled credential selections", () => {
  const driver = new OCCPluginDriver();
  const pluginId = "occ-plugin:slack@1.0.0";

  for (const selection of [
    { enabled: true, driverPolicy: { credentials: "cs_selected" } },
    { enabled: false, driverPolicy: { credentials: { account: "cs_selected" } } },
    { enabled: true, driverPolicy: { credentials: { account: "not-a-source" } } },
    { enabled: true, driverPolicy: { credentials: { "invalid slot": "cs_selected" } } },
  ]) {
    assert.throws(
      () => driver.credentials.selectedBindings({ pluginId, selection }),
      /Invalid credential/,
    );
  }
});

test("Slack describes only the selected account at its single default projection", async () => {
  const driver = new OCCPluginDriver();
  const slot = driver.credentials
    .choices([])
    .find(({ pluginId }) => pluginId === "occ-plugin:slack@1.0.0");
  assert.ok(slot);
  const selected = {
    kind: "credential_source",
    namespaceId: "ns_team",
    id: "cs_selected",
  } as const;
  const other = { ...selected, id: "cs_other" };
  const selection = {
    enabled: true,
    driverPolicy: { releaseSha256: slot.releaseSha256, credentials: { account: selected.id } },
  };
  // A second name cannot share SLACK_MCP_TOKEN, and a different source cannot stand in
  // for the account in the saved selection.
  for (const accounts of [{ default: selected, work: other }, { default: other }] as const) {
    await assert.rejects(
      driver.describeDeployment({
        plugin: { catalog: "driver", pluginId: slot.pluginId },
        selection,
        connections: { account: accounts },
      }),
      /Slack credential slot/,
    );
  }
});
