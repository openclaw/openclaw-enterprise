import assert from "node:assert/strict";
import type { OutgoingHttpHeaders } from "node:http";
import { fixtureRepository, fixtureRepositoryId } from "./metadata.ts";
import type { Permissions } from "./token-authority.ts";

export type RepositoryOptions = {
  repository?: string;
  repositoryId?: string;
  description?: string | null | undefined;
};

export type RepositoryMetadata = ReturnType<typeof createRepositoryResources>["repo"];
export type CreatedPull = ReturnType<typeof createPull>;

type Issue = Record<string, unknown> & {
  number: unknown;
  id: unknown;
  node_id: unknown;
  state: unknown;
  html_url: unknown;
};

type Pull = Issue & {
  head: unknown;
  base: unknown;
};

type DispatchRequest = {
  method: string | undefined;
  url: URL;
  body: unknown;
  accept: string | undefined;
  permissions: Permissions;
  metadataResponse?: (body: RepositoryMetadata) => unknown;
  draftResponse?: (body: CreatedPull) => unknown;
};

type JsonReply = {
  status: number;
  body: unknown;
  headers: OutgoingHttpHeaders;
};

type ResourceReply =
  | JsonReply
  | {
      status: number;
      raw: string;
      headers?: OutgoingHttpHeaders;
    }
  | { status: 204 };

function json(status: number, body: unknown, headers: OutgoingHttpHeaders = {}): JsonReply {
  return { status, body, headers };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestObject(value: unknown) {
  assert.ok(isObject(value), "expected a request object");
  return value;
}

export function readGraphQLRequest(body: unknown) {
  const { query, variables } = requestObject(body);
  assert.ok(query == null || typeof query === "string", "expected GraphQL query text");
  assert.ok(variables == null || isObject(variables), "expected a GraphQL variables object");
  return { query, variables };
}

function pullFields(value: unknown) {
  const input = requestObject(value);
  const { title, body, draft, maintainer_can_modify } = input;
  const head = input.head ?? input.headRefName;
  const base = input.base ?? input.baseRefName;
  assert.ok(
    (title === undefined || typeof title === "string") &&
      (body == null || typeof body === "string") &&
      (draft == null || typeof draft === "boolean") &&
      (maintainer_can_modify === undefined || typeof maintainer_can_modify === "boolean") &&
      (head == null || typeof head === "string") &&
      (base == null || typeof base === "string"),
    "invalid pull request fields",
  );
  return { title, body, draft, maintainer_can_modify, head, base };
}

function createPull(
  { repository, repositoryId }: { repository: string; repositoryId: string },
  number: number,
  fields: ReturnType<typeof pullFields>,
  native: boolean,
) {
  const { title, body, draft, maintainer_can_modify, head, base } = fields;
  const branch = (sha: string) =>
    draft === true
      ? { sha: sha.repeat(40), repo: { id: repositoryId, temp_clone_token: "must-not-escape" } }
      : {};
  return {
    ...(draft === true && {
      draft: true,
      maintainer_can_modify,
    }),
    id: number,
    node_id: `PR_${number}`,
    number,
    state: "open",
    title,
    body: body ?? "",
    html_url: `https://github.com/${repository}/pull/${number}`,
    url: `https://api.github.com/repos/${repository}/pulls/${number}`,
    head: { ref: head ?? "native-feature", ...branch("a") },
    base: { ref: base ?? "main", ...branch("b") },
    native,
  };
}

export function createRepositoryResources({
  repository = fixtureRepository,
  repositoryId = fixtureRepositoryId,
  description = null,
}: RepositoryOptions = {}) {
  const [owner, name] = repository.split("/");
  // The fixture echoes raw PATCH fields, including a base string. Map keys retain their identity.
  const issues = new Map<number, Issue>();
  const pulls = new Map<number, Pull>();
  const comments = new Map<
    number,
    {
      id: number;
      body: string;
      issue: unknown;
      url: string;
      html_url: string;
    }
  >();
  let nextNumber = 1;
  let nextComment = 101;
  const repo = {
    id: Number(repositoryId),
    node_id: repositoryId === fixtureRepositoryId ? "R_fixture" : `R_fixture_${repositoryId}`,
    name,
    full_name: repository,
    owner: { login: owner, id: 1, type: "Organization" },
    private: true,
    description,
    default_branch: "main",
    html_url: `https://github.com/${repository}`,
    clone_url: `https://github.com/${repository}.git`,
  };
  function pageOf<T>(values: readonly T[], url: URL, defaultSize = 100) {
    const size = Number(url.searchParams.get("per_page") ?? defaultSize);
    const page = Number(url.searchParams.get("page") ?? 1);
    return values.slice((page - 1) * size, page * size);
  }
  function issuePull(value: unknown, native = false) {
    const fields = pullFields(value);
    const number = nextNumber++;
    const pull = createPull({ repository, repositoryId }, number, fields, native);
    pulls.set(number, pull);
    return pull;
  }

  function issue(inputValue: unknown, api: "rest" | "graphql") {
    const input = requestObject(inputValue);
    const validTitle =
      typeof input.title === "string" ||
      (api === "rest" && typeof input.title === "number" && Number.isInteger(input.title));
    assert.ok(
      validTitle && (input.body == null || typeof input.body === "string"),
      "invalid issue fields",
    );
    const number = nextNumber++;
    const value = {
      ...input,
      number,
      id: number,
      node_id: `I_${number}`,
      state: "open",
      html_url: `https://github.com/${repository}/issues/${number}`,
      url: `https://api.github.com/repos/${repository}/issues/${number}`,
    };
    issues.set(number, value);
    return value;
  }
  function addComment(number: unknown, body: unknown) {
    assert.ok(typeof body === "string", "expected a comment body");
    const id = nextComment++;
    const value = {
      id,
      body,
      issue: number,
      url: `https://api.github.com/repos/${repository}/issues/comments/${id}`,
      html_url: `https://github.com/${repository}/issues/${number}#issuecomment-${id}`,
    };
    comments.set(id, value);
    return value;
  }
  function connection<T>(nodes: T[]) {
    return { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } };
  }
  function graphItem(item: Issue | undefined, pull?: Pull) {
    if (!item) {
      return null;
    }
    const state = item.state;
    assert.ok(typeof state === "string", "expected an issue or pull state");
    return {
      ...item,
      id: item.node_id,
      __typename: pull ? "PullRequest" : "Issue",
      url: item.html_url,
      state: state.toUpperCase(),
      author: { login: "fixture-bot", __typename: "User" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      closed: item.state === "closed",
      comments: connection(
        [...comments.values()]
          .filter((value) => value.issue === item.number)
          .map((value) => ({
            ...value,
            id: `IC_${value.id}`,
            url: value.html_url,
            author: { login: "fixture-bot" },
          })),
      ),
      labels: connection([]),
      assignees: connection([]),
      projectCards: connection([]),
      projectItems: connection([]),
      milestone: null,
      ...(pull
        ? {
            headRefName: isObject(pull.head) ? pull.head.ref : undefined,
            baseRefName: isObject(pull.base) ? pull.base.ref : undefined,
            isDraft: false,
            merged: false,
            headRepositoryOwner: { login: owner },
            headRepository: { name, nameWithOwner: repository },
            reviewRequests: connection([]),
            reviews: connection([]),
            commits: connection([
              {
                commit: {
                  oid: "a".repeat(40),
                  statusCheckRollup: {
                    contexts: connection([
                      {
                        __typename: "CheckRun",
                        name: "fixture-check",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        isRequired: true,
                        detailsUrl: `https://github.com/${repository}/actions/runs/1`,
                        checkSuite: { workflowRun: { workflow: { name: "fixture" } } },
                      },
                    ]),
                  },
                },
              },
            ]),
          }
        : {}),
    };
  }
  function dispatchGraphQL(
    request: ReturnType<typeof readGraphQLRequest>,
    permissions: Permissions,
  ) {
    const query = request.query ?? "";
    const variables = request.variables;
    const input = variables?.input ?? variables ?? {};
    const denied = () =>
      json(200, {
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      });
    if (query.includes("createPullRequest")) {
      if (permissions.pull_requests !== "write") {
        return denied();
      }
      const pull = issuePull(input, true);
      return json(200, {
        data: {
          createPullRequest: {
            pullRequest: { id: pull.node_id, number: pull.number, url: pull.html_url },
          },
        },
      });
    }
    if (query.includes("createIssue")) {
      if (permissions.issues !== "write") {
        return denied();
      }
      const created = issue(input, "graphql");
      return json(200, { data: { createIssue: { issue: graphItem(created) } } });
    }
    if (query.includes("addComment")) {
      const { subjectId, body } = requestObject(input);
      assert.ok(typeof subjectId === "string", "expected a comment subject");
      const selected = [...issues.values(), ...pulls.values()].find(
        (value) => value.node_id === subjectId,
      );
      if (!selected) {
        return denied();
      }
      const number = selected.number;
      if (
        permissions[
          typeof number === "number" && pulls.has(number) ? "pull_requests" : "issues"
        ] !== "write"
      ) {
        return denied();
      }
      const comment = addComment(number, body);
      return json(200, {
        data: { addComment: { commentEdge: { node: { url: comment.html_url } } } },
      });
    }
    if (query.includes("IssueProjectItems")) {
      return json(200, { data: { repository: { issue: { projectItems: connection([]) } } } });
    }
    if (query.includes("PullRequestProjectItems")) {
      return json(200, {
        data: { repository: { pullRequest: { projectItems: connection([]) } } },
      });
    }
    if (query.includes("PullRequest_fields2")) {
      return json(200, { data: { WorkflowRun: { fields: [{ name: "workflow" }] } } });
    }
    if (query.includes("PullRequest_fields")) {
      return json(200, {
        data: {
          PullRequest: { fields: [{ name: "commits" }] },
          StatusCheckRollupContextConnection: { fields: [{ name: "nodes" }] },
        },
      });
    }
    if (query.includes("PullRequestStatusChecks")) {
      const pull = [...pulls.values()].find((value) => value.node_id === variables?.id);
      return json(200, {
        data: { node: pull ? { statusCheckRollup: graphItem(pull, pull)?.commits } : null },
      });
    }
    const number = Number(
      variables?.number ??
        variables?.issueNumber ??
        variables?.pullRequestNumber ??
        variables?.pr_number,
    );
    const pull = pulls.get(number);
    const selectedIssue = issues.get(number);
    const graphRepository = {
      id: repo.node_id,
      name: repo.name,
      nameWithOwner: repository,
      description: "Fixture repository",
      url: repo.html_url,
      owner: { login: owner, __typename: "Organization" },
      isPrivate: true,
      isFork: false,
      hasIssuesEnabled: true,
      hasWikiEnabled: false,
      viewerPermission: "WRITE",
      defaultBranchRef: { name: "main" },
      parent: null,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      pullRequests: connection([...pulls.values()].map((value) => graphItem(value, value))),
      issues: connection([...issues.values()].map((value) => graphItem(value))),
      pullRequest: graphItem(pull, pull),
      issue: graphItem(selectedIssue),
      issueOrPullRequest: graphItem(selectedIssue ?? pull, pull),
      ref: { name: "native-feature", target: { oid: "a".repeat(40) } },
      // GitHub fills this clone credential for private repositories when selected.
      ...(query.includes("tempCloneToken")
        ? { tempCloneToken: "synthetic-graphql-cloning-credential" }
        : {}),
    };
    return json(200, {
      data: {
        repository: graphRepository,
        repo_000: graphRepository,
        viewer: { login: "fixture-bot" },
      },
    });
  }

  function dispatch({
    method,
    url,
    body,
    accept,
    permissions,
    metadataResponse,
    draftResponse,
  }: DispatchRequest): ResourceReply {
    if (url.pathname === "/graphql") {
      return dispatchGraphQL(readGraphQLRequest(body), permissions);
    }
    if (url.pathname === "/meta") {
      return json(200, { installed_version: "github.com" });
    }
    const prefix = `/repos/${repository}`;
    const suffix = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(prefix)) {
      return json(404, {});
    }
    if (!suffix && method === "GET") {
      return json(200, metadataResponse ? metadataResponse(repo) : repo);
    }
    if (suffix === "/readme" && method === "GET") {
      const readme = "# Fixture README\n\nSelected repository fixture.\n";
      if (accept?.includes(".raw")) {
        return { status: 200, raw: readme };
      }
      return json(200, {
        name: "README.md",
        path: "README.md",
        encoding: "base64",
        content: Buffer.from(readme).toString("base64"),
      });
    }
    if (suffix === "/pulls" && method === "POST") {
      const pull = issuePull(body);
      return json(201, draftResponse ? draftResponse(pull) : pull);
    }
    if (suffix === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":").slice(1).join(":");
      return json(
        200,
        pageOf(
          [...pulls.values()].filter(
            (pull) => !head || (isObject(pull.head) && pull.head.ref === head),
          ),
          url,
        ),
      );
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(suffix);
    if (pullMatch) {
      const pull = pulls.get(Number(pullMatch[1]));
      if (!pull) {
        return json(404, {});
      }
      if (method === "PATCH") {
        Object.assign(pull, requestObject(body));
      }
      if (method === "GET" && accept && /\.(?:diff|patch)$/.test(accept)) {
        const diff =
          "diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n";
        return {
          status: 200,
          raw: accept.endsWith(".patch")
            ? `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Fixture change\n\n${diff}`
            : diff,
        };
      }
      return json(200, pull);
    }
    if (suffix === "/issues" && method === "POST") {
      return json(201, issue(body, "rest"));
    }
    if (suffix === "/issues" && method === "GET") {
      const values = [...issues.values()];
      const size = Number(url.searchParams.get("per_page") ?? 100);
      const page = Number(url.searchParams.get("page") ?? 1);
      const cursor = (issue: Issue) => Buffer.from(`cursor:v2:${issue.id}`).toString("base64");
      const after = url.searchParams.get("after");
      const index = after ? values.findIndex((issue) => cursor(issue) === after) : -1;
      assert.ok(!after || index >= 0, "pagination must preserve the issued cursor");
      const offset = after ? index + 1 : (page - 1) * size;
      const selected = values.slice(offset, offset + size);
      const headers: OutgoingHttpHeaders = {};
      if (offset + size < values.length) {
        const last = selected.at(-1);
        assert.ok(last, "expected a page to issue the next cursor");
        const next = new URL(url);
        next.pathname = `/repositories/${repositoryId}/issues`;
        next.searchParams.set("after", cursor(last));
        next.searchParams.set("page", String(page + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      return json(200, selected, headers);
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(suffix);
    if (issueMatch) {
      const issue = issues.get(Number(issueMatch[1]));
      if (!issue) {
        return json(404, {});
      }
      if (method === "PATCH") {
        Object.assign(issue, requestObject(body));
      }
      return json(200, issue);
    }
    const collection = /^\/issues\/(\d+)\/comments$/.exec(suffix);
    if (collection) {
      const issue = Number(collection[1]);
      if (method === "POST") {
        if (permissions[pulls.has(issue) ? "pull_requests" : "issues"] !== "write") {
          return json(403, { message: "Resource not accessible by integration" });
        }
        return json(201, addComment(issue, requestObject(body).body));
      }
      const values = [...comments.values()].filter((comment) => comment.issue === issue);
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("per_page") ?? 1);
      const headers =
        values.length > page * size
          ? {
              link: `<https://api.github.com/repositories/${repositoryId}${suffix}?page=${page + 1}&per_page=${size}>; rel="next"`,
            }
          : {};
      return json(200, pageOf(values, url, 1), headers);
    }
    const item = /^\/issues\/comments\/(\d+)$/.exec(suffix);
    if (item) {
      const id = Number(item[1]);
      const comment = comments.get(id);
      if (!comment) {
        return json(404, {});
      }
      if (method === "DELETE") {
        comments.delete(id);
        return { status: 204 };
      }
      if (method === "PATCH") {
        const replacement = requestObject(body).body;
        assert.ok(typeof replacement === "string", "expected a comment body");
        comment.body = replacement;
      }
      return json(200, comment);
    }
    return json(404, { message: "Fixture endpoint not implemented" });
  }
  return { repo, issues, pulls, comments, dispatch, dispatchGraphQL };
}
