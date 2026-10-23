import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

test("Filesystem Configuration cleans its temporary file after a failed rename and can retry", async (t) => {
  const root = await temporaryDirectory(t, "occ-configuration-write-");
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

test("Filesystem Configuration shares the URL credential check work budget across a document", async (t) => {
  const root = await temporaryDirectory(t, "occ-configuration-url-check-");
  const driver = new FilesystemConfigurationDriver(root);
  const namespaceId = `ns_${randomUUID()}`;
  const configuration = (values) => ({
    id: `cfg_${randomUUID()}`,
    namespaceId,
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
    values,
  });
  // Each fallback requires another rendering; these short values exhaust the shared check only together.
  const url = (fallbacks) => `x://h${"${A:-x}".repeat(fallbacks)}`;
  const proxy = url(300);
  const channels = {
    telegram: {
      accounts: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`a${index}`, { proxy }]),
      ),
    },
  };
  const env = { vars: { X0: url(170) } };

  await driver.create(configuration({ channels }));
  await driver.create(configuration({ env }));
  const directory = join(root, namespaceId);
  const before = (await readdir(directory)).sort();
  await assert.rejects(driver.create(configuration({ channels, env })), {
    message: /\/env\/vars\/X0, .*too many URLs/,
  });
  assert.deepEqual((await readdir(directory)).sort(), before);

  const fresh = configuration({ channels });
  await driver.create(fresh);
  assert.deepEqual(await driver.read(fresh), fresh);
});
