import assert from "node:assert/strict";
import test from "node:test";

import {
  GITLAB_ORIGIN,
  GitLabProviderError,
  GitLabRepositoryClient,
  draftMergeRequestRequest,
  gitLabOperationAllowed,
  refuseGitLabQuickActions,
  normalizeGitLabProjectPath,
} from "../../apps/controller/src/drivers/repo/gitlab/client.ts";

function client(profile, fetchImpl, projectPath = "rmcook84/test") {
  return new GitLabRepositoryClient({
    projectPath,
    profile,
    token: "synthetic-gitlab-token",
    fetch: fetchImpl,
  });
}

test("GitLab project identity is a canonical relative path", () => {
  assert.equal(normalizeGitLabProjectPath("rmcook84/test"), "rmcook84/test");
  assert.equal(normalizeGitLabProjectPath("group/sub/project"), "group/sub/project");
  for (const refused of [
    "",
    "https://gitlab.com/rmcook84/test",
    "/rmcook84/test",
    "rmcook84/test/",
    "rmcook84//test",
    "../test",
    "rmcook84/../test",
    "rmcook84/test?x=1",
    "rmcook84/test#readme",
    "rmcook84 test",
  ]) {
    assert.throws(() => normalizeGitLabProjectPath(refused), GitLabProviderError, refused);
  }
});

test("GitLab profiles allow only the operations GitHub profiles expose", () => {
  assert.deepEqual(
    [
      "project.read",
      "branches.read",
      "issues.read",
      "mergeRequests.read",
      "pipelines.read",
      "mergeRequest.draft.create",
      "mergeRequest.note",
      "issue.create",
      "issue.note",
    ].filter((operation) => gitLabOperationAllowed("git-read", operation)),
    ["project.read", "branches.read", "issues.read", "mergeRequests.read", "pipelines.read"],
  );
  assert.equal(gitLabOperationAllowed("git-read", "issue.create"), false);
  assert.equal(gitLabOperationAllowed("git-write", "mergeRequest.draft.create"), true);
  assert.equal(gitLabOperationAllowed("git-write", "issue.create"), false);
  assert.equal(gitLabOperationAllowed("git-full", "issue.create"), true);
  // Merge, approval, project administration, and pipeline control are not operations at all.
  assert.equal(gitLabOperationAllowed("git-full", "mergeRequest.merge"), false);
});

test("a draft merge request opens between existing branches and never pushes or forks", () => {
  const request = draftMergeRequestRequest({
    sourceBranch: "feature/readme",
    targetBranch: "main",
    title: "Add README",
  });
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/merge_requests");
  assert.deepEqual(request.body, {
    source_branch: "feature/readme",
    target_branch: "main",
    title: "Draft: Add README",
  });
  assert.equal(JSON.stringify(request.body).includes("push"), false);
  assert.equal(JSON.stringify(request.body).includes("fork"), false);
  assert.throws(
    () =>
      draftMergeRequestRequest({
        sourceBranch: "main",
        targetBranch: "main",
        title: "Same branch",
      }),
    GitLabProviderError,
  );
});

test("the client binds requests to the fixed origin and project and keeps the token out of errors", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 42, path_with_namespace: "rmcook84/test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = client("git-read", fetchImpl);
  assert.deepEqual(await api.project(), {
    id: 42,
    pathWithNamespace: "rmcook84/test",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GITLAB_ORIGIN}/api/v4/projects/rmcook84%2Ftest`);
  assert.equal(calls[0].init.headers["PRIVATE-TOKEN"], "synthetic-gitlab-token");
  assert.equal(calls[0].init.redirect, "error");

  const refusing = async () =>
    new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 });
  await assert.rejects(client("git-read", refusing).project(), (error) => {
    assert.equal(error.name, "GitLabProviderError");
    assert.equal(error.status, 401);
    assert.equal(error.possiblySent, false);
    assert.equal(String(error).includes("synthetic-gitlab-token"), false);
    return true;
  });
});

test("a write that fails in transport is possibly sent and is never retried by the client", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("socket reset");
  };
  await assert.rejects(
    client("git-write", fetchImpl).createDraftMergeRequest({
      sourceBranch: "feature/readme",
      targetBranch: "main",
      title: "Add README",
    }),
    (error) => {
      assert.equal(error.possiblySent, true);
      return true;
    },
  );
  assert.equal(calls, 1, "the client must not repeat a possibly-sent write");
});

test("a draft create reports GitLab's returned draft flag", async () => {
  const response = (draft) =>
    new Response(
      JSON.stringify({
        iid: 7,
        title: "Draft: Add README",
        state: "opened",
        draft,
        source_branch: "feature/readme",
        target_branch: "main",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  const created = await client("git-write", async () => response(true)).createDraftMergeRequest({
    sourceBranch: "feature/readme",
    targetBranch: "main",
    title: "Add README",
  });
  assert.equal(created.draft, true);
  // GitLab's flag wins; the client must not claim a draft the service did not accept.
  const notDraft = await client("git-write", async () => response(false)).createDraftMergeRequest({
    sourceBranch: "feature/readme",
    targetBranch: "main",
    title: "Add README",
  });
  assert.equal(notDraft.draft, false);
});

test("read profiles cannot reach write operations", async () => {
  const api = client("git-read", async () => {
    throw new Error("no request expected");
  });
  await assert.rejects(
    api.createDraftMergeRequest({
      sourceBranch: "feature/readme",
      targetBranch: "main",
      title: "Add README",
    }),
    /does not allow mergeRequest\.draft\.create/,
  );
  await assert.rejects(api.createIssue("Title"), /does not allow issue\.create/);
});

test("GitLab quick actions are refused in notes and descriptions", async () => {
  for (const command of ["/ready", "/approve", "text\n/merge", "  /close"]) {
    assert.throws(
      () => refuseGitLabQuickActions(command, "note"),
      /must not contain a quick action line/,
      command,
    );
  }
  // A slash inside a sentence is not a quick action line.
  assert.equal(
    refuseGitLabQuickActions("Read /usr/bin/env first", "note"),
    "Read /usr/bin/env first",
  );
  const api = client("git-write", async () => {
    throw new Error("no request expected");
  });
  await assert.rejects(api.addMergeRequestNote(1, "/ready"), /quick action/);
  await assert.rejects(
    api.createDraftMergeRequest({
      sourceBranch: "feature/readme",
      targetBranch: "main",
      title: "Add README",
      description: "/approve",
    }),
    /quick action/,
  );
});

test("only a recognized draft marker is preserved", () => {
  const title = (value) =>
    draftMergeRequestRequest({
      sourceBranch: "feature/readme",
      targetBranch: "main",
      title: value,
    }).body.title;
  assert.equal(title("Add README"), "Draft: Add README");
  assert.equal(title("Draft: Add README"), "Draft: Add README");
  assert.equal(title("[Draft] Add README"), "[Draft] Add README");
  // "Draft release notes" is not a recognized marker; GitLab would treat it as ready.
  assert.equal(title("Draft release notes"), "Draft: Draft release notes");
});

test("a response body failure after a write is possibly sent", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("terminated");
      },
    };
  };
  await assert.rejects(
    client("git-write", fetchImpl).createDraftMergeRequest({
      sourceBranch: "feature/readme",
      targetBranch: "main",
      title: "Add README",
    }),
    (error) => {
      assert.equal(error.possiblySent, true);
      return true;
    },
  );
  assert.equal(calls, 1, "the client must not retry");
});
