import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Agent, createServer, request } from "node:https";
import type { Server } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { connect } from "node:tls";
import { promisify } from "node:util";
import type {
  EgressExecution,
  EgressInstallation,
  PreparedGitHubRepositoryUseRequest,
  ProtectedGitHubRepositoryMaterial,
  ProtectedRepositoryGitAuthority,
} from "@openclaw-enterprise/contracts";
import { createRepositorySender } from "../../deploy/examples/strands-box/git/index.ts";
import type {
  CurrentGitRecipient,
  GitReceipt,
} from "../../deploy/examples/strands-box/git/index.ts";
import { certificateAuthority, signedLeaf } from "./certificates.mjs";
import { temporaryDirectory } from "./temporary-directory.ts";

const execute = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const repo = {
  repository: "example/review",
  repositoryId: "42",
  installationId: "17",
  head: "review",
  base: "main",
};
const baseExecution: EgressExecution = {
  installationId: "installation",
  namespaceId: "namespace",
  agentId: "agent",
  servicePrincipalId: "principal",
  revisionId: "revision",
  executionId: "original-execution",
};
const driver = { id: "sender", implementation: "test/sender", configurationId: "config" };
const sender = { id: "exact-sender", generation: 1 };
const version = { preparationAttemptId: "attempt", materialVersion: "version" };

async function listen(t: TestContext, server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
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

export async function strandsRepositorySenderFixture(
  t: TestContext,
  agentId = baseExecution.agentId,
  originalPid = process.pid,
) {
  const execution = {
    ...baseExecution,
    agentId,
    revisionId: `${agentId}-revision`,
    executionId: `${agentId}-execution`,
  };
  const root = await temporaryDirectory(t, "box-repository-");
  const journal = join(root, "journal");
  const projects = join(root, "repositories");
  const repoPath = join(projects, "example", "review.git");
  const checkout = join(root, "seed");
  await Promise.all([
    mkdir(journal, { mode: 0o700 }),
    mkdir(join(projects, "example"), { recursive: true }),
    mkdir(checkout),
  ]);
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

  const ca = await certificateAuthority(root, {
    caName: "Repository test CA",
    caKeyPem: undefined,
  });
  // OpenSSL uses one serial file per CA, so issue leaves in sequence.
  const [serverLeaf, providerLeaf, clientLeaf, unrelatedLeaf] = [
    await signedLeaf(root, ca, {
      name: "sender",
      commonName: "Sender",
      subjectAltName: "IP:127.0.0.1",
      keyPem: undefined,
    }),
    await signedLeaf(root, ca, {
      name: "provider",
      commonName: "Provider",
      subjectAltName: "DNS:github.com,DNS:api.github.com",
      keyPem: undefined,
    }),
    await signedLeaf(root, ca, {
      name: "client",
      commonName: "Execution",
      subjectAltName: undefined,
      usage: "clientAuth",
      keyPem: undefined,
    }),
    await signedLeaf(root, ca, {
      name: "unrelated",
      commonName: "Other execution",
      subjectAltName: undefined,
      usage: "clientAuth",
      keyPem: undefined,
    }),
  ];
  const caBytes = await readFile(ca.caPath);
  const key = sha(
    new X509Certificate(clientLeaf.cert).publicKey.export({ type: "spki", format: "der" }),
  );
  const [boot, proc] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${originalPid}/stat`, "utf8"),
  ]);
  const startTicks = proc.slice(proc.lastIndexOf(")") + 2).split(/\s+/)[19];
  assert.ok(startTicks);
  // This fixture stands in for a committed maintained Worker release. It never
  // claims the ordinary Box launcher can produce an installed recipient.
  const original = {
    running: true,
    executionId: execution.executionId,
    bootId: boot.trim(),
    pid: originalPid,
    startTicks,
  } as const;
  const grant = { providerInstanceId: "provider", repositoryId: "one-selection", grantId: "grant" };
  const installation: EgressInstallation = {
    plan: {
      id: "plan",
      generation: 1,
      execution,
      sandboxDriverId: driver.id,
      egressDriverId: driver.id,
      driver,
      routes: [],
      repositoryGitAuthorization: "online-request",
      repositoryGit: {
        driver: { id: "repo", implementation: "fixture/repo" },
        deadlineWallMs: Date.now() + 60_000,
        bindings: [
          { repositoryRef: "selected", profile: "github-repository", backendId: "repo", grant },
        ],
      },
    },
    sandboxId: "sandbox",
    sender,
    installedAt: new Date().toISOString(),
    enforcement: {
      instanceId: "policy-instance",
      configurationId: "exact-config",
      policyHash: sha("installed-policy"),
      authorityScope: "execution",
      repositoryGitRecipient: {
        providerId: "provider",
        attachmentEpoch: "one-attachment",
        processInstanceId: `${original.bootId}:${original.pid}:${original.startTicks}`,
        networkInstanceId: `mtls-sha256:${key}`,
        authorization: "online-request",
        deliveryProfile: "github_repository",
      },
    },
  };
  const snapshot: CurrentGitRecipient = {
    installation,
    route: { revisionId: execution.revisionId, fence: 3, observed: installation },
    version,
    original,
    clientKeySha256: key,
  };
  const material: ProtectedGitHubRepositoryMaterial = {
    scope: "github-repository",
    value: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sessionId: "session",
    preparationAttemptId: version.preparationAttemptId,
    materialVersion: version.materialVersion,
    providerInstanceId: grant.providerInstanceId,
    grantId: grant.grantId,
    installationId: repo.installationId,
    repositories: [{ repositoryId: repo.repositoryId, repository: repo.repository }],
    apiOrigin: "https://api.github.com",
  };
  const state = {
    withdrawn: false,
    withdrawAtAuthorization: false,
    missing: false,
    loseDraft: false,
    losePush: false,
    live: true,
    replaceAfterAllow: false,
    materialReads: 0,
  };
  const receipts: GitReceipt[] = [];
  const authorizations: PreparedGitHubRepositoryUseRequest[] = [];
  const writes: { path: string; digest: string; body: Buffer }[] = [];

  const provider = createServer(providerLeaf, (req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = req.url ?? "";
      const api = req.headers.host === "api.github.com";
      assert.ok(api || req.headers.host === "github.com");
      const auth = api
        ? `Bearer ${material.value}`
        : `Basic ${Buffer.from(`x-access-token:${material.value}`).toString("base64")}`;
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
        if (state.loseDraft) {
          req.socket.destroy();
          return;
        }
        const repository = { id: 42, full_name: repo.repository };
        res.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: 81,
            number: 7,
            draft: true,
            state: "open",
            html_url: "https://github.com/example/review/pull/7",
            head: { ref: "review", repo: repository },
            base: { ref: "main", repo: repository },
            ignoredProviderField: "provider-only",
          }),
        );
      } else {
        const output = await gitBackend(projects, env, req, body);
        if (state.losePush && path.endsWith("/git-receive-pack")) {
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
    })().catch(() => {
      res.destroy();
    });
  });
  let connections = 0;
  provider.on("connection", () => {
    connections++;
  });
  const providerPort = await listen(t, provider);
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  agent.createConnection = (options) => {
    assert.ok(options.servername === "github.com" || options.servername === "api.github.com");
    return connect({
      host: "127.0.0.1",
      port: providerPort,
      servername: options.servername,
      ca: caBytes,
      rejectUnauthorized: true,
    });
  };
  t.after(() => agent.destroy());
  const denied = { kind: "denied", reason: "unavailable" } as const;
  const compatibility = { readMaterial: async () => undefined, authorize: async () => denied };
  const authority: ProtectedRepositoryGitAuthority = {
    ...compatibility,
    recipients: {
      observe: async () => undefined,
      beginInstall: async () => undefined,
      confirmInstall: async () => undefined,
    },
    online: {
      ...compatibility,
      githubRepository: {
        async readMaterial(route) {
          state.materialReads++;
          assert.deepEqual(route, snapshot.route);
          return state.withdrawn ? { absent: "withdrawn" } : state.missing ? undefined : material;
        },
        async authorize(q, installed) {
          assert.deepEqual(installed, { route: snapshot.route, ...version });
          authorizations.push(q);
          if (state.withdrawn || state.withdrawAtAuthorization) {
            return { kind: "denied", reason: "access_withdrawn" };
          }
          if (state.replaceAfterAllow) {
            state.live = false;
          }
          return {
            kind: "allow",
            exchangeId: q.exchangeId,
            requestDigestSha256: q.requestDigestSha256,
            ...version,
            replyBy: q.deadlineAt,
          };
        },
      },
    },
  };
  const install = async (bind = true) => {
    const example = createRepositorySender({
      execution,
      driver,
      sender,
      repository: repo,
      journalDir: journal,
      upstreamAgent: agent,
      current: async () => (state.live ? structuredClone(snapshot) : undefined),
      record: (row) => {
        receipts.push(row);
      },
    });
    const binding = bind ? await example.bindRepositoryGit(authority) : undefined;
    const server = createServer(
      { ...serverLeaf, ca: caBytes, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        void example.handle(req, res);
      },
    );
    const port = await listen(t, server);
    t.after(() => binding?.close());
    const remote = `https://127.0.0.1:${port}/repository.git`;
    const remoteGit = (args: readonly string[], cwd?: string) =>
      git(
        [
          "-c",
          `http.sslCert=${clientLeaf.certPath}`,
          "-c",
          `http.sslKey=${clientLeaf.keyPath}`,
          "-c",
          `http.sslCAInfo=${ca.caPath}`,
          "-c",
          "http.version=HTTP/1.1",
          ...args,
        ],
        cwd,
      );
    const call = (
      path: string,
      input?: object,
      leaf = clientLeaf,
      gitProtocol?: string,
    ): Promise<{ status: number; body: Buffer }> =>
      new Promise((resolve, reject) => {
        const body =
          input === undefined || Buffer.isBuffer(input)
            ? input
            : Buffer.from(JSON.stringify(input));
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: body ? "POST" : "GET",
            ...leaf,
            ca: caBytes,
            agent: false,
            rejectUnauthorized: true,
            ...(body
              ? {
                  headers: {
                    "content-type": Buffer.isBuffer(input)
                      ? "application/x-git-receive-pack-request"
                      : "application/json",
                    "content-length": body.length,
                    ...(gitProtocol === undefined ? {} : { "git-protocol": gitProtocol }),
                  },
                }
              : {}),
          },
          (res) => {
            void readBody(res).then(
              (bytes) => resolve({ status: res.statusCode ?? 0, body: bytes }),
              reject,
            );
          },
        );
        req.once("error", reject);
        req.end(body);
      });
    return { remote, remoteGit, call, binding };
  };
  return {
    root,
    execution,
    snapshot,
    connections: () => connections,
    journal,
    repoPath,
    git,
    commit,
    state,
    receipts,
    authorizations,
    writes,
    install,
    unrelatedLeaf,
    material,
    async publishCommit(text: string) {
      await writeFile(join(checkout, "tracked.txt"), text);
      await commit("Publish next fixture object");
      await git(["push", repoPath, "HEAD:refs/heads/main"]);
      return (await git(["rev-parse", "HEAD"])).stdout.trim();
    },
  };
}
