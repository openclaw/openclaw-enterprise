import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Each phase loads the selected controller in a fresh process. Persistence,
// authentication, startup seeding, and Configuration storage remain real.
const [repository, directory, phase] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(repository, path)));
const { composeProduction } = await load("apps/controller/src/composition/production.ts");
const { loadInstallationConfiguration } = await load(
  "apps/controller/src/composition/installation-config.ts",
);
const { FilesystemConfigurationDriver } = await load(
  "apps/controller/src/drivers/configuration/filesystem/index.ts",
);
const { createControllerWorker } = await load("apps/controller/src/worker.ts");
const { NativeIAMDriver } = await load("packages/iam/src/index.ts");
const { createReadyComputeDriver } = await load("tests/helpers/development.mjs");
const { createTestSecretDriver } = await load("tests/helpers/secret-driver.mjs");
const { authenticatedHeaders, signInWithEmailPassword } = await load(
  "tests/helpers/auth-session.mjs",
);
const requireDependency = createRequire(join(repository, "apps/controller/package.json"));
const pg = requireDependency("pg");
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const authBaseURL = "http://127.0.0.1:0";
const configuration = JSON.parse(await readFile(join(directory, "startup.json"), "utf8"));
const runtime = await loadInstallationConfiguration({
  mode: "production",
  environment: {},
  startupConfiguration: { configuration, logging: { level: "error" } },
});
assert.ok(runtime);
const drivers = {
  installation: runtime.installation,
  defaultPresets: runtime.defaultPresets,
  shadowedDefaultPresets: runtime.shadowedDefaultPresets,
  bundledPresetVersions: runtime.bundledPresetVersions,
  // Namespace provisioning uses the existing external Compute fixture. No Agent
  // is deployed: this scenario proves saved state, not a Kubernetes runtime.
  computeDriver: createReadyComputeDriver(configuration.drivers.compute.id, {
    async preflight() {
      return { warnings: [] };
    },
  }),
  configurationDriver: new FilesystemConfigurationDriver(join(directory, "configurations")),
  secretDriver: createTestSecretDriver({ id: runtime.installation.drivers.secret.id }),
  createIAMDriver(state) {
    return new NativeIAMDriver(state, runtime.installation.drivers.iam);
  },
};
let app;
let worker;
try {
  app = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret: process.env.OCC_AUTH_SECRET,
    authBaseURL,
    drivers,
  });
  const endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
  const session = await signInWithEmailPassword({
    origin: endpoint,
    email: "preset-upgrade@example.test",
    password: (await readFile(join(directory, "initial-admin-password"), "utf8")).trim(),
  });
  async function request(method, path, payload, expectedStatus = 200) {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: authenticatedHeaders(session, {
        origin: authBaseURL,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      }),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(body)}`);
    return body.data;
  }
  async function readyNamespace(id) {
    worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      mode: "production",
      drivers,
      pollIntervalMs: 20,
      emit: () => {},
    });
    try {
      await worker.start();
      const deadline = Date.now() + 10000;
      while (
        (await request("GET", `/namespaces/${id}`)).status !== "ready" &&
        Date.now() < deadline
      ) {
        await delay(20);
      }
      assert.equal((await request("GET", `/namespaces/${id}`)).status, "ready");
    } finally {
      await worker.stop();
      worker = undefined;
    }
  }
  const installation = await request("GET", "/installation");
  if (phase === "seed") {
    const namespaces = await request("GET", "/namespaces");
    assert.equal(namespaces.length, 1);
    const namespace = namespaces[0];
    await readyNamespace(namespace.id);
    const presetsPath = `/namespaces/${namespace.id}/presets`;
    const defaults = await request("GET", presetsPath);
    assert.deepEqual(defaults.map(({ name }) => name).sort(), [
      "Standard Codex",
      "Standard OpenClaw",
      "default-codex",
    ]);
    const bundled = defaults.find(({ name }) => name === "Standard Codex");
    const edited = await request("PATCH", `${presetsPath}/${bundled.id}`, {
      template: { agent: { name: "Operator edited starter" } },
    });
    const custom = await request(
      "POST",
      presetsPath,
      {
        name: "Operator custom starter",
        template: {
          agent: {
            name: "Custom teammate",
            initialWorkspaceFiles: { "AGENTS.md": "Keep these operator instructions." },
          },
        },
      },
      201,
    );
    const savedConfiguration = await request(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        kind: "agent",
        values: {
          logging: { consoleLevel: "warn", consoleStyle: "json" },
          diagnostics: { otel: { logs: true, captureContent: false } },
        },
      },
      201,
    );
    // Record independently chosen operator values and their real API responses,
    // including stable resource IDs and generations.
    assert.deepEqual(edited.template, { agent: { name: "Operator edited starter" } });
    assert.equal(custom.template.agent.name, "Custom teammate");
    assert.equal(
      custom.template.agent.initialWorkspaceFiles["AGENTS.md"],
      "Keep these operator instructions.",
    );
    assert.equal(installation.name, "Operator installation");
    assert.equal(savedConfiguration.values.logging.consoleLevel, "warn");
    await writeFile(
      join(directory, "saved-state.json"),
      JSON.stringify({
        installation,
        namespaceId: namespace.id,
        edited,
        custom,
        savedConfiguration,
      }),
      { mode: 0o600 },
    );
  } else {
    const saved = JSON.parse(await readFile(join(directory, "saved-state.json"), "utf8"));
    assert.deepEqual(installation, saved.installation);
    const presetsPath = `/namespaces/${saved.namespaceId}/presets`;
    for (const preset of [saved.edited, saved.custom]) {
      assert.deepEqual(await request("GET", `${presetsPath}/${preset.id}`), preset);
    }
    assert.deepEqual(
      await request(
        "GET",
        `/namespaces/${saved.namespaceId}/configurations/${saved.savedConfiguration.id}`,
      ),
      saved.savedConfiguration,
    );
    assert.equal((await request("GET", `/namespaces/${saved.namespaceId}`)).status, "ready");
    if (phase === "disabled") {
      // Disabling defaults affects future Namespaces while retaining existing
      // operator state. A new Namespace proves the startup switch took effect.
      const namespace = await request("POST", "/namespaces", { name: "Defaults disabled" }, 201);
      await readyNamespace(namespace.id);
      assert.deepEqual(await request("GET", `/namespaces/${namespace.id}/presets`), []);
    }
  }
  process.stdout.write(`preset preservation phase ${phase}: passed\n`);
} finally {
  if (worker !== undefined) {
    await worker.stop();
  }
  if (app !== undefined) {
    await app.close();
  }
}
