import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import { prepareNativeProfileUpgradeDatabase } from "../../scripts/ci/prepare.ts";
import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import {
  nativeProfileBaseline,
  nativeProfileSourceReceipt,
  nativeProfileUpgradeFile,
  selectsNativeProfileUpgrade,
} from "../../scripts/ci/native-profile-upgrade.ts";
import { initializeNativeUpgradeInstallation } from "../helpers/native-profile-upgrade-installation.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { composePostgres, fixture, immutableImage } from "../helpers/ci-prepare-fixture.ts";
import { startFakePostgres } from "../helpers/fake-postgres-server.ts";
import { registerLegacyBrowserPairingCases } from "./native-profile-legacy-grant-cases.ts";

type Inputs = {
  repositoryRoot: string;
  writeState: (path: string, state: unknown) => Promise<void>;
};

type CommandEvidence = {
  args: string[];
  migrator: boolean;
  modelForwarded: boolean;
  legacyOutputSettings: boolean;
  credentialInputSettings: boolean;
  bootstrapConfigurationChecked: boolean;
};

function commandEvidence(text: string): CommandEvidence[] {
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      const record = asRecord(value);
      const args = record?.args;
      const migrator = record?.migrator;
      const modelForwarded = record?.modelForwarded;
      const legacyOutputSettings = record?.legacyOutputSettings;
      const credentialInputSettings = record?.credentialInputSettings;
      const bootstrapConfigurationChecked = record?.bootstrapConfigurationChecked;
      assert.ok(Array.isArray(args) && args.every((arg: unknown) => typeof arg === "string"));
      assert.ok(typeof migrator === "boolean" && typeof modelForwarded === "boolean");
      assert.ok(
        typeof legacyOutputSettings === "boolean" &&
          typeof credentialInputSettings === "boolean" &&
          typeof bootstrapConfigurationChecked === "boolean",
      );
      return {
        args,
        migrator,
        modelForwarded,
        legacyOutputSettings,
        credentialInputSettings,
        bootstrapConfigurationChecked,
      };
    });
}

export function registerNativeProfileUpgradeCases({ repositoryRoot, writeState }: Inputs) {
  registerLegacyBrowserPairingCases();
  test("native upgrade initialization uses image entrypoints and isolates the migration credential", async (t) => {
    const root = await fixture(t);
    const command = join(root, "engine");
    const log = join(root, "commands.jsonl");
    await writeFile(
      command,
      String.raw`#!${process.execPath}
const assert = require("node:assert/strict");
const { appendFileSync, readFileSync, statSync } = require("node:fs");
const { basename, join } = require("node:path");
const args = process.argv.slice(2);
const migration = args.includes("-e");
const legacyOutputSettings = args.includes("OCC_BOOTSTRAP_PASSWORD_FILE") || args.includes("OCC_BOOTSTRAP_SERVICE_KEY_FILE");
const inputNames = ["OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE", "OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE"];
const credentialInputSettings = inputNames.some((key) => args.includes(key));
const bootstrapConfigurationChecked = args.includes("scripts/bootstrap-installation.mjs");
if (bootstrapConfigurationChecked) {
  // Execute the current production parser, not a copied validation rule.
  const { bootstrapConfiguration } = require(${JSON.stringify(fileURLToPath(new URL("../../scripts/lib/bootstrap-configuration.ts", import.meta.url)))});
  bootstrapConfiguration("production", process.env);
}
if (credentialInputSettings) {
  const mount = args[args.indexOf("--mount") + 1];
  const directory = mount.match(/^type=bind,src=([^,]+),dst=\/bootstrap,readonly$/)?.[1];
  assert.ok(directory);
  for (const key of inputNames) {
    assert.ok(args.includes(key));
    const path = process.env[key];
    assert.match(path, /^\/bootstrap\/[^/]+$/);
    const file = join(directory, basename(path));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, "utf8").trim().length >= 32);
  }
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, migrator: args.includes("OCC_MIGRATION_DATABASE_URL"), modelForwarded: args.includes("OPENAI_API_KEY"), legacyOutputSettings, credentialInputSettings, bootstrapConfigurationChecked}) + "\n");
if (args[0] === "run") {
  process.stdout.write(JSON.stringify(migration ? {
    event: args.includes("--require-current") ? "migration.checked" : "migration.completed",
    history: args.includes("--expect-empty") ? "empty" : "completed"
  } : { event: args.includes("--verify-existing") ? "installation.bootstrap-verified" : "installation.bootstrapped" }));
}
`,
      { mode: 0o700 },
    );
    const previous = process.env.OCC_DOCKER_BIN;
    process.env.OCC_DOCKER_BIN = command;
    t.after(() => {
      if (previous === undefined) {
        delete process.env.OCC_DOCKER_BIN;
      } else {
        process.env.OCC_DOCKER_BIN = previous;
      }
    });
    const options = {
      image: "sha256:" + "c".repeat(64),
      databaseUrl: syntheticCredentialUrl({
        protocol: "postgresql",
        username: "occ_app",
        password: "synthetic",
        host: "127.0.0.1",
        pathname: "/openclaw_k8s_owned",
      }),
      migrationUrl: syntheticCredentialUrl({
        protocol: "postgresql",
        username: "occ_migrator",
        password: "synthetic",
        host: "127.0.0.1",
        pathname: "/openclaw_k8s_owned",
      }),
      email: "upgrade@example.test",
      authSecret: "synthetic-auth-secret-minimum-32-bytes",
      authBaseURL: "https://console.example.test",
      agentDomain: "agents.example.test",
      installationName: "Upgrade fixture",
    };
    // This command fixture proves orchestration only, never database/image execution.
    const initialized = await initializeNativeUpgradeInstallation(t, options);
    assert.ok(initialized.credentials);
    assert.equal(initialized.credentials.email, options.email);
    await initializeNativeUpgradeInstallation(t, {
      ...options,
      expectedInstallationId: "ins_" + randomUUID(),
    });
    const records = commandEvidence(await readFile(log, "utf8"));
    const runs = records.filter(({ args }) => args[0] === "run");
    assert.equal(runs.length, 6);
    assert.deepEqual(
      runs.map(({ migrator }) => migrator),
      [true, true, false, true, true, false],
    );
    assert.ok(runs.every(({ legacyOutputSettings }) => !legacyOutputSettings));
    assert.deepEqual(
      runs.map(({ credentialInputSettings }) => credentialInputSettings),
      [false, false, true, false, false, false],
      "only the fresh baseline bootstrap receives credential input files",
    );
    assert.deepEqual(
      runs.map(({ args }) => args.includes("--mount")),
      [false, false, true, false, false, false],
    );
    assert.deepEqual(
      runs.map(({ bootstrapConfigurationChecked }) => bootstrapConfigurationChecked),
      [false, false, true, false, false, true],
      "both bootstrap invocations must pass the current production configuration parser",
    );
    const initialMigration = runs[0];
    const catalogCheck = runs[1];
    const candidateMigration = runs[3];
    const candidateCatalogCheck = runs[4];
    const incumbentVerification = runs[5];
    assert.ok(
      initialMigration &&
        catalogCheck &&
        candidateMigration &&
        candidateCatalogCheck &&
        incumbentVerification,
    );
    for (const migration of [
      initialMigration,
      catalogCheck,
      candidateMigration,
      candidateCatalogCheck,
    ]) {
      const entryIndex = migration.args.indexOf("-e");
      assert.ok(entryIndex > 0);
      assert.deepEqual(
        migration.args.slice(entryIndex, entryIndex + selectedImageMigrationEntry.length),
        selectedImageMigrationEntry,
      );
    }
    assert.ok(initialMigration.args.includes("--expect-empty"));
    assert.ok(catalogCheck.args.includes("--require-current"));
    assert.ok(incumbentVerification.args.includes("--verify-existing"));
    assert.ok(runs.every(({ args, modelForwarded }) => !modelForwarded && args.at(-2) !== "node"));
    assert.equal(records.filter(({ args }) => args[0] === "rm").length, 6);
    assert.doesNotMatch(JSON.stringify(records), /postgresql:|synthetic-auth-secret/);
    assert.ok(!JSON.stringify(records).includes(initialized.credentials.password));
  });

  test("native upgrade allocates separate schema-only databases without a current migration template", async (t) => {
    const root = await fixture(t);
    const statePath = join(root, "empty-upgrades.json");
    const postgres = await startFakePostgres();
    t.after(() => postgres.close());
    const server = composePostgres("native-upgrade", postgres.port);
    const image = (role: string, digit: string) =>
      "registry.example/" + role + "@sha256:" + digit.repeat(64);
    const images = {
      OCC_TEST_NATIVE_BASELINE_CONTROLLER_IMAGE: image("old-controller", "1"),
      OCC_TEST_NATIVE_BASELINE_RUNTIME_IMAGE: image("old-runtime", "2"),
      OCC_TEST_PRODUCTION_CONTROLLER_IMAGE: image("candidate-controller", "3"),
    };
    const state = {
      version: 1,
      repositoryRoot,
      lane: "gateway-routing",
      prefix: server.owner,
      env: { ...images, OCC_TEST_NATIVE_BASELINE_SOURCE: JSON.stringify(nativeProfileBaseline) },
      resources: [
        server,
        ...Object.values(images).map((reference, index) => ({
          id: "image-" + index,
          kind: "k3d-image",
          status: "ready",
          owner: server.owner,
          reference,
          hostImageId: "sha256:" + String(index + 1).repeat(64),
        })),
      ],
    };
    await writeState(statePath, state);
    const previous = process.env.OPENCLAW_CI_COREPACK_BIN;
    process.env.OPENCLAW_CI_COREPACK_BIN = join(root, "must-not-run-current-migrator");
    const allocated: Awaited<ReturnType<typeof prepareNativeProfileUpgradeDatabase>>[] = [];
    try {
      // The protocol fixture records orchestration only. The real old/candidate
      // migrations and catalog checks are mandatory in the hosted upgrade case.
      for (let index = 0; index < 2; index += 1) {
        allocated.push(await prepareNativeProfileUpgradeDatabase(statePath));
      }
      const first = allocated[0];
      const second = allocated[1];
      assert.ok(first && second);
      assert.notEqual(
        first.databaseUrl,
        second.databaseUrl,
        "the wrapper and direct QA stage must never share an initialized database",
      );
      assert.ok(
        allocated.every(
          ({ databaseUrl, migrationUrl }) =>
            new URL(databaseUrl).username === "occ_app" &&
            new URL(migrationUrl).username === "occ_migrator",
        ),
      );
      const creates = postgres.queries().filter((line) => line.includes("CREATE DATABASE"));
      assert.equal(creates.length, 2, "no candidate lane template may be created");
      assert.ok(
        creates.every((line) => !line.includes("TEMPLATE")),
        "baseline databases must begin with empty schemas, not a current SQL catalog",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_CI_COREPACK_BIN;
      } else {
        process.env.OPENCLAW_CI_COREPACK_BIN = previous;
      }
      for (const prepared of allocated) {
        await prepared.cleanup();
      }
    }
  });

  test("native upgrade selection requires the fixed pair without contaminating a fresh-install file", async (t) => {
    assert.equal(selectsNativeProfileUpgrade("gateway-routing", undefined), true);
    assert.equal(selectsNativeProfileUpgrade("gateway-routing", nativeProfileUpgradeFile), true);
    assert.equal(
      selectsNativeProfileUpgrade(
        "gateway-routing",
        "tests/integration/oidc-agent-chat-k3d-real.test.ts",
      ),
      false,
    );
    assert.equal(selectsNativeProfileUpgrade("qa-matrix", nativeProfileUpgradeFile), false);
    // A private journal may contain other fields; the exported receipt must not.
    assert.deepEqual(
      nativeProfileSourceReceipt({ ...nativeProfileBaseline, privateOutput: "withheld" }),
      nativeProfileBaseline,
    );
    for (const field of [
      "revision",
      "tree",
      "nativeCommit",
      "sourceArchiveSha256",
      "runtimeTree",
      "migrations",
      "controllerRecipe",
    ]) {
      assert.throws(
        () => nativeProfileSourceReceipt({ ...nativeProfileBaseline, [field]: "a".repeat(64) }),
        /does not match the fixed pre-feature source/,
      );
    }
    const root = await fixture(t);
    const statePath = join(root, "upgrade.json");
    const validSelection = {
      version: 1,
      repositoryRoot,
      prefix: "openclaw-ci-upgrade-custody",
      resources: [],
      lane: "gateway-routing",
      env: {
        OCC_TEST_NATIVE_BASELINE_SOURCE: JSON.stringify(nativeProfileBaseline),
        OCC_TEST_NATIVE_BASELINE_CONTROLLER_IMAGE: immutableImage,
        OCC_TEST_NATIVE_BASELINE_RUNTIME_IMAGE: immutableImage,
      },
    };
    // No server exists in these states. An unintended attempt to allocate from a
    // foreign/current installation fails differently; each refusal must precede it.
    for (const state of [
      { ...validSelection, lane: "qa-matrix" },
      { ...validSelection, selectedFile: "tests/integration/oidc-agent-chat-k3d-real.test.ts" },
      {
        ...validSelection,
        env: {
          ...validSelection.env,
          OCC_TEST_NATIVE_BASELINE_SOURCE: JSON.stringify({ revision: "a".repeat(40) }),
        },
      },
      {
        ...validSelection,
        env: { ...validSelection.env, OCC_TEST_NATIVE_BASELINE_RUNTIME_IMAGE: "" },
      },
    ]) {
      await writeState(statePath, state);
      await assert.rejects(
        prepareNativeProfileUpgradeDatabase(statePath),
        /requires its full or focused prepared Gateway Routing state and fixed baseline pair/,
      );
      assert.deepEqual(
        JSON.parse(await readFile(statePath, "utf8")),
        state,
        "a refused upgrade must not create resources or mutate the other file's journal",
      );
    }
  });
}
