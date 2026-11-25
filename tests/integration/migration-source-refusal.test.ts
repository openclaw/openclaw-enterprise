import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("the journal lists every SQL migration shipped in the controller image exactly once", async () => {
  const directory = join(repository, "migrations");
  const { entries }: { entries: { tag: string }[] } = JSON.parse(
    await readFile(join(directory, "meta/_journal.json"), "utf8"),
  );
  // Match the Dockerfile's COPY of migrations/[0-9]*.sql.
  const shipped = globSync("[0-9]*.sql", { cwd: directory });
  const journaled = entries.map(({ tag }) => `${tag}.sql`);
  assert.deepEqual(journaled.sort(), shipped.sort());
});

test("the migration command reports malformed release metadata before connecting", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "oce-migration-source-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "scripts"));
  await mkdir(join(fixture, "migrations", "meta"), { recursive: true });
  for (const path of ["apps", "packages", "node_modules", "package.json"]) {
    await symlink(join(repository, path), join(fixture, path));
  }
  for (const path of [
    "migrate-production.ts",
    "migration-history.mjs",
    "migration-history-preflight.ts",
    "migration-catalog.ts",
  ]) {
    await copyFile(join(repository, "scripts", path), join(fixture, "scripts", path));
  }
  const meta = join(repository, "migrations", "meta");
  const journal = JSON.parse(await readFile(join(meta, "_journal.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(meta, "_canonical-history.json"), "utf8"));
  const url = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_migrator",
    password: "synthetic-source-secret",
    host: "127.0.0.1",
    port: 9,
    pathname: "/openclaw_enterprise",
  });
  const cases = [
    {
      manifest: { ...manifest, catalogs: [] },
      journal,
      message: "the completed catalog has not been qualified",
    },
    {
      manifest: null,
      journal,
      message:
        "the canonical migration manifest is invalid; preserve the database and run --check with an intact matching release",
    },
    {
      manifest: { ...manifest, entries: [null] },
      journal,
      message:
        "a canonical migration entry is invalid; preserve the database and run --check with an intact matching release",
    },
    {
      // An empty, matching journal reaches the final shape guard without SQL fixture copies.
      manifest: { ...manifest, entries: [], initialSchemaStates: null },
      journal: { ...journal, entries: [] },
      message:
        "the canonical migration manifest is invalid; preserve the database and run --check with an intact matching release",
    },
  ];
  for (const scenario of cases) {
    await writeFile(
      join(fixture, "migrations", "meta", "_journal.json"),
      JSON.stringify(scenario.journal),
    );
    await writeFile(
      join(fixture, "migrations", "meta", "_canonical-history.json"),
      JSON.stringify(scenario.manifest),
    );
    const result = spawnSync(process.execPath, ["scripts/migrate-production.ts", "--check"], {
      cwd: fixture,
      env: {
        ...process.env,
        NODE_ENV: "production",
        OCC_DATABASE_AUTH: "password",
        OCC_CONFIG_PATH: undefined,
        OCC_MIGRATION_DATABASE_URL: url,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.split("\n")[0],
      `Unsupported migration history: ${scenario.message}.`,
    );
    assert.match(result.stderr, /MIGRATION_HISTORY_UNSUPPORTED/);
    assert.doesNotMatch(result.stderr + result.stdout, /synthetic-source-secret/);
  }
});
