import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { runAgentGrantRehearsal } from "../helpers/agent-grant-rehearsal.ts";
import { strandsRepositorySenderFixture } from "../helpers/strands-repository-sender.ts";
import { strandsNativeConversation } from "../helpers/strands-native-conversation.ts";

const selected = process.env.OCC_TEST_STRANDS_SENDER_REHEARSAL === "1";

test(
  "Strands sender refuses fresh Git after withdrawal while native Codex keeps its conversation",
  {
    skip: selected
      ? false
      : "select OCC_TEST_STRANDS_SENDER_REHEARSAL=1 and the native Codex executable",
    timeout: 90_000,
  },
  async (t) => {
    assert.equal(
      process.platform,
      "linux",
      "the rehearsal reads the original Linux process identity",
    );
    const executable = process.env.OCC_TEST_STANDING_GIT_CODEX;
    assert.ok(
      executable && isAbsolute(executable),
      "set OCC_TEST_STANDING_GIT_CODEX to the pinned native executable",
    );
    await access(executable, constants.X_OK);
    const native = await strandsNativeConversation(t, executable);
    const f = await strandsRepositorySenderFixture(t, "rehearsal-agent", native.pid);
    const route = await f.install();
    const checkout = join(f.root, "client");
    await f.git(["init", "--initial-branch=main", checkout]);
    const hasObject = async (sha: string) => {
      try {
        await f.git(["cat-file", "-e", sha + "^{commit}"], checkout);
        return true;
      } catch (error) {
        assert.equal((error as { code: unknown }).code, 128);
        return false;
      }
    };
    const observe = async (when: "before" | "after") => {
      const turn = await native.turn(when);
      assert.equal(
        turn.runtimeId,
        f.snapshot.installation.enforcement.repositoryGitRecipient?.processInstanceId,
      );
      return { agentId: f.execution.agentId, revisionId: f.execution.revisionId, ...turn };
    };
    await runAgentGrantRehearsal(t, async (scenario) => {
      scenario.modelBefore(await observe("before"));
      const first = await f.publishCommit("fresh permitted object\n");
      const beforePresent = await hasObject(first);
      const beforeRequests = f.writes.length;
      await route.remoteGit(["fetch", route.remote, "refs/heads/main"], checkout);
      scenario.gitFetched({
        expectedSha: first,
        beforePresent,
        afterSha: (await f.git(["rev-parse", "FETCH_HEAD"], checkout)).stdout.trim(),
        originRequests: f.writes.length - beforeRequests,
      });

      // Only the controlled authority withdraws. The real sender must enforce it
      // before opening the provider connection; model access remains independent.
      f.state.withdrawn = true;
      const next = await f.publishCommit("fresh forbidden object\n");
      const absentBefore = await hasObject(next);
      const baseline = f.writes.length;
      const connections = f.connections();
      const authorizations = f.authorizations.length;
      let exitCode: number | null = null;
      try {
        await route.remoteGit(["fetch", route.remote, "refs/heads/main"], checkout);
      } catch (error) {
        const failure = error as { code: number; stderr: string };
        exitCode = failure.code;
        assert.match(failure.stderr, /403/);
      }
      assert.equal(f.receipts.at(-1)?.stage, "material-refused");
      assert.equal(f.receipts.at(-1)?.reason, "withdrawn");
      assert.equal(
        f.authorizations.length,
        authorizations,
        "withdrawn material cannot reach authorization",
      );
      assert.equal(f.connections(), connections, "withdrawn Git cannot open a provider connection");
      scenario.gitRefused({
        expectedSha: next,
        beforePresent: absentBefore,
        afterPresent: await hasObject(next),
        exitCode,
        originRequests: f.writes.length - baseline,
      });
      scenario.modelAfter(await observe("after"));
    });
  },
);
