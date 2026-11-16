import assert from "node:assert/strict";

type RepositoryObserver = {
  (
    method: "GET" | "PATCH",
    suffix: string,
    body?: { state: "closed" },
    expected?: number | readonly number[],
  ): Promise<{ status: number; data: unknown }>;
  deleteBranch(branch: string, sha: string): Promise<void>;
};

type CleanupOptions = {
  observe: RepositoryObserver;
  repository: string;
  repositoryId: string | number;
  branch: string;
  base: string;
  baseSha: string;
  file: string;
  content: string;
  marker: string;
  commitMessage: string;
  readOnly: boolean;
  expectedSha?: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `invalid GitHub ${label}`);
  return value;
}

function list(value: unknown, label: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `invalid GitHub ${label}`);
  return value;
}

function refSha(data: unknown): string {
  const { sha } = record(record(data, "ref").object, "ref object");
  assert.ok(typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha), "invalid GitHub ref SHA");
  return sha;
}

function ownedPullNumber(
  pull: Record<string, unknown>,
  { repositoryId, branch, base, marker }: CleanupOptions,
  sha: string,
): number {
  const head = record(pull.head, "PR head");
  const repo = record(head.repo, "PR head repository");
  assert.equal(pull.body, marker);
  assert.equal(head.ref, branch);
  assert.equal(head.sha, sha);
  assert.equal(repo.id, Number(repositoryId));
  assert.equal(record(pull.base, "PR base").ref, base);
  const { number } = pull;
  assert.ok(
    typeof number === "number" && Number.isSafeInteger(number) && number > 0,
    "invalid GitHub PR number",
  );
  return number;
}

// Call only after the Agent is stopped and its credential sessions are disposed.
// A timeout is an unknown remote outcome: independently reconcile the exact
// owned branch and PR before deleting anything, even if task acceptance failed.
export async function cleanupRepositoryJourney(options: CleanupOptions): Promise<void> {
  const {
    observe,
    repository,
    branch,
    baseSha,
    file,
    content,
    commitMessage,
    readOnly,
    expectedSha,
  } = options;
  const { data: pullData } = await observe(
    "GET",
    `pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
  );
  const pulls = list(pullData, "PR list");
  const refPath = `git/ref/heads/${branch}`;
  const reference = await observe("GET", refPath, undefined, [200, 404]);
  if (reference.status === 404) {
    assert.equal(pulls.length, 0, "PR remains after branch disappeared; retain for investigation");
    return;
  }
  const sha = refSha(reference.data);
  if (readOnly) {
    assert.equal(sha, baseSha, "unexpected read-only branch cannot be cleaned automatically");
    assert.equal(pulls.length, 0, "unexpected PR prevents automatic cleanup");
  } else {
    const { data: commitData } = await observe("GET", `commits/${sha}`);
    const commit = record(commitData, "commit response");
    assert.deepEqual(
      list(commit.parents, "commit parents").map((parent) => record(parent, "commit parent").sha),
      [baseSha],
    );
    assert.equal(record(commit.commit, "commit").message, commitMessage);
    assert.deepEqual(
      list(commit.files, "commit files").map((value) => {
        const { filename, status } = record(value, "commit file");
        return { filename, status };
      }),
      [{ filename: file, status: "added" }],
    );
    const { data: fileData } = await observe("GET", `contents/${file}?ref=${sha}`);
    const encoded = record(fileData, "file").content;
    assert.ok(typeof encoded === "string", "invalid GitHub file content");
    const bytes = Buffer.from(encoded, "base64");
    assert.ok(
      bytes.toString("base64") === encoded.replace(/[\r\n]/g, ""),
      "invalid GitHub file encoding",
    );
    assert.deepEqual(bytes, Buffer.from(content, "utf8"));
    if (expectedSha) {
      assert.equal(sha, expectedSha, "changed branch cannot be cleaned automatically");
    }
    assert.ok(pulls.length <= 1, "ambiguous PR ownership");
    for (const value of pulls) {
      const number = ownedPullNumber(record(value, "PR"), options, sha);
      const path = `pulls/${number}`;
      const current = record((await observe("GET", path)).data, "current PR");
      assert.equal(ownedPullNumber(current, options, sha), number);
      assert.ok(current.state === "open" || current.state === "closed", "invalid GitHub PR state");
      if (current.state === "open") {
        await observe("PATCH", path, { state: "closed" });
      }
      assert.equal(record((await observe("GET", path)).data, "PR readback").state, "closed");
    }
  }
  assert.equal(refSha((await observe("GET", refPath)).data), sha);
  await observe.deleteBranch(branch, sha);
  await observe("GET", refPath, undefined, 404);
}
