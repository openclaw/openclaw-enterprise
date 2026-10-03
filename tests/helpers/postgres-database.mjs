// Real PostgreSQL tests run only when OCC_TEST_DATABASE_URL selects a migrated disposable
// database (docs/testing/postgresql.md); otherwise they skip with this reason.
export const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database (docs/testing/postgresql.md).",
};
