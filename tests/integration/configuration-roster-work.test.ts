import assert from "node:assert/strict";
import test from "node:test";
import { validateModelCredentialReferences } from "../../apps/controller/src/drivers/configuration/model-auth.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

test("Configuration credential validation lists the agents roster once across credential slots", () => {
  let rosterEnumerations = 0;
  const entries = new Proxy(
    { first: {}, second: {}, last: {} },
    {
      ownKeys(roster) {
        rosterEnumerations += 1;
        return Reflect.ownKeys(roster);
      },
    },
  );

  // Several credential rules consume the same roster even when the entries are empty.
  validateModelCredentialReferences({ agents: { entries } });
  assert.equal(rosterEnumerations, 1);
});

test("Kubernetes Compute configuration validation skips absent utilityModel lookups and rejects the wrong provider", () => {
  let absentUtilityModelReads = 0;
  const emptyEntry = () =>
    new Proxy(
      {},
      {
        get(row, key, receiver) {
          if (key === "utilityModel") {
            absentUtilityModelReads += 1;
          }
          return Reflect.get(row, key, receiver);
        },
      },
    );
  const compute = createTestKubernetesComputeDriver("compute-roster");

  // Skipping empty rows must still leave the last row subject to the selected provider rule.
  assert.throws(
    () =>
      compute.validateConfiguration({
        agents: {
          defaults: {
            model: "codex/gpt-5",
            models: { "codex/gpt-5": { agentRuntime: { id: "codex" } } },
          },
          ownership: "explicit",
          entries: {
            first: emptyEntry(),
            second: emptyEntry(),
            last: { utilityModel: "openai/gpt-5" },
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationHarnessError);
      assert.match(
        error.message,
        /^Configuration setting agents\.entries\.last\.utilityModel must select codex\/<model>/,
      );
      return true;
    },
  );
  assert.equal(absentUtilityModelReads, 0, "utilityModel lookups on empty roster entries");
});
