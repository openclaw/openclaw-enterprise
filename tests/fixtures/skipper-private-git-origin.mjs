import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { IncomingMessage } from "node:http";
import { createServer, get as httpsGet } from "node:https";
import { checkServerIdentity } from "node:tls";
import { isIP } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnvironment, run } from "./repository-credentials/process.mjs";
import { createTokenAuthority } from "./repository-credentials/github/token-authority.mjs";
import { fixtureAppId, fixtureInstallationId } from "./repository-credentials/github/metadata.mjs";

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
  await run("git", ["check-ref-format", approvalRef]);
  const directory = await mkdtemp(join(tmpdir(), "skipper-private-git-"));
  const env = cleanEnvironment({ HOME: directory, GIT_CONFIG_GLOBAL: "/dev/null" });
  const git = (args, options = {}) => run("git", args, { env, ...options });
  const bare = join(directory, `${repository}.git`);
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
    // A pre-receive hook rejects the entire transaction, including mixed pushes.
    // Network clients can only change the exact approval ref; main stays protected.
    await writeFile(
      join(bare, "hooks", "pre-receive"),
      `#!/bin/sh\nwhile read old new ref; do\n  test "$ref" = "$FIXTURE_APPROVAL_REF" || { echo 'ref denied' >&2; exit 1; }\ndone\n`,
      { mode: 0o700 },
    );
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
    const authority = createTokenAuthority({
      clock: { wallNow: Date.now },
      publicKey,
      lifetimeMs: 3600000,
      repositoryId,
      additionalPermissions: teamReview
        ? [{ metadata: "read", contents: "write", pull_requests: "write" }]
        : [],
    });
    const reviewHead = approvalRef.slice("refs/heads/".length);
    const pullRoute = "/repos/" + repository + "/pulls";
    let pullRequest;
    let pullCreateRequests = 0;
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
    // Draft pull-request creation for the team-review topology. The caller has matched the
    // route and counted the attempt; `reply` records the outcome under that endpoint.
    const createDraftPull = async (request, reply) => {
      const auth = request.headers.authorization;
      if (!authority.authorize(auth) || authority.permissions(auth)?.pull_requests !== "write") {
        reply(403);
        return;
      }
      let json = "";
      for await (const chunk of request) {
        if (json.length + chunk.length > 32_768) {
          reply(413);
          return;
        }
        json += chunk;
      }
      const { title, body, head, base, draft, maintainer_can_modify } = JSON.parse(json);
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
      const reply = (status, body = {}) => {
        count(endpoint, status);
        response.writeHead(status, {
          "content-type": "application/json",
          ...(status === 401 ? { "www-authenticate": 'Basic realm="private fixture"' } : {}),
        });
        response.end(status === 204 ? undefined : JSON.stringify(body));
      };
      try {
        const url = new URL(request.url, "https://fixture.invalid");
        if (request.url !== `${url.pathname}${url.search}`) {
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
          reply(201, {
            token: issued.token,
            expires_at: new Date(issued.expires).toISOString(),
            permissions: issued.permissions,
            repository_selection: "selected",
            repositories: [{ id: Number(repositoryId), full_name: repository, private: true }],
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
        const service = url.searchParams.get("service");
        const discovery =
          request.method === "GET" &&
          url.pathname === `${gitPrefix}/info/refs` &&
          ["git-upload-pack", "git-receive-pack"].includes(service) &&
          [...url.searchParams].length === 1;
        const rpc =
          request.method === "POST" &&
          ["git-upload-pack", "git-receive-pack"].some(
            (name) => url.pathname === `${gitPrefix}/${name}`,
          ) &&
          !url.search;
        if (!discovery && !rpc) {
          reply(404);
          return;
        }
        const receive = discovery
          ? service === "git-receive-pack"
          : url.pathname.endsWith("/git-receive-pack");
        endpoint = `${receive ? "receive" : "upload"}-${discovery ? "advertise" : "pack"}`;
        if (!authority.authorize(request.headers.authorization, "git")) {
          reply(401);
          return;
        }
        const permissions = authority.permissions(request.headers.authorization);
        if (!permissions.contents || (receive && permissions.contents !== "write")) {
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
              PATH_INFO: url.pathname,
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
    const readRefs = async () =>
      Object.fromEntries(
        (await git(["-C", bare, "for-each-ref", "--format=%(refname) %(objectname)"])).stdout
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

export function withdrawDuringFetchCommand(dir, expectedStatus = 503) {
  if (![401, 503].includes(expectedStatus)) {
    throw new Error("expected an explicit refusal status");
  }
  return [
    "set -eu; cd " + dir,
    // Curl trace is filtered inside the Agent; only the boolean outcome reaches the model.
    "set +e; LC_ALL=C GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git -c protocol.version=2 ls-remote origin 2>&1 >withdraw.out | awk '",
    "/=> Send header: GET .*info.refs/ {advert=1}",
    "/<= Recv header: HTTP.* 200/ {if(advert) served=1}",
    "/=> Send header: POST .*git-upload-pack/ {sent=served}",
    "/=> Send header: Authorization: Basic/ {if(sent) authenticated=1}",
    "/<= Recv header: HTTP.* " + expectedStatus + "/ {if(authenticated) denied=1}",
    'END {exit !(sent && denied)}\'; result=$?; set -e; test "$result" = 0; test ! -s withdraw.out',
  ].join("\n");
}

// A new Git process, after the first operation has already observed withdrawal. Consume the
// trace inside the Agent: return only success/failure, never a header or credential. A 401
// challenge followed by an authenticated refusal is expected; anonymous refusal cannot pass.
export function fetchAfterWithdrawalCommand(dir, expectedStatus = 503) {
  if (![401, 503].includes(expectedStatus)) {
    throw new Error("expected an explicit refusal status");
  }
  return [
    "set -eu; cd " + dir,
    "(set +e; LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_TRACE_REDACT=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git -c protocol.version=2 fetch --no-tags origin HEAD;",
    "printf '\\nfresh-fetch-exit=%d\\n' \"$?\") 2>&1 | awk '",
    "/=> Send header: GET .*\\/info\\/refs\\?service=git-upload-pack / { discovery=1; basic=0 }",
    "/=> Send header: Authorization: Basic / { basic=discovery }",
    "/<= Recv header: HTTP\\/[0-9.]+ [1-5][0-9][0-9]/ {",
    "  if (discovery && basic) { authenticated++; if ($0 ~ / " +
      expectedStatus +
      "( |$)/) denied++ }",
    "  discovery=basic=0",
    "}",
    "/^fresh-fetch-exit=128$/ { failed++ }",
    "END { exit !(authenticated == 1 && denied == 1 && failed == 1) }'",
  ].join("\n");
}
