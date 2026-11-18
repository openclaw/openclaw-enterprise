import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("the migration command reports malformed release metadata before connecting", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "oce-migration-source-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "scripts"));
  await mkdir(join(fixture, "migrations", "meta"), { recursive: true });
  for (const path of ["apps", "packages", "node_modules", "package.json"]) {
    await symlink(join(repository, path), join(fixture, path));
  }
  for (const path of [
    "migrate-production.mjs",
    "migration-history.mjs",
    "migration-history-preflight.ts",
    "migration-catalog.ts",
  ]) {
    await copyFile(join(repository, "scripts", path), join(fixture, "scripts", path));
  }
  const meta = join(repository, "migrations", "meta");
  await copyFile(join(meta, "_journal.json"), join(fixture, "migrations", "meta", "_journal.json"));
  const manifest = JSON.parse(await readFile(join(meta, "_canonical-history.json"), "utf8"));
  // Simulate a damaged release artifact while keeping its reviewed journal unchanged.
  manifest.catalogs = [];
  await writeFile(
    join(fixture, "migrations", "meta", "_canonical-history.json"),
    JSON.stringify(manifest),
  );
  const url = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "occ_migrator",
    password: "synthetic-source-secret",
    host: "127.0.0.1",
    port: 9,
    pathname: "/openclaw_enterprise",
  });
  const result = spawnSync(process.execPath, ["scripts/migrate-production.mjs", "--check"], {
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
  assert.match(result.stderr, /MIGRATION_HISTORY_UNSUPPORTED/);
  assert.match(result.stderr, /the completed catalog has not been qualified/);
  assert.doesNotMatch(result.stderr + result.stdout, /synthetic-source-secret/);
});
