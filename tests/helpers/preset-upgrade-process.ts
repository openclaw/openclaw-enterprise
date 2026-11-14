import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { IsSchema } from "typebox/schema";
import {
  InstallationResponse,
  NamespaceResponse,
  NamespaceListResponse,
  PresetResponse,
  PresetListResponse,
  ConfigurationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { InstallationRuntimeDrivers } from "../../apps/controller/src/composition/installation-config.ts";

type SelectedModules = {
  "apps/controller/src/composition/production.ts": typeof import("../../apps/controller/src/composition/production.ts");
  "apps/controller/src/composition/installation-config.ts": typeof import("../../apps/controller/src/composition/installation-config.ts");
  "apps/controller/src/drivers/configuration/filesystem/index.ts": typeof import("../../apps/controller/src/drivers/configuration/filesystem/index.ts");
  "apps/controller/src/worker.ts": typeof import("../../apps/controller/src/worker.ts");
  "packages/iam/src/index.ts": typeof import("../../packages/iam/src/index.ts");
  "tests/helpers/development.mjs": typeof import("./development.ts");
  "tests/helpers/secret-driver.mjs": typeof import("./secret-driver.ts");
  "tests/helpers/auth-session.mjs": typeof import("./auth-session.mjs");
};

// Each phase loads the selected controller in a fresh process. Persistence,
// authentication, startup seeding, and Configuration storage remain real.
const [repository, directory, phase] = process.argv.slice(2);
assert.ok(repository && directory && phase);
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}
const saved: unknown = JSON.parse(input);
const savedSchema = Type.Object({
  installation: Type.Object({ id: Type.String(), name: Type.String(), createdAt: Type.String() }),
  namespaceId: Type.String(),
  edited: PresetResponse.properties.data,
  custom: PresetResponse.properties.data,
  savedConfiguration: ConfigurationResponse.properties.data,
});
// Bind the selected revision's modules to their source-owned contracts. The
// process can load a before checkout; normal API validation detects incompatibility.
async function load<P extends keyof SelectedModules>(path: P): Promise<SelectedModules[P]> {
  return import(pathToFileURL(join(repository!, path)).href);
}
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
const pg: typeof import("pg") = requireDependency("pg");
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const authSecret = process.env.OCC_AUTH_SECRET;
assert.ok(databaseUrl && authSecret);
const authBaseURL = "https://console.oce.localhost";
const configuration: unknown = JSON.parse(await readFile(join(directory, "startup.json"), "utf8"));
assert.ok(Check(Type.Record(Type.String(), Type.Unknown()), configuration));
const runtime = await loadInstallationConfiguration({
  mode: "production",
  environment: {},
  startupConfiguration: { configuration, logging: { level: "error" } },
});
assert.ok(runtime);
const drivers: InstallationRuntimeDrivers = {
  installation: runtime.installation,
  ...(runtime.defaultPresets === undefined ? {} : { defaultPresets: runtime.defaultPresets }),
  ...(runtime.shadowedDefaultPresets === undefined
    ? {}
    : { shadowedDefaultPresets: runtime.shadowedDefaultPresets }),
  ...(runtime.bundledPresetVersions === undefined
    ? {}
    : { bundledPresetVersions: runtime.bundledPresetVersions }),
  // Namespace provisioning uses the existing external Compute fixture. No Agent
  // is deployed: this scenario proves saved state, not a Kubernetes runtime.
  computeDriver: createReadyComputeDriver(runtime.installation.drivers.compute.id, {
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
let app: Awaited<ReturnType<typeof composeProduction>> | undefined;
let worker: ReturnType<typeof createControllerWorker> | undefined;
try {
  app = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret,
    authBaseURL,
    nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
    drivers,
  });
  const schemas = Object.fromEntries(
    Object.entries(app.getSchemas()).map(([id, schema]): [string, TSchema] => {
      assert.ok(IsSchema(schema));
      return [id, schema];
    }),
  );
  const endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
  const localFetch: typeof fetch = (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    assert.ok([endpoint, authBaseURL].includes(url.origin));
    // Advertise the production HTTPS origin while dispatching only to our owned loopback server.
    // This saved-state scenario does not qualify TLS or browser cookie transport.
    const headers = new Headers(request.headers);
    headers.set("host", new URL(authBaseURL).host);
    return fetch(
      new Request(`${endpoint}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
      }),
      { redirect: "error" },
    );
  };
  const session = await signInWithEmailPassword({
    fetch: localFetch,
    origin: authBaseURL,
    email: "preset-upgrade@example.test",
    rememberMe: undefined,
    password: (await readFile(join(directory, "initial-admin-password"), "utf8")).trim(),
  });
  async function request<S extends TSchema>(
    schema: S,
    method: string,
    path: string,
    payload?: unknown,
    expectedStatus = 200,
  ) {
    const response = await localFetch(`${endpoint}${path}`, {
      method,
      headers: authenticatedHeaders(session, {
        origin: authBaseURL,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      }),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(body)}`);
    assert.ok(body && typeof body === "object" && "data" in body);
    const data = body.data;
    assert.ok(Check(schemas, schema, data), `Invalid response for ${method} ${path}`);
    return data;
  }
  async function readyNamespace(id: string) {
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
        (await request(NamespaceResponse.properties.data, "GET", `/namespaces/${id}`)).status !==
          "ready" &&
        Date.now() < deadline
      ) {
        await delay(20);
      }
      assert.equal(
        (await request(NamespaceResponse.properties.data, "GET", `/namespaces/${id}`)).status,
        "ready",
      );
    } finally {
      await worker.stop();
      worker = undefined;
    }
  }
  // Capabilities come from current Drivers; compare persisted identity across versions.
  const { id, name, createdAt } = await request(
    InstallationResponse.properties.data,
    "GET",
    "/installation",
  );
  const installation = { id, name, createdAt };
  if (phase === "seed") {
    const namespaces = await request(NamespaceListResponse.properties.data, "GET", "/namespaces");
    assert.equal(namespaces.length, 1);
    const namespace = namespaces[0];
    assert.ok(namespace);
    await readyNamespace(namespace.id);
    const presetsPath = `/namespaces/${namespace.id}/presets`;
    const defaults = await request(PresetListResponse.properties.data, "GET", presetsPath);
    assert.deepEqual(defaults.map(({ name }) => name).sort(), [
      "Standard Codex",
      "Standard OpenClaw",
      "default-codex",
    ]);
    const bundled = defaults.find(({ name }) => name === "Standard Codex");
    assert.ok(bundled);
    const edited = await request(
      PresetResponse.properties.data,
      "PATCH",
      `${presetsPath}/${bundled.id}`,
      {
        template: { agent: { name: "Operator edited starter" } },
      },
    );
    const custom = await request(
      PresetResponse.properties.data,
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
      ConfigurationResponse.properties.data,
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
    assert.deepEqual(custom.template, {
      agent: {
        name: "Custom teammate",
        initialWorkspaceFiles: { "AGENTS.md": "Keep these operator instructions." },
      },
    });
    assert.equal(installation.name, "Operator installation");
    assert.deepEqual(savedConfiguration.values, {
      logging: { consoleLevel: "warn", consoleStyle: "json" },
      diagnostics: { otel: { logs: true, captureContent: false } },
    });
    process.stdout.write(
      JSON.stringify({
        installation,
        namespaceId: namespace.id,
        edited,
        custom,
        savedConfiguration,
      }),
    );
  } else {
    assert.ok(Check(schemas, savedSchema, saved));
    assert.deepEqual(installation, saved.installation);
    const presetsPath = `/namespaces/${saved.namespaceId}/presets`;
    for (const preset of [saved.edited, saved.custom]) {
      assert.deepEqual(
        await request(PresetResponse.properties.data, "GET", `${presetsPath}/${preset.id}`),
        preset,
      );
    }
    assert.deepEqual(
      await request(
        ConfigurationResponse.properties.data,
        "GET",
        `/namespaces/${saved.namespaceId}/configurations/${saved.savedConfiguration.id}`,
      ),
      saved.savedConfiguration,
    );
    assert.equal(
      (await request(NamespaceResponse.properties.data, "GET", `/namespaces/${saved.namespaceId}`))
        .status,
      "ready",
    );
    if (phase === "disabled") {
      // Disabling defaults affects future Namespaces while retaining existing
      // operator state. A new Namespace proves the startup switch took effect.
      const namespace = await request(
        NamespaceResponse.properties.data,
        "POST",
        "/namespaces",
        { name: "Defaults disabled" },
        201,
      );
      await readyNamespace(namespace.id);
      assert.deepEqual(
        await request(
          PresetListResponse.properties.data,
          "GET",
          `/namespaces/${namespace.id}/presets`,
        ),
        [],
      );
    }
  }
} finally {
  if (worker !== undefined) {
    await worker.stop();
  }
  if (app !== undefined) {
    await app.close();
  }
}
