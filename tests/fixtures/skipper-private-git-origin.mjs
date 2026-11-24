import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { IncomingMessage } from "node:http";
import { createServer, get as httpsGet, request as httpsRequest } from "node:https";
import { checkServerIdentity, createSecureContext } from "node:tls";
import { isIP } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnvironment, run } from "./repository-credentials/process.ts";
import { createTokenAuthority } from "./repository-credentials/github/token-authority.ts";
import { fixtureAppId, fixtureInstallationId } from "./repository-credentials/github/metadata.ts";

export const scopedRestFixturePermissions = Object.freeze({
  metadata: "read",
  contents: "write",
  issues: "read",
  pull_requests: "write",
});

// Compare raw bytes, before URL parsing. Only the encoded read of A has
// an equivalent canonical spelling (unreserved ASCII in the path and query).
function readVariantWire(probe, method, target) {
  const parts = (value) => {
    const q = value.indexOf("?");
    return q < 0 ? [value, ""] : [value.slice(0, q), value.slice(q)];
  };
  const [path, query] = parts(target);
  const [literalPath, literalQuery] = parts(probe.target);
  const encodedRead =
    probe.method === "GET" &&
    probe.target === "/fixture/%61.git/info/refs?%73ervice=git-%75pload-pack";
  const classify = (actual, literal, canonical) =>
    actual === literal ? "literal" : encodedRead && actual === canonical ? "canonical" : "other";
  return {
    method: method === probe.method ? "literal" : "other",
    path: classify(path, literalPath, "/fixture/a.git/info/refs"),
    query: classify(query, literalQuery, "?service=git-upload-pack"),
  };
}

// Test-only origin. Callers own close(); no environment credentials or user Git
// configuration are inherited. Only snapshot() is intended for logged evidence.
export async function startSkipperPrivateGitOrigin({
  host = "127.0.0.1",
  port = 0,
  advertisedHost = host,
  tls,
  repository = `fixture/run-${randomUUID()}`,
  repositoryRef = "private-git",
  approvalRef = "refs/heads/approved",
  repositoryId = "73",
  teamReview = false,
  seedRefs = 0,
  witnessIssuedGit = false,
  networkAcl = /** @type {boolean | "issued"} */ (false),
  scopedRest = false,
} = {}) {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(repository)) {
    throw new Error("repository must be owner/name");
  }
  if (!/^[a-zA-Z0-9.:-]+$/.test(advertisedHost) || ["0.0.0.0", "::"].includes(advertisedHost)) {
    throw new Error("supply a reachable advertisedHost");
  }
  if (!approvalRef.startsWith("refs/heads/") || approvalRef === "refs/heads/main") {
    throw new Error("approvalRef must be a nondefault branch");
  }
  // Signal 0 probes the group selector without delivering a signal. PID 1
  // would produce the broadcast selector, so leave that case to normal startup.
  if (process.platform !== "win32" && process.pid > 1) {
    try {
      process.kill(-process.pid, 0);
    } catch (error) {
      if (error.code === "EPERM") {
        throw new Error(
          "Private Git process-group probe denied (EPERM). Run this fixture on a worker that permits process-group signals.",
          { cause: error },
        );
      }
      // The runner need not be a process-group leader.
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  await run("git", ["check-ref-format", approvalRef]);
  const issuedNetwork = networkAcl === "issued";
  assert.ok(!scopedRest || issuedNetwork, "Scoped REST requires the controlled App issuer");
  const repositoryScopes = [{ repository, repositoryRef, repositoryId }];
  if (networkAcl) {
    repositoryScopes.push(
      { repository: "fixture/b", repositoryRef: "private-git-b", repositoryId: "74" },
      { repository: "fixture/c", repositoryRef: "private-git-c", repositoryId: "75" },
    );
    const uniqueFields = issuedNetwork
      ? ["repository", "repositoryRef", "repositoryId"]
      : ["repository"];
    for (const field of uniqueFields) {
      assert.equal(new Set(repositoryScopes.map((scope) => scope[field])).size, 3);
    }
  }
  const repositoryByName = new Map(repositoryScopes.map((scope) => [scope.repository, scope]));
  const networkRepositories = [...repositoryByName.keys()];
  const directory = await mkdtemp(join(tmpdir(), "skipper-private-git-"));
  const env = cleanEnvironment({ HOME: directory, GIT_CONFIG_GLOBAL: "/dev/null" });
  const git = (args, options = {}) => run("git", args, { env, ...options });
  const bare = join(directory, `${repository}.git`);
  const broadToken = networkAcl === true ? randomBytes(32).toString("hex") : undefined;
  const broadAuthorization = broadToken
    ? `Basic ${Buffer.from(`x-access-token:${broadToken}`).toString("base64")}`
    : undefined;
  /** @type {{ repository: string, operation: string, method: "GET" | "HEAD" | "POST", target?: string, wire?: ReturnType<typeof readVariantWire>, authenticated: boolean, credentialIndex?: number }[]} */
  const networkRequests = [];
  /** @type {import("../helpers/openshell-git-denial.ts").GitAclVariant | undefined} */
  let activeVariant;
  let unknownNetworkRequests = 0;
  const children = new Set();
  // HTTPS exposes a TLSSocket on the request and a net.Socket at TCP accept.
  // Their live TCP four-tuple identifies the same connection across both events.
  const socketKey = ({ localAddress, localPort, remoteAddress, remotePort }) =>
    localAddress && localPort && remoteAddress && remotePort
      ? JSON.stringify([localAddress, localPort, remoteAddress, remotePort])
      : undefined;
  const sockets = new Map();
  const retirementConnections = new Map();
  const stopChild = (child) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
  const issuedGit = witnessIssuedGit === true ? new Map() : undefined;
  /** @type {(readonly [number, string])[]} */
  const issuedFingerprints = [];
  let server;
  let closing;
  let heldDiscovery;
  let releaseDiscovery;
  let armedDiscovery = false;
  let connections = 0;
  let requests = 0;
  let witnessRequests = 0;
  let refusedRetirementIndex;
  let targetedRetirementRefusals = 0;
  const close = () =>
    (closing ??= (async () => {
      issuedGit?.clear();
      for (const { socket } of sockets.values()) {
        socket.destroy();
      }
      releaseDiscovery?.();
      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise((resolve) => {
              child.once("close", resolve);
              stopChild(child);
            }),
        ),
      );
      await rm(directory, { recursive: true, force: true });
    })());
  try {
    await mkdir(join(bare, ".."), { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", bare]);
    await git(["-C", bare, "config", "maintenance.auto", "false"]);
    await git(["-C", bare, "config", "http.receivepack", "true"]);
    const seed = join(directory, "seed");
    await git(["init", "--initial-branch=main", seed]);
    await writeFile(join(seed, "README.md"), "Private qualification repository\n");
    await git(["-C", seed, "add", "README.md"]);
    await git([
      "-C",
      seed,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Seed private repository",
    ]);
    await git(["-C", seed, "push", bare, "HEAD:refs/heads/main"]);
    const initialSha = (await git(["-C", bare, "rev-parse", "refs/heads/main"])).stdout.trim();
    // Extra refs at the seed commit make a clone's negotiation exceed 1 KiB, so git gzips it.
    for (let index = 0; index < seedRefs; index++) {
      await git(["-C", bare, "update-ref", `refs/heads/seed/${index}`, initialSha]);
    }
    // The issued ACL control must permit a real ref update with its token,
    // independently of the Sandbox under test. Preserve the original hook for
    // the other origin modes.
    if (!issuedNetwork) {
      // A pre-receive hook rejects the entire transaction, including mixed pushes.
      // Network clients can only change the exact approval ref; main stays protected.
      await writeFile(
        join(bare, "hooks", "pre-receive"),
        `#!/bin/sh\nwhile read old new ref; do\n  test "$ref" = "$FIXTURE_APPROVAL_REF" || { echo 'ref denied' >&2; exit 1; }\ndone\n`,
        { mode: 0o700 },
      );
    }
    if (networkAcl) {
      for (const name of networkRepositories.slice(1)) {
        const target = join(directory, `${name}.git`);
        await mkdir(join(target, ".."), { recursive: true });
        await git(["clone", "--bare", bare, target]);
        await git(["-C", target, "config", "maintenance.auto", "false"]);
        await git(["-C", target, "config", "http.receivepack", "true"]);
      }
    }
    if (!tls) {
      const keyFile = join(directory, "tls-key.pem");
      const certFile = join(directory, "tls-cert.pem");
      const san = isIP(advertisedHost) ? `IP:${advertisedHost}` : `DNS:${advertisedHost}`;
      await run(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-days",
          "2",
          "-subj",
          "/CN=private-git-fixture",
          "-addext",
          `subjectAltName=${san},DNS:localhost,IP:127.0.0.1`,
        ],
        { env },
      );
      tls = {
        key: await readFile(keyFile),
        cert: await readFile(certFile),
        ca: await readFile(certFile),
      };
    }
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let shortenNextToken = false;
    const authority = createTokenAuthority({
      clock: { wallNow: Date.now },
      publicKey,
      lifetimeMs() {
        const lifetime = shortenNextToken ? 750_000 : 3_600_000;
        shortenNextToken = false;
        return lifetime;
      },
      repositoryId,
      ...(issuedNetwork && {
        expectedRepositoryIds: repositoryScopes.map((scope) => scope.repositoryId),
      }),
      additionalPermissions: [
        ...(teamReview ? [{ metadata: "read", contents: "write", pull_requests: "write" }] : []),
        ...(scopedRest ? [scopedRestFixturePermissions] : []),
      ],
    });
    const reviewHead = approvalRef.slice("refs/heads/".length);
    const pullRoute = "/repos/" + repository + "/pulls";
    let pullRequest;
    let pullCreateRequests = 0;
    /** @typedef {{ ref: string, sha: string, repo: { id: number, full_name: string } }} ScopedPullSide */
    /** @typedef {{ number: number, title: string, state: string, draft: boolean, head: ScopedPullSide, base: ScopedPullSide }} ScopedPull */
    /** @type {Map<string, ScopedPull[]>} */
    const scopedPulls = new Map();
    let redirectPullReadToC = false;
    const observePullRequest = async () => {
      if (!pullRequest) {
        return null;
      }
      const refs = await readRefs();
      const side = (ref) => ({
        ref,
        sha: refs["refs/heads/" + ref],
        repo: { id: Number(repositoryId), full_name: repository },
      });
      return { ...pullRequest, head: side(reviewHead), base: side("main") };
    };
    const readPullBody = async (request, reply) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32_768) {
          reply(413);
          return;
        }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    // Draft pull-request creation for the team-review topology. The caller has matched the
    // route and counted the attempt; `reply` records the outcome under that endpoint.
    const createDraftPull = async (request, reply) => {
      const auth = request.headers.authorization;
      if (!authority.authorize(auth) || authority.permissions(auth)?.pull_requests !== "write") {
        reply(403);
        return;
      }
      const fields = await readPullBody(request, reply);
      if (fields === undefined) {
        return;
      }
      const { title, body, head, base, draft, maintainer_can_modify } = fields;
      const refs = await readRefs();
      if (
        pullRequest ||
        head !== reviewHead ||
        base !== "main" ||
        draft !== true ||
        maintainer_can_modify !== false ||
        !title ||
        !body ||
        !refs[approvalRef] ||
        refs[approvalRef] === refs["refs/heads/main"]
      ) {
        reply(422);
        return;
      }
      // Reading the body and refs yielded; retirement during either must still win.
      if (!authority.authorize(auth)) {
        reply(403);
        return;
      }
      pullRequest = {
        id: 7001,
        number: 1,
        state: "open",
        draft,
        title,
        body,
        html_url: "https://github.com/" + repository + "/pull/1",
      };
      reply(201, await observePullRequest());
    };
    // This origin delegates every selected repository to the same App token.
    // The installed network boundary must enforce its narrower A/B/C grants.
    const serveScopedRest = async (request, scope, route, reply) => {
      const name = scope.repository;
      const authorization = request.headers.authorization;
      const authenticated = authority.authorize(authorization);
      const operation =
        {
          issues: request.method === "GET" ? "rest-issue-list" : "rest-issue-create",
          "issues/42": "rest-issue-read",
          pulls: request.method === "GET" ? "rest-pull-list" : "rest-pull-create",
        }[route] ?? "rest-pull-read";
      networkRequests.push({
        repository: name,
        operation,
        method: request.method,
        authenticated,
        ...(authenticated && { credentialIndex: authority.tokenIndex(authorization) }),
      });
      if (!authenticated || !authority.permitsRepository(authorization, scope.repositoryId)) {
        reply(403);
        return;
      }
      const permissions = authority.permissions(authorization);
      if (route.startsWith("issues")) {
        if (request.method === "GET" && permissions?.issues === "read") {
          const issue = { number: 42, title: `Fixture issue in ${name}`, state: "open" };
          reply(200, route === "issues" ? [issue] : issue);
        } else {
          reply(403);
        }
        return;
      }
      const created = scopedPulls.get(name) ?? [];
      if (
        request.method === "GET" &&
        (permissions?.pull_requests === "read" || permissions?.pull_requests === "write")
      ) {
        if (redirectPullReadToC && name === "fixture/b" && route === "pulls/42") {
          redirectPullReadToC = false;
          reply(302, {}, { location: "/repos/fixture/c/pulls/42" });
          return;
        }
        const seeded = { number: 42, title: `Fixture pull in ${name}`, state: "open" };
        if (route === "pulls") {
          reply(200, [seeded, ...created]);
        } else {
          const pull =
            route === "pulls/42"
              ? seeded
              : created.find(({ number }) => route === `pulls/${number}`);
          reply(pull ? 200 : 404, pull);
        }
        return;
      }
      if (
        request.method !== "POST" ||
        route !== "pulls" ||
        permissions?.pull_requests !== "write"
      ) {
        reply(403);
        return;
      }
      const fields = await readPullBody(request, reply);
      if (fields === undefined) {
        return;
      }
      const { title, head, base, draft = false } = fields;
      const refs = await readRefs(name);
      if (
        typeof title !== "string" ||
        !title ||
        typeof draft !== "boolean" ||
        typeof head !== "string" ||
        base !== "main" ||
        !refs[`refs/heads/${head}`] ||
        refs[`refs/heads/${head}`] === refs["refs/heads/main"] ||
        created.some((pull) => pull.head.ref === head && pull.base.ref === base)
      ) {
        reply(422);
        return;
      }
      if (!authority.authorize(authorization)) {
        reply(403);
        return;
      }
      const repo = { id: Number(scope.repositoryId), full_name: name };
      const pull = {
        number: created.length + 1,
        title,
        state: "open",
        draft,
        head: { ref: head, sha: refs[`refs/heads/${head}`], repo },
        base: { ref: base, sha: refs["refs/heads/main"], repo },
      };
      scopedPulls.set(name, [...created, pull]);
      reply(201, pull);
    };
    /** @type {Record<string, number>} */
    const counts = {};
    const count = (endpoint, status) => {
      const key = `${endpoint}:${status}`;
      counts[key] = (counts[key] ?? 0) + 1;
    };
    const gitPrefix = `/${repository}.git`;
    const tokenPath = `/app/installations/${fixtureInstallationId}/access_tokens`;
    // Node creates the incoming message once headers are parsed, even for CONNECT
    // and requests it rejects before dispatching the HTTPS request listener.
    class OriginRequest extends IncomingMessage {
      constructor(socket) {
        super(socket);
        requests++;
      }
    }
    server = createServer({ ...tls, IncomingMessage: OriginRequest }, async (request, response) => {
      let endpoint = "other";
      if (networkAcl) {
        unknownNetworkRequests++;
      }
      const reply = (status, body = {}, headers = {}) => {
        count(endpoint, status);
        response.writeHead(status, {
          "content-type": "application/json",
          ...(status === 401 ? { "www-authenticate": 'Basic realm="private fixture"' } : {}),
          ...headers,
        });
        response.end(status === 204 ? undefined : JSON.stringify(body));
      };
      try {
        const url = new URL(request.url, "https://fixture.invalid");
        // Only the current literal Git probe may use a noncanonical target.
        const variant =
          activeVariant?.target === request.url && activeVariant?.method === request.method
            ? activeVariant
            : undefined;
        if (!variant && request.url !== `${url.pathname}${url.search}`) {
          reply(404);
          return;
        }
        if (url.pathname === tokenPath && request.method === "POST") {
          endpoint = "issue";
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 16384) {
              reply(413);
              return;
            }
            chunks.push(chunk);
          }
          let issued;
          try {
            issued = authority.issue(
              request.headers.authorization,
              JSON.parse(Buffer.concat(chunks).toString()),
            );
          } catch {
            reply(403);
            return;
          }
          if (issuedGit && !closing) {
            issuedGit.set(authority.tokenIndex(`Bearer ${issued.token}`), issued.token);
          }
          if (issuedNetwork) {
            const basicPayload = Buffer.from(`x-access-token:${issued.token}`).toString("base64");
            for (const value of [issued.token, basicPayload]) {
              issuedFingerprints.push([
                Buffer.byteLength(value),
                createHash("sha256").update(value).digest("hex"),
              ]);
            }
          }
          reply(201, {
            token: issued.token,
            expires_at: new Date(issued.expires).toISOString(),
            permissions: issued.permissions,
            repository_selection: "selected",
            repositories: (issuedNetwork ? repositoryScopes : repositoryScopes.slice(0, 1)).map(
              ({ repositoryId, repository }) => ({
                id: Number(repositoryId),
                full_name: repository,
                private: true,
              }),
            ),
          });
          return;
        }
        if (url.pathname === "/installation/token" && request.method === "DELETE") {
          endpoint = "revoke";
          if (!authority.authorize(request.headers.authorization, "retirement")) {
            reply(401);
            return;
          }
          const tokenIndex = authority.tokenIndex(request.headers.authorization);
          if (tokenIndex === refusedRetirementIndex) {
            // Refuse every authenticated attempt for this token, including after worker replacement.
            // No request is delayed, and the issuer never commits its revocation.
            targetedRetirementRefusals++;
            reply(503);
            return;
          }
          if (request.url === "/installation/token") {
            retirementConnections.set(tokenIndex, sockets.get(socketKey(request.socket))?.ordinal);
          }
          authority.revoke(request.headers.authorization);
          reply(204);
          return;
        }
        if (teamReview && request.method === "POST" && url.pathname === pullRoute && !url.search) {
          endpoint = "pull-create";
          pullCreateRequests++;
          await createDraftPull(request, reply);
          return;
        }
        const rest =
          scopedRest &&
          !url.search &&
          /^\/repos\/([^/]+\/[^/]+)\/(issues(?:\/42)?|pulls(?:\/[1-9][0-9]*)?)$/.exec(url.pathname);
        if (rest) {
          const scope = repositoryByName.get(rest[1]);
          if (!scope) {
            reply(404);
            return;
          }
          endpoint = "scoped-rest";
          unknownNetworkRequests--;
          await serveScopedRest(request, scope, rest[2], reply);
          return;
        }
        const gitPath = variant ? decodeURIComponent(url.pathname) : url.pathname;
        const matchedRepository = networkRepositories.find((name) =>
          gitPath.startsWith(`/${name}.git/`),
        );
        const requestGitPrefix = `/${matchedRepository}.git`;
        const service = variant
          ? url.searchParams.getAll("service").at(-1)
          : url.searchParams.get("service");
        const gitServices = ["git-upload-pack", "git-receive-pack"];
        const discovery =
          (request.method === "GET" || (variant && request.method === "HEAD")) &&
          gitPath === `${requestGitPrefix}/info/refs` &&
          gitServices.includes(service) &&
          (variant || [...url.searchParams].length === 1);
        const rpc =
          request.method === "POST" &&
          gitServices.some((name) => gitPath === `${requestGitPrefix}/${name}`) &&
          (variant || !url.search);
        if (!matchedRepository || (!discovery && !rpc)) {
          reply(404);
          return;
        }
        const receive = discovery
          ? service === "git-receive-pack"
          : gitPath.endsWith("/git-receive-pack");
        endpoint = `${receive ? "receive" : "upload"}-${discovery ? "advertise" : "pack"}`;
        const authorization = request.headers.authorization;
        const broad = broadAuthorization !== undefined && authorization === broadAuthorization;
        const authenticated =
          networkAcl === true ? broad : authority.authorize(authorization, "git");
        if (networkAcl) {
          unknownNetworkRequests--;
          networkRequests.push({
            repository: matchedRepository,
            operation: endpoint,
            method: request.method === "HEAD" ? "HEAD" : discovery ? "GET" : "POST",
            ...(variant && { target: request.url }),
            ...(activeVariant?.expected === "read" && {
              wire: readVariantWire(activeVariant, request.method, request.url),
            }),
            authenticated,
            ...(issuedNetwork &&
              authenticated && { credentialIndex: authority.tokenIndex(authorization) }),
          });
        }
        if (!authenticated) {
          reply(401);
          return;
        }
        // Only the selected token issued for all three synthetic repositories
        // should accept every A/B/C operation independently of the Sandbox policy.
        if (
          issuedNetwork &&
          !authority.permitsRepository(
            authorization,
            repositoryByName.get(matchedRepository)?.repositoryId,
          )
        ) {
          reply(403);
          return;
        }
        const permissions = broad ? { contents: "write" } : authority.permissions(authorization);
        const needsWrite =
          receive || (variant && url.searchParams.getAll("service").includes("git-receive-pack"));
        if (!permissions.contents || (needsWrite && permissions.contents !== "write")) {
          reply(403);
          return;
        }
        // Real Git owns parsing, object validation, and ref transactions. CGI output
        // stays binary; neither credentials nor arbitrary request targets are recorded.
        const child = execFile(
          "git",
          ["http-backend"],
          {
            env: {
              ...env,
              GIT_PROJECT_ROOT: directory,
              GIT_HTTP_EXPORT_ALL: "1",
              PATH_INFO: gitPath,
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: request.method,
              CONTENT_TYPE: request.headers["content-type"] ?? "",
              CONTENT_LENGTH: request.headers["content-length"] ?? "",
              HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
              HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
              REMOTE_USER: "fixture",
              FIXTURE_APPROVAL_REF: approvalRef,
            },
            detached: true,
            encoding: "buffer",
            timeout: 30000,
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, output) => {
            if (error) {
              reply(502);
              return;
            }
            const end = output.indexOf("\r\n\r\n");
            if (end < 0) {
              reply(502);
              return;
            }
            const headers = {};
            let status = 200;
            for (const line of output.subarray(0, end).toString().split("\r\n")) {
              const colon = line.indexOf(":");
              const name = line.slice(0, colon).toLowerCase();
              const value = line.slice(colon + 1).trim();
              if (name === "status") {
                status = Number(value.split(" ")[0]);
              } else {
                headers[name] = value;
              }
            }
            count(endpoint, status);
            const send = () => response.writeHead(status, headers).end(output.subarray(end + 4));
            if (armedDiscovery && endpoint === "upload-advertise" && status === 200) {
              armedDiscovery = false;
              heldDiscovery = true;
              releaseDiscovery = () => {
                heldDiscovery = false;
                releaseDiscovery = undefined;
                send();
              };
            } else {
              send();
            }
          },
        );
        children.add(child);
        const deadline = setTimeout(() => stopChild(child), 30000);
        child.once("close", () => {
          clearTimeout(deadline);
          stopChild(child);
          children.delete(child);
        });
        child.stdin.on("error", () => {});
        request.pipe(child.stdin);
        response.once("close", () => {
          if (child.exitCode === null) {
            stopChild(child);
          }
        });
      } catch {
        if (!response.headersSent) {
          reply(500);
        } else {
          response.destroy();
        }
      }
    });
    server.requestTimeout = 30000;
    server.maxRequestsPerSocket = 1;
    // Pipelined requests over the limit bypass the HTTPS request listener.
    server.on("dropRequest", () => {
      count("other", 503);
    });
    server.on("connection", (socket) => {
      connections++;
      // An incomplete tuple can still be closed, but cannot qualify an HTTP request.
      const key = socketKey(socket) ?? socket;
      sockets.set(key, { socket, ordinal: connections });
      socket.once("close", () => {
        if (sockets.get(key)?.socket === socket) {
          sockets.delete(key);
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const origin = `https://${isIP(advertisedHost) === 6 ? `[${advertisedHost}]` : advertisedHost}:${server.address().port}`;
    const listener = server.address();
    const readRefs = async (name = repository) =>
      Object.fromEntries(
        (
          await git([
            "-C",
            join(directory, `${name}.git`),
            "for-each-ref",
            "--format=%(refname) %(objectname)",
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ")),
      );
    const snapshot = () => ({
      connections,
      requests,
      pullCreateRequests,
      endpoints: { ...counts },
      issued: authority.issuesOfTokens.length,
      tokens: authority.tokenState(),
      targetedRetirementRefusals,
    });
    return {
      origin,
      apiOrigin: origin,
      gitOrigin: origin,
      cloneUrl: `${origin}${gitPrefix}`,
      repository,
      repositoryRef,
      repositoryId,
      approvalRef,
      defaultRef: "refs/heads/main",
      initialSha,
      tls,
      appId: fixtureAppId,
      installationId: fixtureInstallationId,
      privateKey,
      createAppJwt() {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
          "base64url",
        );
        const payload = Buffer.from(
          JSON.stringify({ iss: fixtureAppId, iat: now - 30, exp: now + 300 }),
        ).toString("base64url");
        const input = `${header}.${payload}`;
        return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
      },
      snapshot,
      ...(networkAcl && {
        network: {
          token: broadToken,
          repositories: networkRepositories,
          scopes: repositoryScopes.map((scope) => ({ ...scope })),
          /**
           * @param {number} index
           * @param {(variant: import("../helpers/openshell-git-denial.ts").GitAclVariant) => Promise<string>} replay
           */
          async checkGitVariants(index, replay) {
            const { gitAclVariants } = await import("../helpers/openshell-git-denial.ts");
            assert.ok(issuedNetwork && issuedGit?.has(index) && repository === "fixture/a");
            assert.equal(activeVariant, undefined);
            try {
              const outcomes = [];
              for (const probe of gitAclVariants(initialSha)) {
                activeVariant = probe;
                const { method, target, repository, operation, service } = probe;
                const before = requests;
                const start = networkRequests.length;
                const recipient = {
                  method,
                  repository,
                  operation: `${operation}-${method === "POST" ? "pack" : "advertise"}`,
                  credentialIndex: index,
                  authenticated: true,
                };
                // A denial is meaningful only after the exact same wire target succeeds.
                assert.deepEqual(
                  await this.probeIssued(index, repository, probe),
                  {
                    status: 200,
                    type: `application/x-${service}-${method === "POST" ? "result" : "advertisement"}`,
                  },
                  "Git variant calibration failed",
                );
                assert.equal(requests, before + 1);
                const literal = { method: "literal", path: "literal", query: "literal" };
                assert.deepEqual(
                  networkRequests.slice(start),
                  [{ ...recipient, target, ...(probe.expected === "read" && { wire: literal }) }],
                  "Git calibration recipient or target mismatch",
                );

                const allowedBefore = counts["upload-advertise:200"] ?? 0;
                const decision = await replay(probe);
                if (probe.expected === "read" && decision === "200 upload-advertisement\n") {
                  assert.equal(requests, before + 2);
                  assert.equal(counts["upload-advertise:200"], allowedBefore + 1);
                  const reads = networkRequests.slice(start + 1);
                  const wire = reads[0]?.wire;
                  assert.ok(
                    wire?.method === "literal" &&
                      (wire.path === "literal" || wire.path === "canonical") &&
                      (wire.query === "literal" || wire.query === "canonical"),
                    `Unexpected Git read shape: ${JSON.stringify(wire)}`,
                  );
                  const exactLiteral = wire.path === "literal" && wire.query === "literal";
                  assert.deepEqual(
                    reads,
                    [{ ...recipient, ...(exactLiteral && { target }), wire }],
                    "Git read recipient or target mismatch",
                  );
                  // Preserve the literal mismatch even if a later probe fails.
                  if (!exactLiteral) {
                    process.stdout.write(
                      JSON.stringify({ event: "saved-git-acl-variant-mismatch", wire }) + "\n",
                    );
                  }
                  outcomes.push({ method, target, decision: decision.trim(), wire, exactLiteral });
                } else {
                  assert.equal(requests, before + 1, "Forbidden Git variant reached the origin");
                  assert.ok(
                    decision ===
                      (method === "HEAD" ? "403 head-http\n" : "403 native-rest-policy\n"),
                    "Missing Git variant refusal",
                  );
                  outcomes.push({ method, target, decision: decision.trim() });
                }
              }
              assert.equal(outcomes.length, 15);
              return outcomes;
            } finally {
              activeVariant = undefined;
            }
          },
          /**
           * @param {number | undefined} index
           * @param {string} repository
           * @param {{ service: string, method: "GET" | "HEAD" | "POST", body?: string, target?: string }} options
           * @returns {Promise<{ status?: number, type?: string }>}
           */
          async probeIssued(index, repository, { service, method, body, target }) {
            assert.ok(
              issuedNetwork && (index === undefined || issuedGit?.has(index)),
              "missing controlled issuer credential",
            );
            assert.ok(networkRepositories.includes(repository));
            assert.ok(["git-upload-pack", "git-receive-pack"].includes(service));
            if (target === undefined) {
              assert.ok(["GET", "POST"].includes(method));
            } else {
              assert.ok(
                activeVariant &&
                  target === activeVariant.target &&
                  method === activeVariant.method &&
                  repository === activeVariant.repository &&
                  service === activeVariant.service &&
                  body === activeVariant.body,
                "Git target is not the active calibration",
              );
            }
            assert.ok(method === "POST" ? typeof body === "string" : body === undefined);

            const path = method === "POST" ? service : `info/refs?service=${service}`;
            const secureContext = createSecureContext({ ca: tls.ca ?? tls.cert });
            return new Promise((resolve, reject) => {
              const request = httpsRequest(
                {
                  hostname: listener.address,
                  port: listener.port,
                  path: target ?? `/${repository}.git/${path}`,
                  method,
                  agent: false,
                  secureContext,
                  servername: isIP(advertisedHost) ? "" : advertisedHost,
                  checkServerIdentity: (_host, cert) => checkServerIdentity(advertisedHost, cert),
                  signal: AbortSignal.timeout(5000),
                  ...(index === undefined
                    ? {}
                    : { auth: "x-access-token:" + issuedGit.get(index) }),
                  headers: {
                    host: new URL(origin).host,
                    ...(body === undefined
                      ? {}
                      : {
                          "content-type": `application/x-${service}-request`,
                          "content-length": Buffer.byteLength(body),
                        }),
                  },
                },
                (response) => {
                  response.resume();
                  response.once("error", reject);
                  response.once("end", () => {
                    if (!response.complete) {
                      reject(new Error("incomplete Git origin response"));
                      return;
                    }
                    resolve({
                      status: response.statusCode,
                      type: response.headers["content-type"],
                    });
                  });
                },
              );
              request.once("error", reject);
              request.end(body);
            });
          },

          /** @param {Buffer} output */
          containsIssuedCredential(output) {
            assert.ok(issuedNetwork);
            return [...issuedGit.values()].some(
              (token) =>
                output.includes(token) ||
                output.includes(Buffer.from(`x-access-token:${token}`).toString("base64")),
            );
          },

          shortenNextTokenForRenewal() {
            assert.ok(issuedNetwork && !shortenNextToken);
            shortenNextToken = true;
          },
          issuedCredentialFingerprints() {
            assert.ok(issuedNetwork);
            return issuedFingerprints.map(
              ([length, digest]) => /** @type {const} */ ([length, digest]),
            );
          },
          requests: () => networkRequests.map((entry) => ({ ...entry })),
          /** @param {string} name */
          pullRequest: (name) => structuredClone(scopedPulls.get(name)?.[0]),
          /** @param {string} name */
          pullRequests: (name) => structuredClone(scopedPulls.get(name) ?? []),
          redirectNextPullReadToC() {
            assert.ok(scopedRest && !redirectPullReadToC);
            redirectPullReadToC = true;
          },
          unknownRequests: () => unknownNetworkRequests,
          async ref(name, ref) {
            assert.ok(networkRepositories.includes(name));
            // Only a successful enumeration can prove absence; Git can warn and skip broken refs.
            const result = await git(
              [
                "-C",
                join(directory, `${name}.git`),
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                ref,
              ],
              { allowFailure: true },
            );
            assert.ok(result.code === 0 && !result.stderr, "Git ref lookup failed");
            return result.stdout
              .split("\n")
              .find((row) => row.startsWith(`${ref} `))
              ?.slice(ref.length + 1);
          },
          async hasObject(name, oid) {
            assert.ok(networkRepositories.includes(name) && /^[a-f0-9]{40}$/.test(oid));
            const result = await git(
              ["-C", join(directory, `${name}.git`), "cat-file", "--batch-check"],
              { allowFailure: true, input: `${oid}\n` },
            );
            // Git reports a missing object on stdout with a successful exit.
            // A failed lookup or unreadable object store is missing evidence.
            assert.ok(result.code === 0 && !result.stderr, "Git object lookup failed");
            if (result.stdout === `${oid} missing\n`) {
              return false;
            }
            assert.ok(
              result.stdout.startsWith(`${oid} commit `) &&
                /^\d+\n$/u.test(result.stdout.slice(oid.length + " commit ".length)),
              "Unexpected Git object lookup result",
            );
            return true;
          },
        },
      }),
      observeReplacementOrigin(indexA, indexB) {
        const before = snapshot();
        const witnesses = witnessRequests;
        const tokenB = before.tokens.find(({ index }) => index === indexB);
        assert.ok(indexA !== indexB && before.tokens.some(({ index }) => index === indexA));
        assert.equal(tokenB?.revoked, false, "B must enter replacement with its original grant");
        return (completedWitnesses = 0) => {
          const after = snapshot();
          assert.equal(
            witnessRequests - witnesses,
            completedWitnesses,
            "unexpected verifier probe",
          );
          const retired = after.tokens.find(({ index }) => index === indexB)?.revoked === true;
          const ordinal = retirementConnections.get(indexB);
          if (retired) {
            assert.ok(Number.isSafeInteger(ordinal), "B retirement lacks an accepted connection");
          }
          // Each intentional A witness opens its own fresh connection (agent: false).
          // B may use a connection already open at the start of the interval.
          const endpoints = { ...before.endpoints };
          if (retired) {
            endpoints["revoke:204"] = (endpoints["revoke:204"] ?? 0) + 1;
          }
          if (completedWitnesses) {
            endpoints["upload-advertise:200"] =
              (endpoints["upload-advertise:200"] ?? 0) + completedWitnesses;
          }
          assert.deepEqual(
            after,
            {
              ...before,
              connections:
                before.connections +
                completedWitnesses +
                Number(retired && ordinal > before.connections),
              requests: before.requests + completedWitnesses + Number(retired),
              endpoints,
              tokens: before.tokens.map((token) => {
                const uses =
                  token.index === indexA
                    ? completedWitnesses
                    : Number(retired && token.index === indexB);
                return {
                  ...token,
                  uses: token.uses + uses,
                  attempts: token.attempts + uses,
                  revoked: token.revoked || (retired && token.index === indexB),
                };
              }),
            },
            "unexpected origin traffic after replacement",
          );
        };
      },
      // The restart assertion compares the whole origin. On failure, identify which
      // authentication boundaries were reached and which HTTP statuses the origin recorded.
      // Discovery records its status before a held response is released.
      observeRestartTraffic(indexA, indexB) {
        const firstAttempt = authority.authenticationAttempts.length;
        const initialCounts = { ...counts };
        const witnesses = witnessRequests;
        return () => {
          const labels = new Set();
          for (const { boundary, tokenIndex } of authority.authenticationAttempts.slice(
            firstAttempt,
          )) {
            const role = tokenIndex === indexA ? "A" : tokenIndex === indexB ? "B" : "other";
            const channel = boundary === "git" || boundary === "retirement" ? boundary : "api";
            labels.add(`${channel} auth ${role}`);
          }
          for (const [key, value] of Object.entries(counts)) {
            if (value === initialCounts[key]) {
              continue;
            }
            const [endpoint, status] = key.split(":");
            labels.add(`${endpoint} HTTP ${status}`);
          }
          if (witnesses !== witnessRequests) {
            labels.add("verifier probe");
          }
          return [...labels].sort();
        };
      },
      refuseTokenRetirement(index) {
        if (!Number.isSafeInteger(index) || !issuedGit?.has(index)) {
          throw new Error("unknown issued Git witness index");
        }
        if (refusedRetirementIndex !== undefined) {
          throw new Error("token retirement refusal already armed");
        }
        refusedRetirementIndex = index;
      },
      gitAttemptIndices: () =>
        authority.authenticationAttempts
          .filter(
            ({ boundary, tokenIndex }) => boundary === "git" && Number.isSafeInteger(tokenIndex),
          )
          .map(({ tokenIndex }) => tokenIndex),
      async probeIssuedGit(index) {
        if (!issuedGit) {
          throw new Error("issued Git witness disabled");
        }
        if (closing || !server.listening) {
          throw new Error("origin closed");
        }
        if (!Number.isSafeInteger(index) || !issuedGit.has(index)) {
          throw new Error("unknown issued Git index");
        }
        // Connect only to this listener; its service DNS name resolves inside the test cluster.
        const hostname =
          listener.address === "0.0.0.0"
            ? "127.0.0.1"
            : listener.address === "::"
              ? "::1"
              : listener.address;
        witnessRequests++;
        const response = await new Promise((resolve, reject) => {
          httpsGet(
            {
              hostname,
              port: listener.port,
              path: gitPrefix + "/info/refs?service=git-upload-pack",
              agent: false,
              ca: tls.ca ?? tls.cert,
              rejectUnauthorized: true,
              servername: isIP(advertisedHost) ? "" : advertisedHost,
              checkServerIdentity: (_host, cert) => checkServerIdentity(advertisedHost, cert),
              signal: AbortSignal.timeout(5000),
              auth: "x-access-token:" + issuedGit.get(index),
              headers: { host: new URL(origin).host },
            },
            resolve,
          ).once("error", reject);
        });
        const chunks = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          assert.ok(length <= 1024 * 1024, "oversized fixture advertisement");
          chunks.push(chunk);
        }
        if (response.statusCode === 401 || response.statusCode === 403) {
          return response.statusCode;
        }
        assert.equal(response.statusCode, 200, "unexpected fixture discovery status");
        assert.ok(
          response.complete &&
            response.headers["content-type"] === "application/x-git-upload-pack-advertisement",
        );
        // Positive controls check the actual ref against Git; do not implement a second Git parser.
        assert.ok(
          Buffer.concat(chunks)
            .subarray(0, 34)
            .equals(Buffer.from("001e# service=git-upload-pack\n0000")),
          "missing upload-pack advertisement",
        );
        return 200;
      },
      readRefs,
      observePullRequest,
      holdNextDiscovery() {
        if (armedDiscovery || heldDiscovery) {
          throw new Error("discovery already armed");
        }
        armedDiscovery = true;
      },
      discoveryHeld: () => heldDiscovery === true,
      releaseDiscovery: () => {
        if (!heldDiscovery) {
          throw new Error("no held discovery");
        }
        releaseDiscovery();
      },
      async witnessCommit(ref = approvalRef) {
        await git(["check-ref-format", ref]);
        const refs = await readRefs();
        if (!refs[ref]) {
          throw new Error("witness ref absent");
        }
        const witness = await mkdtemp(join(directory, "witness-"));
        try {
          await git(["init", "--bare", witness]);
          // A fresh fetch copies objects, with no alternates, client cache, broker,
          // or HTTP origin involved. Pin the observed SHA to detect concurrent moves.
          await git(["-C", witness, "fetch", "--no-tags", bare, refs[ref]]);
          const sha = (
            await git(["-C", witness, "rev-parse", "FETCH_HEAD^{commit}"])
          ).stdout.trim();
          const commit = (await git(["-C", witness, "cat-file", "commit", sha])).stdout;
          const tree = (await git(["-C", witness, "ls-tree", "-r", sha])).stdout;
          const content = tree.includes("\tskipper-proof.txt")
            ? (await git(["-C", witness, "show", sha + ":skipper-proof.txt"])).stdout
            : undefined;
          const changed = (
            await git(["-C", witness, "diff", "--name-status", sha + "^", sha])
          ).stdout
            .trim()
            .split("\n");
          const reviewFiles = {};
          for (const file of ["review-title.mjs", "review-title.test.mjs"]) {
            if (tree.includes("\t" + file + "\n")) {
              reviewFiles[file] = (await git(["-C", witness, "show", sha + ":" + file])).stdout;
            }
          }
          return { refs, sha, commit, tree, content, changed, reviewFiles };
        } finally {
          await rm(witness, { recursive: true, force: true });
        }
      },
      async deleteApprovalRef(expectedSha) {
        if (!/^[0-9a-f]{40}$/.test(expectedSha) || /^0+$/.test(expectedSha)) {
          throw new Error("expected commit SHA required");
        }
        await git(["-C", bare, "update-ref", "-d", approvalRef, expectedSha]);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// Git and the installation API share this origin. Only the background DELETE may reach it
// after withdrawal; compare the whole snapshot so extra traffic cannot hide behind retirement.
export function assertOnlyTokenRetirement(before, after) {
  const [token] = before.tokens;
  assert.equal(before.issued, 1);
  assert.equal(token.revoked, false);
  assert.equal(before.endpoints["revoke:204"], undefined);
  assert.deepEqual(
    after,
    {
      ...before,
      connections: before.connections + 1,
      requests: before.requests + 1,
      endpoints: { ...before.endpoints, "revoke:204": 1 },
      tokens: [{ ...token, attempts: token.attempts + 1, uses: token.uses + 1, revoked: true }],
    },
    "only the prepared-token owner retired its credential; no Git request reached the origin",
  );
}

// Keep each final response paired with its own request and Authorization header.
// Git may retry a failed Basic request. An anonymous 401 challenge never counts.
const withdrawalRequestTrace = [
  "/=> Send header: (GET|POST|CONNECT) / {",
  "  request=0; basic=0",
  "  if ($0 ~ /=> Send header: GET .*\\/info\\/refs\\?service=git-upload-pack /) request=1",
  "  if ($0 ~ /=> Send header: POST .*\\/git-upload-pack /) request=2",
  "  if (request == target) attempts++",
  "  next",
  "}",
  "tolower($0) ~ /=> send header: authorization: basic / {",
  "  if (!basic && request == target) authenticated++",
  "  basic=1",
  "}",
];

export function withdrawDuringFetchCommand(dir, expectedStatus = 503, barrier) {
  if (![401, 503].includes(expectedStatus)) {
    throw new Error("expected an explicit refusal status");
  }
  if (barrier !== undefined && !/^\.oce-git-withdrawal-[a-f0-9]{16}$/.test(barrier)) {
    throw new Error("invalid Git withdrawal barrier name");
  }
  // Git stores the credential after authenticated discovery succeeds. This extra helper
  // ignores get/erase and never reads or prints credentials.
  const setup =
    barrier === undefined
      ? []
      : [
          "umask 077",
          "OCE_FIXTURE_WORKTREE=$(pwd -P) || exit 52",
          "export OCE_FIXTURE_WORKTREE",
          "mkdir -- " + barrier + " || exit 53",
          "owned_barrier=" + barrier,
          "git_origin=$(git remote get-url origin) || exit 54",
          "git_authority=${git_origin#https://}; git_authority=${git_authority%%/*}",
          "cat > \"$owned_barrier/helper\" <<'OCE_GIT_BARRIER' || exit 55",
          "#!/bin/sh",
          "barrier=${0%/*}",
          'if [ "$1" != store ]; then exit 0; fi',
          'if ! mkdir "$barrier/ready" 2>/dev/null; then',
          // Repeated stores can share our own directory. Every store waits for release.
          '  if [ ! -d "$barrier/ready" ] || [ -L "$barrier/ready" ]; then',
          "    printf '%s\\n' 'oce-fixture-git-ready-failed' >&2",
          "    exit 57",
          "  fi",
          "fi",
          "remaining=900",
          'until [ -f "$barrier/release" ]; do',
          '  if [ $remaining -eq 0 ]; then : > "$barrier/expired"; exit 1; fi',
          "  remaining=$((remaining-1)); sleep 0.1",
          "done",
          "OCE_GIT_BARRIER",
          'set -- -c "credential.https://$git_authority.helper=!sh \\"\\$OCE_FIXTURE_WORKTREE/' +
            barrier +
            '/helper\\""',
        ];
  return [
    "set -eu; set +x",
    "cd " + dir + " || exit 50",
    "set --; output=$(mktemp -- ./.oce-git-withdrawal-output.XXXXXX) || exit 51; owned_barrier=",
    "cleanup() {",
    "  result=$1",
    "  cleanup_failed=0",
    '  if [ -f "$output" ]; then rm -- "$output" || cleanup_failed=1; fi',
    '  if [ -n "$owned_barrier" ]; then',
    "    for entry in helper release expired; do",
    '      if [ -f "$owned_barrier/$entry" ]; then rm -- "$owned_barrier/$entry" || cleanup_failed=1; fi',
    "    done",
    '    if [ -d "$owned_barrier/ready" ]; then rmdir -- "$owned_barrier/ready" || cleanup_failed=1; fi',
    '    rmdir -- "$owned_barrier" || cleanup_failed=1',
    "  fi",
    '  if [ "$result" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then exit 56; fi',
    '  exit "$result"',
    "}",
    "trap 'cleanup \"$?\"' EXIT",
    ...setup,
    '(set +e; LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_TRACE_REDACT=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git "$@" -c protocol.version=2 ls-remote origin 2>&1 >"$output";',
    "printf '\\nheld-fetch-exit=%d\\n' \"$?\") | awk '",
    "BEGIN { target=2 }",
    "/^oce-fixture-git-ready-failed$/ { readyFailed=1 }",
    ...withdrawalRequestTrace,
    "/<= Recv header: HTTP\\/[0-9.]+ [2-5][0-9][0-9]/ {",
    "  match($0, /HTTP\\/[0-9.]+ [2-5][0-9][0-9]/); status=substr($0, RSTART+RLENGTH-3, 3)+0",
    "  if (request == 1 && basic && status == 200) advertised=1",
    "  if (request == 2 && basic) {",
    "    if (status == " + expectedStatus + ") denied++",
    "    else if (status == 503) unavailable++",
    "  }",
    "  request=basic=0",
    "}",
    "/^held-fetch-exit=128$/ { failed++ }",
    // These codes reach the failure receipt without forwarding the Git trace.
    "END {",
    "  if (readyFailed) exit 57",
    "  if (!advertised) exit 41", // No completed authenticated discovery.
    "  if (!attempts) exit 42", // No upload POST after discovery.
    "  if (!authenticated) exit 47", // An upload POST was attempted without Basic.
    "  if (unavailable && denied + unavailable == authenticated) exit 48", // At least one authenticated 503.
    "  if (denied != authenticated) exit 43", // Other status, or no final response.
    "  if (failed != 1) exit 44",
    "}'",
    'test ! -s "$output" || exit 45',
    ...(barrier === undefined ? [] : ['test ! -e "$owned_barrier/expired" || exit 46']),
  ].join("\n");
}

// A new Git process after disposal. Every authenticated discovery attempt
// must see the expected final refusal, and Git must exit unsuccessfully.
export function fetchAfterWithdrawalCommand(dir, expectedStatus = 503) {
  if (![401, 503].includes(expectedStatus)) {
    throw new Error("expected an explicit refusal status");
  }
  return [
    "set -eu; set +x; cd " + dir,
    "(set +e; LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_TRACE_REDACT=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git -c protocol.version=2 fetch --no-tags origin HEAD;",
    "printf '\\nfresh-fetch-exit=%d\\n' \"$?\") 2>&1 | awk '",
    "BEGIN { target=1 }",
    ...withdrawalRequestTrace,
    "/<= Recv header: HTTP\\/[0-9.]+ [2-5][0-9][0-9]/ {",
    "  match($0, /HTTP\\/[0-9.]+ [2-5][0-9][0-9]/); status=substr($0, RSTART+RLENGTH-3, 3)+0",
    "  if (request == 1 && basic && status == " + expectedStatus + ") denied++",
    "  request=basic=0",
    "}",
    "/^fresh-fetch-exit=128$/ { failed++ }",
    "END { if (!authenticated) exit 42; if (denied != authenticated) exit 43; if (failed != 1) exit 44 }'",
  ].join("\n");
}
