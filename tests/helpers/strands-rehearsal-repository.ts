import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Agent, createServer } from "node:https";
import type { Server } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { certificateAuthority, signedLeaf } from "./certificates.ts";
import { temporaryDirectory } from "./temporary-directory.ts";
import { strandsTimeoutMs } from "./strands-timeout.ts";

const execute = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const repository = {
  repository: "example/review",
  repositoryId: "42",
  installationId: "17",
  head: "review",
  base: "main",
};

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function readBody(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseCgi(bytes: Buffer): { status: number; type: string; body: Buffer } {
  const boundary = bytes.indexOf("\r\n\r\n");
  assert.ok(boundary >= 0, "git http-backend returned CGI headers");
  const header = bytes.toString("ascii", 0, boundary);
  const type = /^Content-Type: ([^\r\n]+)$/im.exec(header)?.[1];
  assert.ok(type);
  return {
    status: Number(/^Status: ([0-9]{3})/im.exec(header)?.[1] ?? 200),
    type,
    body: bytes.subarray(boundary + 4),
  };
}

async function gitBackend(
  root: string,
  env: NodeJS.ProcessEnv,
  request: IncomingMessage,
  body: Buffer,
) {
  const [path, query = ""] = (request.url ?? "").split("?");
  const child = spawn("/usr/bin/git", ["http-backend"], {
    env: {
      ...env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "installation",
      PATH_INFO: path,
      QUERY_STRING: query,
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"],
      CONTENT_LENGTH: String(body.length),
      HTTP_GIT_PROTOCOL:
        typeof request.headers["git-protocol"] === "string"
          ? request.headers["git-protocol"]
          : undefined,
    },
    stdio: ["pipe", "pipe", "ignore"],
    timeout: strandsTimeoutMs(4_000),
  });
  const done = once(child, "exit");
  child.stdin.on("error", () => {});
  child.stdin.end(body);
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  assert.deepEqual(await done, [0, null]);
  return parseCgi(Buffer.concat(chunks));
}

export interface RepositoryOriginFaults {
  loseDraft: boolean;
  losePush: boolean;
}

export interface FixturePull {
  readonly number: number;
  readonly id: string;
  readonly draft: boolean;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  /** The installation-token credential that created it, as GitHub records the App bot actor. */
  readonly actor: "installation";
}

const graphQlRepository = {
  id: "R_review",
  databaseId: 42,
  name: "review",
  owner: { login: "example" },
  sshUrl: "git@github.com:example/review.git",
  hasIssuesEnabled: true,
  description: "",
  hasWikiEnabled: false,
  viewerPermission: "WRITE",
  defaultBranchRef: { name: "main" },
};

// Real Git behind a controlled GitHub HTTPS origin. No recipient or grant
// authority is created here; the caller supplies those through its runtime.
// The installation token covers only `example/review`, as a GitHub App installation token
// scoped to one repository does; `revoke()` models GitHub after DELETE /installation/token.
export async function strandsRepositoryOriginFixture(
  t: TestContext,
  faults: RepositoryOriginFaults = { loseDraft: false, losePush: false },
) {
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  let dispose = async () => {
    agent.destroy();
  };
  t.after(() => dispose());
  const root = await temporaryDirectory(t, "repository-origin-");
  const projects = join(root, "repositories");
  const repoPath = join(projects, "example", "review.git");
  const checkout = join(root, "seed");
  await Promise.all([mkdir(join(projects, "example"), { recursive: true }), mkdir(checkout)]);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: readonly string[], cwd = checkout) =>
    execute("/usr/bin/git", args, { cwd, env, timeout: strandsTimeoutMs(8_000) });
  await git(["init", "--bare", "--initial-branch=main", repoPath]);
  await git(["--git-dir", repoPath, "config", "http.receivepack", "true"]);
  await git(["init", "--initial-branch=main"]);
  await writeFile(join(checkout, "tracked.txt"), "first\n");
  await git(["add", "tracked.txt"]);
  const commit = (message: string, cwd = checkout) =>
    git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-am",
        message,
      ],
      cwd,
    );
  await commit("first");
  await git(["push", repoPath, "HEAD:refs/heads/main"]);

  const authority = await certificateAuthority(root, {
    caName: "Repository test CA",
    caKeyPem: undefined,
  });
  const providerLeaf = await signedLeaf(root, authority, {
    name: "provider",
    commonName: "Provider",
    subjectAltName: "DNS:github.com,DNS:api.github.com",
    keyPem: undefined,
  });
  const caBytes = await readFile(authority.caPath);
  const credential = `ghs_${randomBytes(18).toString("hex")}`;
  let revoked = false;
  const pulls: FixturePull[] = [];
  const refusals: { host: string; method: string; path: string; status: number }[] = [];
  const writes: { path: string; digest: string; body: Buffer }[] = [];
  const operations = new Set<Promise<void>>();
  let providerError: unknown;
  const provider = createServer(providerLeaf, (req, res) => {
    const operation = (async () => {
      const body = await readBody(req);
      const path = req.url ?? "";
      const api = req.headers.host === "api.github.com";
      assert.ok(api || req.headers.host === "github.com");
      const accepted = api
        ? [`Bearer ${credential}`, `token ${credential}`]
        : [`Basic ${Buffer.from(`x-access-token:${credential}`).toString("base64")}`];
      const refuse = (status: number, message: string) => {
        refusals.push({ host: req.headers.host!, method: req.method!, path, status });
        res
          .writeHead(status, {
            "content-type": "application/json",
            ...(status === 401 && !api ? { "www-authenticate": 'Basic realm="GitHub"' } : {}),
          })
          .end(JSON.stringify({ message }));
      };
      if (revoked || !accepted.includes(req.headers.authorization ?? "")) {
        refuse(401, "Bad credentials");
        return;
      }
      if (!api && !path.startsWith(`/${repository.repository}.git/`)) {
        refuse(404, "Repository not found.");
        return;
      }
      const headers = Object.entries(req.headers)
        .filter(([name]) => name !== "authorization")
        .sort();
      writes.push({
        path,
        body,
        digest: sha(
          Buffer.concat([
            Buffer.from(JSON.stringify([req.method, `https://${req.headers.host}`, path, headers])),
            body,
          ]),
        ),
      });
      if (api && path === "/graphql") {
        const request = JSON.parse(body.toString()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const operation = /(?:query|mutation) ([A-Za-z]+)/.exec(request.query)?.[1];
        const variables = request.variables;
        const input = (variables.input ?? {}) as Record<string, unknown>;
        const named = `${String(variables.owner)}/${String(variables.name ?? variables.repo)}`;
        const reply = (value: unknown) =>
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
        if (
          (operation === "RepositoryInfo" || operation === "PullRequestForBranch") &&
          named !== repository.repository
        ) {
          refusals.push({ host: "api.github.com", method: "POST", path, status: 200 });
          reply({
            data: { repository: null },
            errors: [
              {
                type: "NOT_FOUND",
                path: ["repository"],
                message: `Could not resolve to a Repository with the name '${named}'.`,
              },
            ],
          });
        } else if (operation === "RepositoryInfo") {
          reply({
            data: {
              repository: {
                ...graphQlRepository,
                parent: null,
                mergeCommitAllowed: true,
                rebaseMergeAllowed: true,
                squashMergeAllowed: true,
              },
            },
          });
        } else if (operation === "PullRequestForBranch") {
          reply({
            data: {
              repository: {
                pullRequests: {
                  nodes: pulls
                    .filter(({ head }) => head === variables.headRefName)
                    .map((pull) => ({
                      url: `https://github.com/${repository.repository}/pull/${pull.number}`,
                      id: pull.id,
                      number: pull.number,
                      state: "OPEN",
                      baseRefName: pull.base,
                      headRefName: pull.head,
                      isCrossRepository: false,
                      headRepositoryOwner: { id: "O_example", login: "example" },
                    })),
                },
                defaultBranchRef: { name: "main" },
              },
            },
          });
        } else if (operation === "PullRequestCreate" && input.repositoryId === "R_review") {
          const head = String(input.headRefName);
          const exists = (
            await execute(
              "/usr/bin/git",
              ["--git-dir", repoPath, "rev-parse", "--verify", "-q", `refs/heads/${head}`],
              {
                env,
              },
            ).catch(() => ({ stdout: "" }))
          ).stdout.trim();
          if (exists === "") {
            refusals.push({ host: "api.github.com", method: "POST", path, status: 200 });
            reply({
              data: { createPullRequest: null },
              errors: [{ type: "UNPROCESSABLE", message: `Head sha can't be blank` }],
            });
            return;
          }
          const pull: FixturePull = {
            number: 7 + pulls.length,
            id: `PR_${7 + pulls.length}`,
            draft: input.draft === true,
            head,
            base: String(input.baseRefName),
            title: String(input.title),
            actor: "installation",
          };
          pulls.push(pull);
          reply({
            data: {
              createPullRequest: {
                pullRequest: {
                  id: pull.id,
                  url: `https://github.com/${repository.repository}/pull/${pull.number}`,
                },
              },
            },
          });
        } else {
          refuse(400, `unsupported fixture operation ${String(operation)}`);
        }
      } else if (api) {
        assert.equal(req.method, "POST");
        assert.equal(path, "/repos/example/review/pulls");
        if (faults.loseDraft) {
          req.socket.destroy();
          return;
        }
        const responseRepository = { id: 42, full_name: repository.repository };
        res.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: 81,
            number: 7,
            draft: true,
            state: "open",
            html_url: "https://github.com/example/review/pull/7",
            head: { ref: "review", repo: responseRepository },
            base: { ref: "main", repo: responseRepository },
            ignoredProviderField: "provider-only",
          }),
        );
      } else {
        const output = await gitBackend(projects, env, req, body);
        if (faults.losePush && path.endsWith("/git-receive-pack")) {
          req.socket.destroy();
          return;
        }
        res
          .writeHead(output.status, {
            "content-type": output.type,
            "content-length": String(output.body.length),
          })
          .end(output.body);
      }
    })().catch((error: unknown) => {
      providerError = error;
      res.destroy();
    });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  let connections = 0;
  provider.on("connection", () => {
    connections++;
  });
  dispose = async () => {
    agent.destroy();
    const closed = new Promise<void>((resolve) => provider.close(() => resolve()));
    provider.closeAllConnections();
    // A closed socket does not join its Git subprocess. Drain handlers before
    // the later temporary-directory hook removes the repository.
    await Promise.all([closed, ...operations]);
  };
  const port = await listen(provider);
  agent.createConnection = (options) => {
    assert.ok(options.servername === "github.com" || options.servername === "api.github.com");
    return connect({
      host: "127.0.0.1",
      port,
      servername: options.servername,
      ca: caBytes,
      rejectUnauthorized: true,
    });
  };
  return {
    root,
    repository: { ...repository },
    repoPath,
    checkout,
    git,
    commit,
    credential,
    authority,
    rootCertificatePath: authority.caPath,
    caBundle: caBytes,
    address: { host: "127.0.0.1", port },
    gitOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
    upstreamAgent: agent,
    faults,
    writes,
    pulls,
    refusals,
    /** GitHub after OCE's retirement revoked the installation token. */
    revoke() {
      revoked = true;
    },
    connections: () => connections,
    error: () => providerError,
    async publishCommit(text: string) {
      await writeFile(join(checkout, "tracked.txt"), text);
      await commit("Publish next fixture object");
      await git(["push", repoPath, "HEAD:refs/heads/main"]);
      return (await git(["rev-parse", "HEAD"])).stdout.trim();
    },
  };
}
