import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  cp,
  link,
  mkdir,
  readFile,
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
  deploy(namespaceId: string, agentId: string): Promise<{ stdout: string }>;
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
  for (const outcome of ["succeeded", "failed"] as const) {
    test(`a stale receipt preserves the journaled replacement when it ${outcome}`, async (t) => {
      const f = await fixture(t, { agent: true });
      const namespaceId = "ns_test";
      const agentId = "agt_test";
      const revisionA = "rev_new";
      const revisionB = "rev_replacement";
      const revisionC = "rev_later";
      const receipt = join(f.evidence, "dispatch", `${namespaceId}--${agentId}.json`);
      const journal = f.evidence + ".dispatch-state";
      const failure = /at least one Agent deployment failed/;
      const scriptOutcome = async (status: "succeeded" | "failed") => {
        if (status === "failed") {
          await assert.rejects(f.run("--resume"), failure);
        } else {
          await f.run("--resume");
        }
      };
      const selectNextDeployment = async (id: string, status: "succeeded" | "failed") => {
        const state = await f.state();
        await writeFile(
          join(f.directory, "state.json"),
          JSON.stringify({ ...state, nextDeployment: { id, status } }),
        );
      };
      const operatorDeploy = async (id: string, status: "succeeded" | "failed") => {
        await selectNextDeployment(id, status);
        const response = await f.deploy(namespaceId, agentId);
        assert.equal(JSON.parse(response.stdout).id, id);
      };
      const recordReplacement = async (id: string, replacesDeploymentId: string) => {
        const temporary = receipt + ".replacement";
        await writeFile(temporary, JSON.stringify({ id, replacesDeploymentId }), {
          mode: 0o600,
        });
        await rename(temporary, receipt);
      };
      const projectedRevision = async () =>
        JSON.parse(await readFile(join(f.evidence, "deployments.jsonl"), "utf8")).deploymentId;
      const lastEntry = async () =>
        JSON.parse((await readFile(journal, "utf8")).trimEnd().split("\n").at(-1)!);

      await selectNextDeployment(revisionA, "failed");
      await assert.rejects(f.run(), failure);
      assert.equal(await projectedRevision(), revisionA);
      const backup = join(f.directory, "evidence-before-replacement");
      await cp(f.evidence, backup, { recursive: true });
      const originalReceipt = await readFile(receipt);
      const beforeReplacement = await readFile(journal);

      // An unseen ID bound to the current revision still needs an exact OCC
      // deployment status response before it can become authoritative.
      if (outcome === "failed") {
        await recordReplacement("rev_missing", revisionA);
        await assert.rejects(f.run("--resume"), /cannot confirm the failed deployment/);
        assert.deepEqual(await readFile(journal), beforeReplacement);
        assert.equal((await f.state()).dispatches, 1);
      }

      // The operator submits a separate deploy and supplies the acknowledged ID
      // with the failed revision it replaces. Resume should only observe it.
      await operatorDeploy(revisionB, outcome);
      await recordReplacement(revisionB, revisionA);
      await scriptOutcome(outcome);
      assert.equal(await projectedRevision(), revisionB);
      const currentJournal = await readFile(journal);
      const replacementReceipt = await readFile(receipt);

      const originalDirectory = await stat(f.evidence);
      await quarantineContents(f.evidence, join(f.directory, "evidence-with-replacement"));
      await cp(backup, f.evidence, { recursive: true });
      const restoredDirectory = await stat(f.evidence);
      assert.deepEqual(
        [restoredDirectory.dev, restoredDirectory.ino],
        [originalDirectory.dev, originalDirectory.ino],
      );
      await scriptOutcome(outcome);
      assert.equal(await projectedRevision(), revisionB);
      assert.deepEqual(await readFile(journal), currentJournal, "resume must not append a rewind");
      assert.deepEqual(await lastEntry(), ["replace", namespaceId, agentId, revisionA, revisionB]);
      assert.deepEqual(await readFile(receipt), originalReceipt, "retain the earlier receipt");
      assert.equal(
        (await f.state()).dispatches,
        2,
        "only the original send and manual replacement",
      );

      if (outcome === "failed") {
        await operatorDeploy(revisionC, "succeeded");
        const rejectReplacement = async (expected: RegExp, scenario: string) => {
          await assert.rejects(f.run("--resume"), expected, scenario);
          assert.deepEqual(await readFile(journal), currentJournal, scenario);
          assert.equal(await projectedRevision(), revisionB, scenario);
          assert.equal((await f.state()).dispatches, 3, scenario);
        };
        await recordReplacement(revisionC, revisionA);
        await rejectReplacement(/name the current journaled revision/, "superseded parent");

        await recordReplacement(revisionC, revisionB);
        const cannotConfirm = /cannot confirm the failed deployment and its recorded replacement/;
        // A status command that emits a body but fails cannot prove the
        // predecessor is failed. The next successful read can confirm it.
        await f.failNext("fail-deployment-status-after-output");
        await rejectReplacement(cannotConfirm, "predecessor status command failed");

        // Both deployments exist. Change only the CLI response for the selected read.
        const statusC = { namespaceId, agentId, deploymentId: revisionC, status: "succeeded" };
        const validStatus = JSON.stringify(statusC);
        const statusCases = [
          ["wrong Namespace", revisionC, JSON.stringify({ ...statusC, namespaceId: "ns_other" })],
          ["wrong Agent", revisionC, JSON.stringify({ ...statusC, agentId: "agt_other" })],
          ["wrong deployment", revisionC, JSON.stringify({ ...statusC, deploymentId: revisionB })],
          ["multiple status documents", revisionC, `${validStatus}\n${validStatus}`],
          ["invalid status JSON", revisionC, '{"status":'],
          ["unsupported status", revisionC, JSON.stringify({ ...statusC, status: "unknown" })],
          [
            "successful predecessor",
            revisionB,
            JSON.stringify({ ...statusC, deploymentId: revisionB }),
          ],
          ["replacement status command failed", revisionC, validStatus, 1],
        ] as const;
        const statePath = join(f.directory, "state.json");
        const normalState = await f.state();
        for (const [scenario, deploymentId, stdout, exitCode] of statusCases) {
          await writeFile(
            statePath,
            JSON.stringify({
              ...normalState,
              deploymentStatusResponses: { [deploymentId]: { stdout, exitCode } },
            }),
          );
          await rejectReplacement(cannotConfirm, scenario);
        }
        await writeFile(statePath, JSON.stringify(normalState));

        // Keep the upgrade unfinished so the next resume exercises an older
        // receipt after the journal has already selected the newer revision.
        await f.failNext("doctor-error");
        await assert.rejects(f.run("--resume"), /OpenClaw Doctor failed/);
        assert.equal(await projectedRevision(), revisionC);
        assert.deepEqual(await lastEntry(), [
          "replace",
          namespaceId,
          agentId,
          revisionB,
          revisionC,
        ]);
        const newestJournal = await readFile(journal);
        // B's older receipt has an explicit parent, so this also distinguishes
        // a historical receipt from a new replacement with a wrong parent.
        await writeFile(receipt, replacementReceipt);
        await f.run("--resume");
        assert.equal(await projectedRevision(), revisionC);
        assert.deepEqual(await readFile(journal), newestJournal);
        assert.deepEqual(await readFile(receipt), replacementReceipt);
        assert.equal((await f.state()).dispatches, 3, "each manual replacement was sent once");
      }
    });
  }

  test("a stale backup restored into the original directory cannot replay an Agent dispatch", async (t) => {
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

    // Restore stale bytes under the same canonical path, device and inode.
    // Resume observes the same directory identity as inode reuse would produce,
    // without relying on the filesystem allocator to recycle a deleted inode.
    const original = await stat(f.evidence);
    await quarantineContents(f.evidence, join(f.directory, "quarantine"));
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

  test("a restored refusal cannot retry a later dispatch with an unknown outcome", async (t) => {
    const f = await fixture(t, { agent: true });
    const state = await f.state();
    state.deployFailures = {
      agt_test: "Error: OCC operation failed (HTTP 400): INVALID_REQUEST: Correct the draft.",
    };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run(), /OCC refused to deploy/);
    const backup = join(f.directory, "refused-evidence");
    await cp(f.evidence, backup, { recursive: true });

    await f.failNext("lost-agent-response");
    await assert.rejects(f.run("--resume"), /deployment outcome is unknown/);
    await quarantineContents(f.evidence, join(f.directory, "latest-evidence"));
    await cp(backup, f.evidence, { recursive: true });

    const calls = f.commands.length;
    await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
    assert.equal(f.commands.length, calls, "resume stops before any external command");
    assert.equal((await f.state()).dispatches, 2);
    assert.deepEqual(
      (await f.events()).filter((event) => event.startsWith("agent-deploy")),
      ["agent-deploy-failed agt_test", "agent-deploy agt_test"],
    );
  });

  test("resume refuses a missing, linked, substituted, or incomplete dispatch journal before live access", async (t) => {
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
    // Simulate a torn final write on the same journal inode. Resume preserves
    // the bytes and refuses before a new send can erase uncertainty.
    const complete = await readFile(journal, "utf8");
    const incomplete = complete + '["send",';
    await writeFile(journal, incomplete);
    await assert.rejects(f.run("--resume"), /incomplete record/);
    assert.equal(f.commands.length, calls);
    assert.equal(await readFile(journal, "utf8"), incomplete);
    await writeFile(journal, complete);
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
