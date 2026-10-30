import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";

async function load(t, plugin) {
  const configuration = createInstallationDriverConfiguration();
  if (plugin !== undefined) {
    configuration.drivers.plugin = plugin;
  }
  return loadInstallationFile(t, configuration);
}

test("Installation startup selects one bundled Agent PluginDriver or leaves it absent", async (t) => {
  const absent = await load(t);
  assert.deepEqual(absent.pluginDrivers, []);
  for (const id of ["occ-plugin", "codex-plugin"]) {
    const loaded = await load(t, { id, configuration: {} });
    assert.equal(loaded.pluginDrivers[0].id, id);
    assert.equal(loaded.pluginDrivers[0].capability, "plugin");
    assert.equal(loaded.installation.drivers.plugin[0].id, id);
    assert.equal(
      loaded.installation.drivers.plugin[0].implementation,
      loaded.pluginDrivers[0].implementation,
    );
  }
});

test("Installation startup registers each configured plugin catalog and rejects duplicate owners", async (t) => {
  const selections = [
    { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
    { id: "occ-plugin", configuration: {} },
  ];
  const { pluginDrivers } = await load(t, selections);
  assert.deepEqual(
    pluginDrivers.map(({ id, harnessId }) => [id, harnessId]),
    [
      ["codex-plugin", "codex"],
      ["occ-plugin", "openclaw"],
    ],
  );
  await assert.rejects(load(t, [selections[0], selections[0]]), /duplicates another Plugin Driver/);
});

test("Installation startup accepts explicit native Codex catalog reader configuration", async (t) => {
  const loaded = await load(t, {
    id: "codex-plugin",
    configuration: {
      codexExecutable: "/tmp/codex-plugin-catalog-bin/codex",
      codexHome: "/tmp/codex-plugin-catalog-home",
      requestTimeoutMs: 30_000,
    },
  });
  assert.equal(loaded.pluginDrivers[0].id, "codex-plugin");
  assert.deepEqual(loaded.installation.drivers.plugin[0].configuration, {
    codexExecutable: "/tmp/codex-plugin-catalog-bin/codex",
    codexHome: "/tmp/codex-plugin-catalog-home",
    requestTimeoutMs: 30_000,
  });
});

test("Installation selects hosted discovery by default and can select the curated catalog", async (t) => {
  for (const [configuration, credential] of [
    [{}, "required"],
    [{ catalogSource: "hosted" }, "required"],
    [{ catalogSource: "openai-curated" }, "none"],
  ]) {
    const loaded = await load(t, { id: "codex-plugin", configuration });
    assert.equal(loaded.pluginDrivers[0].discoveryCredential, credential);
    assert.deepEqual(loaded.installation.drivers.plugin[0].configuration, configuration);
  }
});

test("Installation rejects untrusted PluginDriver packages, unknown selections and configuration", async (t) => {
  const refusal = (path, code, message) => [{ path, code, message }];
  for (const [selection, expected] of [
    [
      { id: "unknown-plugin-driver", configuration: {} },
      /drivers\.plugin\.id must select occ-plugin or codex-plugin/,
    ],
    [
      { id: "occ-plugin", package: "@untrusted/driver", configuration: {} },
      /drivers\.plugin contains unsupported option package/,
    ],
    [
      { id: "codex-plugin", configuration: { arbitrarySource: "https://example.test/plugin" } },
      refusal("", "UNKNOWN_FIELD", "Configuration does not satisfy additionalProperties."),
    ],
    [
      { id: "codex-plugin", configuration: { catalogSource: "unknown" } },
      refusal("/catalogSource", "INVALID_VALUE", "Configuration does not satisfy enum."),
    ],
    ...[1, null].map((catalogSource) => [
      { id: "codex-plugin", configuration: { catalogSource } },
      [
        ...refusal("/catalogSource", "INVALID_TYPE", "Configuration does not satisfy type."),
        ...refusal("/catalogSource", "INVALID_VALUE", "Configuration does not satisfy enum."),
      ],
    ]),
    [
      { id: "codex-plugin", configuration: { codexExecutable: "/tmp/codex" } },
      refusal(
        "/codexHome",
        "REQUIRED",
        "This field is required for a configured native catalog reader.",
      ),
    ],
    [
      {
        id: "codex-plugin",
        configuration: {
          codexExecutable: "/tmp/codex",
          codexHome: "/tmp/codex-home",
          requestTimeoutMs: 0,
        },
      },
      refusal("/requestTimeoutMs", "INVALID_VALUE", "Configuration does not satisfy minimum."),
    ],
  ]) {
    if (expected instanceof RegExp) {
      await assert.rejects(load(t, selection), expected);
    } else {
      await assert.rejects(load(t, selection), (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(error.error.details, expected);
        return true;
      });
    }
  }
});
