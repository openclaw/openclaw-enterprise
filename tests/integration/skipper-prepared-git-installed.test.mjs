import { isRecord, record } from "../helpers/egress-observation-values.ts";
import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import {
  assertOnlyTokenRetirement,
  fetchAfterWithdrawalCommand,
  withdrawDuringFetchCommand,
} from "../fixtures/skipper-private-git-origin.mjs";
import { runTeamReview } from "../fixtures/skipper-team-review-journey.mjs";
import { assertNativeRepositoryCommit } from "../helpers/repository-native-journey.mjs";
import { prepareComputeSkipper, waitFor } from "../helpers/skipper-prepared-compute.mjs";

const socketPath = process.env.OCC_TEST_SKIPPER_PRIVATE_GIT_WITNESS;
const selected = socketPath !== undefined || process.env.OCC_TEST_SKIPPER_PREPARED_GIT === "1";
const input = process.env.OCC_TEST_SKIPPER_COMPUTE_INPUTS;

test(
  "same Compute-owned Skipper chats, authors private Git, loses Git during an authenticated fetch, and still chats",
  {
    timeout: 30 * 60_000,
    skip: selected
      ? false
      : "requires a fresh Compute-owned installation with synthetic model and private Git",
  },
  async (t) => {
    const git = await witness("/input");
    assert.match(git.id, /^[a-f0-9]{16}$/);
    const team = process.env.OCC_TEST_SKIPPER_TEAM_REVIEW === "1";
    assert.equal(team, git.teamReview);
    assert.equal(
      git.approvalRef,
      "refs/heads/review/skipper-" + (team ? "acceptance-" : "") + git.id,
    );
    assert.equal(git.repository, "fixture/skipper-" + git.id);
    const cold = await witness("/evidence");
    assert.equal(cold.issued, 0);
    assert.deepEqual(
      cold.endpoints,
      {},
      "authoring the installation and describing repository options must not issue or access Git",
    );
    const {
      api,
      agentPath,
      revision,
      agent,
      query,
      namespaceId,
      checkpoint,
      ordinaryChat,
      sendScript,
      withdrawalBarrier,
      withdrawalBarrierPath,
    } = await prepareComputeSkipper(t, input, git.repositoryRef);
    const current = record(await api("GET", agentPath));
    assert.equal(current.activeRevisionId, revision.id);
    assert.deepEqual(current.repositoryBindings, [
      { repositoryRef: git.repositoryRef, profile: "git-write" },
    ]);
    const sessions = await query(
      `SELECT s.admission_id,s.session_id,b.generation
         FROM occ.repository_session_attempts s JOIN occ.repository_broker_receipts b
           ON b.admission_id=s.admission_id AND b.session_id=s.session_id
         WHERE s.namespace_id=$1 AND s.agent_id=$2 AND s.revision_id=$3 AND s.phase='open'
           AND s.broker_protocol=3 AND b.state='active' AND b.generation IS NOT NULL`,
      [namespaceId, agent.id, revision.id],
    );
    assert.equal(sessions.rowCount, 1, "one live, durable admission for this Compute revision");
    const session = sessions.rows[0];
    assert.match(session.generation, /^[a-f0-9-]{36}$/);
    const uses = async (operation = null) =>
      (
        await query(
          "SELECT count(*)::int AS n FROM occ.prepared_repository_git_uses WHERE admission_id=$1 AND ($2::text IS NULL OR operation=$2)",
          [session.admission_id, operation],
        )
      ).rows[0].n;
    await ordinaryChat("chat-before-private-git", "before-private-git");
    await waitFor("one background issuance before native Git", async () => {
      const state = await witness("/evidence");
      assert.ok(state.issued <= 1);
      assert.deepEqual(
        Object.keys(state.endpoints).filter((k) => /^(upload|receive)-/.test(k)),
        [],
      );
      return state.issued === 1;
    });
    await checkpoint("prepared-before-native-git", { sessionId: session.session_id });
    const content = "skipper-native-private-proof-" + randomUUID() + "\n";
    const dir = "skipper-" + git.id;
    const url = "https://github.com/" + git.repository + ".git";
    const pre = [
      "set -eu; set +x",
      // Check the delivered URL rewrite *before* opening a connection. Never select a real upstream.
      "u=$(git ls-remote --get-url " +
        url +
        '); case "$u" in https://git.*.svc.cluster.local/' +
        git.repository +
        ".git) ;; *) exit 53;; esac",
    ];
    const { sha, refs } = team
      ? await runTeamReview({
          git,
          pre,
          dir,
          sendScript,
          witness,
          checkpoint,
          sessionId: session.session_id,
          uses,
        })
      : await gitOnly();

    async function gitOnly() {
      const native = await sendScript(
        [
          ...pre,
          "git clone -- " + url + " " + dir,
          "cd " + dir,
          "git pull --ff-only",
          'test "$(git rev-parse HEAD)" = ' + git.initialSha,
          "git config user.name Skipper",
          "git config user.email skipper@example.invalid",
          "printf '%s' '" + content + "' > skipper-proof.txt",
          "git add -- skipper-proof.txt",
          "git commit -qm 'Private Skipper proof'",
          "git push origin HEAD:" + git.approvalRef,
          "git rev-parse HEAD",
        ].join("\n"),
        "native-push",
      );
      const remote = await witness("/fetch");
      const { sha, refs } = remote;
      assert.match(sha, /^[a-f0-9]{40}$/);
      assert.ok(
        native.commitShas.includes(sha),
        "actual native execution must produce the commit independently fetched from fresh storage",
      );
      assert.deepEqual(refs, { "refs/heads/main": git.initialSha, [git.approvalRef]: sha });
      assertNativeRepositoryCommit({
        baseSha: git.initialSha,
        parents: [...remote.commit.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]),
        files: remote.changed.map((line) => ({
          status: line.startsWith("A\t") ? "added" : "unexpected",
          filename: line.slice(2),
        })),
        file: "skipper-proof.txt",
        content,
        observedContent: remote.content,
      });
      const before = await witness("/evidence");
      assert.equal(before.endpoints["receive-pack:200"], 1);
      await checkpoint("native-commit-confirmed-by-independent-fetch", {
        sha,
        baseSha: git.initialSha,
      });
      return { sha, refs };
    }

    // The installed Compute path includes the native hook. Keep it, require *its* refusal,
    // and prove no origin write. In this synthetic repository only, separately send the mixed-ref
    // POST to exercise the broker boundary even for a client that doesn't run its local hook.
    const writePermits = await uses("receive-pack");
    assert.ok(writePermits > 0, "successful push must have gone through prepared authority");
    const protectedPush = await sendScript(
      [
        ...pre,
        "cd " + dir,
        'h=$(git config core.hooksPath); test -x "$h/pre-push"',
        "git commit --allow-empty -qm 'Client must not send this'",
        'denied(){ set +e; git push origin "$@" >denied.out 2>&1; c=$?; set -e; test "$c" != 0; grep -q repository-push-ref-not-allowed denied.out; }',
        "denied HEAD:refs/heads/main",
        "denied HEAD:" + git.approvalRef + " HEAD:refs/heads/not-allowed",
        'other="${u%/*}/not-this-repo.git"; if GIT_TERMINAL_PROMPT=0 git ls-remote "$other" >other.out 2>&1; then exit 54; fi',
        "grep -Eiq '400|401|403|404|denied|not found|not-admitted|terminal prompts disabled' other.out",
        "(set +e; LC_ALL=C GIT_TRACE_REDACT=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git -c core.hooksPath=/dev/null push origin HEAD:" +
          git.approvalRef +
          " HEAD:refs/heads/not-allowed; printf '\\nmixed-push-exit=%d\\n' \"$?\") 2>&1 | awk '",
        "/=> Send header: POST .*git-receive-pack / { post=1; basic=0 }",
        "/=> Send header: Authorization: Basic / { basic=post }",
        "/<= Recv header: HTTP.* 400 / { if (post && basic) denied++ }",
        "/^mixed-push-exit=[1-9][0-9]*$/ { failed++ }",
        "END {exit !(denied == 1 && failed == 1)}'",
        "git rev-parse --verify HEAD",
      ].join("\n"),
      "installed-push-hook-and-other-repository-deny",
    );
    assert.deepEqual(await witness("/refs"), refs);
    const denies = await witness("/evidence");
    assert.equal(
      await uses("receive-pack"),
      writePermits,
      "no credential release for the forbidden write",
    );
    assert.equal(denies.endpoints["receive-pack:200"], team ? 3 : 1);
    assert.equal(
      denies.endpoints["other:404"],
      undefined,
      "broker may not delegate another Git repository to the origin",
    );

    await checkpoint("wrong-repository-hook-refusal-and-broker-denied-mixed-push", {
      writePermits,
    });

    // Pause the same native Git process after its successful authenticated discovery, before
    // the upload POST. Closing the broker too early would cancel discovery itself.
    const barrierName = ".oce-git-withdrawal-" + git.id;
    const [checkoutHead, ...extraHeads] = protectedPush.commitShas;
    assert.ok(checkoutHead);
    assert.deepEqual(extraHeads, []);
    const barrier = await withdrawalBarrierPath(dir, checkoutHead);
    let completed;
    let released = false;
    const outcome = sendScript(
      withdrawDuringFetchCommand(dir, 401, barrierName),
      "withdraw-during-native-fetch",
    ).then(
      (value) => (completed = { value }),
      (error) => (completed = { error }),
    );
    try {
      await waitFor(
        "native Git stored its authenticated discovery before starting the upload",
        async () => {
          if (completed) {
            throw (
              completed.error ??
              new Error("the native Git command completed before its withdrawal barrier")
            );
          }
          return withdrawalBarrier(barrier, "ready");
        },
        60_000,
      );
      const prior = await witness("/evidence");
      const permits = await uses();
      assert.ok(permits > 0);
      const removed = await api("PATCH", agentPath, {
        configurationId: current.configurationId,
        repositoryBindings: [],
      });
      assert.equal(Object.hasOwn(record(removed), "repositoryBindings"), false);
      assert.ok(isRecord(removed));
      assert.equal(removed.activeRevisionId, revision.id);
      const retired = await waitFor(
        "the original broker session and provider token were disposed",
        async () => {
          const { rows } = await query(
            `SELECT s.phase, b.state, w.state AS work_state, w.reason_code
             FROM occ.repository_session_attempts s
             JOIN occ.repository_broker_receipts b USING (admission_id)
             LEFT JOIN occ.controller_work w ON w.idempotency_key=$6
             WHERE s.namespace_id=$1 AND s.agent_id=$2 AND s.revision_id=$3
               AND s.admission_id=$4 AND s.session_id=$5 AND b.session_id=$5 AND b.generation=$7`,
            [
              namespaceId,
              agent.id,
              revision.id,
              session.admission_id,
              session.session_id,
              repositoryRemovalWorkKey(revision.id),
              session.generation,
            ],
          );
          const row = rows[0];
          if (row?.work_state === "succeeded") {
            assert.equal(row.reason_code, "REPOSITORY_ACCESS_WITHDRAWN");
          }
          if (
            row?.phase !== "disposed" ||
            row?.state !== "disposed" ||
            row?.work_state !== "succeeded"
          ) {
            return undefined;
          }
          const evidence = await witness("/evidence");
          return evidence.endpoints["revoke:204"] ? evidence : undefined;
        },
        60_000,
      );
      assertOnlyTokenRetirement(prior, retired);
      released = await withdrawalBarrier(barrier, "release");
      assert.ok(released, "the exact native barrier must still be present");
      // The release receipt still uses the discovery checkpoint. Write it only after the
      // original Git process can continue past its discovery barrier.
      await checkpoint("repository-binding-withdrawn-discovery-released", {
        brokerDisposed: true,
      }).catch(() => {});
      const done = await outcome;
      const after = await witness("/evidence");
      assert.deepEqual(after, retired, "no new origin activity after releasing the native upload");
      assert.equal(
        await uses(),
        permits,
        "zero new permit after withdrawing repository binding from this running Agent",
      );
      if (done.error) {
        throw done.error;
      }
      await checkpoint("native-authenticated-post-after-withdrawal-refused", {
        gitSessionId: session.session_id,
        permits,
      });

      const bound = record(await api("GET", agentPath));
      assert.equal(bound.activeRevisionId, revision.id);
      assert.deepEqual(bound.repositoryBindings ?? [], []);
      const label = "fresh-authenticated-fetch-after-effective-withdrawal";
      await sendScript(fetchAfterWithdrawalCommand(dir, 401), label);
      const denied = await witness("/evidence");
      assert.deepEqual(denied, retired, "no new origin connection, request, issuance or token use");
      assert.equal(await uses(), permits, "no new provider credential release by this admission");
      await checkpoint(label + "-refused", {
        gitSessionId: session.session_id,
        permits,
        connections: denied.connections,
        requests: denied.requests,
      });
    } finally {
      if (!released) {
        await withdrawalBarrier(barrier, "release").catch(() => {});
      }
      await outcome;
    }
    await ordinaryChat("same-compute-owned-skipper-chat-after-git-withdrawal", "after-withdrawal");
    assert.deepEqual(await witness("/review/" + sha, "DELETE"), {
      "refs/heads/main": git.initialSha,
    });
    await checkpoint("same-compute-owned-skipper-chat-git-and-live-withdrawal-observed", {
      sha,
      agentId: agent.id,
      revisionId: revision.id,
    });
  },
);

function witness(path, method = "GET") {
  assert.match(socketPath ?? "", /^\/tmp\/oce-skipper-[a-zA-Z0-9]+\/witness\.sock$/);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, timeout: 10000 }, (res) => {
      let text = "";
      res
        .setEncoding("utf8")
        .on("data", (v) => (text += v))
        .on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error("owned private Git witness refused " + path));
          } else {
            resolve(JSON.parse(text));
          }
        });
    });
    req
      .on("error", reject)
      .on("timeout", () => req.destroy(new Error("private Git witness timeout")))
      .end();
  });
}
