import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

function jsonLines(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function startupDiagnostic(stderr, event) {
  const diagnostic = jsonLines(stderr).find((line) => line.event === event);
  assert.ok(diagnostic, stderr);
  return diagnostic;
}

async function fixture(t, configuration = installation()) {
  const directory = await mkdtemp(join(tmpdir(), "occ-installation-startup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  // JSON is valid YAML; mutations exercise the same real SDK YAML parser as controller startup.
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

function chatgptInstallation() {
  const configuration = installation();
  configuration.provider = [
    {
      id: "openai",
      type: "chatgpt",
      configuration: {
        workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
        apiKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: {
        service_account: "chatgpt-service-accounts",
      },
    },
  ];
  configuration.drivers.service_account = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  return configuration;
}

function retiredChatgptInstallation() {
  const configuration = installation();
  configuration.integrations = {
    chatgpt: {
      workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
      adminKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
      credentialTtlSeconds: 3600,
    },
  };
  configuration.drivers.service_account = {
    id: "chatgpt-service-accounts",
    configuration: {},
  };
  return configuration;
}

test("startup loads singleton Installation YAML and validates Drivers before construction", async (t) => {
  const path = await fixture(t);
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  const configuration = drivers.installation;
  assert.equal(configuration.occ.cluster, "production-west");
  assert.equal(Object.hasOwn(configuration, "installationId"), false);

  // Runtime Driver identities must exactly match startup selections and admitted descriptors.
  assert.equal(drivers.computeDriver.id, "compute-kubernetes");
  assert.equal(drivers.computeDriver.implementation, "occ/kubernetes");
  assert.equal(drivers.configurationDriver.id, "config-kubernetes");
  assert.equal(drivers.configurationDriver.implementation, "occ/kubernetes-configmap");
  assert.equal(configuration.drivers.compute.configuration.network.gatewayPort, 8080);

  // Startup constructs the selected Compute Driver using the updated trusted YAML settings.
  const changed = installation();
  changed.drivers.compute.configuration.network.gatewayPort = 8081;
  const updated = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, changed) },
  });
  assert.equal(updated.computeDriver.id, drivers.computeDriver.id);
  assert.equal(updated.computeDriver.implementation, drivers.computeDriver.implementation);
  assert.equal(updated.installation.drivers.compute.configuration.network.gatewayPort, 8081);
});

test("shared startup loads provider metadata without reading the API-only ChatGPT admin Secret", async (t) => {
  // The worker shares this loader but deliberately cannot access the configured API-only mount.
  const drivers = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, chatgptInstallation()) },
  });

  assert.deepEqual(drivers.installation.provider, [
    {
      id: "openai",
      type: "chatgpt",
      configuration: {
        workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
        apiKeyPath: "/tmp/nonexistent-occ-chatgpt-admin-key",
        credentialTtlSeconds: 3600,
      },
      drivers: {
        service_account: "chatgpt-service-accounts",
      },
    },
  ]);
  assert.equal(
    Object.hasOwn(drivers.installation.provider[0].configuration, "adminKeyPath"),
    false,
  );
  assert.deepEqual(drivers.installation.drivers.service_account, {
    id: "chatgpt-service-accounts",
  });
  assert.equal(Object.hasOwn(drivers, "serviceAccountDriver"), false);
  assert.equal(Object.hasOwn(drivers, "chatgptClient"), false);
});

test("ChatGPT startup rejects retired integrations and unsafe provider configuration", async (t) => {
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, retiredChatgptInstallation()) },
    }),
    /integrations is retired.*provider.*apiKeyPath/,
  );

  for (const [mutate, expected] of [
    [(value) => delete value.provider, /requires an owning provider/],
    [(value) => delete value.drivers.service_account, /requires drivers\.service_account/],
    [
      (value) => delete value.provider[0].drivers.service_account,
      /drivers\.service_account.*required/,
    ],
    [
      (value) => (value.provider[0].configuration.workspaceId = "untrusted"),
      /workspaceId.*invalid/,
    ],
    [
      (value) => (value.provider[0].configuration.apiKeyPath = "relative-admin-key"),
      /absolute mounted file path/,
    ],
    [
      (value) => (value.provider[0].configuration.credentialTtlSeconds = 2_592_001),
      /between 1 and 2592000/,
    ],
    [
      (value) => (value.provider[0].configuration.apiKey = "plaintext-admin-key"),
      /plaintext credential|unsupported option/,
    ],
    [
      (value) => (value.provider[0].configuration.adminKeyPath = "/tmp/old-admin-key"),
      /adminKeyPath.*unsupported/,
    ],
    [(value) => (value.provider[0].type = "installed"), /must be chatgpt/],
    [(value) => (value.provider[0].package = "@example/provider"), /unsupported option package/],
    [
      (value) => (value.provider[0].drivers.service_account = "other-service-accounts"),
      /must match the selected drivers\.service_account\.id/,
    ],
    [
      (value) => value.provider.push(structuredClone(value.provider[0])),
      /Provider IDs must be unique/,
    ],
    [
      (value) => {
        const duplicate = structuredClone(value.provider[0]);
        duplicate.id = "other-openai";
        value.provider.push(duplicate);
      },
      /ServiceAccount Driver cannot belong to multiple Providers/,
    ],
    [
      (value) => (value.drivers.service_account.configuration.providerId = "openai"),
      /unsupported option/,
    ],
  ]) {
    const configuration = chatgptInstallation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("startup accepts actual block-style YAML instead of requiring JSON", async (t) => {
  const path = await fixture(t);
  const configuration = installation();
  const yaml = `occ:\n  cluster: production-west\ndrivers:\n  configuration: ${JSON.stringify(configuration.drivers.configuration)}\n  iam: ${JSON.stringify(configuration.drivers.iam)}\n  compute: ${JSON.stringify(configuration.drivers.compute)}\n  secret: ${JSON.stringify(configuration.drivers.secret)}\n`;
  await writeFile(path, yaml, "utf8");
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
  });
  assert.equal(loaded.installation.occ.cluster, "production-west");
});

test("production requires one YAML while development may start without a ConfigurationDriver", async () => {
  await assert.rejects(
    loadInstallationConfiguration({ mode: "production", environment: {} }),
    /OCC_CONFIG_PATH/,
  );
  assert.equal(
    await loadInstallationConfiguration({ mode: "development", environment: {} }),
    undefined,
  );
});

test("production server and worker resolve singleton startup without an Installation ID", async (t) => {
  const path = await fixture(t);
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };

  // The actual server gets beyond singleton/Driver startup and fails only at missing session auth.
  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...shared,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(server.status, 1);
  assert.equal(startupDiagnostic(server.stderr, "startup-error").code, "AUTH_BASE_URL_INVALID");
  assert.doesNotMatch(server.stderr, /OCC_AUTH_BASE_URL|OCC_AUTH_SECRET|OCC_INSTALLATION_ID/);

  // The real worker likewise reaches PostgreSQL; no test-owned database or driver is substituted.
  const worker = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
    cwd: process.cwd(),
    env: shared,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(worker.status, 1);
  assert.equal(
    startupDiagnostic(worker.stderr, "worker.startup-error").code,
    "PERSISTENCE_UNAVAILABLE",
  );
  assert.doesNotMatch(worker.stderr, /OCC_INSTALLATION_ID|explicit Installation/);
});

test("only the actual API process reads ChatGPT admin credentials and provider accounts require PostgreSQL", async (t) => {
  const path = await fixture(t, chatgptInstallation());
  const shared = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: path,
    OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
  };

  // API startup fails on its missing mounted admin key before opening the configured database.
  const server = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...shared,
      OCC_HOST: "192.0.2.10",
      OCC_PORT: "8080",
      OCC_AUTH_SECRET: "production-auth-secret-with-at-least-32-characters",
      OCC_AUTH_BASE_URL: "http://192.0.2.10:8080",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(server.status, 1);
  assert.equal(
    startupDiagnostic(server.stderr, "startup-error").code,
    "CHATGPT_ADMIN_KEY_UNAVAILABLE",
  );
  assert.doesNotMatch(server.stderr, /ChatGPT admin-key Secret is unavailable/);

  // The same configured worker cannot read that mount and fails only when PostgreSQL is unavailable.
  const worker = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
    cwd: process.cwd(),
    env: shared,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(worker.status, 1);
  assert.equal(
    startupDiagnostic(worker.stderr, "worker.startup-error").code,
    "PERSISTENCE_UNAVAILABLE",
  );
  assert.doesNotMatch(worker.stderr, /ChatGPT|admin-key|ServiceAccount Driver/);

  // Driver-private provider bindings cannot silently fall back to ephemeral in-memory persistence.
  const inMemory = spawnSync(process.execPath, ["apps/controller/src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      OCC_CONFIG_PATH: path,
      OCC_HOST: "127.0.0.1",
      OCC_PORT: "8080",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(inMemory.status, 1);
  assert.equal(
    startupDiagnostic(inMemory.stderr, "startup-error").code,
    "SERVICE_ACCOUNT_REQUIRES_POSTGRES",
  );
  assert.doesNotMatch(
    inMemory.stderr,
    /ServiceAccounts require PostgreSQL persistence|ChatGPT admin-key Secret/,
  );
});

test("startup rejects caller-selected Installation IDs and obsolete Driver selectors", async (t) => {
  const path = await fixture(t);
  for (const [name, value] of [
    ["OCC_INSTALLATION_ID", "ins_untrusted"],
    ["OCC_COMPUTE_DRIVER", "kubernetes"],
    ["OCC_KUBERNETES_CONFIG_PATH", "/tmp/obsolete.json"],
    ["OCC_NATIVE_IAM_DRIVER_ID", "native-iam"],
  ]) {
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: path, [name]: value },
      }),
      new RegExp(name),
    );
  }

  const injected = installation();
  injected.drivers.compute.configuration.authentication.installation_id = "ins_untrusted";
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, injected) },
    }),
    /must not contain an Installation ID/,
  );
});

test("startup rejects plaintext secrets, caller-authored identities, and unsupported schema options", async (t) => {
  for (const [mutate, expected] of [
    [(value) => (value.drivers.compute.configuration.apiKey = "plaintext"), /plaintext credential/],
    [
      (value) => (value.drivers.configuration.implementation = "occ/docker-config"),
      /unsupported option.*implementation/,
    ],
    [
      (value) =>
        (value.drivers.configuration.configuration.authentication = { mode: "kubeconfig" }),
      /schema|authentication/,
    ],
    [(value) => (value.drivers.iam.configuration.unexpected = true), /schema|unsupported option/],
    [
      (value) => (value.drivers.compute.configuration.resources.gateway.unexpected = true),
      /schema|unsupported option/,
    ],
    [
      (value) => (value.drivers.compute.configuration.images.requireImmutableDigest = false),
      /immutable image digests/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.network.gatewayPort = Number.MAX_SAFE_INTEGER + 1),
      /schema|integer|port/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.images.gateway = "registry.example/gateway:latest"),
      /immutable SHA-256 digest/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.images.agent = "registry.example/agent:latest"),
      /immutable SHA-256 digest/,
    ],
    [
      (value) => delete value.drivers.compute.configuration.runtime,
      /explicitly configured Codex runtime/,
    ],
    [
      (value) =>
        (value.drivers.compute.configuration.runtime.modelSecretPrefix =
          value.drivers.compute.configuration.runtime.transportSecretPrefix),
      /credentials must remain separate/,
    ],
  ]) {
    const configuration = installation();
    mutate(configuration);
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});
