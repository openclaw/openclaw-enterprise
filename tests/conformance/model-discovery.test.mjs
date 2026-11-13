import assert from "node:assert/strict";
import test from "node:test";
import { discoverHarnessModels } from "../../apps/controller/src/drivers/compute/model-discovery.ts";

// The operator catalog command for this same Codex URL keeps every visibility "list"
// slug and ignores priority. A hidden row is not part of that list.
async function discoverCodex(t, models) {
  const pages = [
    { chatgpt_account_id: "verified-account", chatgpt_account_is_fedramp: false },
    { models },
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json(pages.shift()));
  return discoverHarnessModels({
    provider: "openai",
    authMethod: "codex_pat",
    apiKey: "at-fixture-token",
  });
}

test("Codex model discovery lists the operator catalog when priority is omitted", async (t) => {
  // Listed rows follow the catalog command: visibility list, slug, and an optional name.
  // A hidden row without priority is not a reason to reject those models.
  const listed = await discoverCodex(t, [
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
    { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" },
  ]);
  assert.deepEqual(listed, [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
  ]);

  // When every listed model has a numeric priority, picker order stays that order.
  const ordered = await discoverCodex(t, [
    { slug: "codex-later", display_name: "Later model", visibility: "list", priority: 2 },
    { slug: "codex-hidden", display_name: "Hidden model", visibility: "hide" },
    { slug: "codex-dynamic", display_name: "Codex dynamic", visibility: "list", priority: 1 },
  ]);
  assert.deepEqual(ordered, [
    { id: "codex-dynamic", name: "Codex dynamic" },
    { id: "codex-later", name: "Later model" },
  ]);

  await assert.rejects(
    discoverCodex(t, [{ slug: "bad id", display_name: "Broken", visibility: "list" }]),
    (error) => error?.name === "ModelDiscoveryError" && error.reason === "invalid_response",
  );
});
