import assert from "node:assert/strict";
import test from "node:test";
import { codexRuntimeReadParams } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import {
  codexCatalogFixture,
  codexSelection,
  thirdPluginId,
  thirdRemotePluginId,
} from "./plugin-driver-fixtures.ts";

test("Codex runtime resolves selected plugins in the native marketplace", () => {
  assert.deepEqual(codexRuntimeReadParams(codexSelection(thirdPluginId), codexCatalogFixture()), [
    { remoteMarketplaceName: "openai-curated-remote", pluginName: thirdRemotePluginId },
  ]);
});
