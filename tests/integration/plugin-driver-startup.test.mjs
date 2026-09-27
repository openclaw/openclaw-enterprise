import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

async function load(t, plugin) {
  const directory = await mkdtemp(join(tmpdir(), "occ-plugin-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuration = createInstallationDriverConfiguration();
  if (plugin !== undefined) {
    configuration.drivers.plugin = plugin;
  }
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration));
  return loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
}

test("Installation startup selects one bundled Agent PluginDriver or leaves it absent", async (t) => {
  const absent = await load(t);
  assert.equal(absent.pluginDriver, undefined);
  for (const id of ["occ-plugin", "codex-plugin"]) {
    const loaded = await load(t, { id, configuration: {} });
    assert.equal(loaded.pluginDriver.id, id);
    assert.equal(loaded.pluginDriver.capability, "plugin");
    assert.equal(loaded.installation.drivers.plugin.id, id);
    assert.equal(
      loaded.installation.drivers.plugin.implementation,
      loaded.pluginDriver.implementation,
    );
  }
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
  assert.equal(loaded.pluginDriver.id, "codex-plugin");
  assert.deepEqual(loaded.installation.drivers.plugin.configuration, {
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
    assert.equal(loaded.pluginDriver.discoveryCredential, credential);
    assert.deepEqual(loaded.installation.drivers.plugin.configuration, configuration);
  }
});

test("Installation rejects untrusted PluginDriver packages, unknown selections and configuration", async (t) => {
  for (const selection of [
    { id: "unknown-plugin-driver", configuration: {} },
    { id: "occ-plugin", package: "@untrusted/driver", configuration: {} },
    { id: "codex-plugin", configuration: { arbitrarySource: "https://example.test/plugin" } },
    { id: "codex-plugin", configuration: { catalogSource: "unknown" } },
    { id: "codex-plugin", configuration: { catalogSource: 1 } },
    { id: "codex-plugin", configuration: { catalogSource: null } },
    { id: "codex-plugin", configuration: { codexExecutable: "/tmp/codex" } },
    {
      id: "codex-plugin",
      configuration: {
        codexExecutable: "/tmp/codex",
        codexHome: "/tmp/codex-home",
        requestTimeoutMs: 0,
      },
    },
  ]) {
    await assert.rejects(
      load(t, selection),
      /drivers\.plugin|codexHome|requestTimeoutMs|catalogSource/,
    );
  }
});
