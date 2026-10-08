import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Run in a child so selection is set before the real fixture module is loaded,
// without changing the caller's environment or touching a cluster or database.
test("the full real plugin proof rejects shared or missing scenario databases before provisioning", () => {
  const fixtureModule = new URL("../helpers/plugin-driver-real.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const { createPluginDriverRealFixture } = await import(${JSON.stringify(fixtureModule)});
    const scenarios = ["openclaw", "codex_linear", "codex_failure"];
    const key = (scenario) => \`OCC_TEST_PLUGIN_DRIVER_\${scenario.toUpperCase()}_DATABASE_URL\`;
    const reset = () => {
      for (const scenario of scenarios) {
        process.env[key(scenario)] = \`postgresql://user:secret@127.0.0.1:5432/\${scenario}\`;
      }
    };
    const create = (scenario) => createPluginDriverRealFixture({}, {
      scenario,
      pluginDriverId: scenario === "openclaw" ? "occ-plugin" : "codex-plugin",
      databaseUrl: process.env[key(scenario)],
    });
    for (let first = 0; first < scenarios.length; first += 1) {
      for (let second = first + 1; second < scenarios.length; second += 1) {
        reset();
        // Different credentials must not disguise the same underlying database.
        process.env[key(scenarios[second])] =
          \`postgresql://other:secret@127.0.0.1:5432/\${scenarios[first]}\`;
        for (const scenario of [scenarios[first], scenarios[second]]) {
          await assert.rejects(create(scenario), (error) => {
            assert.match(error.message, /must use separate dedicated databases/);
            assert.doesNotMatch(error.message, /secret/);
            return true;
          });
        }
      }
    }
    for (const scenario of scenarios) {
      reset();
      delete process.env[key(scenario)];
      await assert.rejects(create("openclaw"), new RegExp(key(scenario)));
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OCC_TEST_PLUGIN_DRIVER_REAL: "1",
      OCC_TEST_KUBERNETES_KUBECONFIG: "/nonexistent",
      OCC_TEST_KUBERNETES_CONTEXT: "preflight",
      OCC_TEST_KUBERNETES_GATEWAY_IMAGE: "preflight",
      OCC_TEST_KUBERNETES_CODEX_IMAGE: "preflight",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
