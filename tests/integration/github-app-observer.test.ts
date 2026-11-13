import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { captureChild } from "../helpers/child-processes.mjs";
import { setEnvironment } from "../helpers/environment.ts";
import {
  createGitHubAppRepositoryObserver,
  loadGitHubAppObserverInput,
} from "../helpers/github-app-observer.ts";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repository = "fixture-owner/fixture-repo";
const repositoryId = 789;

type RequestObservation = Pick<IncomingMessage, "method" | "url"> & {
  authorization: IncomingMessage["headers"]["authorization"];
};

type TokenContext = { index: number };
type FixtureOptions = {
  tokenRepositories?: { id: number; full_name: string }[];
  token?: (context: TokenContext) => string;
  expiresAt?: (context: TokenContext) => string;
  stallTokenBody?: boolean;
  stallGetBody?: boolean;
};

type ObserverOptions = Parameters<typeof createGitHubAppRepositoryObserver>[0];

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: AsyncIterable<unknown> = request;
  let input = "";
  for await (const chunk of chunks) {
    assert.ok(Buffer.isBuffer(chunk), "expected HTTP body bytes");
    input += chunk.toString("utf8");
  }
  return input ? JSON.parse(input) : undefined;
}

function generatePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" });
}

async function fixture(
  t: Pick<TestContext, "after">,
  {
    tokenRepositories,
    token = ({ index }) => `ghs_observer_secret_token_${index}`,
    expiresAt = () => new Date(Date.now() + 3600_000).toISOString(),
    stallTokenBody = false,
    stallGetBody = false,
  }: FixtureOptions = {},
) {
  const directory = await temporaryDirectory(t, "github-app-observer-");
  await writeFile(join(directory, "private-key.pem"), generatePrivateKeyPem(), { mode: 0o600 });
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
  const seen: RequestObservation[] = [];
  const issuedTokens: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (request.method === "POST" && request.url === "/app/installations/456/access_tokens") {
        const body = await readRequestJson(request);
        assert.deepEqual(body, {
          repository_ids: [repositoryId],
          permissions: { contents: "write", pull_requests: "write" },
        });
        assert.ok(bearer, "token mint request must carry a JWT");
        const encodedPayload = bearer.split(".")[1];
        assert.ok(encodedPayload, "JWT must contain a payload");
        const payload: unknown = JSON.parse(
          Buffer.from(encodedPayload, "base64url").toString("utf8"),
        );
        assert.ok(payload !== null && typeof payload === "object" && "iss" in payload);
        assert.equal(payload.iss, "123");
        const value = token({ index: issuedTokens.length + 1 });
        issuedTokens.push(value);
        response.writeHead(201, { "content-type": "application/json" });
        if (stallTokenBody) {
          response.write("{");
          return;
        }
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
        assert.ok(bearer !== undefined && issuedTokens.includes(bearer));
        response.writeHead(200, { "content-type": "application/json" });
        if (stallGetBody) {
          response.write("{");
          return;
        }
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
        assert.ok(bearer !== undefined && issuedTokens.includes(bearer));
        assert.deepEqual(await readRequestJson(request), { state: "closed" });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ number: 42, state: "closed" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "fixture request failed" }));
    }
  });
  const origin = `http://127.0.0.1:${await listen(t, server)}`;
  return { directory, origin, seen, issuedTokens };
}

test("GitHub App observer input rejects symlinked private key files", async (t) => {
  const f = await fixture(t);
  const target = join(f.directory, "private-key-target.pem");
  const keyPath = join(f.directory, "private-key.pem");
  const privateKey = generatePrivateKeyPem();
  await rm(keyPath);
  await writeFile(target, privateKey, { mode: 0o600 });
  await symlink(target, keyPath);

  await assert.rejects(
    loadGitHubAppObserverInput(f.directory, repository),
    /ELOOP|symlink|private regular file|too many levels/i,
  );
  assert.equal(f.seen.length, 0);
});

test("GitHub App observer input rejects FIFO private key files without hanging", async (t) => {
  const f = await fixture(t);
  const keyPath = join(f.directory, "private-key.pem");
  await rm(keyPath);
  const fifo = spawnSync("mkfifo", [keyPath], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  await chmod(keyPath, 0o600);

  // A blocking FIFO read must fail the test within the subprocess deadline.
  const result = runLoadObserverInput(f.directory);
  const { error } = result;
  const errorCode = error && "code" in error ? error.code : undefined;

  assert.notEqual(errorCode, "ETIMEDOUT", result.stderr);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private regular file/);
  assert.equal(f.seen.length, 0);
});

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

  assert.ok(first.data !== null && typeof first.data === "object" && "full_name" in first.data);
  assert.equal(first.data.full_name, repository);
  assert.ok(second.data !== null && typeof second.data === "object" && "id" in second.data);
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
  // The first token is still valid, but has entered the five-minute refresh window.
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

  assert.ok(result.data !== null && typeof result.data === "object" && "state" in result.data);
  assert.equal(result.data.state, "closed");
  assert.equal(f.issuedTokens.length, 1);

  // A malformed close request must not echo its contents, even with a valid token.
  const [token] = f.issuedTokens;
  assert.ok(token, "expected an installation token");
  const marker = `invalid-close-state-${randomUUID()}`;
  const rejected = await fetch(`${f.origin}/repos/${repository}/pulls/42`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ state: `${marker} ${token}` }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(rejected.status, 500);
  assert.equal(rejected.headers.get("content-type"), "application/json");
  const responseBody = await rejected.text();
  assert.ok(
    responseBody === JSON.stringify({ message: "fixture request failed" }),
    "expected only the fixed error message without request data or a stack trace",
  );
});

test("GitHub App observer deleteBranch uses a credential helper and leased Git push", async (t) => {
  const f = await fixture(t);
  const calls: Parameters<ObserverOptions["run"]>[] = [];
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    githubApiOrigin: f.origin,
    run: async (...args) => {
      calls.push(args);
      return "";
    },
  });

  await observe.deleteBranch("qa/test-branch", "a".repeat(40));

  assert.equal(calls.length, 2);
  const [refCheck, push] = calls;
  assert.ok(refCheck, "expected a Git ref check");
  const [refCommand, refArgs, refOptions = {}] = refCheck;
  assert.equal(refCommand, "git");
  assert.deepEqual(refArgs, ["check-ref-format", "refs/heads/qa/test-branch"]);
  assert.deepEqual(refOptions, {});
  assert.ok(push, "expected a Git push");
  const [command, args, options] = push;
  assert.equal(command, "git");
  assert.ok(args.includes("push"));
  assert.ok(args.includes("--porcelain"));
  assert.ok(args.includes(`--force-with-lease=refs/heads/qa/test-branch:${"a".repeat(40)}`));
  assert.ok(args.includes(`https://github.com/${repository}.git`));
  assert.ok(args.includes(":refs/heads/qa/test-branch"));
  assert.ok(args.includes("credential.useHttpPath=true"));
  const helper = args.find((arg) => arg.includes("github-app-observer-credential-helper.ts"));
  assert.ok(helper, "expected a credential helper in Git argv");
  assert.match(helper, /credential\.helper=.*github-app-observer-credential-helper\.ts/);
  assert.match(helper, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(args.join("\n"), /ghs_observer_secret_token|private-key|Bearer/);
  assert.ok(options, "expected Git push options");
  assert.deepEqual(options.env, { GIT_TERMINAL_PROMPT: "0" });
  assert.equal(options.privateFailureOutput, true);
});

async function runCredentialHelper(
  f: { directory: string },
  operation: string,
  request: string,
  env: NodeJS.ProcessEnv = {},
) {
  const helper = fileURLToPath(
    new URL("../../scripts/ci/github-app-observer-credential-helper.ts", import.meta.url),
  );
  const options = { encoding: "utf8" as const, env: childEnv(env), input: request };
  const result: unknown = await captureChild(
    process.execPath,
    [helper, f.directory, repository, operation],
    options,
  );
  assert.ok(result !== null && typeof result === "object");
  assert.ok("status" in result && (result.status === null || typeof result.status === "number"));
  assert.ok("stdout" in result && typeof result.stdout === "string");
  assert.ok("stderr" in result && typeof result.stderr === "string");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function credentialRequest({
  protocol = "https",
  host = "github.com",
  path = repository,
}: { protocol?: string; host?: string; path?: string } = {}) {
  return `protocol=${protocol}\nhost=${host}\npath=${path}.git\n\n`;
}

function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return { ...env, ...overrides };
}

function runLoadObserverInput(inputDirectory: string) {
  const helper = new URL("../helpers/github-app-observer.ts", import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { loadGitHubAppObserverInput } from ${JSON.stringify(helper)};
await loadGitHubAppObserverInput(process.env.OBSERVER_INPUT_DIRECTORY, ${JSON.stringify(repository)});`,
    ],
    {
      encoding: "utf8",
      env: childEnv({ OBSERVER_INPUT_DIRECTORY: inputDirectory }),
      timeout: 1000,
    },
  );
}

test("GitHub App observer credential helper mints only for valid get operations", async (t) => {
  const f = await fixture(t);
  const result = await runCredentialHelper(f, "get", credentialRequest(), {
    NODE_ENV: "test",
    OCC_TEST_QA_GITHUB_API_ORIGIN: f.origin,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^username=x-access-token\npassword=ghs_observer_secret_token_1\n$/);
  assert.equal(
    f.seen.filter((request) => request.url === "/app/installations/456/access_tokens").length,
    1,
  );
});

test("GitHub App observer credential helper does not mint for store or erase", async (t) => {
  const f = await fixture(t);
  for (const operation of ["store", "erase"]) {
    const result = await runCredentialHelper(f, operation, credentialRequest(), {
      NODE_ENV: "test",
      OCC_TEST_QA_GITHUB_API_ORIGIN: f.origin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.equal(f.seen.length, 0);
});

test("GitHub App observer credential helper rejects unsupported operations and wrong targets", async (t) => {
  const f = await fixture(t);
  const env = { NODE_ENV: "test", OCC_TEST_QA_GITHUB_API_ORIGIN: f.origin };
  const unsupported = await runCredentialHelper(f, "approve", credentialRequest(), env);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported Git credential helper operation/);

  const wrongHost = await runCredentialHelper(
    f,
    "get",
    credentialRequest({ host: "example.com" }),
    env,
  );
  assert.notEqual(wrongHost.status, 0);
  assert.match(wrongHost.stderr, /requires github\.com/);

  const wrongPath = await runCredentialHelper(
    f,
    "get",
    credentialRequest({ path: "fixture-owner/other-repo" }),
    env,
  );
  assert.notEqual(wrongPath.status, 0);
  assert.match(wrongPath.stderr, /request path must match/);
  assert.equal(f.seen.length, 0);
});

test("GitHub App observer credential helper keeps API origin override test-only and loopback", async (t) => {
  const f = await fixture(t);
  setEnvironment(t, { NODE_ENV: "test" });
  const notTest = await runCredentialHelper(f, "get", credentialRequest(), {
    OCC_TEST_QA_GITHUB_API_ORIGIN: f.origin,
  });
  assert.notEqual(notTest.status, 0);
  assert.match(notTest.stderr, /allowed only in tests/);

  const httpsOrigin = await runCredentialHelper(f, "get", credentialRequest(), {
    NODE_ENV: "test",
    OCC_TEST_QA_GITHUB_API_ORIGIN: "https://example.invalid",
  });
  assert.notEqual(httpsOrigin.status, 0);
  assert.match(httpsOrigin.stderr, /must use http/);

  // Use HTTP to reach the hostname check without triggering the scheme check.
  const nonLoopback = await runCredentialHelper(f, "get", credentialRequest(), {
    NODE_ENV: "test",
    OCC_TEST_QA_GITHUB_API_ORIGIN: "http://example.invalid",
  });
  assert.ok(nonLoopback.status !== null && nonLoopback.status !== 0);
  assert.match(nonLoopback.stderr, /(?:^|: )test GitHub API origin must be loopback$/m);
  assert.equal(nonLoopback.stdout, "");
  assert.equal(f.seen.length, 0);
});

test("GitHub App observer token mint times out while reading a stalled response body", async (t) => {
  const f = await fixture(t, { stallTokenBody: true });
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    run: async () => "",
    githubApiOrigin: f.origin,
    fetchTimeoutMs: 50,
  });

  await assert.rejects(observe("GET"), /aborted|AbortError|timeout/i);
});

test("GitHub App observer REST calls time out while reading a stalled response body", async (t) => {
  const f = await fixture(t, { stallGetBody: true });
  const observe = await createGitHubAppRepositoryObserver({
    inputDirectory: f.directory,
    repository,
    run: async () => "",
    githubApiOrigin: f.origin,
    fetchTimeoutMs: 50,
  });

  await assert.rejects(observe("GET"), /aborted|AbortError|timeout/i);
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
