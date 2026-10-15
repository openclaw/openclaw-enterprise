import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../fixtures/repository-credentials/process.mjs";
import { ownedNetwork } from "../fixtures/repository-credentials-isolation/ownership.mjs";

// These checks qualify fixture ownership only; they do not run the service,
// Docker daemon, delivered images, or provider integration.
test("runner timeout cancels and joins commands before teardown admits cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "isolation-owner-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const late = join(directory, "late");
  const cleaned = join(directory, "cleaned");
  const ownership = new URL(
    "../fixtures/repository-credentials-isolation/ownership.mjs",
    import.meta.url,
  ).href;
  const processModule = new URL("../fixtures/repository-credentials/process.mjs", import.meta.url)
    .href;
  const source = `
    import test from 'node:test';
    import { forwardWork } from ${JSON.stringify(ownership)};
    import { run } from ${JSON.stringify(processModule)};
    let body;
    test('expected timeout', { timeout: 200 }, async t => {
      const work = forwardWork(t.signal);
      t.after(async () => {
        await work.stop();
        await Promise.allSettled([body]);
        await run(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(cleaned)}, 'done')`)}], { signal: AbortSignal.timeout(2000) });
      });
      body = (async () => {
        try {
          await work.command(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late command'), 600)`)}]);
        } catch {}
        // A caller swallowing the cancelled command still cannot start forward work.
        await work.command(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late start')`)}]);
      })();
      await body;
    });
  `;
  const result = await run(process.execPath, ["--input-type=module", "-e", source], {
    allowFailure: true,
    timeout: 5000,
  });
  assert.notEqual(result.code, 0, "the nested Node test must actually time out");
  assert.match(result.stdout + result.stderr, /test timed out after 200ms/);
  assert.equal(await readFile(cleaned, "utf8"), "done");
  await assert.rejects(readFile(late), { code: "ENOENT" });
});

test("accepted network creation with a lost response stays owned until verified absent", async (t) => {
  for (const completionDelay of [0, 500]) {
    await t.test(`creation completes after ${completionDelay}ms`, async () => {
      const name = "credential-isolation-controlled-network";
      const owner = "controlled-owner";
      const id = "a".repeat(64);
      let network;
      let removed = 0;
      let readbacks = 0;
      let creation;
      const docker = async (args) => {
        if (args[1] === "create") {
          creation = delay(completionDelay).then(() => {
            network = {
              Name: name,
              Id: id,
              Labels: { "repository-credentials-isolation.owner": owner },
            };
          });
          throw new Error("accepted creation; response lost");
        }
        if (args[1] === "ls") {
          readbacks++;
          return { stdout: network ? JSON.stringify({ Name: name, ID: id }) : "" };
        }
        if (args[1] === "inspect") {
          return { stdout: JSON.stringify([network]) };
        }
        assert.deepEqual(args, ["network", "rm", id]);
        network = undefined;
        removed++;
        return { stdout: "" };
      };
      const resource = ownedNetwork(name, owner, docker);
      await assert.rejects(resource.create(), /response lost/);
      try {
        await resource.remove(docker, AbortSignal.timeout(2000));
      } finally {
        // Join accepted daemon work even when the pre-fix cleanup returns too soon.
        await creation;
      }
      assert.equal(network, undefined);
      assert.equal(removed, 1);
      assert.ok(readbacks >= 2, "removal must be followed by an absence readback");
    });
  }
});

test("uncertain network creation remains unresolved when its cleanup budget expires empty", async () => {
  const resource = ownedNetwork("uncertain-name", "owner", async () => {
    throw new Error("creation cancelled");
  });
  await assert.rejects(resource.create(), /creation cancelled/);
  await assert.rejects(
    resource.remove(async () => ({ stdout: "" }), AbortSignal.timeout(350)),
    /aborted|timeout/i,
  );
});

test("network cleanup reports failed readback and refuses foreign ownership", async () => {
  const resource = ownedNetwork("owned-name", "owner", async () => {
    throw new Error("lost response");
  });
  await assert.rejects(resource.create(), /lost response/);
  await assert.rejects(
    resource.remove(async () => {
      throw new Error("readback failed");
    }),
    /readback failed/,
  );
  let removed = false;
  await assert.rejects(
    resource.remove(async (args) => {
      if (args[1] === "ls") {
        return { stdout: JSON.stringify({ Name: "owned-name", ID: "id" }) };
      }
      if (args[1] === "inspect") {
        return { stdout: JSON.stringify([{ Name: "owned-name", Id: "id", Labels: {} }]) };
      }
      removed = true;
      return { stdout: "" };
    }),
    /identity mismatch/,
  );
  assert.equal(removed, false);
});
