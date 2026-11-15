import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runPinnedClients, type CredentialClientFixture } from "./clients.ts";
import { fixtureRepository, humanText } from "./github.mjs";

type PinnedClients = Awaited<ReturnType<typeof runPinnedClients>>;

export async function removeRemoteBranches(
  client: Pick<PinnedClients, "git">,
  checkout: string,
  branches: readonly string[],
) {
  const heads = "refs/heads/";
  const refs = branches.map((branch) => heads + branch);
  const remote = await client.git(["ls-remote", "--heads", "origin", ...refs], {
    cwd: checkout,
  });
  const present = new Set<string>();
  for (const line of remote.stdout.split("\n")) {
    const [, ref] = line.split("\t");
    if (ref !== undefined) {
      present.add(ref);
    }
  }
  const existing = branches.filter((branch) => present.has(heads + branch));
  if (existing.length) {
    await client.git(["push", "origin", "--delete", ...existing], { cwd: checkout });
  }
}

export async function exerciseGit(
  t: TestContext,
  fixture: Pick<CredentialClientFixture, "clientDirectory" | "opened"> & {
    git: Pick<CredentialClientFixture["git"], "ref">;
  },
  { push = true }: { push?: boolean } = {},
) {
  const client = await runPinnedClients(t, fixture);
  const checkout = join(client.directory, "checkout");
  await client.git(["clone", fixture.opened.client.gitRemote, checkout]);
  await client.git(["fetch", "origin"], { cwd: checkout });
  await client.git(["switch", "existing-branch"], { cwd: checkout });
  assert.equal(
    (await client.git(["branch", "--show-current"], { cwd: checkout })).stdout.trim(),
    "existing-branch",
  );
  await client.git(["config", "user.name", "Agent fixture"], { cwd: checkout });
  await client.git(["config", "user.email", "agent@example.test"], { cwd: checkout });
  await writeFile(join(checkout, "change.txt"), "Agent change\n");
  await client.git(["add", "change.txt"], { cwd: checkout });
  await client.git(["commit", "-m", "Agent fixture change"], { cwd: checkout });
  await client.git(["mv", "change.txt", "renamed.txt"], { cwd: checkout });
  assert.equal(await readFile(join(checkout, "renamed.txt"), "utf8"), "Agent change\n");
  await client.git(["commit", "-m", "Move fixture file"], { cwd: checkout });
  await client.git(["rm", "renamed.txt"], { cwd: checkout });
  await client.git(["commit", "-m", "Remove fixture file"], { cwd: checkout });
  assert.equal(
    (await client.git(["ls-files", "change.txt", "renamed.txt"], { cwd: checkout })).stdout,
    "",
  );
  const commit = (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  if (push) {
    await client.git(["push", "origin", "HEAD:refs/heads/agent-feature"], { cwd: checkout });
    assert.equal(await fixture.git.ref("refs/heads/agent-feature"), commit);
  }
  return { client, checkout, commit };
}

function assertJsonObject(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assertJsonObject(value);
  return value;
}

function resourceId(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}

type GhWorkflowFixture = {
  github: {
    comments: Pick<ReadonlyMap<number, unknown>, "has">;
    errors: { readonly length: number };
  };
};

export async function exerciseGh(
  fixture: GhWorkflowFixture,
  client: Pick<PinnedClients, "json" | "gh">,
): Promise<number> {
  const prefix = `repos/${fixtureRepository}`;
  const createPr = await client.json("create-pr.json", {
    title: "Example change",
    body: humanText,
    head: "agent-feature",
    base: "main",
  });
  const pull = parseJsonObject(
    (await client.gh(["api", "--method", "POST", `${prefix}/pulls`, "--input", createPr])).stdout,
  );
  const pullNumber = resourceId(pull.number);
  assert.equal(pull.body, humanText);
  assert.equal(pull.html_url, `https://github.com/${fixtureRepository}/pull/${pullNumber}`);
  const readPull = parseJsonObject(
    (await client.gh(["api", `${prefix}/pulls/${pullNumber}`])).stdout,
  );
  assert.equal(readPull.number, pullNumber);
  const update = await client.json("update-pr.json", { title: "Updated change", body: humanText });
  await client.gh(["api", "--method", "PATCH", `${prefix}/pulls/${pullNumber}`, "--input", update]);
  const issueInput = await client.json("create-issue.json", {
    title: "Fixture issue",
    body: humanText,
  });
  const issue = parseJsonObject(
    (await client.gh(["api", "--method", "POST", `${prefix}/issues`, "--input", issueInput]))
      .stdout,
  );
  const issueNumber = resourceId(issue.number);
  const commentsPath = `${prefix}/issues/${issueNumber}/comments`;
  const commentInput = await client.json("comment.json", { body: humanText });
  const createComment = async () => {
    const result = await client.gh([
      "api",
      "--method",
      "POST",
      commentsPath,
      "--input",
      commentInput,
    ]);
    return resourceId(parseJsonObject(result.stdout).id);
  };
  const commentId = await createComment();
  const secondCommentId = await createComment();
  const pages = await client.gh(["api", "--paginate", "--slurp", `${commentsPath}?per_page=1`]);
  const parsedPages: unknown = JSON.parse(pages.stdout);
  assert.ok(Array.isArray(parsedPages));
  const commentsByPage = parsedPages.map((page: unknown) => {
    assert.ok(Array.isArray(page));
    return page.map((entry: unknown) => {
      assertJsonObject(entry);
      const { id, body } = entry;
      assert.equal(typeof body, "string");
      return { id: resourceId(id), body };
    });
  });
  assert.notEqual(commentId, secondCommentId);
  assert.deepEqual(commentsByPage, [
    [{ id: commentId, body: humanText }],
    [{ id: secondCommentId, body: humanText }],
  ]);
  for (const route of [
    prefix,
    `${prefix}/pulls`,
    `${prefix}/issues`,
    `${prefix}/issues/${issueNumber}`,
    `${prefix}/issues/comments/${commentId}`,
  ]) {
    await client.gh(["api", route]);
  }
  await client.gh([
    "api",
    "--method",
    "PATCH",
    `${prefix}/issues/${issueNumber}`,
    "--input",
    update,
  ]);
  await client.gh([
    "api",
    "--method",
    "PATCH",
    `${prefix}/issues/comments/${commentId}`,
    "--input",
    commentInput,
  ]);
  const deleted = await client.gh([
    "api",
    "--method",
    "DELETE",
    `${prefix}/issues/comments/${commentId}`,
  ]);
  assert.equal(deleted.stdout, "");
  assert.equal(fixture.github.comments.has(commentId), false);
  assert.equal(fixture.github.errors.length, 0);
  return issueNumber;
}
