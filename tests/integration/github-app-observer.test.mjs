import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubAppRepositoryObserver } from "../helpers/github-app-observer.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function readRequestJson(request) {
  let input = "";
  for await (const chunk of request) {
    input += chunk;
  }
  return input ? JSON.parse(input) : undefined;
}

async function fixture(t, { tokenRepositories } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "github-app-observer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(
    join(directory, "private-key.pem"),
    privateKey.export({ type: "pkcs1", format: "pem" }),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "registry.json"),
    JSON.stringify({
      version: 1,
      backendId: "github",
      providerInstanceId: "github-fixture-instance",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      repositories: [
        {
          repositoryRef: "fixture",
          repositoryId: "789",
          repository: "fixture-owner/fixture-repo",
          namespaces: [{ namespaceId: "ns_test", profiles: ["git-read", "git-full"] }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  await chmod(directory, 0o700);
  const seen = [];
  const server = createServer(async (request, response) => {
    try {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      if (request.method === "POST" && request.url === "/app/installations/456/access_tokens") {
        const body = await readRequestJson(request);
        assert.deepEqual(body, {
          repository_ids: [789],
          permissions: { contents: "write", pull_requests: "write" },
        });
        const jwt = request.headers.authorization?.replace(/^Bearer /, "");
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
        assert.equal(payload.iss, "123");
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            token: "ghs_observer_secret_token_1234567890",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { contents: "write", pull_requests: "write", metadata: "read" },
            repositories: tokenRepositories ?? [
              { id: 789, full_name: "fixture-owner/fixture-repo" },
            ],
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/repos/fixture-owner/fixture-repo") {
        assert.equal(request.headers.authorization, "Bearer ghs_observer_secret_token_1234567890");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: 789,
            full_name: "fixture-owner/fixture-repo",
            default_branch: "main",
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: error.message }));
    }
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listen(server);
  return { directory, origin, seen };
}

test("GitHub App observer mints a one-repository runner token and reuses it before expiry", async (t) => {
  const f = await fixture(t);
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository: "fixture-owner/fixture-repo",
    run: async () => "",
    githubApiOrigin: f.origin,
  });

  const first = await observe("GET");
  const second = await observe("GET");

  assert.equal(first.data.full_name, "fixture-owner/fixture-repo");
  assert.equal(second.data.id, 789);
  assert.equal(
    f.seen.filter((request) => request.url === "/app/installations/456/access_tokens").length,
    1,
    "observer should not mint again before the refresh window",
  );
});

test("GitHub App observer fails closed when GitHub cannot prove exact repository scope", async (t) => {
  const f = await fixture(t, {
    tokenRepositories: [
      { id: 789, full_name: "fixture-owner/fixture-repo" },
      { id: 790, full_name: "fixture-owner/other" },
    ],
  });
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository: "fixture-owner/fixture-repo",
    run: async () => "",
    githubApiOrigin: f.origin,
  });
  await assert.rejects(observe("GET"), /scoped to one repository/);
});
