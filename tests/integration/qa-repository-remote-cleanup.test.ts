import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";
import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.ts";
import { createGitHubAppRepositoryObserver } from "../helpers/github-app-observer.ts";
import { listen } from "../helpers/listen.ts";
import { cleanupRepositoryJourney } from "../helpers/repository-remote-cleanup.ts";

const repository = "fixture-owner/fixture-repository";
const repositoryId = 789;
const branch = "qa/run";
const branchRef = `refs/heads/${branch}`;
const unrelatedRef = "refs/heads/unrelated";
const file = "proof.txt";
const content = "Repository write proof\n";
const marker = "QA repository write marker";
const commitMessage = "Installed credential proof";
const token = "fixture-observer-token";
const gitEnv = cleanEnvironment({ GIT_CONFIG_GLOBAL: "/dev/null" });

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const body: AsyncIterable<unknown, unknown, unknown> = request;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    assert.ok(Buffer.isBuffer(chunk), "expected HTTP body bytes");
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

async function cleanupFixture(
  t: TestContext,
  {
    pullNumber = 42,
    pullMarker = marker,
    concurrentWrite = false,
  }: {
    pullNumber?: number | string;
    pullMarker?: string;
    concurrentWrite?: boolean;
  } = {},
) {
  const directory = await temporaryDirectory(t, "qa-repository-cleanup-");
  const bare = join(directory, "remote.git");
  const checkout = join(directory, "checkout");
  await run("git", ["init", "--bare", "--object-format=sha1", bare], { env: gitEnv });
  await run("git", ["init", "--object-format=sha1", checkout], { env: gitEnv });

  async function git(cwd: string, ...args: string[]): Promise<string> {
    return (await run("git", args, { cwd, env: gitEnv })).stdout;
  }
  await git(bare, "config", "maintenance.auto", "false");
  await git(checkout, "config", "user.name", "Cleanup Fixture");
  await git(checkout, "config", "user.email", "cleanup@example.test");
  await git(checkout, "commit", "--allow-empty", "-m", "Fixture base");
  const baseSha = (await git(checkout, "rev-parse", "HEAD")).trim();
  await writeFile(join(checkout, file), content);
  await git(checkout, "add", file);
  await git(checkout, "commit", "-m", commitMessage);
  const ownedSha = (await git(checkout, "rev-parse", "HEAD")).trim();
  await git(checkout, "push", bare, `HEAD:${branchRef}`, `${baseSha}:${unrelatedRef}`);
  await git(checkout, "commit", "--allow-empty", "-m", "Concurrent update");
  const newerSha = (await git(checkout, "rev-parse", "HEAD")).trim();

  async function remoteSha(ref: string): Promise<string | undefined> {
    const { code, stdout } = await run("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: bare,
      env: gitEnv,
      allowFailure: true,
    });
    if (code === 1) {
      return undefined;
    }
    assert.equal(code, 0, "read exact remote ref");
    return stdout.trim();
  }

  await writeFile(
    join(directory, "registry.json"),
    JSON.stringify({
      version: 1,
      appId: "123",
      githubInstallationId: "456",
      repositories: [{ repository, repositoryId: String(repositoryId) }],
    }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, "private-key.pem"), sharedRsaPrivateKeyPem(), { mode: 0o600 });

  let pullState = "open";
  let pushCount = 0;
  let refReads = 0;
  let closeRequests = 0;
  const server = createServer(async (request, response) => {
    const respond = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    try {
      if (request.method === "POST" && request.url === "/app/installations/456/access_tokens") {
        assert.deepEqual(await requestJson(request), {
          repository_ids: [repositoryId],
          permissions: { contents: "write", pull_requests: "write" },
        });
        respond(201, {
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { contents: "write", pull_requests: "write" },
          repositories: [{ id: repositoryId, full_name: repository }],
        });
        return;
      }
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const prefix = `/repos/${repository}/`;
      assert.ok(url.pathname.startsWith(prefix), "expected scoped repository request");
      const path = url.pathname.slice(prefix.length);

      const pull = {
        number: pullNumber,
        body: pullMarker,
        head: { ref: branch, sha: ownedSha, repo: { id: repositoryId } },
        base: { ref: "main" },
        state: pullState,
      };
      if (request.method === "PATCH" && path === "pulls/42") {
        closeRequests++;
        assert.deepEqual(await requestJson(request), { state: "closed" });
        pullState = "closed";
        respond(200, { ...pull, state: pullState });
        return;
      }
      assert.equal(request.method, "GET");
      if (path === "pulls") {
        assert.equal(url.searchParams.get("head"), `fixture-owner:${branch}`);
        assert.equal(url.searchParams.get("state"), "all");
        respond(200, [pull]);
      } else if (path === "pulls/42") {
        respond(200, pull);
      } else if (path === `git/ref/heads/${branch}`) {
        refReads++;
        const sha = await remoteSha(branchRef);
        respond(sha ? 200 : 404, sha ? { object: { sha } } : {});
      } else if (path === `commits/${ownedSha}`) {
        // Derive ownership evidence independently from Git objects on the remote.
        const parents = (await git(bare, "show", "-s", "--format=%P", ownedSha)).trim();
        const message = (await git(bare, "show", "-s", "--format=%B", ownedSha)).trimEnd();
        const changes = (
          await git(bare, "diff-tree", "--no-commit-id", "--name-status", "-r", ownedSha)
        ).trim();
        const files = changes.split("\n").map((change) => {
          const [status, filename] = change.split("\t");
          return { filename, status: status === "A" ? "added" : status };
        });
        respond(200, {
          parents: parents
            .split(" ")
            .filter(Boolean)
            .map((parent) => ({ sha: parent })),
          commit: { message },
          files,
        });
      } else if (path === `contents/${file}`) {
        assert.equal(url.searchParams.get("ref"), ownedSha);
        const bytes = await git(bare, "show", `${ownedSha}:${file}`);
        respond(200, { content: Buffer.from(bytes, "utf8").toString("base64") });
      } else {
        respond(404, {});
      }
    } catch (error) {
      t.diagnostic(String(error));
      respond(500, { message: "fixture request failed" });
    }
  });
  const port = await listen(t, server);
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: directory,
    repository,
    githubApiOrigin: `http://127.0.0.1:${port}`,
    run: async (command, args, options) => {
      const githubRemote = `https://github.com/${repository}.git`;
      if (args.includes("push")) {
        assert.ok(args.includes(githubRemote), "observer push must target the fixture repository");
        pushCount++;
        if (concurrentWrite) {
          assert.equal(refReads, 2, "advance the ref after the final REST observation");
          await git(checkout, "push", bare, `${newerSha}:${branchRef}`);
        }
      } else {
        assert.deepEqual(args, ["check-ref-format", branchRef]);
      }
      // Redirect only the transport target. Stock Git receives the observer's actual refspec and lease.
      const localArgs = args.map((arg) => (arg === githubRemote ? bare : arg));
      const result = await run(command, localArgs, {
        cwd: checkout,
        env: gitEnv,
        timeout: options?.timeout,
        allowFailure: true,
      });
      if (result.code !== 0) {
        throw new Error(`Git exited ${result.code}: ${result.stdout}`);
      }
    },
  });
  return {
    cleanup: () =>
      cleanupRepositoryJourney({
        observe,
        repository,
        repositoryId,
        branch,
        base: "main",
        baseSha,
        file,
        content,
        marker,
        commitMessage,
        readOnly: false,
      }),
    ownedSha,
    newerSha,
    baseSha,
    remoteSha,
    mutationCounts: () => ({ closeRequests, pushCount }),
  };
}

test("repository cleanup reconciles an unknown write and removes only the owned ref", async (t) => {
  const fixture = await cleanupFixture(t);
  // The write reached Git, but the task result never provided an expected SHA.
  assert.equal(await fixture.remoteSha(branchRef), fixture.ownedSha);
  await fixture.cleanup();

  assert.deepEqual(fixture.mutationCounts(), { closeRequests: 1, pushCount: 1 });
  assert.equal(await fixture.remoteSha(branchRef), undefined);
  assert.equal(await fixture.remoteSha(unrelatedRef), fixture.baseSha);
});

test("repository cleanup retains the ref and PR on ownership mismatch", async (t) => {
  const fixture = await cleanupFixture(t, { pullMarker: "different run" });
  await assert.rejects(fixture.cleanup(), { code: "ERR_ASSERTION" });

  assert.deepEqual(fixture.mutationCounts(), { closeRequests: 0, pushCount: 0 });
  assert.equal(await fixture.remoteSha(branchRef), fixture.ownedSha);
  assert.equal(await fixture.remoteSha(unrelatedRef), fixture.baseSha);
});

test("repository cleanup rejects a malformed PR number before mutation", async (t) => {
  // A numeric string would resolve to the same REST path as the number 42.
  const fixture = await cleanupFixture(t, { pullNumber: "42" });
  await assert.rejects(fixture.cleanup(), /invalid GitHub PR number/);

  assert.deepEqual(fixture.mutationCounts(), { closeRequests: 0, pushCount: 0 });
  assert.equal(await fixture.remoteSha(branchRef), fixture.ownedSha);
});

test("repository cleanup preserves a concurrent ref update when Git refuses its stale lease", async (t) => {
  const fixture = await cleanupFixture(t, { concurrentWrite: true });
  await assert.rejects(fixture.cleanup(), /stale info/);

  assert.deepEqual(fixture.mutationCounts(), { closeRequests: 1, pushCount: 1 });
  assert.equal(await fixture.remoteSha(branchRef), fixture.newerSha);
  assert.equal(await fixture.remoteSha(unrelatedRef), fixture.baseSha);
});
