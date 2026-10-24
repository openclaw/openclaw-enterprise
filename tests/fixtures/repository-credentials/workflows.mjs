import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPinnedClients } from "./clients.mjs";
import { fixtureRepository, humanText } from "./github.mjs";

export async function removeRemoteBranches(client, checkout, branches) {
  const refs = branches.map((branch) => `refs/heads/${branch}`);
  const remote = await client.git(["ls-remote", "--heads", "origin", ...refs], {
    cwd: checkout,
  });
  const present = new Set(
    remote.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[1]),
  );
  const existing = branches.filter((_, index) => present.has(refs[index]));
  if (existing.length) {
    await client.git(["push", "origin", "--delete", ...existing], { cwd: checkout });
  }
}

export async function exerciseGit(t, fixture, { push = true } = {}) {
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

export async function exerciseGh(fixture, client) {
  const prefix = `repos/${fixtureRepository}`;
  const createPr = await client.json("create-pr.json", {
    title: "Example change",
    body: humanText,
    head: "agent-feature",
    base: "main",
  });
  const pull = JSON.parse(
    (await client.gh(["api", "--method", "POST", `${prefix}/pulls`, "--input", createPr])).stdout,
  );
  assert.equal(pull.body, humanText);
  assert.equal(pull.html_url, `https://github.com/${fixtureRepository}/pull/${pull.number}`);
  const readPull = JSON.parse((await client.gh(["api", `${prefix}/pulls/${pull.number}`])).stdout);
  assert.equal(readPull.number, pull.number);
  const update = await client.json("update-pr.json", { title: "Updated change", body: humanText });
  await client.gh([
    "api",
    "--method",
    "PATCH",
    `${prefix}/pulls/${pull.number}`,
    "--input",
    update,
  ]);
  const issueInput = await client.json("create-issue.json", {
    title: "Fixture issue",
    body: humanText,
  });
  const issue = JSON.parse(
    (await client.gh(["api", "--method", "POST", `${prefix}/issues`, "--input", issueInput]))
      .stdout,
  );
  const commentInput = await client.json("comment.json", { body: humanText });
  const comment = JSON.parse(
    (
      await client.gh([
        "api",
        "--method",
        "POST",
        `${prefix}/issues/${issue.number}/comments`,
        "--input",
        commentInput,
      ])
    ).stdout,
  );
  const secondComment = JSON.parse(
    (
      await client.gh([
        "api",
        "--method",
        "POST",
        `${prefix}/issues/${issue.number}/comments`,
        "--input",
        commentInput,
      ])
    ).stdout,
  );
  const pages = await client.gh([
    "api",
    "--paginate",
    "--slurp",
    `${prefix}/issues/${issue.number}/comments?per_page=1`,
  ]);
  const parsedPages = JSON.parse(pages.stdout);
  assert.deepEqual(
    parsedPages.map((page) => page.length),
    [1, 1],
  );
  assert.notEqual(comment.id, secondComment.id);
  assert.deepEqual(
    parsedPages.flat().map(({ id, body }) => ({ id, body })),
    [comment, secondComment].map(({ id }) => ({ id, body: humanText })),
  );
  for (const route of [
    prefix,
    `${prefix}/pulls`,
    `${prefix}/issues`,
    `${prefix}/issues/${issue.number}`,
    `${prefix}/issues/comments/${comment.id}`,
  ]) {
    await client.gh(["api", route]);
  }
  await client.gh([
    "api",
    "--method",
    "PATCH",
    `${prefix}/issues/${issue.number}`,
    "--input",
    update,
  ]);
  await client.gh([
    "api",
    "--method",
    "PATCH",
    `${prefix}/issues/comments/${comment.id}`,
    "--input",
    commentInput,
  ]);
  const deleted = await client.gh([
    "api",
    "--method",
    "DELETE",
    `${prefix}/issues/comments/${comment.id}`,
  ]);
  assert.equal(deleted.stdout, "");
  assert.equal(fixture.github.comments.has(comment.id), false);
  assert.equal(fixture.github.errors.length, 0);
  return { pull, issue, comment };
}
