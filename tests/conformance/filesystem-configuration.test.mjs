import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";

test("Filesystem Configuration cleans its temporary file after a failed rename and can retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-configuration-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = new FilesystemConfigurationDriver(root);
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: `ns_${randomUUID()}`,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
    values: { model: "synthetic-model" },
  };
  const directory = join(root, configuration.namespaceId);
  const destination = join(directory, `${configuration.id}.json`);
  // An existing directory makes the actual filesystem refuse the atomic rename.
  // No filesystem method or production implementation is replaced.
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const otherTemporary = ".another-write.tmp";
  await writeFile(join(directory, otherTemporary), "another writer's content", { mode: 0o600 });

  await assert.rejects(driver.create(configuration), { code: "EISDIR" });
  assert.equal((await stat(destination)).isDirectory(), true);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [`${configuration.id}.json`, otherTemporary].sort(),
  );
  assert.equal(await readFile(join(directory, otherTemporary), "utf8"), "another writer's content");

  // Once storage accepts the destination, the same approved Configuration saves.
  await rm(destination, { recursive: true });
  await driver.create(configuration);
  assert.deepEqual(await driver.read(configuration), configuration);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [`${configuration.id}.json`, otherTemporary].sort(),
  );
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});
