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
import { certificateAuthority, signedLeaf } from "./certificates.mjs";
import { temporaryDirectory } from "./temporary-directory.ts";

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
    timeout: 4_000,
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

// Real Git behind a controlled GitHub HTTPS origin. No recipient or grant
// authority is created here; the caller supplies those through its runtime.
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
    execute("/usr/bin/git", args, { cwd, env, timeout: 8_000 });
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
  const credential = randomBytes(32).toString("hex");
  const writes: { path: string; digest: string; body: Buffer }[] = [];
  const operations = new Set<Promise<void>>();
  let providerError: unknown;
  const provider = createServer(providerLeaf, (req, res) => {
    const operation = (async () => {
      const body = await readBody(req);
      const path = req.url ?? "";
      const api = req.headers.host === "api.github.com";
      assert.ok(api || req.headers.host === "github.com");
      const auth = api
        ? `Bearer ${credential}`
        : `Basic ${Buffer.from(`x-access-token:${credential}`).toString("base64")}`;
      assert.equal(req.headers.authorization, auth);
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
      if (api) {
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
