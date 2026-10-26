import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// The controlled model drives three completed native turns. Each must demonstrate an
// assertion failure, fix it, run the resulting tests, commit and push. Only the first
// creates a draft. Provider state and the received Git objects are observed independently.
export const teamReviewProof = [
  "controlled-draft-and-tested-commit-observed",
  "review-feedback-advanced-same-draft",
  "later-turn-reauthorized-and-advanced-same-draft",
];
const exercise = [
  ["Trim a review title", "  Ready  ", "Ready", "s.trim()"],
  [
    "Collapse repeated spaces in a review title",
    "Code   review",
    "Code review",
    's.trim().replace(/ +/g, " ")',
  ],
  [
    "Handle tabs in a review title",
    "Review\tready",
    "Review ready",
    's.trim().replace(/\\s+/g, " ")',
  ],
];
const implementation = "review-title.mjs";
const check = "review-title.test.mjs";
const writeFile = (name, content) =>
  "cat >" + name + " <<'SKIPPER_FIXTURE'\n" + content + "SKIPPER_FIXTURE";
const readReceipt = (expression) =>
  'node -e \'const fs = require("node:fs"); const pr = JSON.parse(fs.readFileSync(".git/team-pull.json")); ' +
  expression +
  "'";

export async function runTeamReview({
  git,
  pre,
  dir,
  sendScript,
  witness,
  checkpoint,
  sessionId,
  uses,
}) {
  const originalRef = git.approvalRef;
  const branch = originalRef.slice("refs/heads/".length);
  const url = "https://github.com/" + git.repository;
  const title = "Normalize titles in review summaries";
  const operationId = randomUUID();
  assert.equal(originalRef, "refs/heads/review/skipper-acceptance-" + git.id);
  assert.equal(await witness("/pull"), null);
  const pullUrl = url + "/pull/1";
  const turns = new Set();
  let threadId;
  let parent = git.initialSha;
  let refs;
  for (const [stage, [task, , , change]] of exercise.entries()) {
    const testFile =
      'import assert from "node:assert/strict";\nimport { reviewTitle } from "./review-title.mjs";\n' +
      exercise
        .slice(0, stage + 1)
        .map(
          ([, input, output]) =>
            "assert.equal(reviewTitle(" +
            JSON.stringify(input) +
            "), " +
            JSON.stringify(output) +
            ");\n",
        )
        .join("");
    const moduleFile = "export const reviewTitle = (s) => " + change + ";\n";
    const enter =
      stage === 0
        ? [
            "git clone -- " + url + ".git " + dir,
            "cd " + dir,
            'test "$(git rev-parse HEAD)" = ' + git.initialSha,
            "git switch -c " + branch,
            "git config user.name Skipper; git config user.email skipper@example.invalid",
            writeFile(implementation, "export const reviewTitle = (s) => s;\n"),
          ]
        : [
            "cd " + dir,
            // Recover the target from the Agent's original PR receipt, then acquire the current
            // remote commit and prove we are its only expected successor, before modifying anything.
            "ref=$(" + readReceipt('process.stdout.write("refs/heads/" + pr.head.ref)') + ")",
            'test "$ref" = "$(git symbolic-ref HEAD)"',
            'test -z "$(git status --porcelain)"',
            'git fetch --no-tags origin "$ref"',
            'test "$(git rev-parse FETCH_HEAD)" = "$(git rev-parse HEAD)"',
            'test "$(git rev-parse HEAD)" = "$(cat .git/team-review-head)"',
          ];
    const submit =
      stage === 0
        ? [
            "/opt/oce/repository-credentials/bin/oce-github pr-create --head " +
              branch +
              " --base main --title '" +
              title +
              "' --body 'Check: node --test review-title.test.mjs'" +
              " --operation-id " +
              operationId +
              " --draft >.git/team-pull.json",
            readReceipt(
              'if (pr.head.sha !== fs.readFileSync(".git/team-review-head", "utf8").trim() || ' +
                'pr.draft !== true || pr.base.ref !== "main" || pr.head.ref !== "' +
                branch +
                '") process.exit(1); console.log(pr.url)',
            ),
          ]
        : [];
    const permits = await uses();
    const result = await sendScript(
      [
        ...pre,
        ...enter,
        writeFile(check, testFile),
        "if node --test " + check + " >.git/red 2>&1; then exit 55; fi",
        "grep -q ERR_ASSERTION .git/red",
        writeFile(implementation, moduleFile),
        "node --test " + check,
        "git add -- " + implementation + " " + check,
        "git diff --cached --check",
        "git commit -qm '" + task + "'",
        "git push origin HEAD:" + originalRef,
        "git rev-parse HEAD >.git/team-review-head",
        "cat .git/team-review-head",
        ...submit,
      ].join("\n"),
      task,
    );

    threadId ??= result.threadId;
    assert.equal(result.threadId, threadId, "continue the original task and retained workspace");
    assert.ok(result.turnId && !turns.has(result.turnId), "a separate, completed turn");
    turns.add(result.turnId);
    if (stage === 0) {
      assert.deepEqual(result.pullUrls, [pullUrl]);
    }
    const remote = await witness("/fetch");
    const { sha } = remote;
    assert.deepEqual(result.commitShas, [sha], "Agent reported the independently fetched commit");
    assert.deepEqual(
      [...remote.commit.matchAll(/^parent ([a-f0-9]{40})$/gm)].map((m) => m[1]),
      [parent],
    );
    refs = { "refs/heads/main": git.initialSha, [originalRef]: sha };
    assert.deepEqual(remote.refs, refs);
    const kind = stage === 0 ? "A" : "M";
    assert.deepEqual(
      remote.changed.sort(),
      [implementation, check].map((f) => kind + "\t" + f).sort(),
    );
    assert.deepEqual(remote.reviewFiles, { [implementation]: moduleFile, [check]: testFile });
    const pr = await witness("/pull");
    assert.equal(pr.html_url, pullUrl);
    assert.equal(pr.state, "open");
    assert.equal(pr.draft, true);
    assert.equal(pr.title, title);
    assert.equal(pr.head.ref, branch);
    assert.equal(pr.head.repo.full_name, git.repository);
    assert.equal(pr.head.sha, sha);
    assert.equal(pr.base.ref, "main");
    assert.equal(pr.base.sha, git.initialSha);
    const origin = await witness("/evidence");
    assert.equal(origin.endpoints["pull-create:201"], 1);
    assert.equal(
      origin.pullCreateRequests,
      1,
      "exactly one draft submission at the controlled provider",
    );
    assert.equal(origin.endpoints["receive-pack:200"], stage + 1);
    assert.ok((await uses()) > permits, "fresh authority use on the admitted session");
    await checkpoint(teamReviewProof[stage], {
      sessionId,
      threadId,
      turnId: result.turnId,
      parent,
      sha,
      pull: pr.number,
      repository: git.repository,
    });
    parent = sha;
  }
  return { sha: parent, refs };
}
