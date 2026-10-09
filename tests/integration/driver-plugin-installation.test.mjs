import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { cookieHeaderFromSetCookie, createTestAuthPrincipal } from "../helpers/auth-session.mjs";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/driver-packages");
const provisionPath = "/tmp/local-test";
const computePackage = "@fixture/test-compute-driver";
const configurationPackage = "@fixture/test-configuration-driver";
const iamPackage = "@fixture/test-iam-driver";
function selectedConfiguration() {
  return {
    id: "configuration-installed-fixture",
    package: configurationPackage,
    configuration: { endpoint: "memory:driver-plugin-test" },
  };
}

function selectedIAM() {
  return {
    id: "iam-installed-fixture",
    package: iamPackage,
    configuration: {},
  };
}

function selectedCompute() {
  return {
    id: "compute-installed-fixture",
    package: computePackage,
    configuration: { provisionPath },
  };
}

async function installedPackages(t) {
  const directory = await mkdtemp(join(tmpdir(), "occ-installed-drivers-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const owner = join(directory, "owner");
  await writeFile(join(directory, "empty.npmrc"), "", "utf8");
  const xdgConfigHome = join(directory, "xdg-config");
  await mkdir(owner);
  await mkdir(xdgConfigHome);
  await writeFile(
    join(owner, "package.json"),
    `${JSON.stringify({ name: "isolated-controller-owner", version: "1.0.0", private: true })}\n`,
    "utf8",
  );

  const archives = [];
  for (const fixture of ["test-compute-driver", "test-configuration-driver", "test-iam-driver"]) {
    const staging = join(directory, `${fixture}-archive`);
    await mkdir(staging);
    await cp(join(fixtures, fixture), join(staging, "package"), { recursive: true });
    const archive = join(directory, `${fixture}.tgz`);
    const packed = spawnSync("tar", ["-czf", archive, "-C", staging, "package"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
    archives.push(archive);
  }

  // Both package lifecycle and dependency state stay inside this isolated owner, never the checkout.
  const packageManagerOptions = {
    cwd: owner,
    encoding: "utf8",
    env: {
      ...process.env,
      COREPACK_ENABLE_AUTO_PIN: "0",
      XDG_CONFIG_HOME: xdgConfigHome,
      npm_config_userconfig: join(directory, "empty.npmrc"),
      npm_config_globalconfig: join(directory, "empty.npmrc"),
    },
  };
  const dependencyOwnerOptions = ["--lockfile-dir", owner, "--store-dir", join(directory, "store")];
  const installed = spawnSync(
    "pnpm",
    [
      "add",
      "--offline",
      "--ignore-scripts",
      "--save-exact",
      ...dependencyOwnerOptions,
      ...archives,
    ],
    packageManagerOptions,
  );
  assert.equal(
    installed.status,
    0,
    installed.stderr || installed.stdout || installed.error?.message,
  );

  // Prove that the reviewed lockfile can independently recreate the production-only dependency tree.
  await rm(join(owner, "node_modules"), { recursive: true });
  const frozen = spawnSync(
    "pnpm",
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--prod",
      "--ignore-scripts",
      ...dependencyOwnerOptions,
    ],
    packageManagerOptions,
  );
  assert.equal(frozen.status, 0, frozen.stderr || frozen.stdout || frozen.error?.message);

  return owner;
}

async function load(owner, configuration, mode = "production") {
  const path = join(owner, `installation-${randomUUID()}.yaml`);
  // JSON is valid YAML and exercises the same parser and closed-schema validation as real startup.
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return loadInstallationConfiguration({
    mode,
    environment: { OCC_CONFIG_PATH: path },
    packageRoot: owner,
  });
}

async function authenticatedApplication(t, drivers) {
  const installationId = `ins_${randomUUID()}`;
  const authOrigin = "http://127.0.0.1";
  const authFixture = await createTestAuthPrincipal({
    installationId,
    mode: "production",
    baseURL: authOrigin,
    email: `driver-plugin-admin-${randomUUID()}@example.test`,
    password: `driver-plugin-password-${randomUUID()}`,
    name: "Driver Plugin Administrator",
  });
  const principal = authFixture.seed.principal;
  const role = {
    id: "role-production-plugin-operator",
    permissions: [
      { action: "administer", resourceKind: "installation" },
      { action: "create", resourceKind: "namespace" },
      { action: "read", resourceKind: "namespace" },
      { action: "delete", resourceKind: "namespace" },
      { action: "create", resourceKind: "configuration" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  const deleteRestriction = {
    id: "restriction-production-plugin-namespace-delete",
    action: "delete",
    resourceKind: "namespace",
    effect: "deny",
  };
  let policy = {
    identities: [principal],
    groups: [],
    memberships: [],
    roles: [role],
    bindings: [
      {
        id: "binding-production-plugin-operator",
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: role.id,
      },
    ],
    restrictions: [],
  };
  const auditSink = new InMemoryAuditSink();
  let iamLoadCount = 0;
  const iamDriver = drivers.createIAMDriver({
    async loadNativeIAMState() {
      iamLoadCount += 1;
      return policy;
    },
  });
  assert.equal(iamDriver.id, drivers.installation.drivers.iam.id);
  assert.equal(iamDriver.implementation, drivers.installation.drivers.iam.implementation);
  let controller;

  // Admission, IAM, Harness, and Fastify are production paths; persistence is explicitly in-memory.
  const app = createFastifyApp({
    createController(value) {
      controller = new OpenClawController(value, {
        state: new InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
      return controller;
    },
    iamDriver,
    computeDriver: drivers.computeDriver,
    configurationDriver: drivers.configurationDriver,
    resolveHarness: resolveApprovedProductionHarness,
    auditSink,
    development: {
      enabled: false,
      installationId,
    },
    auth: authFixture.auth,
  });
  t.after(async () => app.close());

  const signedIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: { email: authFixture.email, password: authFixture.password },
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  const setCookie = signedIn.headers["set-cookie"];
  const cookie = cookieHeaderFromSetCookie(
    Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie],
  );
  assert.match(cookie, /(?:^|; )openclaw_occ\.session_token=/);

  return {
    app,
    config: { installationId, principalId: principal.id, cookie, authOrigin },
    auditSink,
    iamDriver,
    restrictNamespaceDelete() {
      policy = { ...policy, restrictions: [deleteRestriction] };
    },
    get controller() {
      return controller;
    },
    get iamLoadCount() {
      return iamLoadCount;
    },
  };
}

async function request(fixture, method, url, payload) {
  const response = await fixture.app.inject({
    method,
    url,
    headers: {
      cookie: fixture.config.cookie,
      origin: fixture.config.authOrigin,
      host: "127.0.0.1",
    },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: response.statusCode, ...response.json() };
}

test("reviewed scoped Driver packages install, activate, and fail closed", async (t) => {
  const owner = await installedPackages(t);

  await t.test(
    "installed Compute, Configuration, and IAM Drivers operate through production admission",
    async (scenario) => {
      let ownedArtifact = false;
      try {
        await stat(provisionPath);
        assert.fail(`Refusing to overwrite existing ${provisionPath}.`);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      scenario.after(async () => {
        if (ownedArtifact) {
          await rm(provisionPath, { force: true });
        }
      });

      const configuration = installation();
      configuration.drivers.configuration = selectedConfiguration();
      configuration.drivers.compute = selectedCompute();
      configuration.drivers.iam = selectedIAM();
      const drivers = await load(owner, configuration, "production");
      const cancellation = new AbortController();
      assert.equal(drivers.computeDriver.currentOperationAbortSignal(), undefined);
      await withComputeAbortSignal(cancellation.signal, async () => {
        assert.equal(drivers.computeDriver.currentOperationAbortSignal(), cancellation.signal);
      });
      const fixture = await authenticatedApplication(scenario, drivers);

      // Require an actual Better Auth session before creating the singleton Installation.
      for (const headers of [{}, { authorization: "Bearer invalid-production-token" }]) {
        const unauthenticated = await fixture.app.inject({
          method: "POST",
          url: "/installation/bootstrap",
          headers: {
            host: "127.0.0.1",
            ...headers,
          },
          payload: { name: "Unauthenticated Driver selection" },
        });
        assert.equal(unauthenticated.statusCode, 401);
      }
      const publicSignup = await fixture.app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload: {
          email: "public-driver-plugin@example.test",
          password: "public-driver-plugin-password",
          name: "Public",
        },
      });
      assert.equal(publicSignup.statusCode, 404);
      const bootstrap = await request(fixture, "POST", "/installation/bootstrap", {
        name: "Installed Driver integration",
      });
      assert.equal(bootstrap.status, 201, JSON.stringify(bootstrap));
      const namespace = await request(fixture, "POST", "/namespaces", {
        name: `installed-compute-${randomUUID()}`,
      });
      assert.equal(namespace.status, 201, JSON.stringify(namespace));
      assert.equal(namespace.data.status, "provisioning");

      // Real OCC reconciliation, not a direct fixture call, selects the installed Compute Driver.
      const ready = await fixture.controller.handleNamespaceLifecycle(
        fixture.config.principalId,
        namespace.data.id,
        "ready",
      );
      ownedArtifact = true;
      assert.equal(ready.status, "ready");
      const evidence = JSON.parse(await readFile(provisionPath, "utf8"));
      assert.deepEqual(evidence, {
        namespaceId: namespace.data.id,
        driverId: "compute-installed-fixture",
        implementation: `${computePackage}@1.0.0`,
      });
      scenario.diagnostic(`${provisionPath}: ${JSON.stringify(evidence)}`);

      // The separately installed Configuration Driver must service an actual scoped Fastify route.
      const created = await request(
        fixture,
        "POST",
        `/namespaces/${namespace.data.id}/configurations`,
        { kind: "agent", values: { model: "external-driver-proof" } },
      );
      assert.equal(created.status, 201, JSON.stringify(created));
      const observed = await request(
        fixture,
        "GET",
        `/namespaces/${namespace.data.id}/configurations/${created.data.id}`,
      );
      assert.equal(observed.status, 200, JSON.stringify(observed));
      assert.deepEqual(observed.data.values, { model: "external-driver-proof" });

      const loadsBeforeRestriction = fixture.iamLoadCount;
      fixture.restrictNamespaceDelete();
      // A valid session cannot bypass a policy change made after the installed IAM Driver exists.
      const forbidden = await request(fixture, "DELETE", `/namespaces/${namespace.data.id}`);
      assert.equal(forbidden.status, 403, JSON.stringify(forbidden));
      assert.ok(fixture.iamLoadCount > loadsBeforeRestriction);
      const denied = fixture.auditSink.events.find(
        (event) => event.kind === "authorization_denial" && event.resource.id === namespace.data.id,
      );
      assert.equal(denied.iamDriverId, "iam-installed-fixture");
      assert.equal(denied.authorization.action, "delete");
      assert.deepEqual(denied.details.iamEvidence.bindingIds, [
        "binding-production-plugin-operator",
      ]);
      assert.deepEqual(denied.details.iamEvidence.restrictionIds, [
        "restriction-production-plugin-namespace-delete",
      ]);
      const granted = fixture.auditSink.events.find(
        (event) => event.kind === "bootstrap" && event.iamDriverId === "iam-installed-fixture",
      );
      assert.deepEqual(granted.details.iamEvidence.bindingIds, [
        "binding-production-plugin-operator",
      ]);

      // Constructor acceptance proves selected production wiring only; no PostgreSQL query or worker loop runs.
      const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
      scenario.after(async () => pool.end());
      assert.doesNotThrow(() => createControllerWorker({ pool, mode: "production", drivers }));
    },
  );

  await t.test(
    "production rejects an installed Compute package missing revision stages",
    async () => {
      const configuration = installation();
      configuration.drivers.compute = selectedCompute();
      configuration.drivers.compute.configuration.revisionStages = false;

      await assert.rejects(load(owner, configuration, "production"), /activat|stage/i);

      // Development can still use a real four-method package without promising production staging.
      const development = await load(owner, configuration, "development");
      assert.equal(typeof development.computeDriver.activateRevision, "undefined");
      assert.equal(typeof development.computeDriver.deactivateRevision, "undefined");
    },
  );

  await t.test("mutable direct dependency ranges and registry tags fail closed", async () => {
    const manifestPath = join(owner, "package.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const configuration = installation();
    configuration.drivers.configuration = selectedConfiguration();

    try {
      for (const mutable of ["^1.0.0", "latest", "file:../not-a-tarball.js"]) {
        const manifest = JSON.parse(originalManifest);
        manifest.dependencies[configurationPackage] = mutable;
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

        await assert.rejects(
          load(owner, configuration),
          /exact|pin|version|tarball|dependenc/i,
          `Mutable dependency declaration ${mutable} must be rejected.`,
        );
      }
    } finally {
      await writeFile(manifestPath, originalManifest, "utf8");
    }
  });

  await t.test(
    "unsupported selections and unavailable packages fail without fallback",
    async () => {
      for (const [description, mutate, mode, pattern] of [
        [
          "missing dependency",
          (value) => {
            value.drivers.configuration = selectedConfiguration();
            value.drivers.configuration.package = "@fixture/missing-driver";
          },
          "development",
          /package|dependenc|available|installed/i,
        ],
        [
          "caller-authored implementation identity",
          (value) => {
            value.drivers.configuration = selectedConfiguration();
            value.drivers.configuration.implementation = "operator/forged";
          },
          "production",
          /unsupported option.*implementation/i,
        ],
        [
          "caller-authored package version",
          (value) => {
            value.drivers.configuration = selectedConfiguration();
            value.drivers.configuration.version = "9.9.9";
          },
          "production",
          /unsupported option.*version/i,
        ],
        [
          "invalid external configuration",
          (value) => {
            value.drivers.configuration = selectedConfiguration();
            value.drivers.configuration.configuration.endpoint = 42;
          },
          "development",
          /configuration|endpoint|string/i,
        ],
        [
          "IAM capability mismatch",
          (value) => {
            value.drivers.iam = selectedIAM();
            value.drivers.iam.package = configurationPackage;
          },
          "production",
          /iam|capability|package|version|configuration/i,
        ],
      ]) {
        const configuration = installation();
        mutate(configuration);
        await assert.rejects(load(owner, configuration, mode), pattern, description);
      }
    },
  );
});

// Exact on-disk production dependencies isolate export resolution from registry installation.
// Node's own ESM import is the independent oracle; the OCC path stays the real startup loader.
test("compiled Driver export arrays activate through production startup and Configuration HTTP", async (t) => {
  for (const [description, exports] of [
    ["root array", ["./compiled/index.js"]],
    ["root subpath array", { ".": ["./compiled/index.js"] }],
    ["invalid target before URL decoding", ["./node_modules/%ZZ.js", "./compiled/index.js"]],
    ["import array", { import: ["./compiled/index.js"], require: "./compiled/index.cjs" }],
    [
      "target fallbacks",
      {
        ".": [
          null,
          "../invalid.js",
          { browser: "./browser.js" },
          { import: ["./compiled/index.js"] },
        ],
      },
    ],
    [
      "nested conditions",
      {
        node: [{ require: "./compiled/index.cjs" }, { import: ["./compiled/index.js"] }],
        default: "./compiled/index.cjs",
      },
    ],
    ["condition order", { default: ["./compiled/index.js"], import: ["./compiled/index.cjs"] }],
  ]) {
    await t.test(description, async (scenario) => {
      const owner = await onDiskConfigurationPackage(scenario, exports);
      const native = importConfigurationPackage(owner);
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout.trim(), "function");
      const configuration = installation();
      configuration.drivers.configuration = selectedConfiguration();
      const drivers = await load(owner, configuration);
      const fixture = await authenticatedApplication(scenario, drivers);
      const bootstrap = await request(fixture, "POST", "/installation/bootstrap", {
        name: "Array exports",
      });
      assert.equal(bootstrap.status, 201, JSON.stringify(bootstrap));
      const namespace = await request(fixture, "POST", "/namespaces", {
        name: "Array Configuration",
      });
      assert.equal(namespace.status, 201, JSON.stringify(namespace));
      const created = await request(
        fixture,
        "POST",
        `/namespaces/${namespace.data.id}/configurations`,
        {
          kind: "agent",
          values: { agents: { defaults: { model: "openai/example-model" } } },
        },
      );
      assert.equal(created.status, 201, JSON.stringify(created));
      const read = await request(
        fixture,
        "GET",
        `/namespaces/${namespace.data.id}/configurations/${created.data.id}`,
      );
      assert.equal(read.status, 200, JSON.stringify(read));
      assert.deepEqual(read.data, created.data);
    });
  }
  for (const [description, exports] of [
    ["empty array", []],
    ["no import condition", [{ require: "./compiled/index.cjs" }]],
    ["invalid targets only", ["../invalid.js", 42]],
    ["selected missing file", ["./compiled/missing.js", "./compiled/index.js"]],
    ["selected malformed encoding", ["./compiled/%ZZ.js", "./compiled/index.js"]],
    ["selected CJS", ["./compiled/index.cjs", "./compiled/index.js"]],
    ["matched null condition", { import: null, default: ["./compiled/index.js"] }],
  ]) {
    await t.test(description, async (scenario) => {
      const owner = await onDiskConfigurationPackage(scenario, exports);
      const native = importConfigurationPackage(owner);
      if (description !== "selected CJS") {
        assert.notEqual(native.status, 0, native.stdout);
      }
      const configuration = installation();
      configuration.drivers.configuration = selectedConfiguration();
      await assert.rejects(
        load(owner, configuration),
        /package.*(?:available|compiled|JavaScript|encoding)/,
      );
    });
  }
});

async function onDiskConfigurationPackage(t, exports) {
  const owner = await mkdtemp(join(tmpdir(), "occ-driver-export-array-"));
  t.after(() => rm(owner, { recursive: true, force: true }));
  const installed = join(owner, "node_modules", configurationPackage);
  await mkdir(dirname(installed), { recursive: true });
  await cp(join(fixtures, "test-configuration-driver"), installed, { recursive: true });
  await cp(join(installed, "compiled", "index.js"), join(installed, "compiled", "driver entry.js"));
  const manifestPath = join(installed, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, exports }));
  await writeFile(
    join(owner, "package.json"),
    JSON.stringify({
      name: "driver-export-array-owner",
      version: "1.0.0",
      private: true,
      dependencies: { [configurationPackage]: manifest.version },
    }),
  );
  return owner;
}

function importConfigurationPackage(owner) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `console.log(typeof (await import(${JSON.stringify(configurationPackage)})).createDriver)`,
    ],
    {
      cwd: owner,
      encoding: "utf8",
    },
  );
}

// Node's ESM resolver is the oracle: "." selects a subpath only at the top level, and the
// selected target must name an existing file exactly (no extension, directory or main lookup).
test("Driver export resolution selects the file Node's import selects", async (t) => {
  for (const [description, exports] of [
    [
      "nested dot key is a condition name",
      [{ ".": "./compiled/index.cjs" }, "./compiled/index.js"],
    ],
    [
      "nested dot key under a condition",
      { import: { ".": "./compiled/missing.js" }, default: "./compiled/index.js" },
    ],
    [
      "module-sync condition",
      { "module-sync": "./compiled/index.js", import: "./compiled/missing.js" },
    ],
    ["percent-decoded target", "./compiled/driver%20entry.js"],
    ["query and fragment", ["./compiled/index.js?x=1#y"]],
  ]) {
    await t.test(description, async (scenario) => {
      const owner = await onDiskConfigurationPackage(scenario, exports);
      const native = importConfigurationPackage(owner);
      assert.equal(native.status, 0, native.stderr);
      const configuration = installation();
      configuration.drivers.configuration = selectedConfiguration();
      const drivers = await load(owner, configuration);
      assert.equal(
        drivers.installation.drivers.configuration.implementation,
        `${configurationPackage}@1.0.0`,
      );
      assert.equal(drivers.configurationDriver.implementation, `${configurationPackage}@1.0.0`);
    });
  }
  for (const [description, exports, message] of [
    [
      "directory target",
      ["./compiled", "./compiled/index.js"],
      /package export target must be a file, not a directory/,
    ],
    [
      "trailing-slash directory",
      "./compiled/",
      /package export target must be a file, not a directory/,
    ],
    [
      "extensionless target",
      ["./compiled/index", "./compiled/index.js"],
      /package selects an unavailable compiled ESM entry/,
    ],
    [
      "encoded separator",
      "./compiled%2findex.js",
      /package export target must not encode a path separator/,
    ],
    [
      "mixed subpath and condition keys",
      { ".": "./compiled/index.js", import: "./compiled/index.js" },
      /package exports must not mix subpath and condition keys/,
    ],
    [
      "numeric condition key",
      [{ 0: "./compiled/index.cjs", import: "./compiled/index.js" }, "./compiled/index.js"],
      /package exports must not contain numeric condition keys/,
    ],
    [
      "malformed encoding",
      ["./compiled/%ZZ.js", "./compiled/index.js"],
      /^drivers\.configuration\.package export target has malformed percent encoding\.$/,
    ],
  ]) {
    await t.test(description, async (scenario) => {
      const owner = await onDiskConfigurationPackage(scenario, exports);
      const native = importConfigurationPackage(owner);
      assert.notEqual(native.status, 0, native.stdout);
      const configuration = installation();
      configuration.drivers.configuration = selectedConfiguration();
      await assert.rejects(load(owner, configuration), (error) => {
        assert.match(error.message, message);
        return true;
      });
    });
  }
});
