import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  cp,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";

type UpgradeFixture = {
  directory: string;
  evidence: string;
  commands: string[];
  run(...args: string[]): Promise<unknown>;
  failNext(fault: string): Promise<void>;
  state(): Promise<{
    dispatches: number;
    activeRevision?: string;
    deployFailures?: Record<string, string>;
  }>;
  events(): Promise<string[]>;
};

type FixtureOptions = {
  agent?: true;
  afterDeploy?: () => Promise<void>;
  inventoryNamespaces?: {
    id: string;
    status: string;
    agents: Record<string, string | boolean>[];
  }[];
  names?: Record<string, string>;
};

async function quarantineContents(directory: string, quarantine: string): Promise<void> {
  await mkdir(quarantine, { mode: 0o700 });
  for (const entry of await readdir(directory)) {
    await rename(join(directory, entry), join(quarantine, entry));
  }
}

export function registerDispatchRestoreTests(
  fixture: (t: TestContext, options: FixtureOptions) => Promise<UpgradeFixture>,
  injectedFault: { code: number },
): void {
  for (const replacement of [false, true]) {
    const restored = replacement
      ? "a replacement with the original inode"
      : "the original directory";
    test(`a stale backup restored into ${restored} cannot replay an Agent dispatch`, async (t) => {
      const f = await fixture(t, { agent: true });
      await f.failNext("fail-rollout-worker");
      await assert.rejects(f.run(), injectedFault);
      const backup = join(f.directory, "pre-dispatch-backup");
      await cp(f.evidence, backup, { recursive: true });

      await f.failNext("lost-agent-response");
      await assert.rejects(f.run("--resume"), /deployment outcome is unknown/);
      const accepted = await f.state();
      assert.equal(accepted.dispatches, 1);
      // Simulate an Agent read that still shows the old active revision.
      await writeFile(
        join(f.directory, "state.json"),
        JSON.stringify({
          ...accepted,
          activeRevision: "rev_old",
        }),
      );

      const original = await stat(f.evidence);
      await quarantineContents(f.evidence, join(f.directory, "quarantine"));
      if (replacement) {
        let reused = false;
        for (let attempt = 0; attempt < 128 && !reused; attempt++) {
          await rmdir(f.evidence);
          await mkdir(f.evidence, { mode: 0o700 });
          reused = (await stat(f.evidence)).ino === original.ino;
        }
        if (!reused) {
          t.skip("this filesystem did not reuse the inode");
          return;
        }
      }
      await cp(backup, f.evidence, { recursive: true });
      const stale = await stat(f.evidence);
      assert.deepEqual([stale.dev, stale.ino], [original.dev, original.ino]);

      const calls = f.commands.length;
      const error: unknown = await f.run("--resume").then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.equal((await f.state()).dispatches, 1, "restoring a stale backup must not send again");
      assert.match(
        (error as { stderr?: string } | undefined)?.stderr ?? "",
        /unknown deployment outcome/,
      );
      assert.equal(f.commands.length, calls, "resume must stop before any external command");
    });
  }

  test("a stale fleet backup retries only the Agent with a definite refusal", async (t) => {
    const agent = (id: string) => ({
      id,
      status: "active",
      desiredRuntimeState: "running",
      executionMode: "embedded",
      activeRevisionId: "rev_old",
      deploymentInProgress: false,
    });
    const f = await fixture(t, {
      inventoryNamespaces: [
        { id: "ns_test", status: "ready", agents: [agent("agt_ok"), agent("agt_test")] },
      ],
      names: { ns_test: "Support", agt_ok: "Accepted", agt_test: "Mail triage" },
    });
    const state = await f.state();
    state.deployFailures = {
      agt_test: "Error: OCC operation failed (HTTP 400): INVALID_REQUEST: Correct the draft.",
    };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await f.failNext("fail-rollout-worker");
    await assert.rejects(f.run(), injectedFault);
    const backup = join(f.directory, "pre-dispatch-backup");
    await cp(f.evidence, backup, { recursive: true });

    await assert.rejects(f.run("--resume"), /OCC refused to deploy/);
    assert.equal((await f.state()).dispatches, 2);
    await quarantineContents(f.evidence, join(f.directory, "quarantine"));
    await cp(backup, f.evidence, { recursive: true });
    await f.run("--resume");
    assert.equal((await f.state()).dispatches, 3);
    assert.deepEqual(
      (await f.events()).filter((event) => event.startsWith("agent-deploy")).sort(),
      ["agent-deploy agt_ok", "agent-deploy agt_test", "agent-deploy-failed agt_test"],
    );
  });

  test("resume refuses a missing, linked, or substituted dispatch journal before live access", async (t) => {
    const f = await fixture(t, { agent: true });
    await f.failNext("fail-rollout-worker");
    await assert.rejects(f.run(), injectedFault);
    const journal = f.evidence + ".dispatch-state";
    const original = join(f.directory, "original-journal");
    assert.equal((await stat(journal)).mode & 0o777, 0o600);
    await rename(journal, original);

    const calls = f.commands.length;
    const refuse = async () => {
      await assert.rejects(f.run("--resume"), /dispatch journal/);
      assert.equal(f.commands.length, calls);
      assert.equal((await f.state()).dispatches, 0);
    };
    await refuse();
    await assert.rejects(stat(journal), { code: "ENOENT" });
    await symlink(original, journal);
    await refuse();
    await rm(journal);
    await link(original, journal);
    await refuse();
    await rm(journal);
    await cp(original, journal);
    await refuse();
    await rm(journal);

    await rename(original, journal);
    await f.run("--resume");
    assert.equal((await f.state()).dispatches, 1);
  });

  test("a concurrent resume cannot take over while the native deploy is in flight", async (t) => {
    const pause = new EventEmitter();
    const entered = once(pause, "entered");
    const release = once(pause, "release");
    const f = await fixture(t, {
      agent: true,
      afterDeploy: async () => {
        pause.emit("entered");
        await release;
      },
    });
    const original = f.run();
    // The fixture has accepted the send but deliberately withheld its response.
    try {
      await Promise.race([
        entered,
        original.then(() => assert.fail("upgrade finished before the dispatch pause")),
        setTimeout(60_000, undefined, { ref: false }).then(() =>
          assert.fail("deploy did not start"),
        ),
      ]);
      assert.equal((await f.state()).dispatches, 1);
      await rmdir(join(f.evidence, ".upgrade-lock"));
      const calls = f.commands.length;
      await assert.rejects(f.run("--resume"), /dispatch journal is locked/);
      assert.equal(f.commands.length, calls);
      assert.equal((await f.state()).dispatches, 1);
    } finally {
      pause.emit("release");
      await original;
    }
  });
}
