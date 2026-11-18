import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";

async function load(t: TestContext, plugin?: unknown) {
  const configuration = createInstallationDriverConfiguration();
  if (plugin !== undefined) {
    Object.assign(configuration.drivers, { plugin });
  }
  const loaded = await loadInstallationFile(t, configuration);
  assert.ok(loaded);
  return loaded;
}

test("Installation startup selects one bundled Agent PluginDriver or leaves it absent", async (t) => {
  const absent = await load(t);
  assert.deepEqual(absent.pluginDrivers, []);
  for (const id of ["occ-plugin", "codex-plugin"]) {
    const loaded = await load(t, [{ id, configuration: {} }]);
    assert.equal(loaded.pluginDrivers?.[0]?.id, id);
    assert.equal(loaded.pluginDrivers?.[0]?.capability, "plugin");
    assert.equal(loaded.installation.drivers.plugin?.[0]?.id, id);
    assert.equal(
      loaded.installation.drivers.plugin?.[0]?.implementation,
      loaded.pluginDrivers?.[0]?.implementation,
    );
  }
});

test("Installation startup registers each configured plugin catalog and rejects duplicate owners", async (t) => {
  const selections = [
    { id: "codex-plugin", configuration: {} },
    { id: "occ-plugin", configuration: {} },
  ];
  const { pluginDrivers } = await load(t, selections);
  assert.ok(pluginDrivers);
  assert.deepEqual(
    pluginDrivers.map(({ id, harnessId }) => [id, harnessId]),
    [
      ["codex-plugin", "codex"],
      ["occ-plugin", "openclaw"],
    ],
  );
  await assert.rejects(load(t, selections[0]), /drivers\.plugin must be an array/);
  await assert.rejects(load(t, [selections[0], selections[0]]), /duplicates another Plugin Driver/);
});

test("Installation requires authenticated Codex discovery without catalog configuration", async (t) => {
  const loaded = await load(t, [{ id: "codex-plugin", configuration: {} }]);
  assert.equal(loaded.pluginDrivers?.[0]?.discoveryCredential, "required");
});

test("Installation rejects untrusted PluginDriver packages, unknown selections and configuration", async (t) => {
  const refusal = (path: string, code: string, message: string) => [{ path, code, message }];
  for (const [selection, expected] of [
    [
      { id: "unknown-plugin-driver", configuration: {} },
      /drivers\.plugin\[0\]\.id must select occ-plugin or codex-plugin/,
    ],
    [
      { id: "occ-plugin", package: "@untrusted/driver", configuration: {} },
      /drivers\.plugin\[0\] contains unsupported option package/,
    ],
    [
      { id: "codex-plugin", configuration: { arbitrarySource: "https://example.test/plugin" } },
      refusal("", "UNKNOWN_FIELD", "Configuration does not satisfy additionalProperties."),
    ],
    ...[
      { catalogSource: "openai-curated" },
      { catalogSource: "hosted" },
      { codexExecutable: "/tmp/codex" },
      { codexHome: "/tmp/codex-home" },
      { requestTimeoutMs: 10_000 },
    ].map((configuration) => [
      { id: "codex-plugin", configuration },
      refusal("", "UNKNOWN_FIELD", "Configuration does not satisfy additionalProperties."),
    ]),
  ]) {
    if (expected instanceof RegExp) {
      await assert.rejects(load(t, [selection]), expected);
    } else {
      await assert.rejects(load(t, [selection]), (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(error.error.details, expected);
        return true;
      });
    }
  }
});
