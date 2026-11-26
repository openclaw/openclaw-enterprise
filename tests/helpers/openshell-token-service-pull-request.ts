import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { asRecord } from "../../packages/utils/src/index.ts";
import { createGitHubAppRepositoryObserver } from "./github-app-observer.ts";
import { runQaCommand } from "./qa-command.ts";
import { cleanupRepositoryJourney } from "./repository-remote-cleanup.ts";
import { waitUntil } from "./wait-for.ts";

export async function verifyNativePullRequest({
  repository,
  repositoryId,
  inputDirectory,
  chat,
  observePublication,
  stop,
}: {
  repository: string;
  repositoryId: string;
  inputDirectory: string;
  chat: (prompt: string) => Promise<string>;
  observePublication: (turn: () => Promise<void>) => Promise<void>;
  stop: () => Promise<void>;
}) {
  const observe = await createGitHubAppRepositoryObserver({
    repository,
    inputDirectory,
    run: (command, args, options) =>
      runQaCommand(
        { directory: inputDirectory, stateDirectory: inputDirectory, env: process.env },
        command,
        args,
        { ...options, env: { ...process.env, ...options?.env } },
      ),
  });
  const remote = asRecord((await observe("GET")).data);
  assert.equal(String(remote?.id), repositoryId);
  assert.equal(String(remote?.full_name).toLowerCase(), repository);
  const base = remote?.default_branch;
  assert.ok(
    typeof base === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(base) &&
      !base.includes(".."),
    "The disposable repository must use an ordinary default branch name.",
  );
  const baseRef = await observe("GET", `git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = asRecord(asRecord(baseRef.data)?.object)?.sha;
  assert.ok(typeof baseSha === "string" && /^[a-f0-9]{40}$/.test(baseSha));

  const branch = `oce-pr-proof-${randomUUID()}`;
  const refPath = `git/ref/heads/${branch}`;
  const file = `${branch}.txt`;
  const content = `Disposable pull request proof ${branch}\n`;
  const title = `OpenClaw publication proof ${branch}`;
  const marker = `OpenClaw publication evidence ${branch}`;
  const commitMessage = `Prepare ${branch}`;
  const head = encodeURIComponent(`${repository.split("/")[0]}:${branch}`);
  const pulls = async () => {
    const result = (await observe("GET", `pulls?state=all&head=${head}`)).data;
    assert.ok(Array.isArray(result), "GitHub must return a pull request list.");
    return result;
  };
  await observe("GET", refPath, undefined, 404);
  assert.equal((await pulls()).length, 0, "The disposable branch must have no prior pull request.");

  let expectedSha: string | undefined;
  let failure: unknown;
  try {
    await observe("POST", "git/refs", { ref: `refs/heads/${branch}`, sha: baseSha }, 201);
    // Prepare a real diff outside the Agent turn. The only Agent action is opening the PR.
    const seeded = await observe(
      "PUT",
      `contents/${file}`,
      { message: commitMessage, content: Buffer.from(content).toString("base64"), branch },
      201,
    );
    const sha = asRecord(asRecord(seeded.data)?.commit)?.sha;
    assert.ok(typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha) && sha !== baseSha);
    expectedSha = sha;
    let reply = "";
    await observePublication(async () => {
      reply = await chat(
        `Open a draft pull request in ${repository} from branch ${branch} into ${base}. ` +
          `Use the title "${title}" and the exact body "${marker}". Return the pull request link.`,
      );
    });
    await waitUntil(
      "GitHub observes the Agent's pull request",
      async () => (await pulls()).length > 0,
      {
        intervalMs: 1_000,
        timeoutMs: 30_000,
      },
    );
    const observed = await pulls();
    assert.equal(observed.length, 1, "The Agent must create one pull request.");
    const pull = asRecord(observed[0]);
    assert.ok(pull && Number.isSafeInteger(pull.number));
    const link = `https://github.com/${repository}/pull/${pull.number}`;
    assert.ok(
      pull.state === "open" &&
        pull.draft === true &&
        pull.title === title &&
        pull.body === marker &&
        pull.html_url === link,
      "GitHub must report the exact requested open draft and link.",
    );
    const pullHead = asRecord(pull.head);
    const pullBase = asRecord(pull.base);
    assert.ok(
      pullHead?.ref === branch &&
        pullHead.sha === expectedSha &&
        pullBase?.ref === base &&
        String(asRecord(pullHead.repo)?.id) === repositoryId &&
        String(asRecord(pullBase.repo)?.id) === repositoryId,
      "The PR must target the exact disposable repository, prepared commit, and base.",
    );
    assert.ok(reply.includes(link), "The Agent must report the real GitHub pull request link.");
  } catch (error) {
    failure = error;
  }
  try {
    await stop();
    const ref = await observe("GET", refPath, undefined, [200, 404]);
    await cleanupRepositoryJourney({
      observe,
      repository,
      repositoryId,
      base,
      baseSha,
      branch,
      file,
      content,
      marker,
      commitMessage,
      readOnly: asRecord(asRecord(ref.data)?.object)?.sha === baseSha,
      expectedSha,
    });
  } catch (error) {
    if (failure) {
      throw new AggregateError([failure, error], "Pull request proof and cleanup failed.", {
        cause: error,
      });
    }
    throw error;
  }
  if (failure) {
    throw failure;
  }
}
