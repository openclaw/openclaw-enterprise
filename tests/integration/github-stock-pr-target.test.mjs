import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubPullTargetReader } from "../../apps/controller/src/drivers/repo/github/access/provider-transport/pull-request-target.ts";
import { selectGitHubRequest } from "../../apps/controller/src/drivers/repo/github/access/routes/request-selection.ts";
import { selfSigned } from "../helpers/certificates.mjs";

const requests = JSON.parse(
  await readFile(new URL("../fixtures/gh-pr-create-edit-2.103.2.json", import.meta.url), "utf8"),
);
const selected = { repositoryId: "101", repository: "example/project" };

function classify(
  request,
  body = JSON.stringify(request.body),
  target = {},
  repositories = [selected],
) {
  const result = selectGitHubRequest(
    {
      target: {
        reportedScheme: "https",
        host: "api.github.com",
        port: 443,
        method: "POST",
        path: "/graphql",
        query: "",
        ...target,
      },
      headers: [["content-type", request.contentType]],
      body: Buffer.from(body),
    },
    { scope: "github-repository", repositories, allowStockPullRequestApi: true },
    () => {
      throw new Error("selected pull preview must not enter legacy draft admission");
    },
  );
  return result.selected?.stockPullRequest;
}

test("the pinned CLI's six exact request documents stay on the selected repository", () => {
  assert.deepEqual(
    requests.map((request) => classify(request)),
    [
      { operation: "repository-info" },
      { operation: "pull-request-for-branch" },
      { operation: "create-draft", nodeId: "R_CONTROLLED_REPO" },
      { operation: "pull-request-by-number" },
      { operation: "pull-request-project-items" },
      { operation: "edit-title", nodeId: "PR_CONTROLLED_OTHER_AUTHOR" },
    ],
  );

  const [info, , create, finder, projects, edit] = requests;
  const changed = [
    [info, { ...info.body, variables: { ...info.body.variables, owner: "different" } }],
    [finder, { ...finder.body, variables: { ...finder.body.variables, repo: "different" } }],
    [projects, { ...projects.body, variables: { ...projects.body.variables, name: "different" } }],
    [
      create,
      {
        ...create.body,
        variables: { input: { ...create.body.variables.input, draft: false } },
      },
    ],
    [
      create,
      {
        ...create.body,
        variables: { input: { ...create.body.variables.input, headRefName: "different:branch" } },
      },
    ],
    [
      edit,
      {
        ...edit.body,
        variables: { input: { ...edit.body.variables.input, baseRefName: "different" } },
      },
    ],
    [
      edit,
      {
        ...edit.body,
        query: edit.body.query.replace("updatePullRequest(", "other: updatePullRequest("),
      },
    ],
    [edit, { ...edit.body, operationName: "PullRequestUpdate" }],
  ];
  for (const [request, body] of changed) {
    assert.equal(classify(request, JSON.stringify(body)), undefined);
  }
  const editBody = JSON.stringify(edit.body);
  assert.equal(classify(edit, editBody.replace('"title":', '"title":"first","title":')), undefined);
  assert.equal(classify(edit, editBody, { query: "unexpected=1" }), undefined);
  assert.equal(classify(edit, editBody, { method: "GET" }), undefined);
  assert.equal(classify(edit, editBody, { host: "github.com" }), undefined);
  assert.equal(classify(edit, editBody, { port: 8443 }), undefined);
  assert.equal(
    classify(edit, editBody, {}, [selected, { repository: "example/other" }]),
    undefined,
  );
});

test("provider ownership of an opaque write target requires the selected stable repository", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-pr-target-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { key, cert } = await selfSigned(directory);
  const token = "synthetic-selected-repository-bearer";
  const received = [];
  const repository = { databaseId: 101, nameWithOwner: "Example/Project" };
  const server = createServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({
      method: req.method,
      target: req.url,
      authorized: req.headers.authorization === "Bearer " + token,
      query: body.query,
      variables: body.variables,
    });
    const { id } = body.variables;
    const node =
      id === "R_CONTROLLED_REPO"
        ? { __typename: "Repository", id, ...repository }
        : { __typename: "PullRequest", id, repository };
    if (id === "PR_FOREIGN") {
      node.repository = { ...repository, databaseId: 999 };
    }
    if (id === "PR_WRONG_NAME") {
      node.repository = { ...repository, nameWithOwner: "example/other" };
    }
    if (id === "PR_WRONG_ID") {
      node.id = "PR_OTHER";
    }
    res.setHeader("content-type", "application/json");
    if (id === "PR_REDIRECT") {
      res.writeHead(307, { location: "/redirect" });
      res.end();
    } else if (id === "PR_PARTIAL") {
      res.end(JSON.stringify({ data: { node }, errors: [{ message: "field refused" }] }));
    } else {
      res.end(JSON.stringify({ data: { node } }));
    }
  });
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const origin = "https://127.0.0.1:" + server.address().port;
  const readTarget = createGitHubPullTargetReader({ origin, ca: Buffer.from(cert) });
  const { signal } = new AbortController();
  const create = classify(requests[2]);
  const edit = classify(requests[5]);
  assert.equal(await readTarget(token, selected, create, signal), true);
  assert.equal(await readTarget(token, selected, edit, signal), true);
  const denied = ["PR_FOREIGN", "PR_WRONG_NAME", "PR_WRONG_ID", "PR_REDIRECT", "PR_PARTIAL"];
  for (const nodeId of denied) {
    assert.equal(await readTarget(token, selected, { ...edit, nodeId }, signal), false);
  }
  assert.equal(await readTarget(token, selected, edit, AbortSignal.abort()), false);
  assert.equal(
    await createGitHubPullTargetReader({ origin })(token, selected, edit, signal),
    false,
  );
  assert.deepEqual(
    received.map(({ variables }) => variables.id),
    [create.nodeId, edit.nodeId, ...denied],
  );
  for (const call of received) {
    assert.equal(call.method, "POST");
    assert.equal(call.target, "/graphql");
    assert.equal(call.authorized, true);
    assert.match(call.query, /^query (?:Repository|PullRequest)WriteTarget\(/);
    assert.match(call.query, /node\(id:\$id\)/);
    assert.deepEqual(Object.keys(call.variables), ["id"]);
  }
});
