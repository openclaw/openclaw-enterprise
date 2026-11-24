import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  fixture,
  missing,
  parseJson,
  parseRecord,
  prepare,
  readRecord,
  revision,
  tenant,
} from "./ssh-compute-fixture.ts";

test("SSH rejects foreign Agent, revision and unit ownership without mutating them", async (t) => {
  const f = await fixture(t);
  const rev = await prepare(f);
  const files: [path: string, key: string][] = [
    [join(f.agentDir(rev), "agent.json"), "servicePrincipalId"],
    [join(f.revisionDir(rev), "revision.json"), "revisionId"],
    [join(f.revisionDir(rev), "revision.json"), "configurationHash"],
  ];
  for (const [path, key] of files) {
    const original = await readFile(path, "utf8");
    const parsed = parseJson(original);
    const foreign = JSON.stringify({ ...parseRecord(parsed), [key]: "foreign" });
    await writeFile(path, foreign);
    await assert.rejects(f.driver.prepareRevision(rev), /ownership|snapshot/);
    await assert.rejects(f.driver.retireRevision(rev), /ownership|snapshot/);
    await assert.rejects(f.driver.stopRevision(rev), /ownership|snapshot/);
    assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
    assert.equal(await readFile(path, "utf8"), foreign);
    await writeFile(path, original);
  }
  const unit = join(f.units, f.unit(rev));
  const originalUnit = await readFile(unit, "utf8");
  await writeFile(unit, "[Unit]\nDescription=foreign\n");
  const log = await readFile(join(f.state, "systemctl.log"), "utf8");
  await assert.rejects(f.driver.prepareRevision(rev), /ownership/);
  assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
  assert.equal(await readFile(unit, "utf8"), "[Unit]\nDescription=foreign\n");
  assert.equal(await readFile(join(f.state, "systemctl.log"), "utf8"), log);
  await writeFile(unit, originalUnit);
  const agent = await readRecord(join(f.agentDir(rev), "agent.json"));
  assert.ok(typeof agent.runtimeUser === "string");
  const account = join(f.root, "accounts", `${agent.runtimeUser}.json`);
  const originalAccount = await readRecord(account);
  assert.ok(typeof originalAccount.uid === "number");
  await writeFile(account, JSON.stringify({ ...originalAccount, uid: originalAccount.uid + 1 }));
  await assert.rejects(f.driver.activateRevision(rev), /foreign ownership|snapshot/);
  assert.equal((await f.driver.deleteNamespace(tenant)).failure, "permanent");
  assert.equal(await readFile(join(f.state, "systemctl.log"), "utf8"), log);
});

test("SSH immutable snapshots, supersession, cutover, retirement and deletion preserve exact ownership", async (t) => {
  const hooks: string[] = [];
  const f = await fixture(t, {
    lifecycleDrivers: [
      {
        id: "hooks",
        implementation: "test",
        capability: "configuration",
        computeLifecycleHooks: {
          async beforeWorkloadStop(rev) {
            hooks.push(`retire:${rev.id}`);
          },
        },
      },
    ],
  });
  const first = await prepare(f);
  const dir = f.agentDir(first);
  await writeFile(join(dir, "state", "persisted"), "state survives");
  await writeFile(join(dir, "env"), "OPERATOR_OWNED=unchanged\n", { mode: 0o600 });
  await assert.rejects(
    f.driver.prepareRevision({
      ...first,
      configuration: admitLoggingConfiguration(
        { agents: { defaults: { skipBootstrap: false } } },
        "info",
      ),
    }),
    /snapshot mismatch/,
  );
  const second = revision(f.driver, 2);
  assert.equal((await f.driver.prepareRevision(second)).ready, true);
  const log = await readFile(join(f.state, "systemctl.log"), "utf8");
  assert.equal((await f.driver.prepareRevision(first)).ready, true);
  assert.equal(await readFile(join(f.state, "systemctl.log"), "utf8"), log);
  assert.equal(await readFile(join(dir, "state", "persisted"), "utf8"), "state survives");
  await f.driver.activateRevision(second);
  await assert.rejects(f.driver.activateRevision(first), /ownership/);
  await f.driver.retireRevision(first);
  await f.driver.retireRevision(first);
  await missing(f.revisionDir(first));
  assert.equal((await stat(f.revisionDir(second))).isDirectory(), true);
  assert.equal(await readFile(join(dir, "env"), "utf8"), "OPERATOR_OWNED=unchanged\n");
  // A superseded candidate whose snapshot was retired must not recreate it.
  assert.equal((await f.driver.prepareRevision(first)).ready, false);
  await missing(f.revisionDir(first));
  await f.driver.retireRevision(second);
  await missing(join(dir, "current"));
  await missing(f.revisionDir(second));
  assert.equal(await readFile(join(dir, "state", "persisted"), "utf8"), "state survives");
  await writeFile(join(f.state, "groupdel.fail"), "once");
  assert.deepEqual(await f.driver.deleteNamespace(tenant), {
    namespaceId: tenant.id,
    namespaceDeleted: false,
    failure: "retryable",
  });
  await missing(f.nsDir);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
  assert.deepEqual(await readdir(join(f.root, "accounts")), []);
  assert.equal((await f.driver.deleteNamespace(tenant)).namespaceDeleted, true);
  await missing(f.nsDir);
  await missing(join(f.units, f.unit(first)));
  await missing(join(f.state, `${f.unit(first)}.enabled`));
  await missing(join(f.state, `${f.unit(first)}.pid`));
  assert.ok(hooks.includes(`retire:${first.id}`));
  const commands = await readFile(join(f.state, "systemctl.log"), "utf8");
  assert.match(commands, /stop openclaw-enterprise-gateway-/);
  assert.match(commands, /disable openclaw-enterprise-gateway-/);
});
