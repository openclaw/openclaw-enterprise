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
import "./plugin-driver-codex-configuration-cases.ts";

test("bundled Plugin Drivers enforce Harness identity", async () => {
  const occ = new OCCPluginDriver();
  const codex = new CodexPluginDriver();

  await assert.rejects(occ.listCatalog(context("dedicated")), NotImplementedError);
  await assert.rejects(codex.listCatalog(context("embedded")), NotImplementedError);
});
