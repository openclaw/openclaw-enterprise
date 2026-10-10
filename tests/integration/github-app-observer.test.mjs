import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGitHubAppRepositoryObserver } from "../helpers/github-app-observer.mjs";

const repository = "fixture-owner/fixture-repo";
const repositoryId = 789;

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

async function fixture(
  t,
  {
    tokenRepositories,
    token = ({ index }) => `ghs_observer_secret_token_${index}`,
    expiresAt = () => new Date(Date.now() + 3600_000).toISOString(),
  } = {},
) {
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
          repositoryId: String(repositoryId),
          repository,
          namespaces: [{ namespaceId: "ns_test", profiles: ["git-read", "git-full"] }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  await chmod(directory, 0o700);
  const seen = [];
  const issuedTokens = [];
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
          repository_ids: [repositoryId],
          permissions: { contents: "write", pull_requests: "write" },
        });
        const jwt = request.headers.authorization?.replace(/^Bearer /, "");
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
        assert.equal(payload.iss, "123");
        const value = token({ index: issuedTokens.length + 1 });
        issuedTokens.push(value);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            token: value,
            expires_at: expiresAt({ index: issuedTokens.length }),
            permissions: { contents: "write", pull_requests: "write", metadata: "read" },
            repositories: tokenRepositories ?? [{ id: repositoryId, full_name: repository }],
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === `/repos/${repository}`) {
        assert.ok(issuedTokens.includes(request.headers.authorization?.replace(/^Bearer /, "")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: repositoryId,
            full_name: repository,
            default_branch: "main",
          }),
        );
        return;
      }
      if (request.method === "PATCH" && request.url === `/repos/${repository}/pulls/42`) {
        assert.ok(issuedTokens.includes(request.headers.authorization?.replace(/^Bearer /, "")));
        assert.deepEqual(await readRequestJson(request), { state: "closed" });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ number: 42, state: "closed" }));
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
  return { directory, origin, seen, issuedTokens };
}

test("GitHub App observer mints a one-repository runner token and reuses it before expiry", async (t) => {
  const f = await fixture(t);
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    run: async () => "",
    githubApiOrigin: f.origin,
  });

  const first = await observe("GET");
  const second = await observe("GET");

  assert.equal(first.data.full_name, repository);
  assert.equal(second.data.id, repositoryId);
  assert.equal(
    f.seen.filter((request) => request.url === "/app/installations/456/access_tokens").length,
    1,
    "observer should not mint again before the refresh window",
  );
});

test("GitHub App observer refreshes before the installation token expires", async (t) => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const f = await fixture(t, {
    expiresAt: () => new Date(now + 6 * 60_000).toISOString(),
  });
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    run: async () => "",
    githubApiOrigin: f.origin,
    now: () => now,
  });

  await observe("GET");
  now += 61_000;
  await observe("GET");

  assert.deepEqual(f.issuedTokens, ["ghs_observer_secret_token_1", "ghs_observer_secret_token_2"]);
});

test("GitHub App observer can close pull requests with the scoped runner token", async (t) => {
  const f = await fixture(t);
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    run: async () => "",
    githubApiOrigin: f.origin,
  });

  const result = await observe("PATCH", "pulls/42", { state: "closed" });

  assert.equal(result.data.state, "closed");
  assert.equal(f.issuedTokens.length, 1);
});

test("GitHub App observer deleteBranch uses a credential helper and leased Git push", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    githubApiOrigin: f.origin,
    run: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      return "";
    },
  });

  await observe.deleteBranch("qa/test-branch", "a".repeat(40));

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: "git",
    args: ["check-ref-format", "refs/heads/qa/test-branch"],
    options: {},
  });
  const push = calls[1];
  assert.equal(push.command, "git");
  assert.ok(push.args.includes("push"));
  assert.ok(push.args.includes("--porcelain"));
  assert.ok(push.args.includes(`--force-with-lease=refs/heads/qa/test-branch:${"a".repeat(40)}`));
  assert.ok(push.args.includes(`https://github.com/${repository}.git`));
  assert.ok(push.args.includes(":refs/heads/qa/test-branch"));
  const helper = push.args.find((arg) => arg.includes("github-app-observer-credential-helper.mjs"));
  assert.match(helper, /credential\.helper=.*github-app-observer-credential-helper\.mjs/);
  assert.match(helper, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(push.args.join("\n"), /ghs_observer_secret_token|private-key|Bearer/);
  assert.deepEqual(push.options.env, { GIT_TERMINAL_PROMPT: "0" });
  assert.equal(push.options.privateFailureOutput, true);
});

test("GitHub App observer credential helper mints through the fixture App key", async (t) => {
  const f = await fixture(t);
  const helper = fileURLToPath(
    new URL("../../scripts/ci/github-app-observer-credential-helper.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [helper, f.directory, repository], {
    env: { ...process.env, OCC_TEST_QA_GITHUB_API_ORIGIN: f.origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(status, 0, stderr);
  assert.equal(stderr, "");
  assert.match(stdout, /^username=x-access-token\npassword=ghs_observer_secret_token_1\n$/);
});
test("GitHub App observer fails closed when GitHub cannot prove exact repository scope", async (t) => {
  const f = await fixture(t, {
    tokenRepositories: [
      { id: repositoryId, full_name: repository },
      { id: 790, full_name: "fixture-owner/other" },
    ],
  });
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    run: async () => "",
    githubApiOrigin: f.origin,
  });
  await assert.rejects(observe("GET"), /scoped to one repository/);
});
