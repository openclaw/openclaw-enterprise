import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GitLabRepositoryClient } from "../../apps/controller/src/drivers/repo/gitlab/client.ts";

const tokenFile = process.env.GITLAB_TEST_TOKEN_FILE;
const projectPath = process.env.GITLAB_TEST_PROJECT;
const live = process.env.GITLAB_TEST_LIVE === "1";

function requireLiveAuthorization() {
  assert.equal(
    process.env.GITLAB_TEST_AUTHORIZED,
    "1",
    "explicit authorization for the disposable GitLab project is required",
  );
  assert.ok(tokenFile && projectPath, "the live lane requires a token file and project");
}

// Real GitLab.com reads only. Writes are exercised by the protected-sender integration once the
// provider is composed; this case qualifies the provider identity, transport, and read profile.
test(
  "GitLab.com read profile reaches the configured project over the real API",
  { skip: !live },
  async () => {
    requireLiveAuthorization();
    const token = (await readFile(tokenFile, "utf8")).trim();
    assert.ok(token.length > 0, "the token file must contain a token");
    const api = new GitLabRepositoryClient({
      projectPath: projectPath,
      profile: "git-read",
      token,
    });

    const project = await api.project();
    assert.equal(project.pathWithNamespace, projectPath);
    assert.ok(project.id > 0, "the project must resolve to a numeric identity");
    assert.equal(typeof project.visibility, "string");

    const branches = await api.branches();
    assert.ok(branches.some((branch) => branch.name === (project.defaultBranch ?? "main")));

    const issues = await api.issues("all");
    const mergeRequests = await api.mergeRequests("all");
    const pipelines = await api.pipelines();
    assert.ok(Array.isArray(issues));
    assert.ok(Array.isArray(mergeRequests));
    assert.ok(Array.isArray(pipelines));
  },
);

const writeBranch = process.env.GITLAB_TEST_WRITE_BRANCH;

// The write profile opens a draft merge request between branches the caller already created.
// This never pushes, forks, or merges; the source branch is provisioned outside the provider.
test(
  "GitLab.com write profile opens a draft merge request and never a ready one",
  {
    skip: !live,
  },
  async () => {
    requireLiveAuthorization();
    assert.ok(writeBranch, "the live lane requires a preprovisioned source branch");
    const token = (await readFile(tokenFile, "utf8")).trim();
    const api = new GitLabRepositoryClient({
      projectPath: projectPath,
      profile: "git-write",
      token,
    });
    const title = `Provider validation ${Date.now()}`;
    const created = await api.createDraftMergeRequest({
      sourceBranch: writeBranch,
      targetBranch: "main",
      title,
      description: "Created by the GitLab provider validation.",
    });
    assert.match(created.title, /^Draft: /);
    // The provider's guarantee is the draft state GitLab accepted, not the title text alone.
    assert.equal(created.draft, true);
    assert.equal(created.sourceBranch, writeBranch);
    assert.equal(created.targetBranch, "main");
    const listed = await api.mergeRequests("opened");
    assert.ok(listed.some((mergeRequest) => mergeRequest.iid === created.iid));
  },
);
