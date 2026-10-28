import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { nativeSession } from "./session.ts";

type Session = Awaited<ReturnType<typeof nativeSession>>;

async function verifyEnvironment() {
  assert.equal(process.getuid?.(), 1000);
  assert.equal(
    spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim(),
    "codex-cli 0.163.0-alpha.2",
  );
  await assert.rejects(
    fs.writeFile("/fixture/plugins/selected/.codex-plugin/plugin.json", "forbidden"),
    { code: "EROFS" },
  );
}

function pluginApi({ rpc }: Session) {
  type Skill = { pluginId?: string; path: string; enabled: boolean };
  const skills = async () =>
    (
      await rpc<{ data: { skills: Skill[] }[] }>("skills/list", {
        cwds: ["/tmp/workspace"],
        forceReload: true,
      })
    ).data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.pluginId?.endsWith("@oce-fixture"));
  const detail = (pluginName: string) =>
    rpc<{ plugin: { summary: { installed: boolean; enabled: boolean }; skills: unknown[] } }>(
      "plugin/read",
      {
        marketplacePath: "/fixture/.agents/plugins/marketplace.json",
        pluginName,
      },
    );

  return { skills, detail };
}
type PluginApi = ReturnType<typeof pluginApi>;

async function readBaseline({ rpc, send }: Session, { skills }: PluginApi) {
  const initialized = await rpc<{ userAgent: string; codexHome: string }>("initialize", {
    clientInfo: { name: "oce_native_fixture", version: "1" },
    capabilities: { experimentalApi: true },
  });
  assert.match(initialized.userAgent, /\/0\.163\.0-alpha\.2\b/);
  assert.equal(initialized.codexHome, process.env.CODEX_HOME);
  send(JSON.stringify({ method: "initialized" }));
  const config = await rpc<{
    config: {
      features: { plugins: boolean; remote_plugin: boolean; apps: boolean };
      plugins: Record<string, { enabled?: boolean }>;
      marketplaces: Record<string, { source: string }>;
    };
  }>("config/read", {});
  assert.equal(config.config.marketplaces["oce-fixture"]!.source, "/fixture");
  assert.equal(config.config.plugins._default?.enabled, false);
  assert.equal(config.config.features.remote_plugin, false);
  assert.equal(config.config.features.apps, false);
  const registered = JSON.parse(
    await fs.readFile("/fixture/.agents/plugins/marketplace.json", "utf8"),
  );
  assert.deepEqual(
    registered.plugins.map((plugin: { name: string }) => plugin.name),
    ["selected", "excluded"],
  );
  assert.deepEqual(await skills(), []);

  return config;
}
type Baseline = Awaited<ReturnType<typeof readBaseline>>;

async function verifyProtected(config: Baseline, { skills, detail }: PluginApi) {
  assert.equal(config.config.features.plugins, false);
  for (const name of ["selected", "excluded"]) {
    await assert.rejects(detail(name), /plugins feature is disabled/);
  }
  // Read-only control: do not teach CI to expect post-admission installation.
  assert.deepEqual(await skills(), []);
}

async function verifyPreparation(
  config: Baseline,
  { rpc }: Session,
  { skills, detail }: PluginApi,
) {
  assert.equal(config.config.features.plugins, true);
  assert.equal(config.config.plugins["selected@oce-fixture"]?.enabled, true);
  for (const name of ["selected", "excluded"]) {
    const result = await detail(name);
    assert.equal(result.plugin.summary.installed, false);
    assert.equal(result.plugin.skills.length, 1);
  }
  assert.equal((await detail("excluded")).plugin.summary.enabled, false);
  assert.deepEqual(
    await rpc("plugin/install", {
      marketplacePath: "/fixture/.agents/plugins/marketplace.json",
      pluginName: "selected",
    }),
    { authPolicy: "ON_INSTALL", appsNeedingAuth: [] },
  );
  const loaded = await skills();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.pluginId, "selected@oce-fixture");
  assert.equal(loaded[0]!.enabled, true);
  const path = await fs.realpath(loaded[0]!.path);
  assert.ok(path.startsWith(process.env.CODEX_HOME! + "/"));
  assert.equal(
    await fs.readFile(path, "utf8"),
    await fs.readFile("/fixture/plugins/selected/skills/greeting/SKILL.md", "utf8"),
  );
  assert.equal((await detail("excluded")).plugin.summary.installed, false);
  assert.equal((await detail("excluded")).plugin.summary.enabled, false);
  for (const entries of [{ "selected@oce-fixture": { enabled: false } }, {}]) {
    await rpc("config/batchWrite", {
      edits: [
        {
          keyPath: "plugins",
          mergeStrategy: "replace",
          value: { _default: { enabled: false }, ...entries },
        },
      ],
      reloadUserConfig: true,
    });
    assert.deepEqual(await skills(), [], "disabled and omitted selections must not load");
  }
}

// One native session owns initialization, installation (preparation only), and readback.
export async function nativeProbe(mode: "protected" | "stock", bearer?: string) {
  await verifyEnvironment();
  const session = await nativeSession(bearer);
  try {
    const api = pluginApi(session);
    const baseline = await readBaseline(session, api);
    if (mode === "protected") {
      await verifyProtected(baseline, api);
    } else {
      await verifyPreparation(baseline, session, api);
    }
    console.log(`NATIVE_${mode.toUpperCase()}_PASSED`);
  } finally {
    await session.close();
  }
}
