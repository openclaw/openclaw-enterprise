import assert from "node:assert/strict";

// Call only after the Agent is stopped and its credential sessions are disposed.
// A timeout is an unknown remote outcome: independently reconcile the exact
// owned branch and PR before deleting anything, even if task acceptance failed.
export async function cleanupRepositoryJourney({
  observe,
  repository,
  repositoryId,
  branch,
  base,
  baseSha,
  file,
  content,
  marker,
  commitMessage,
  readOnly,
  expectedSha,
}) {
  const { data: pulls } = await observe(
    "GET",
    `pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
  );
  const reference = await observe("GET", `git/ref/heads/${branch}`, undefined, [200, 404]);
  if (reference.status === 404) {
    assert.equal(pulls.length, 0, "PR remains after branch disappeared; retain for investigation");
    return;
  }
  const sha = reference.data.object.sha;
  if (readOnly) {
    assert.equal(sha, baseSha, "unexpected read-only branch cannot be cleaned automatically");
    assert.equal(pulls.length, 0, "unexpected PR prevents automatic cleanup");
  } else {
    const { data: commit } = await observe("GET", `commits/${sha}`);
    assert.deepEqual(
      commit.parents.map((parent) => parent.sha),
      [baseSha],
    );
    assert.equal(commit.commit.message, commitMessage);
    assert.deepEqual(
      commit.files.map((value) => ({ filename: value.filename, status: value.status })),
      [{ filename: file, status: "added" }],
    );
    const { data: remoteFile } = await observe("GET", `contents/${file}?ref=${sha}`);
    assert.equal(Buffer.from(remoteFile.content, "base64").toString("utf8"), content);
    if (expectedSha) {
      assert.equal(sha, expectedSha, "changed branch cannot be cleaned automatically");
    }
    assert.ok(pulls.length <= 1, "ambiguous PR ownership");
    for (const pull of pulls) {
      assert.equal(pull.body, marker);
      assert.equal(pull.head.ref, branch);
      assert.equal(pull.head.sha, sha);
      assert.equal(pull.head.repo.id, Number(repositoryId));
      assert.equal(pull.base.ref, base);
      const { data: current } = await observe("GET", `pulls/${pull.number}`);
      assert.equal(current.head.sha, sha);
      assert.equal(current.body, marker);
      if (current.state === "open") {
        await observe("PATCH", `pulls/${pull.number}`, { state: "closed" });
      }
      assert.equal((await observe("GET", `pulls/${pull.number}`)).data.state, "closed");
    }
  }
  assert.equal((await observe("GET", `git/ref/heads/${branch}`)).data.object.sha, sha);
  await observe.deleteBranch(branch, sha);
  await observe("GET", `git/ref/heads/${branch}`, undefined, 404);
}
