import assert from "node:assert/strict";
import test from "node:test";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

type BarrierFixtureSelection = {
  enabled: boolean;
  ciFixtureRequested: boolean;
  appUrl: string | undefined;
  migrationUrl: string | undefined;
  fixtureDatabase: string | undefined;
};

export function readBarrierFixtureSelection(): BarrierFixtureSelection {
  const ciFixtureRequested = [
    process.env.OCC_TEST_NATIVE_IAM_BARRIER_CI,
    process.env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE,
    process.env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL,
  ].some((value) => value !== undefined);
  return {
    enabled: process.env.OCC_NATIVE_IAM_BARRIER_TEST === "1" || ciFixtureRequested,
    ciFixtureRequested,
    appUrl: process.env.OCC_TEST_DATABASE_URL,
    migrationUrl: ciFixtureRequested
      ? process.env.OCC_TEST_NATIVE_IAM_BARRIER_MIGRATION_DATABASE_URL
      : process.env.OCC_MIGRATION_DATABASE_URL,
    fixtureDatabase: ciFixtureRequested
      ? process.env.OCC_TEST_NATIVE_IAM_BARRIER_DATABASE
      : "openclaw_enterprise",
  };
}

function requireExplicitCISelection(requested: boolean, flag: string | undefined): void {
  if (requested && flag !== "1") {
    throw new Error("An owned PostgreSQL fixture requires explicit CI selection.");
  }
}

function requireRawFixtureUrl(value: unknown, database: string): asserts value is string {
  if (
    typeof value !== "string" ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("An owned PostgreSQL fixture has an unsupported connection target.");
  }
  const schemeEnd = value.indexOf("://");
  const pathStart = schemeEnd < 0 ? -1 : value.indexOf("/", schemeEnd + 3);
  if (pathStart < 0 || value.slice(pathStart) !== `/${database}`) {
    throw new Error("An owned PostgreSQL fixture has an unsupported connection target.");
  }
}

function validateFixtureUrls(
  application: unknown,
  migration: unknown,
  database: unknown,
  mode: unknown,
) {
  if (
    typeof database !== "string" ||
    (mode === "standalone" && database !== "openclaw_enterprise") ||
    (mode === "ci" &&
      !/^openclaw_ci_postgres_native_iam_policy_barrier_[a-f0-9]{12}$/.test(database)) ||
    (mode !== "standalone" && mode !== "ci")
  ) {
    throw new Error("An owned PostgreSQL fixture has an unsupported database.");
  }
  requireRawFixtureUrl(application, database);
  requireRawFixtureUrl(migration, database);

  let app: URL;
  let migrator: URL;
  try {
    app = new URL(application);
    migrator = new URL(migration);
  } catch {
    throw new Error("An owned PostgreSQL fixture requires valid connection URLs.");
  }
  for (const [url, role] of [
    [app, "occ_app"],
    [migrator, "occ_migrator"],
  ] as const) {
    if (
      url.protocol !== "postgresql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.pathname !== `/${database}` ||
      url.username !== role ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("An owned PostgreSQL fixture has an unsupported connection target.");
    }
  }
  if (app.host !== migrator.host) {
    throw new Error("The app and migrator must use the same owned PostgreSQL fixture.");
  }
  return { appUrl: application, migrationUrl: migration, fixtureDatabase: database };
}

export function requireBarrierFixtureTarget(selection: BarrierFixtureSelection) {
  const { appUrl, migrationUrl, fixtureDatabase, ciFixtureRequested } = selection;
  requireExplicitCISelection(ciFixtureRequested, process.env.OCC_TEST_NATIVE_IAM_BARRIER_CI);
  assert.ok(appUrl && migrationUrl, "an explicitly owned app and migrator fixture is required");
  return {
    ...validateFixtureUrls(
      appUrl,
      migrationUrl,
      fixtureDatabase,
      ciFixtureRequested ? "ci" : "standalone",
    ),
    ciFixtureRequested,
  };
}

export function tupleTransactionId(xid8: string): string {
  return (BigInt(xid8) & 0xffff_ffffn).toString();
}

export function registerBarrierAdmissionCases(): void {
  test("xid8 comparison preserves the tuple transaction ID across epochs", () => {
    const epochOneXid8 = "4294967338";
    const tupleXmin = "42";
    assert.equal(tupleTransactionId("42"), "42");
    assert.equal(tupleTransactionId(epochOneXid8), tupleXmin);
    assert.equal(tupleTransactionId("8589934591"), "4294967295");
    assert.throws(() => tupleTransactionId("not-an-xid"), SyntaxError);
  });

  test("native IAM barrier fixture rejects unsafe connection targets before connecting", () => {
    const connection = {
      protocol: "postgresql",
      password: "synthetic",
      host: "127.0.0.1",
      port: 5432,
      pathname: "/openclaw_enterprise",
    };
    const app = syntheticCredentialUrl({ ...connection, username: "occ_app" });
    const migrator = syntheticCredentialUrl({ ...connection, username: "occ_migrator" });
    const ciDatabase = "openclaw_ci_postgres_native_iam_policy_barrier_0123456789ab";
    const ciApp = app.replace("openclaw_enterprise", ciDatabase);
    const ciMigrator = migrator.replace("openclaw_enterprise", ciDatabase);
    assert.doesNotThrow(() => requireExplicitCISelection(false, undefined));
    assert.doesNotThrow(() => requireExplicitCISelection(true, "1"));
    assert.throws(
      () => requireExplicitCISelection(true, undefined),
      /requires explicit CI selection/,
    );
    assert.throws(() => requireExplicitCISelection(true, "0"), /requires explicit CI selection/);
    assert.doesNotThrow(() =>
      validateFixtureUrls(app, migrator, "openclaw_enterprise", "standalone"),
    );
    assert.doesNotThrow(() => validateFixtureUrls(ciApp, ciMigrator, ciDatabase, "ci"));
    for (const invalid of [
      app.replace("occ_app", "%6fcc_app"),
      `${app}?`,
      `${app}#`,
      app.replace("127.0.0.1", "localhost"),
      app.replace(":5432", ":5433"),
    ]) {
      assert.throws(
        () => validateFixtureUrls(invalid, migrator, "openclaw_enterprise", "standalone"),
        /owned PostgreSQL fixture|same owned PostgreSQL fixture/,
      );
    }
    for (const [application, migration, database, mode] of [
      [ciApp, undefined, ciDatabase, "ci"],
      [ciApp, ciMigrator, undefined, "ci"],
      [ciApp, ciMigrator, "openclaw_enterprise", "ci"],
      [ciApp, ciMigrator, ciDatabase.replace("0123456789ab", "INVALID"), "ci"],
      [ciApp, ciMigrator.replace(ciDatabase, `${ciDatabase}x`), ciDatabase, "ci"],
      [ciApp, ciMigrator.replace("occ_migrator", "%6fcc_migrator"), ciDatabase, "ci"],
      [ciApp, ciMigrator.replace(":5432", ":5433"), ciDatabase, "ci"],
      [ciApp.replace(ciDatabase, "%6f" + ciDatabase.slice(1)), ciMigrator, ciDatabase, "ci"],
      [ciApp, ciMigrator, ciDatabase, "standalone"],
      [ciApp, ciMigrator, ciDatabase, "unknown"],
    ] as const) {
      assert.throws(
        () => validateFixtureUrls(application, migration, database, mode),
        /owned PostgreSQL fixture|same owned PostgreSQL fixture/,
      );
    }
    for (const [application, migration, database, mode] of [
      [app, migrator, "openclaw_enterprise", "standalone"],
      [ciApp, ciMigrator, ciDatabase, "ci"],
    ] as const) {
      const assertSafeRefusal = (nextApp: string, nextMigration: string) => {
        assert.throws(
          () => validateFixtureUrls(nextApp, nextMigration, database, mode),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              "An owned PostgreSQL fixture has an unsupported connection target.",
            );
            assert.equal(error.cause, undefined);
            assert.equal("input" in error ? error.input : undefined, undefined);
            assert.equal("actual" in error ? error.actual : undefined, undefined);
            assert.doesNotMatch(String(error.stack), /synthetic/);
            return true;
          },
        );
      };
      const spacedApplication = application.replace("synthetic", "syn thetic");
      const spacedMigration = migration.replace("synthetic", "syn thetic");
      assert.doesNotThrow(() => validateFixtureUrls(spacedApplication, migration, database, mode));
      assert.doesNotThrow(() => validateFixtureUrls(application, spacedMigration, database, mode));

      const roles = [
        {
          url: application,
          spacedUrl: spacedApplication,
          refuse: (url: string) => assertSafeRefusal(url, migration),
        },
        {
          url: migration,
          spacedUrl: spacedMigration,
          refuse: (url: string) => assertSafeRefusal(application, url),
        },
      ];
      // URL parsing can normalize these paths to the allowed database.
      for (const { spacedUrl, refuse } of roles) {
        for (const prefix of ["%2e", "%2E", "%2e%2e", ".", "x/.."]) {
          refuse(spacedUrl.replace(`/${database}`, `/${prefix}/${database}`));
        }
      }

      // Refuse characters that the URL parser can strip or rewrite, even in credentials.
      for (const { url, refuse } of roles) {
        for (const invalid of [` ${url}`, `${url} `]) {
          refuse(invalid);
        }
        for (const code of [...Array(32).keys(), 127]) {
          const control = String.fromCharCode(code);
          for (const invalid of [
            `${control}${url}`,
            `${url}${control}`,
            url.replace("synthetic", `syn${control}thetic`),
          ]) {
            refuse(invalid);
          }
        }
      }
    }
    const sentinel = "synthetic-secret-not-for-errors";
    assert.throws(
      () => validateFixtureUrls(`${ciApp}?${sentinel}`, ciMigrator, ciDatabase, "ci"),
      (error) =>
        error instanceof Error &&
        !String(error).includes(sentinel) &&
        !String(error.stack).includes(sentinel),
    );
  });
}
