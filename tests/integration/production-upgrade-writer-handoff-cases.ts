import assert from "node:assert/strict";
import { constants, existsSync, symlinkSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join, relative } from "node:path";
import test, { describe } from "node:test";
import {
  registerAcceptedAgentDeployNoticeTest,
  registerUnknownAgentDeploymentResumeTest,
} from "../helpers/production-upgrade-dispatch-restore.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { preflightIdentities } from "../helpers/production-upgrade-preflight-cleanup.ts";
import {
  assertHelmIntent,
  assertPrivateReceipt,
  assertStoppedBeforeWriters,
  runWithInjectedFault,
} from "../helpers/production-upgrade-recovery-evidence.ts";
import type {
  RecoveryFixture,
  RecoveryFixtureFactory,
} from "../helpers/production-upgrade-recovery-fixture.ts";
import {
  field,
  list,
  record,
  requireRecoveryPreflight,
  type RecoveryState,
} from "../helpers/production-upgrade-recovery-state.ts";
import { runtime } from "../helpers/production-upgrade-recovery-tools.ts";
import {
  createDoctorPodFixture,
  embeddedDoctorNamespace,
} from "../helpers/upgrade-doctor-observations.ts";

const doctorPod = createDoctorPodFixture(runtime);

function readUpgradeFailure(error: unknown) {
  assert.ok(error instanceof Error);
  assert.ok("code" in error && typeof error.code === "number");
  assert.ok("stderr" in error && typeof error.stderr === "string");
  assert.ok("stdout" in error && typeof error.stdout === "string");
  return { code: error.code, stdout: error.stdout, stderr: error.stderr };
}

async function expectUpgradeFailure(result: Promise<unknown>, message: string) {
  try {
    await result;
  } catch (error) {
    return readUpgradeFailure(error);
  }
  assert.fail(message);
}

function doctorTargets(contents: string) {
  return contents
    .trim()
    .split("\n")
    .map((line) => {
      const target = asRecord(JSON.parse(line));
      assert.ok(target, "expected a Doctor target record");
      return target;
    });
}

export function registerWriterHandoffCases({
  fixture,
  realHelm,
  repository,
}: {
  fixture: RecoveryFixtureFactory;
  realHelm: string;
  repository: string;
}): void {
  test("a separate database deployment pauses after quiescence and before Helm even on resume", async (t) => {
    let databaseId = "ins_test";
    const f = await fixture(t, {
      controllerOnly: true,
      candidates: true,
      chart: { installation: (installation) => installation },
      databaseAnswer: () => ({ rows: [{ id: databaseId }] }),
    });
    // This handoff changes migration ownership, not the example's Plugin Drivers.
    await writeFile(
      join(f.directory, "candidate-installation.json"),
      await readFile(join(f.directory, "installation.json")),
    );
    const path = join(f.directory, "candidate-values.json");
    const values = asRecord(JSON.parse(await readFile(path, "utf8")));
    assert.ok(values, "expected staged chart values");
    const database = asRecord(values.database);
    assert.ok(database, "expected staged database settings");
    values.database = { ...database, upgradeMigration: "separate" };
    await writeFile(path, JSON.stringify(values));
    await runWithInjectedFault(f, "fail-scale-worker");
    await assert.rejects(f.run("--resume", "--migration-history-checked"), (error: unknown) => {
      const failure = readUpgradeFailure(error);
      return failure.code === 3 && /separate database deployment/.test(failure.stderr);
    });
    const stopped = await f.state();
    assert.deepEqual([stopped.api, stopped.worker], [0, 0]);
    assert.equal(stopped.helmSubmissions ?? 0, 0);
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);
    // A replacement with the same labels and replica count does not own this handoff.
    const stateFile = join(f.directory, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        ...stopped,
        deploymentIdentities: {
          ...asRecord(stopped.deploymentIdentities),
          worker: { uid: "replacement-worker" },
        },
      }),
    );
    await assert.rejects(
      f.run("--resume", "--migration-history-checked"),
      /worker Deployment changed/,
    );
    assert.equal((await f.state()).helmSubmissions ?? 0, 0);
    // Both writers stopped, but the application Secret/route can have changed.
    // A valid migration check must not authorize replacing services on another DB.
    await writeFile(stateFile, JSON.stringify({ ...stopped, denyWorkerPatch: true }));
    databaseId = "ins_other";
    await assert.rejects(f.run("--resume", "--migration-history-checked"), (error: unknown) => {
      const { stderr } = readUpgradeFailure(error);
      assert.match(stderr, /does not identify the incumbent Installation/);
      assert.doesNotMatch(stderr, /old release keeps serving/);
      return true;
    });
    const refused = await f.state();
    assert.equal(refused.helmSubmissions ?? 0, 0);
    assert.deepEqual([refused.api, refused.worker], [0, 0]);
    databaseId = "ins_test";
    // Completing the handoff requires no further patch.
    await f.run("--resume", "--migration-history-checked");
    assert.equal((await f.state()).helmSubmissions, 1);
  });

  test("quiescence validates both writers before stopping either and resumes after correction", async (t) => {
    const f = await fixture(t);
    // A preexisting worker configuration must not cause an avoidable API outage.
    const initial = await f.state();
    initial.worker = 2;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
    await assert.rejects(
      f.run(),
      /openclaw-enterprise-worker has unexpected ownership or replicas/,
    );
    const refused = await f.state();
    const events = await f.events();
    t.diagnostic(JSON.stringify({ api: refused.api, worker: refused.worker, events }));
    assert.equal(refused.api, 1);
    assert.equal(refused.worker, 2);
    assert.deepEqual(events, []);
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);

    // Operator correction permits normal resume without replaying a migration.
    refused.worker = 1;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(refused));
    await f.run("--resume");
    assert.deepEqual(await f.events(), [
      "scale-api",
      "scale-worker",
      "secret-replaced",
      "migration",
    ]);
    assert.equal((await f.state()).api, 1);
    assert.equal((await f.state()).worker, 1);
  });

  test("a named worker patch denial keeps the incumbent API serving", async (t) => {
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      chart: { installation: (installation) => installation },
    });
    const initial = await f.state();
    initial.denyWorkerPatch = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(initial));
    const failure = await expectUpgradeFailure(
      f.run(),
      "the worker patch denial must stop the upgrade",
    );
    const { api, worker, version } = await f.state();
    const events = await f.events();
    t.diagnostic(JSON.stringify({ api, worker, version, events }));
    assert.deepEqual(
      { api, worker, version, events },
      { api: 1, worker: 1, version: 1, events: [] },
    );
    assert.match(
      failure.stderr,
      /Kubernetes denied patch on worker Deployment system\/openclaw-enterprise-worker/,
    );
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);
  });

  test("a mismatched worker review leaves the live patch authoritative", async (t) => {
    const f = await fixture(t);
    const state = await f.state();
    state.denyWorkerPatch = true;
    state.wrongWorkerReview = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run(), (error: unknown) => {
      const { stderr } = readUpgradeFailure(error);
      assert.match(stderr, /Could not verify patch access to the worker Deployment/);
      assert.match(stderr, /Forbidden: cannot patch the worker Deployment/);
      return true;
    });
    assert.deepEqual(await f.events(), ["scale-api"]);
    assert.equal((await f.state()).worker, 1);
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);
  });

  test("an interrupted quiescence never starts migration while the worker still runs", async (t) => {
    let databaseId = "ins_test";
    const f = await fixture(t, {
      chart: { installation: (installation) => installation },
      databaseAnswer: () => ({ rows: [{ id: databaseId }] }),
    });
    await runWithInjectedFault(f, "fail-scale-worker");
    const path = join(f.evidence, "native-command-failures.tsv");
    const receipt = "quiescence-scale\tworker\t9\n";
    assert.equal(await readFile(path, "utf8"), receipt);
    assert.equal((await f.state()).api, 0);
    assert.equal((await f.state()).worker, 1);
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);
    assert.deepEqual(await f.events(), ["scale-api"]);
    const originalCheck = await f.readEvidence("preflight-migration.log");
    // Compatibility can change after preparation. A fresh refusal on resume must
    // leave the remaining writer running and preserve the original check's evidence.
    const state = await f.state();
    state.preflightResults = {
      migration: { phase: "Failed", log: "migration history changed\n" },
    };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(f.run("--resume"), /could not confirm database migration compatibility/);
    assert.equal((await f.state()).worker, 1);
    assert.equal((await f.state()).version, 1);
    assert.deepEqual(await f.events(), ["scale-api"]);
    assert.equal(await readFile(path, "utf8"), receipt);
    assert.equal(await f.readEvidence("preflight-migration.log"), originalCheck);
    const [retry] = (await readdir(f.evidence)).filter((name) =>
      name.startsWith("upgrade-preflight-resume."),
    );
    assert.ok(retry);
    assert.equal(
      await f.readEvidence(retry, "preflight-migration.log"),
      "migration history changed\n",
    );
    const retryState = await f.state();
    const preflightResults = asRecord(retryState.preflightResults);
    assert.ok(preflightResults);
    delete preflightResults.migration;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(retryState));
    // The API is already down. Resume must use the frozen ID and recheck the
    // application connection before it can stop the worker, independent of migration.
    databaseId = "ins_other";
    await assert.rejects(f.run("--resume"), /does not identify the incumbent Installation/);
    assert.equal((await f.state()).worker, 1);
    assert.deepEqual(await f.events(), ["scale-api"]);
    databaseId = "ins_test";
    // A later failed attempt appends its observation instead of erasing the first.
    await runWithInjectedFault(f, "fail-scale-worker", "--resume");
    assert.equal(await readFile(path, "utf8"), receipt + receipt);
    await f.run("--resume");
    assert.equal(await readFile(path, "utf8"), receipt + receipt);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    assert.equal(
      (await readdir(f.evidence)).filter((name) => name.startsWith("upgrade-preflight-resume."))
        .length,
      4,
    );
    assert.deepEqual(requireRecoveryPreflight(await f.state()).jobs, {});
  });

  test("a helper PID signal during resumed migration preserves its acknowledged resources", async (t) => {
    // Arm the real signal only after a partial stop. Signalling the process group
    // would hide a resume subshell that continues running after its parent is signalled.
    const fault: { mode: "interrupt" | null } = { mode: null };
    const f = await fixture(t, { preflightFault: fault });
    await runWithInjectedFault(f, "fail-scale-worker");
    const before = await f.state();
    const originalCheck = await readFile(join(f.evidence, "preflight-migration.log"));
    fault.mode = "interrupt";
    const failure = await expectUpgradeFailure(
      f.run("--resume"),
      "the interrupted helper must stop the upgrade",
    );
    assert.equal(failure.code, 143);
    assert.match(failure.stderr, /upgrade interrupted/);
    assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
    const [retry] = (await readdir(f.evidence)).filter((name) =>
      name.startsWith("upgrade-preflight-resume."),
    );
    assert.ok(retry);
    const state = await f.state();
    const beforePreflight = requireRecoveryPreflight(before);
    const preflight = requireRecoveryPreflight(state);
    const beforeCreated = list(beforePreflight.created, "preflight creations before resume");
    const created = list(preflight.created, "preflight creations");
    assert.deepEqual(
      preflight.deleted,
      beforePreflight.deleted,
      "interruption must not delete the resumed migration Job or Pod",
    );
    const records = await preflightIdentities({ evidence: join(f.evidence, retry) });
    assert.equal(
      records.length,
      4,
      "the Secret and all three Jobs were acknowledged before observation",
    );
    assert.deepEqual(
      records.sort((a, b) => a.name.localeCompare(b.name)),
      created.slice(beforeCreated.length).sort((a, b) => {
        const first = field(a, "name");
        const second = field(b, "name");
        assert.ok(typeof first === "string" && typeof second === "string");
        return first.localeCompare(second);
      }),
    );
    assert.equal(Object.keys(record(preflight.jobs, "preflight jobs")).length, 3);
    assert.equal(Object.keys(record(preflight.pods, "preflight pods")).length, 3);
    assert.equal(state.api, 0);
    assert.equal(state.worker, 1);
    assert.deepEqual(await f.events(), ["scale-api"]);
    assert.deepEqual(await readFile(join(f.evidence, "preflight-migration.log")), originalCheck);
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);
    // A separate cleanup traverses the resumed migration attempt but must not
    // continue the partially stopped upgrade or erase its original evidence.
    await f.cleanup("--previous-process-settled", "--evidence-unrestored");
    const cleaned = await f.state();
    const cleanedPreflight = requireRecoveryPreflight(cleaned);
    assert.deepEqual(cleanedPreflight.jobs, {});
    assert.deepEqual(cleanedPreflight.pods, {});
    assert.equal(cleaned.api, 0);
    assert.equal(cleaned.worker, 1);
    assert.deepEqual(await f.events(), ["scale-api"]);
    assert.deepEqual(await readFile(join(f.evidence, "preflight-migration.log")), originalCheck);
    assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });

  test("a lost resumed migration acknowledgement preserves the original recovery path", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "fail-scale-worker");
    const before = await f.state();
    const originalParameters = await readFile(join(f.evidence, "parameters.json"));
    const originalCheck = await readFile(join(f.evidence, "preflight-migration.log"));
    const originalFailures = await readFile(join(f.evidence, "native-command-failures.tsv"));
    before.preflightFault = { target: "migration", mode: "lost" };
    await writeFile(join(f.directory, "state.json"), JSON.stringify(before));
    const failure = await expectUpgradeFailure(
      f.run("--resume"),
      "the lost acknowledgement must stop the upgrade",
    );
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /ownership unconfirmed/);
    assert.doesNotMatch(failure.stderr, /fresh evidence directory|This run stopped no OCC writer/);
    assert.match(failure.stderr, /reconcil[ei].*--resume.*original evidence directory/i);
    const [retry] = (await readdir(f.evidence)).filter((name) =>
      name.startsWith("upgrade-preflight-resume."),
    );
    assert.ok(retry);
    assert.ok(failure.stderr.includes(`Resume evidence is in ${join(f.evidence, retry)}.`));
    assert.ok(failure.stderr.includes(`Preserve ${f.evidence} and any dispatch journal`));
    assert.ok(existsSync(join(f.evidence, ".upgrade-lock")));
    assert.deepEqual(await readFile(join(f.evidence, "parameters.json")), originalParameters);
    assert.deepEqual(await readFile(join(f.evidence, "preflight-migration.log")), originalCheck);
    assert.deepEqual(
      await readFile(join(f.evidence, "native-command-failures.tsv")),
      originalFailures,
    );
    const state = await f.state();
    const preflight = requireRecoveryPreflight(state);
    assert.equal(
      Object.keys(record(preflight.jobs, "preflight jobs")).length,
      1,
      "unknown Job must not be deleted by name",
    );
    assert.equal(Object.keys(record(preflight.pods, "preflight pods")).length, 1);
    assert.equal(
      (await preflightIdentities({ evidence: join(f.evidence, retry) })).length,
      1,
      "the Secret was acknowledged before the lost migration Job response",
    );
    assert.deepEqual(preflight.deleted, requireRecoveryPreflight(before).deleted);
    assert.equal(state.api, 0);
    assert.equal(state.worker, 1);
    assert.deepEqual(await f.events(), ["scale-api"]);
    assert.equal(existsSync(join(f.evidence, "helm-started")), false);
  });

  test("quiescence refuses a worker changed after observation and preserves partial recovery", async (t) => {
    for (const fault of ["replace-worker-before-scale", "edit-worker-before-scale"]) {
      await t.test(fault, async (t) => {
        const f = await fixture(t);
        await f.failNext(fault);
        const failure = await expectUpgradeFailure(
          f.run(),
          "the changed worker must refuse scaling",
        );
        const state = await f.state();
        const events = await f.events();
        t.diagnostic(JSON.stringify({ api: state.api, worker: state.worker, events }));
        assert.equal(failure.code, 1);
        assert.equal(state.api, 0);
        assert.equal(state.worker, 1);
        assert.equal(
          asRecord(asRecord(state.deploymentIdentities)?.worker)?.uid,
          fault === "replace-worker-before-scale"
            ? "replacement-worker-uid"
            : "worker-deployment-uid",
        );
        assert.equal(existsSync(join(f.evidence, "helm-started")), false);
        assert.deepEqual(await f.events(), ["scale-api"]);
        assert.equal(
          await f.readEvidence("native-command-failures.tsv"),
          "quiescence-scale\tworker\t1\n",
        );
        // After the operator reconciles the conflict, resume observes the current
        // worker and the already-stopped API instead of replaying stale preconditions.
        await f.run("--resume");
        assert.deepEqual(await f.events(), [
          "scale-api",
          "scale-worker",
          "secret-replaced",
          "migration",
        ]);
        assert.equal((await f.state()).worker, 1);
      });
    }
  });

  test("native failure status survives failed diagnostics and receipt writes", async (t) => {
    for (const [stderr, blockedReceipt] of [
      ["/dev/full", false],
      [null, true],
      ["/dev/full", true],
      ["pipe", true],
    ] as const) {
      await t.test(
        `${stderr ?? "normal stderr"}, blocked receipt: ${blockedReceipt}`,
        async (t) => {
          let sink: FileHandle | undefined;
          if (stderr === "/dev/full") {
            try {
              sink = await open("/dev/full", constants.O_WRONLY);
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                throw error;
              }
              t.skip("requires /dev/full (Linux)");
              return;
            }
            const fullDevice = sink;
            t.after(() => fullDevice.close());
          }
          const f = await fixture(t);
          await f.failNext("fail-scale-worker");
          // A directory denies receipt append even when the test runs as root.
          if (blockedReceipt) {
            await f.failNext("block-failure-receipt");
          }
          const status = sink
            ? (await f.runWithStderr(sink.fd)).status
            : (
                await expectUpgradeFailure(
                  stderr === "pipe" ? f.runWithBrokenPipe() : f.run(),
                  "worker scale must fail",
                )
              ).code;
          const path = join(f.evidence, "native-command-failures.tsv");
          const events = await f.events();
          t.diagnostic(JSON.stringify({ status, events }));
          assert.equal(status, 9);
          assert.equal((await f.state()).api, 0);
          assert.equal((await f.state()).worker, 1);
          assert.equal(existsSync(join(f.evidence, "helm-started")), false);
          assert.deepEqual(events, ["scale-api"]);
          if (blockedReceipt) {
            assert.deepEqual(await readdir(path), []);
          } else {
            await assertPrivateReceipt(path, "quiescence-scale\tworker\t9\n");
          }
        },
      );
    }
  });

  test("failed Helm migration keeps old writers stopped and requires checked history and a terminal Job", async (t) => {
    const f = await fixture(t);
    await runWithInjectedFault(f, "fail-migration");
    assert.equal((await f.state()).api, 0);
    assert.equal((await f.state()).worker, 0);
    await assert.rejects(f.run("--resume"), /migration --check/);
    const state = await f.state();
    // An active Job may schedule a replacement even with no active Pods.
    state.initJobActive = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(
      f.run("--resume", "--migration-history-checked"),
      /initialization Job is still active/,
    );
    state.initJobActive = false;
    state.initActive = true;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    await assert.rejects(
      f.run("--resume", "--migration-history-checked"),
      /initialization Pod is still active/,
    );
    state.initActive = false;
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
    // The accepted failure consumed revision 2. A retry must bind revision 3;
    // losing its response must still resume without a third submission.
    await runWithInjectedFault(f, "lost-helm-response", "--resume", "--migration-history-checked");
    await assertHelmIntent(f, 2, 3);
    await f.run("--resume");
    assert.equal((await f.state()).version, 3);
    assert.equal((await f.events()).filter((event) => event === "migration").length, 2);
  });

  registerUnknownAgentDeploymentResumeTest(fixture);

  describe("resume evidence directory ownership", { concurrency: 2 }, () => {
    test("resume binds stale prepared copies to the original evidence directory before live access", async (t) => {
      const f = await fixture(t, { agent: true });
      await runWithInjectedFault(f, "fail-rollout-worker");
      const copy = join(f.directory, "stale-copy");
      await cp(f.evidence, copy, { recursive: true });

      // The copy predates dispatch. The original records a later accepted request
      // whose response was lost; replay from the stale copy would deploy twice.
      await f.failNext("lost-agent-response");
      await assert.rejects(f.run("--resume"), /deployment outcome is unknown/);
      assert.equal((await f.state()).dispatches, 1);
      const lock = join(f.evidence, ".upgrade-lock");
      await mkdir(lock);
      const calls = f.commands.length;
      const refusal = await expectUpgradeFailure(
        f.run("--resume", "--evidence-dir", copy),
        "the stale evidence copy must be refused",
      );
      assert.equal(
        (await f.state()).dispatches,
        1,
        "a stale copy must not replay the accepted dispatch",
      );
      assert.match(refusal.stderr, /resume evidence directory/);
      assert.equal(f.commands.length, calls, "reject before external commands, including reads");
      assert.ok(existsSync(lock), "a copy must not remove the original's held lock");
      await rm(lock, { recursive: true });
      await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
      assert.equal((await f.state()).dispatches, 1);
    });

    test("resume binds moved and replaced evidence directories before live access", async (t) => {
      for (const change of ["move", "replacement", "missing identity"]) {
        await t.test(change, async (t) => {
          const f = await fixture(t, { agent: true });
          await runWithInjectedFault(f, "fail-scale-worker");
          const moved = join(f.directory, "moved-evidence");
          if (change === "missing identity") {
            const path = join(f.evidence, "parameters.json");
            const parameters = asRecord(JSON.parse(await readFile(path, "utf8")));
            assert.ok(parameters, "expected a prepared parameters receipt");
            assert.ok("evidenceDirectory" in parameters);
            delete parameters.evidenceDirectory;
            await writeFile(path, JSON.stringify(parameters));
          } else {
            await rename(f.evidence, moved);
            if (change === "replacement") {
              await cp(moved, f.evidence, { recursive: true });
            }
          }
          const calls = f.commands.length;
          await assert.rejects(
            f.run("--resume", "--evidence-dir", change === "move" ? moved : f.evidence),
            /resume evidence directory/,
          );
          assert.equal(
            f.commands.length,
            calls,
            "reject before external commands, including reads",
          );
          assert.equal((await f.state()).dispatches, 0);
          if (change === "move") {
            await rename(moved, f.evidence);
            await f.run("--resume");
            assert.equal((await f.state()).dispatches, 1);
          }
        });
      }
    });

    test("resume accepts the original evidence directory and canonical aliases", async (t) => {
      for (const alias of ["original", "relative", "parent symlink"]) {
        await t.test(alias, async (t) => {
          const f = await fixture(t, { agent: true });
          await runWithInjectedFault(f, "fail-scale-worker");
          let evidence = f.evidence;
          if (alias === "relative") {
            evidence = relative(repository, f.evidence);
          } else if (alias === "parent symlink") {
            const parent = join(f.directory, "parent-alias");
            symlinkSync(f.directory, parent, "dir");
            evidence = join(parent, "evidence");
          } else {
            // Canonicalization must not bypass the existing leaf-symlink or mode guards.
            const leaf = join(f.directory, "leaf-alias");
            symlinkSync(f.evidence, leaf, "dir");
            const calls = f.commands.length;
            await assert.rejects(
              f.run("--resume", "--evidence-dir", leaf),
              /requires the original evidence directory/,
            );
            await chmod(f.evidence, 0o755);
            await assert.rejects(f.run("--resume"), /must not grant group or other permissions/);
            await chmod(f.evidence, 0o700);
            assert.equal(f.commands.length, calls);
          }
          // Aliases must still share the original lock, not create another lock.
          const lock = join(f.evidence, ".upgrade-lock");
          await mkdir(lock);
          const calls = f.commands.length;
          await assert.rejects(
            f.run("--resume", "--evidence-dir", evidence),
            /evidence directory is locked/,
          );
          assert.equal(f.commands.length, calls);
          await rm(lock, { recursive: true });
          await f.run("--resume", "--evidence-dir", evidence);
          assert.equal((await f.state()).dispatches, 1);
          assert.equal(existsSync(lock), false);
        });
      }
    });

    test("newline-suffixed evidence paths never use the existing sibling directory", async (t) => {
      const f = await fixture(t, { agent: true });
      const evidence = f.evidence + "\n";
      const siblingParameters = join(f.evidence, "parameters.json");
      const sentinel = "Preserve the unrelated sibling's evidence.\n";
      await mkdir(f.evidence, { mode: 0o700 });
      await writeFile(siblingParameters, sentinel, { mode: 0o600 });

      // Shell command substitution would strip the newline, redirecting both
      // the lock and evidence writes into the pre-existing sibling directory.
      await runWithInjectedFault(f, "fail-scale-worker", "--evidence-dir", evidence);
      assert.equal(await readFile(siblingParameters, "utf8"), sentinel);
      assert.deepEqual(await readdir(f.evidence), ["parameters.json"]);
      assert.ok(existsSync(join(evidence, "prepared")));

      const lock = join(evidence, ".upgrade-lock");
      await mkdir(lock);
      const calls = f.commands.length;
      await assert.rejects(
        f.run("--resume", "--evidence-dir", evidence),
        /evidence directory is locked/,
      );
      assert.equal(f.commands.length, calls);
      await rm(lock, { recursive: true });

      // A lock held by the sibling must neither block this resume nor be removed.
      const siblingLock = join(f.evidence, ".upgrade-lock");
      await mkdir(siblingLock);
      await f.run("--resume", "--evidence-dir", evidence);
      assert.equal((await f.state()).dispatches, 1);
      assert.equal(existsSync(lock), false);
      assert.ok(existsSync(siblingLock));
      assert.equal(await readFile(siblingParameters, "utf8"), sentinel);
      assert.deepEqual((await readdir(f.evidence)).sort(), [".upgrade-lock", "parameters.json"]);
    });
  });

  // OCC admits a deploy in one transaction, so a 4xx answer with an OCC error code saved
  // no revision: the helper names the Agent and the refusal, and --resume deploys it
  // again. A 408 or 5xx answer, like a lost response, leaves the outcome unknown, and so
  // does stderr with a second "Error: " line, here inside OCC's message. A refused service
  // key is the helper's own credential failing, not an Agent refusal. occ refuses before the
  // deploy request when it cannot establish the requested Harness overrides, which also saves
  // no revision. Each case deploys two Agents; OCC accepts agt_ok, which is neither named nor
  // deployed again on resume.
  const refusedField =
    "Configuration setting tools.gatewayPolicy.actions.sessions must use reviewed task actions.";
  const unknownOverrides =
    "revision rev_5f34f0b3-e660-4106-88a9-fa4df634398d has unreadable saved settings (SAVED_CONFIGURATION_UNREADABLE: harnessAuth) and the Agent's revision list has no Harness summary for it, so its requested Harness overrides are unknown; pass them with --harness-overrides instead";
  for (const { name, error, refusal, keyRefused = false, notSent = false } of [
    {
      name: "HTTP 400",
      // occ indents the rejected field's details under the message; a control character
      // in OCC's message must not reach the terminal.
      error:
        `Error: OCC operation failed (HTTP 400): INVALID_REQUEST: ${refusedField}\u001b[2J\n` +
        '  {"path":"tools.gatewayPolicy.actions.sessions","code":"invalid_value"}',
      refusal: `OCC operation failed (HTTP 400): INVALID_REQUEST: ${refusedField}?[2J {"path":"tools.gatewayPolicy.actions.sessions","code":"invalid_value"}`,
    },
    {
      name: "HTTP 401 for the service key",
      error:
        "Error: OCC rejected the service key in /keys/upgrade.json: it is invalid, expired or revoked. Ask an Installation administrator for a new key.",
      refusal:
        "OCC rejected the service key in /keys/upgrade.json: it is invalid, expired or revoked. Ask an Installation administrator for a new key.",
      keyRefused: true,
    },
    {
      name: "occ's refusal before the deploy request",
      error: `Error: ${unknownOverrides}`,
      refusal: unknownOverrides,
      notSent: true,
    },
    {
      name: "HTTP 408",
      error: "Error: OCC operation failed (HTTP 408): REQUEST_TIMEOUT: The request timed out.",
    },
    {
      name: "HTTP 503",
      error:
        "Error: OCC operation failed (HTTP 503): DEPENDENCY_UNAVAILABLE: The selected compute Driver is unavailable.",
    },
    {
      name: "HTTP 503 whose message carries a refusal line",
      error:
        "Error: OCC operation failed (HTTP 503): DEPENDENCY_UNAVAILABLE: upstream answered\n" +
        `Error: OCC operation failed (HTTP 400): INVALID_REQUEST: ${refusedField}`,
    },
  ]) {
    const outcome = keyRefused
      ? "a service-key failure"
      : notSent
        ? "not sent and redeployed on resume"
        : refusal
          ? "refused and redeployed on resume"
          : "an unknown outcome";
    test(`an Agent deploy answered with ${name} is ${outcome}`, async (t) => {
      const f = await fixture(t, {
        inventoryNamespaces: [embeddedDoctorNamespace("agt_ok", "agt_test")],
        names: { ns_test: "Support", agt_ok: "Accepted", agt_test: "Mail triage" },
      });
      const state = await f.state();
      state.deployFailures = { agt_test: error };
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      const failure = await expectUpgradeFailure(
        f.run(),
        "the upgrade must stop at the failed deploy",
      );
      const prefix = join(f.evidence, "dispatch/ns_test--agt_test");
      assert.doesNotMatch(failure.stderr, /agt_ok/);
      assert.equal(existsSync(join(f.evidence, "dispatch/ns_test--agt_ok.json")), true);
      if (!refusal) {
        assert.deepEqual(failure.stderr.trimEnd().split("\n"), [
          `upgrade-production-images: at least one Agent deployment outcome is unknown; inspect ${join(f.evidence, "dispatch")} and reconcile it before resuming:`,
          '  - Agent agt_test "Mail triage" in Namespace ns_test',
        ]);
        assert.equal(existsSync(prefix + ".rejected"), false);
        await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
        assert.equal((await f.state()).dispatches, 2);
        return;
      }
      assert.deepEqual(
        failure.stderr.trimEnd().split("\n"),
        keyRefused
          ? [
              `upgrade-production-images: OCC rejected the service key in ${join(f.directory, "key")}, so it did not deploy 1 recorded Agent(s) and saved no revision for them:`,
              '  - Agent agt_test "Mail triage" in Namespace ns_test',
              "The key is invalid, expired or revoked; the Agents are not at fault. Ask an Installation administrator for a new key, point OCC_SERVICE_KEY_FILE at it, then repeat this command with --resume and the same evidence directory. The resume deploys these Agents once.",
            ]
          : notSent
            ? [
                "upgrade-production-images: occ sent no deployment request for 1 recorded Agent(s), so OCC saved no revision for them:",
                `  - Agent agt_test "Mail triage" in Namespace ns_test: ${refusal}`,
                "occ could not establish the Harness overrides that each Agent's active revision requested. Correct what each error names, then repeat this command with --resume and the same evidence directory. The resume deploys each of these Agents once; do not deploy it yourself. The errors are in dispatch/*.rejected.",
              ]
            : [
                "upgrade-production-images: OCC refused to deploy 1 recorded Agent(s) with the new release and saved no revision for them:",
                `  - Agent agt_test "Mail triage" in Namespace ns_test: ${refusal}`,
                "Correct what each refusal names, such as a Configuration setting the new release refuses, then repeat this command with --resume and the same evidence directory. The resume deploys each refused Agent once; do not deploy it yourself. The refusals are in dispatch/*.rejected.",
              ],
      );
      assert.equal(await readFile(prefix + ".rejected", "utf8"), refusal + "\n");
      assert.equal(existsSync(prefix + ".intent"), false);
      // The operator corrected the cause; the resume sends only the refused deploy, once.
      await f.run("--resume");
      assert.equal((await f.state()).dispatches, 3);
      assert.deepEqual(
        (await f.events()).filter((event) => event.startsWith("agent-deploy")).sort(),
        ["agent-deploy agt_ok", "agent-deploy agt_test", "agent-deploy-failed agt_test"],
      );
    });
  }

  test("a failed deployment poll preserves the last observed Agent status", async (t) => {
    const f = await fixture(t, { agent: true });
    // The second poll writes a complete succeeded response before the CLI exits with an error.
    await f.failNext("deployment-status-running");
    await runWithInjectedFault(f, "fail-deployment-status-after-output");
    assert.equal(existsSync(join(f.evidence, "completed")), false);
    const snapshot = join(f.evidence, "status/ns_test--agt_test--rev_new.json");
    const identity = { namespaceId: "ns_test", agentId: "agt_test", deploymentId: "rev_new" };
    const running = JSON.stringify({ ...identity, status: "running" });
    assert.equal(await readFile(snapshot, "utf8"), running);

    // A successful CLI can also return an invalid state. Shell output capture
    // strips trailing newlines, so compare the state inside the JSON document.
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify({
        ...(await f.state()),
        deploymentStatusResponses: {
          rev_new: { stdout: JSON.stringify({ ...identity, status: "succeeded\n" }) },
        },
      }),
    );
    await assert.rejects(f.run("--resume"), /invalid deployment status/);
    assert.equal(await readFile(snapshot, "utf8"), running);
    assert.equal(existsSync(join(f.evidence, "completed")), false);
  });

  registerAcceptedAgentDeployNoticeTest(fixture);

  // Doctor shares the serving gateway container's memory limit, and an out-of-memory
  // kill there stops the gateway too (finding 2697). Doctor, with a 384 MiB heap cap,
  // starts after one read with 1 GiB free or two reads in a row with 640 MiB (the cap,
  // off-heap memory and a margin); a dropped connection is read again, and a kill is named.
  const doctorCommand = (heap: number | string) =>
    `doctor env NODE_OPTIONS=--max-old-space-size=${heap} node /app/openclaw.mjs doctor --lint --json --severity-min error`;
  const doctorEvents = async (f: Pick<RecoveryFixture, "events">) =>
    (await f.events()).filter((event) => /^(gateway-memory|doctor) /.test(event));
  const updateDoctorFixtureState = async (
    f: Pick<RecoveryFixture, "state" | "directory">,
    fields: Partial<RecoveryState>,
  ) => {
    const state = await f.state();
    Object.assign(state, fields);
    await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  };
  const scriptGatewayMemory = (f: RecoveryFixture, reads: (number | string | null)[]) =>
    updateDoctorFixtureState(f, { gatewayFree: reads });

  // Exit 137 is a kill. Only the gateway container's status, with a restart after the
  // gateway became Ready, shows that the container hit its memory limit.
  test("OpenClaw Doctor waits for free gateway memory and names an OOM kill only from the container status", async (t) => {
    const f = await fixture(t, { agent: true });
    // Free MiB per read: a low read resets the count of good reads.
    await scriptGatewayMemory(f, ["transient", 700, 300, 700, 640]);
    await f.failNext("doctor-oom");
    const oom = await expectUpgradeFailure(
      f.run(),
      "the upgrade must stop when the gateway is OOM-killed",
    );
    assert.deepEqual(await doctorEvents(f), [
      "gateway-memory transient",
      "gateway-memory 700",
      "gateway-memory 300",
      "gateway-memory 700",
      "gateway-memory 640",
      doctorCommand(384),
    ]);
    assert.doesNotMatch(oom.stderr, /without checking its free memory/);
    assert.match(
      oom.stderr,
      /OpenClaw Doctor was killed \(exit 137\) in Agent agt_test's gateway\.\n.*Agent agt_test's gateway container was OOM-killed and restarted 1 time\(s\) after it became Ready/,
    );
    assert.match(oom.stderr, /OpenClaw Doctor failed for at least one replacement gateway/);
    // Resume runs Doctor again without a new deploy. Kubernetes kills the container for
    // another reason now: exit 137 again, but no OOM kill. Only the restart after this
    // run's Ready gateway counts; the earlier OOM restart predates it.
    await scriptGatewayMemory(f, [null]);
    await f.failNext("doctor-killed");
    const killed = await expectUpgradeFailure(
      f.run("--resume"),
      "the upgrade must stop when Doctor is killed",
    );
    assert.match(
      killed.stderr,
      /OpenClaw Doctor was killed \(exit 137\) in Agent agt_test's gateway\.\n.*Agent agt_test's gateway container restarted 1 time\(s\) after it became Ready \(last termination: Error\)\./,
    );
    assert.doesNotMatch(killed.stderr, /OOM-killed and restarted/);
    // A gateway without a memory limit (memory.max reads "max") has room.
    await scriptGatewayMemory(f, ["unlimited"]);
    await f.run("--resume");
    assert.equal((await f.state()).dispatches, 1);
    assert.deepEqual((await doctorEvents(f)).slice(6), [
      "gateway-memory 2048",
      doctorCommand(384),
      "gateway-memory unlimited",
      doctorCommand(384),
    ]);
  });

  // These cases each wait out a real upgrade timeout (3 s or 8 s) with their own fixture,
  // so they run side by side instead of one after another.
  describe("OpenClaw Doctor at the upgrade timeout", { concurrency: true }, () => {
    // A memory timeout at one gateway starts no further Doctor but waits for the ones
    // already running: the evidence lock must outlast them, or a second upgrade could
    // start while a Doctor still runs in a serving gateway. Doctor's own exit status, not
    // an exit code quoted on its stderr, classifies its failure.
    test("a Doctor memory timeout keeps the evidence lock until every started Doctor ends", async (t) => {
      // A poll that finds the deadline passed reads nothing; the timeout still names B's last
      // read (0 MiB), not "unknown".
      const f = await fixture(t, {
        inventoryNamespaces: [embeddedDoctorNamespace("agt_a", "agt_b")],
      });
      // Gateway A has room at once; gateway B never does before the 3 s timeout. A's Doctor
      // runs past the timeout.
      await scriptGatewayMemory(f, [2048, ...Array.from({ length: 20 }, () => 0)]);
      const state = await f.state();
      state.doctorHoldMs = 6000;
      // The gateway was OOM-killed once before it became Ready; that restart is not Doctor's.
      state.gatewayRestarts = 1;
      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      await f.failNext("doctor-hold");
      const failure = await expectUpgradeFailure(
        f.run("--timeout-seconds", "3"),
        "the upgrade must stop at the memory timeout",
      );
      // Bounded wait: without the join, A ends after the command has exited.
      for (let tries = 0; tries < 100; tries += 1) {
        if ((await f.events()).some((event) => event.startsWith("doctor-ended "))) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const events = await f.events();
      assert.deepEqual(
        events.filter((event) => event.startsWith("doctor")),
        [doctorCommand(384), "doctor-ended lock held"],
      );
      assert.equal(existsSync(join(f.evidence, ".upgrade-lock")), false);
      const lines = failure.stderr.trimEnd().split("\n");
      assert.deepEqual(lines.slice(-3, -1), [
        "upgrade-production-images: OpenClaw Doctor failed (exit 1) in Agent agt_a's gateway.",
        "upgrade-production-images: Agent agt_a's gateway container did not restart after it became Ready.",
      ]);
      const lastLine = lines.at(-1);
      assert.ok(lastLine);
      assert.match(
        lastLine,
        /Agent agt_b's gateway did not keep 640 MiB free below its memory limit before the upgrade timeout \(last read: 0 MiB free\), so OpenClaw Doctor did not run/,
      );
    });

    test("OpenClaw Doctor does not run while the gateway lacks free memory", async (t) => {
      const f = await fixture(t, { agent: true });
      // Every read is 1 MiB short; the timeout names the last one, even when the final poll
      // finds the deadline passed and reads nothing.
      await scriptGatewayMemory(
        f,
        Array.from({ length: 20 }, () => 639),
      );
      await assert.rejects(
        f.run("--timeout-seconds", "3"),
        /Agent agt_test's gateway did not keep 640 MiB free below its memory limit before the upgrade timeout \(last read: 639 MiB free\), so OpenClaw Doctor did not run/,
      );
      assert.equal(
        (await f.events()).some((event) => event.startsWith("doctor ")),
        false,
      );
    });

    // A read can admit Doctor and still end at the deadline. Doctor then does not start,
    // and the error is a plain timeout: the gateway had the memory, so the low-memory
    // message (with its "last read" of ample memory) would contradict itself.
    test("OpenClaw Doctor admitted at the upgrade deadline reports a plain timeout", async (t) => {
      const f = await fixture(t, { agent: true });
      // The low read and the slow read both start well before the 8 s deadline.
      await scriptGatewayMemory(f, [300, "slow:2048"]);
      const failure = await expectUpgradeFailure(
        f.run("--timeout-seconds", "8"),
        "the upgrade must stop at the timeout",
      );
      assert.deepEqual(await doctorEvents(f), ["gateway-memory 300", "gateway-memory slow:2048"]);
      assert.equal(
        failure.stderr.trimEnd().split("\n").at(-1),
        "upgrade-production-images: OpenClaw Doctor did not run before the upgrade timeout.",
      );
    });

    test(
      "OpenClaw Doctor keeps low memory admission closed across missing and transient reads",
      { concurrency: true },
      async (t) => {
        const cases: Promise<void>[] = [];
        for (const unavailable of ["missing", "transient"]) {
          cases.push(
            t.test(unavailable, async (t) => {
              const f = await fixture(t, { agent: true });
              // Do not exhaust the script: the fixture defaults to ample memory afterward.
              await scriptGatewayMemory(f, [
                300,
                ...Array.from({ length: 100 }, () => unavailable),
              ]);
              // The reads after the low one measure nothing; the timeout names the low one.
              await assert.rejects(
                f.run("--timeout-seconds", "8"),
                /before the upgrade timeout \(last measured: 300 MiB free; later reads failed\), so OpenClaw Doctor did not run/,
              );
              const events = await doctorEvents(f);
              assert.equal(events[0], "gateway-memory 300");
              assert.ok(events.includes(`gateway-memory ${unavailable}`));
              assert.ok(!events.includes("gateway-memory 2048"));
              assert.ok(!events.some((event) => event.startsWith("doctor ")));
            }),
          );
        }
        await Promise.all(cases);
      },
    );
  });

  test("OpenClaw Doctor retains warning and run for initially unavailable transport observations", async (t) => {
    const f = await fixture(t, { agent: true });
    await scriptGatewayMemory(
      f,
      Array.from({ length: 3 }, () => "transient"),
    );
    const result = await f.run();
    assert.match(result.stderr, /running OpenClaw Doctor without checking its free memory/);
    assert.deepEqual(await doctorEvents(f), [
      ...Array.from({ length: 3 }, () => "gateway-memory transient"),
      doctorCommand(384),
    ]);
  });

  test("OpenClaw Doctor recovers with fresh consecutive memory evidence after observation failures", async (t) => {
    const f = await fixture(t, { agent: true });
    const reads = [
      300,
      "transient",
      "transient",
      "transient",
      700,
      "missing",
      700,
      "transient",
      700,
      640,
    ];
    await scriptGatewayMemory(f, reads);
    await f.run();
    assert.deepEqual(await doctorEvents(f), [
      ...reads.map((free) => `gateway-memory ${free}`),
      doctorCommand(384),
    ]);
  });

  test("candidate database identity refuses an upgrade before writer shutdown", async (t) => {
    assert.ok(realHelm, "helm is required to exercise the stock chart");
    type IdentityAnswer = { rows: Record<string, string>[] } | { error: string } | { hang: true };
    let answer: IdentityAnswer = { rows: [{ id: "ins_other" }] };
    const f = await fixture(t, {
      controllerOnly: true,
      chart: {
        values: (values) => ({
          ...values,
          database: {
            ...values.database,
            secretName: "candidate-database",
            appUrlKey: "writer-connection",
          },
        }),
        installation: (installation) => installation,
      },
      databaseAnswer: () => answer,
    });
    // The incumbent name and administrator are unchanged. Only the candidate
    // database's singleton ID differs. Real bootstrap/SQL proof is separate.
    await assert.rejects(f.run(), (error: unknown) => {
      const { stderr } = readUpgradeFailure(error);
      assert.match(stderr, /does not identify the incumbent Installation/);
      assert.doesNotMatch(stderr, /ins_other|fixture-only|postgresql:\/\//);
      return true;
    });
    await assertStoppedBeforeWriters(f);
    assert.equal(f.databaseSessions.length, 2);
    for (const session of f.databaseSessions) {
      assert.equal(session.user, "candidate_app");
      assert.equal(session.database, "candidate");
      assert.equal(session.queries[0], "BEGIN READ ONLY");
    }
    // Exercise the same generated identity-only command used on resume, with
    // the real rendered environment. Do not replay the shell for SQL permutations.
    for (const [name, response, component, diagnostic] of [
      ["matching API", { rows: [{ id: "ins_test" }] }, "api", null],
      ["matching worker", { rows: [{ id: "ins_test" }] }, "worker", null],
      ["worker mismatch", { rows: [{ id: "ins_other" }] }, "worker", /does not identify/],
      ["empty", { rows: [] }, "api", /does not identify/],
      [
        "ambiguous",
        { rows: [{ id: "ins_test" }, { id: "ins_other" }] },
        "api",
        /does not identify/,
      ],
      ["denied", { error: "private database diagnostic" }, "api", /could not be verified/],
      ["stalled", { hang: true }, "api", /could not be verified/],
    ] satisfies [string, IdentityAnswer, "api" | "worker", RegExp | null][]) {
      await t.test(name, { timeout: 25_000 }, async () => {
        answer = response;
        const previousSessions: number = f.databaseSessions.length;
        const result = await f.runIdentityCheck(component);
        // Each generated identity command must query the candidate DB as the application role.
        const [session] = f.databaseSessions.slice(previousSessions);
        assert.equal(f.databaseSessions.length, previousSessions + 1);
        assert.ok(session);
        assert.equal(session.user, "candidate_app");
        assert.equal(session.database, "candidate");
        assert.equal(session.queries[0], "BEGIN READ ONLY");
        assert.ok(session.queries.includes("SELECT id FROM occ.installation LIMIT 2"));
        assert.equal(result.phase, diagnostic ? "Failed" : "Succeeded");
        const log = result.log;
        assert.ok(typeof log === "string");
        if (diagnostic) {
          assert.match(log, diagnostic);
        }
        assert.doesNotMatch(
          log,
          /ins_other|private database diagnostic|fixture-only|postgresql:\/\//,
        );
      });
    }
    // pg parses other schemes as connection strings, but stock startup refuses
    // them. Neither generated entrypoint may open that otherwise reachable DB.
    answer = { rows: [{ id: "ins_test" }] };
    for (const action of ["job", "identity-job"] as const) {
      for (const component of ["api", "worker"] as const) {
        const previousSessions: number = f.databaseSessions.length;
        const result = await f.runIdentityCheck(component, action, "https:");
        assert.equal(result.phase, "Failed");
        const log = result.log;
        assert.ok(typeof log === "string");
        assert.match(log, /Installation identity could not be verified/);
        assert.doesNotMatch(log, /fixture-only|https:\/\/|candidate_app/);
        assert.equal(f.databaseSessions.length, previousSessions);
      }
    }
  });

  test(
    "OpenClaw Doctor reports unknown restart history unless Ready and post-read observations are comparable",
    { concurrency: true },
    async (t) => {
      const ready = doctorPod();
      const withoutRows = {
        ...ready,
        status: { phase: ready.status.phase, conditions: ready.status.conditions },
      };
      const replacement = doctorPod({ uid: "replacement-uid" });
      // Only Pod states the Kubernetes API returns: container statuses not reported, a Pod
      // replaced under the same name (new UID), and a lower restart count.
      const cases = [
        ["missing Ready row", withoutRows, doctorPod()],
        ["missing post row", doctorPod(), withoutRows],
        ["replacement Pod", doctorPod(), replacement],
        ["decreased count", doctorPod({ restartCount: 2 }), doctorPod({ restartCount: 1 })],
        [
          "additional restart without reason",
          doctorPod(),
          doctorPod({ restartCount: 1 }),
          "restart",
        ],
        ["true zero", doctorPod(), doctorPod(), true],
        ["unchanged nonzero", doctorPod({ restartCount: 3 }), doctorPod({ restartCount: 3 }), true],
      ] as const;
      const runs: Promise<void>[] = [];
      for (const [name, ready, after, comparable] of cases) {
        runs.push(
          t.test(name, async (t) => {
            const f = await fixture(t, { agent: true });
            await updateDoctorFixtureState(f, { gatewayReady: ready, gatewayAfter: after });
            await f.failNext("doctor-error");
            const failure = await expectUpgradeFailure(
              f.run(),
              "Doctor command failure must stop the upgrade",
            );
            assert.match(failure.stderr, /OpenClaw Doctor failed \(exit 1\)/);
            if (comparable === "restart") {
              assert.match(
                failure.stderr,
                /restarted 1 time\(s\) after it became Ready \(last termination: none\)/,
              );
              assert.doesNotMatch(
                failure.stderr,
                /did not restart|OOM-killed and restarted|history since Ready is unknown/,
              );
            } else if (comparable) {
              assert.match(
                failure.stderr,
                /gateway container did not restart after it became Ready/,
              );
              assert.doesNotMatch(failure.stderr, /restart history since Ready is unknown/);
            } else {
              assert.match(failure.stderr, /restart history since Ready is unknown/);
              assert.doesNotMatch(failure.stderr, /did not restart|OOM-killed and restarted/);
            }
          }),
        );
      }
      await Promise.all(runs);
    },
  );

  // Doctor passing proves nothing about a gateway that Kubernetes then evicted, replaced
  // or restarted (finding 2736: node memory pressure evicted a gateway after its Doctor
  // passed, and the upgrade still reported success). Each case changes the gateway right
  // after a passing Doctor, in a state the Kubernetes API returns.
  test(
    "a gateway changed after a passing Doctor fails the upgrade and resume checks its replacement",
    { concurrency: true },
    async (t) => {
      // The Deployment's replacement Pod, Ready on the new revision.
      const replacement = doctorPod({ name: "gateway-2", uid: "gateway-2-uid" });
      // The kubelet ends an evicted Pod and keeps it (phase Failed, reason Evicted).
      const evicted = doctorPod({ phase: "Failed", ready: false, reason: "Evicted" });
      // On the dogfood cluster the evicted gateway ended with phase Succeeded.
      const ended = doctorPod({ phase: "Succeeded", ready: false });
      const afterEviction = { revisionPods: [evicted, replacement] };
      const cases = [
        ["evicted", afterEviction, /was evicted \(phase Failed\)/],
        [
          "ended",
          { revisionPods: [ended, replacement] },
          /stopped \(phase Succeeded, reason none\)/,
        ],
        ["deleted", { revisionPods: [replacement] }, /no longer exists \(evicted or deleted\)/],
        [
          "replaced under the same name",
          { gatewayAfter: doctorPod({ uid: "gateway-uid-2" }) },
          /was replaced by a new Pod with the same name/,
        ],
        [
          "restarted",
          { gatewayRestarts: 1, gatewayLastReason: "Error" },
          /restarted 1 time\(s\) \(last termination: Error\)/,
        ],
        ["not Ready", { gatewayAfter: doctorPod({ ready: false }) }, /is not Ready/],
      ] satisfies [string, Record<string, unknown>, RegExp][];
      const runs: Promise<void>[] = [];
      for (const [name, afterDoctor, change] of cases) {
        runs.push(
          t.test(name, async (t) => {
            const f = await fixture(t, { agent: true });
            await updateDoctorFixtureState(f, { afterDoctor });
            const failure = await expectUpgradeFailure(
              f.run(),
              "a gateway changed after Doctor must stop the upgrade",
            );
            assert.match(
              failure.stderr,
              new RegExp(
                `Agent agt_test's gateway Pod tenant/gateway ${change.source} after it became Ready for OpenClaw Doctor\\.`,
              ),
            );
            assert.match(
              failure.stderr,
              /repeat the command with --resume and the same evidence directory/,
            );
            assert.doesNotMatch(failure.stdout, /Upgraded/);
            assert.deepEqual(
              (await f.events()).filter((event) => event.startsWith("doctor ")),
              [doctorCommand(384)],
            );
          }),
        );
      }
      await Promise.all(runs);
      // A gateway can still report Ready while its deletion is in progress.
      // Resume must run Doctor in its replacement without waiting for garbage collection.
      const ready = doctorPod();
      const retiring = {
        ...ready,
        metadata: { ...ready.metadata, deletionTimestamp: "2026-01-01T00:00:00Z" },
      };
      const f = await fixture(t, { agent: true });
      await updateDoctorFixtureState(f, { afterDoctor: { revisionPods: [retiring, replacement] } });
      await assert.rejects(f.run(), /is being deleted/);
      const resumed = await f.run("--resume", "--timeout-seconds", "10");
      assert.match(resumed.stdout, /Upgraded runtime image/);
      assert.equal((await f.state()).dispatches, 1);
      assert.deepEqual(
        (await f.events()).filter((event) => event.startsWith("doctor ")),
        [doctorCommand(384), doctorCommand(384)],
      );
      const targets = doctorTargets(await f.readEvidence("doctor-targets.jsonl"));
      assert.deepEqual(
        targets.map((target) => target.gatewayName),
        ["gateway-2"],
      );
      // An eviction while Doctor runs kills Doctor (exit 137) without a container restart. The
      // failure must still name the eviction, so it is not read as a Doctor or memory problem.
      const killed = await fixture(t, { agent: true });
      await updateDoctorFixtureState(killed, { afterDoctor: afterEviction });
      await killed.failNext("doctor-evicted");
      const failure = await expectUpgradeFailure(
        killed.run(),
        "a Doctor killed by an eviction must stop the upgrade",
      );
      assert.match(failure.stderr, /OpenClaw Doctor was killed \(exit 137\)/);
      assert.match(
        failure.stderr,
        /Agent agt_test's gateway Pod tenant\/gateway was evicted \(phase Failed\) after it became Ready for OpenClaw Doctor\./,
      );
      assert.match(failure.stderr, /OpenClaw Doctor failed for at least one replacement gateway/);
      assert.doesNotMatch(failure.stdout, /Upgraded/);
      // A dedicated Agent serves through its gateway and Codex agent Pods, and the readiness
      // wait requires both. Node memory pressure during the Doctors evicts only the agent Pod
      // (finding 2755): Doctor in the untouched gateway passes, but the upgrade must name the
      // agent Pod instead of reporting success, and resume checks the replacement.
      const dedicated = await fixture(t, {
        inventoryNamespaces: [
          {
            id: "ns_test",
            status: "ready",
            agents: [
              {
                id: "agt_test",
                status: "active",
                desiredRuntimeState: "running",
                executionMode: "dedicated",
                activeRevisionId: "rev_old",
                deploymentInProgress: false,
              },
            ],
          },
        ],
      });
      await updateDoctorFixtureState(dedicated, {
        revisionPods: [doctorPod(), doctorPod({ containerName: "agent" })],
        afterDoctor: {
          revisionPods: [
            doctorPod(),
            doctorPod({
              containerName: "agent",
              phase: "Failed",
              ready: false,
              reason: "Evicted",
            }),
            doctorPod({ containerName: "agent", name: "agent-2", uid: "agent-2-uid" }),
          ],
        },
      });
      const agentFailure = await expectUpgradeFailure(
        dedicated.run(),
        "an agent Pod evicted during Doctor must stop the upgrade",
      );
      assert.match(
        agentFailure.stderr,
        /Agent agt_test's agent Pod tenant\/agent was evicted \(phase Failed\) after it became Ready for OpenClaw Doctor\./,
      );
      assert.doesNotMatch(
        agentFailure.stderr,
        /gateway Pod tenant\/gateway|OpenClaw Doctor failed/,
      );
      assert.match(agentFailure.stderr, /did not stay on the same Ready Pod without restarts/);
      assert.doesNotMatch(agentFailure.stdout, /Upgraded/);
      const resumedDedicated = await dedicated.run("--resume");
      assert.match(resumedDedicated.stdout, /Upgraded runtime image/);
      assert.equal((await dedicated.state()).dispatches, 1);
      const [dedicatedTarget] = doctorTargets(
        await readFile(join(dedicated.evidence, "doctor-targets.jsonl"), "utf8"),
      );
      assert.ok(dedicatedTarget);
      assert.deepEqual(
        list(dedicatedTarget.revisionPods, "Doctor revision Pods").map((value) => {
          const pod = asRecord(value);
          assert.ok(pod, "expected a revision Pod record");
          return [pod.role, pod.name];
        }),
        [
          ["gateway", "gateway"],
          ["agent", "agent-2"],
        ],
      );
    },
  );

  // Doctors in several gateways on one node can together exhaust its memory, so they run
  // one at a time: each ends before the next gateway's memory check and Doctor start.
  test("OpenClaw Doctor runs in one gateway at a time", async (t) => {
    const f = await fixture(t, {
      inventoryNamespaces: [embeddedDoctorNamespace("agt_a", "agt_b", "agt_c")],
    });
    await updateDoctorFixtureState(f, { doctorSpanMs: 500 });
    await f.run();
    assert.deepEqual(
      (await f.events()).filter((event) => /^(gateway-memory|doctor)/.test(event)),
      Array.from({ length: 3 }, () => [
        "gateway-memory 2048",
        doctorCommand(384),
        "doctor-end",
      ]).flat(),
    );
  });

  // Values that would wrap shell arithmetic (a negative deadline or Doctor threshold)
  // are refused before any upgrade effect; the largest accepted values still run.
  test("upgrade options reject overflowing values before upgrade effects", async (t) => {
    for (const [flag, value, message] of [
      ["--doctor-heap-mib", "9223372036854775168", /must be at most 9223372036854775167/],
      ["--doctor-heap-mib", "9223372036854775808", /must be at most 9223372036854775167/],
      ["--doctor-heap-mib", "18446744073709551616", /must be at most 9223372036854775167/],
      ["--doctor-heap-mib", "9".repeat(100), /must be at most 9223372036854775167/],
      ["--timeout-seconds", "86401", /--timeout-seconds must be at most 86400/],
      ["--timeout-seconds", "9223372036854775807", /--timeout-seconds must be at most 86400/],
    ] as const) {
      const f = await fixture(t, { agent: true });
      const before = await f.state();
      await assert.rejects(f.run(flag, value), message);
      assert.deepEqual(await f.state(), before);
      assert.deepEqual(await f.events(), []);
      assert.equal(existsSync(f.evidence), false);
    }
    const f = await fixture(t, { agent: true });
    await scriptGatewayMemory(f, ["unlimited"]);
    await f.run("--doctor-heap-mib", "9223372036854775167", "--timeout-seconds", "86400");
    assert.deepEqual(await doctorEvents(f), [
      "gateway-memory unlimited",
      doctorCommand("9223372036854775167"),
    ]);
  });

  // A Doctor that exhausts its capped heap is named; resume with a larger cap, whose
  // memory gate grows with it. Without readable cgroup files Doctor runs with a warning.
  test("OpenClaw Doctor that runs out of its heap cap resumes with a larger cap", async (t) => {
    const f = await fixture(t, { agent: true });
    await scriptGatewayMemory(f, ["missing"]);
    await f.failNext("doctor-heap");
    const failure = await expectUpgradeFailure(
      f.run(),
      "the upgrade must stop when Doctor runs out of heap",
    );
    assert.match(failure.stderr, /running OpenClaw Doctor without checking its free memory/);
    assert.match(
      failure.stderr,
      /OpenClaw Doctor ran out of its 384 MiB heap in Agent agt_test's gateway\. Repeat the command with --resume and a larger --doctor-heap-mib/,
    );
    assert.deepEqual(await doctorEvents(f), ["gateway-memory missing", doctorCommand(384)]);
    // 1100 MiB is short of one read's 1408 MiB at a 768 MiB cap, so two reads are needed.
    await scriptGatewayMemory(f, [1100, 1100]);
    await f.run("--resume", "--doctor-heap-mib", "768");
    assert.equal((await f.state()).dispatches, 1);
    assert.deepEqual((await doctorEvents(f)).slice(2), [
      "gateway-memory 1100",
      "gateway-memory 1100",
      doctorCommand(768),
    ]);
  });
}
