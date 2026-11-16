import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer, request } from "node:https";
import type { Server } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
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
import { signedLeaf } from "./certificates.ts";
import { strandsRepositoryOriginFixture } from "./strands-rehearsal-repository.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
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
  const origin = await strandsRepositoryOriginFixture(t, state);
  const {
    root,
    repository: repo,
    repoPath,
    git,
    commit,
    authority: ca,
    caBundle: caBytes,
  } = origin;
  const journal = join(root, "journal");
  await mkdir(journal, { mode: 0o700 });
  const serverLeaf = await signedLeaf(root, ca, {
    name: "sender",
    commonName: "Sender",
    subjectAltName: "IP:127.0.0.1",
    keyPem: undefined,
  });
  // Box presents no client certificate. The paired Driver mints one bearer per execution and
  // the host hands it to Box as a phantom credential, so the request carries the real value.
  const bearer = randomBytes(32).toString("base64url");
  const unrelatedBearer = randomBytes(32).toString("base64url");
  const key = sha(bearer);
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
        networkInstanceId: `box-phantom-sha256:${key}`,
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
    executionBearerSha256: key,
  };
  const material: ProtectedGitHubRepositoryMaterial = {
    scope: "github-repository",
    value: origin.credential,
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
  const receipts: GitReceipt[] = [];
  const authorizations: PreparedGitHubRepositoryUseRequest[] = [];
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
      upstreamAgent: origin.upstreamAgent,
      current: async () => (state.live ? structuredClone(snapshot) : undefined),
      record: (row) => {
        receipts.push(row);
      },
    });
    const binding = bind ? await example.bindRepositoryGit(authority) : undefined;
    const server = createServer({ key: serverLeaf.key, cert: serverLeaf.cert }, (req, res) => {
      void example.handle(req, res);
    });
    const port = await listen(t, server);
    t.after(() => binding?.close());
    const remote = `https://127.0.0.1:${port}/repository.git`;
    const remoteGit = (args: readonly string[], cwd?: string) =>
      git(
        [
          "-c",
          `http.extraHeader=Authorization: Bearer ${bearer}`,
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
      credential: string | null = bearer,
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
            ca: caBytes,
            agent: false,
            rejectUnauthorized: true,
            headers: {
              ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
              ...(body
                ? {
                    "content-type": Buffer.isBuffer(input)
                      ? "application/x-git-receive-pack-request"
                      : "application/json",
                    "content-length": body.length,
                    ...(gitProtocol === undefined ? {} : { "git-protocol": gitProtocol }),
                  }
                : {}),
            },
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
    const raw = (
      path: string,
      headers: Record<string, string | string[]>,
    ): Promise<{ status: number; body: Buffer }> =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path, method: "GET", ca: caBytes, agent: false, headers },
          (res) => {
            void readBody(res).then(
              (bytes) => resolve({ status: res.statusCode ?? 0, body: bytes }),
              reject,
            );
          },
        );
        req.once("error", reject);
        req.end();
      });
    return { remote, remoteGit, call, raw, binding };
  };
  /** The host reports a new `box run` for this execution; the committed recipient is unchanged. */
  const replaceExecution = (): string => {
    const replacement = randomBytes(32).toString("base64url");
    (snapshot as { executionBearerSha256: string }).executionBearerSha256 = sha(replacement);
    return replacement;
  };
  return {
    root,
    execution,
    snapshot,
    replaceExecution,
    connections: origin.connections,
    journal,
    repoPath,
    git,
    commit,
    state,
    receipts,
    authorizations,
    writes: origin.writes,
    install,
    bearer,
    unrelatedBearer,
    material,
    publishCommit: origin.publishCommit,
  };
}
