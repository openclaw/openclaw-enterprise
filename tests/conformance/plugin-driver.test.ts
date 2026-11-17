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
});

test("credentialless Diffs keeps its pinned Gateway installation when its tool is disabled", async () => {
  const description = await new OCCPluginDriver().describeDeployment({
    pluginId: "occ-plugin:diffs",
    selection: { enabled: true, tools: { diffs: { enabled: false } } },
    connections: {},
  });
  assert.deepEqual(description.credentials, {});
  const [tool] = description.tools;
  assert.ok(tool);
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
        pluginId: slot.pluginId,
        selection,
        connections: { account: accounts },
      }),
      /Slack credential slot/,
    );
  }
});
