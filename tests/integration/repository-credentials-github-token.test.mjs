import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import {
  eventually,
  gatewayRequest,
  startTokenServiceScope,
} from "../fixtures/repository-credentials/service.mjs";
import { startStaticTokenService } from "../fixtures/repository-credentials/service-resources.mjs";
import { fileCompileCache } from "../helpers/compile-cache.mjs";
import { listen } from "../helpers/listen.mjs";

// Each case starts its own service, Git and GitHub fixtures and spends most of
// its time waiting on stock Git children. The cases register here and run two at
// a time in one suite at the end of the file: more at once starves the fixture's
// 30 s per-command limit on an overloaded host.
const cases = [];
const test = (...registration) => cases.push(registration);
// The bare repository has no such ref: `git rev-parse` exits 128.
const missingRef = { message: "command failed (exit 128)" };

// Stock Git must reach the gateway under its public HTTPS name. A CONNECT proxy
// forwards only that name to the listener; TLS still terminates at the gateway.
async function startGatewayProxy(resources, gatewayHost, gatewayPort) {
  const server = createServer((_, response) => response.writeHead(405).end());
  server.on("connect", (request, socket, head) => {
    if (request.url !== `${gatewayHost}:443`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(gatewayPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    // A tunnel lives exactly as long as both ends, so gateway drain is not held open.
    for (const [one, other] of [
      [socket, upstream],
      [upstream, socket],
    ]) {
      one.once("close", () => other.destroy());
      one.on("error", () => other.destroy());
    }
  });
  return `http://127.0.0.1:${await listen(resources, server)}`;
}

async function startTokenService(t, limits = {}, configuration = {}) {
  const { resources, clock, tls, config, github } = await startTokenServiceScope(t, { limits });
  const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
  // Synthetic host token: the fake GitHub accepts it on git and REST without issuing it.
  const { token, tokenIndex, service, listeners } = await startStaticTokenService(resources, {
    config,
    clock,
    tls,
    github,
    gitOrigin: git.origin,
    configuration,
  });
  const proxy = await startGatewayProxy(
    resources,
    new URL(config.gateway.publicOrigin).hostname,
    listeners.address.port,
  );
  return { clock, tls, config, github, git, service, listeners, token, tokenIndex, proxy };
}

// Git starts the credential helper and the hook dispatcher (for every hook, three times
// per ref update) as Node children of an allowlisted environment, so the compile cache
// is passed explicitly.
const compileCache = await fileCompileCache("repository-credentials-github-token");

async function stockGit(t, fixture, opened) {
  const material = await createNativeClientMaterial(t, [{ opened, repositoryRef: "fixture" }], {
    ca: fixture.tls.ca,
  });
  const home = await temporaryDirectory(t, "repository-token-home-");
  const env = cleanEnvironment({
    NODE_COMPILE_CACHE: compileCache,
    HOME: home,
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
    HTTPS_PROXY: fixture.proxy,
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  return (args, options = {}) => run("/usr/bin/git", args, { env, cwd: home, ...options });
}

test("development token sessions clone, push allowed refs and call REST without issuing tokens", async (t) => {
  const fixture = await startTokenService(t);
  const { github, git, service } = fixture;
  const opened = service.open({ durationSeconds: 3600, profile: "git-write" });
  const session = { ...fixture, opened };
  assert.deepEqual(opened.client.pushRefAllowlist, ["refs/heads/agent/*"]);
  assert.equal(JSON.stringify(opened).includes(fixture.token), false);
  const gitCommand = await stockGit(t, fixture, opened);
  const checkout = join(await temporaryDirectory(t, "repository-token-work-"), "checkout");
  await gitCommand(["clone", opened.client.gitRemote, checkout]);
  await gitCommand(["config", "user.name", "Agent fixture"], { cwd: checkout });
  await gitCommand(["config", "user.email", "agent@example.test"], { cwd: checkout });
  await writeFile(join(checkout, "change.txt"), "Agent change\n");
  await gitCommand(["add", "change.txt"], { cwd: checkout });
  await gitCommand(["commit", "-m", "Agent change"], { cwd: checkout });
  const commit = (await gitCommand(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  await gitCommand(["push", "origin", "HEAD:refs/heads/agent/x"], { cwd: checkout });
  assert.equal(await git.ref("refs/heads/agent/x"), commit);
  // Upstream git saw the service-owned token (Basic x-access-token:<token>).
  assert.ok(
    github.authenticationAttempts.some(
      (attempt) => attempt.boundary === "git" && attempt.tokenIndex === fixture.tokenIndex,
    ),
  );

  // The push allowlist is enforced at the gateway: bypassing or replacing the
  // client hook changes nothing, and no receive-pack request reaches upstream.
  const mainBefore = await git.ref("refs/heads/main");
  const pushesBefore = git.trace.filter((entry) => entry.path.endsWith("/git-receive-pack"));
  const hooked = await gitCommand(["push", "origin", "HEAD:refs/heads/main"], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(hooked.code, 0);
  assert.match(hooked.stderr, /repository-push-ref-not-allowed/);
  for (const bypass of [
    ["push", "--no-verify", "origin", "HEAD:refs/heads/main"],
    ["-c", "core.hooksPath=/dev/null", "push", "origin", "HEAD:refs/heads/main"],
    ["push", "--no-verify", "origin", "HEAD:refs/heads/agent/y", "HEAD:refs/tags/v1"],
    ["push", "--no-verify", "origin", "--delete", "refs/heads/existing-branch"],
  ]) {
    const refused = await gitCommand(bypass, { cwd: checkout, allowFailure: true });
    assert.notEqual(refused.code, 0, bypass.join(" "));
    assert.match(refused.stderr, /\b400\b/, bypass.join(" "));
  }
  assert.equal(await git.ref("refs/heads/main"), mainBefore);
  assert.notEqual(await git.ref("refs/heads/existing-branch"), "");
  await assert.rejects(git.ref("refs/heads/agent/y"), missingRef);
  assert.deepEqual(
    git.trace.filter((entry) => entry.path.endsWith("/git-receive-pack")),
    pushesBefore,
  );

  // REST uses Bearer <token> through the same session; GraphQL is denied for an OAuth token.
  const repository = await gatewayRequest(session, "/repos/fixture/repository");
  assert.equal(repository.status, 200);
  assert.equal(github.trace.at(-1).tokenIndex, fixture.tokenIndex);
  const traced = github.trace.length;
  const graphql = await gatewayRequest(session, "/graphql", {
    method: "POST",
    body: { query: "{ viewer { login } }" },
  });
  assert.equal(graphql.status, 400);
  assert.equal(github.trace.length, traced);
  assert.equal(github.issuesOfTokens.length, 0);

  // Closing releases the custody copy at once (expiry-only), without waiting an hour.
  service.close(opened.session.sessionId);
  const disposed = await eventually(
    () =>
      service.status(opened.session.sessionId)?.state === "DISPOSED" &&
      service.status(opened.session.sessionId),
    { message: "token session did not dispose after close" },
  );
  assert.equal(disposed.cleanup.pending, 0);
  assert.equal(disposed.cleanup.uncertain, 0);
  const afterClose = await gatewayRequest(session, "/repos/fixture/repository");
  assert.equal(afterClose.status, 401);
  assert.deepEqual(github.errors, []);
});

test("development token git-read sessions are refused receive-pack before any acquisition", async (t) => {
  const fixture = await startTokenService(t);
  const opened = fixture.service.open({ durationSeconds: 3600, profile: "git-read" });
  const gitCommand = await stockGit(t, fixture, opened);
  const checkout = join(await temporaryDirectory(t, "repository-token-read-"), "checkout");
  await gitCommand(["clone", opened.client.gitRemote, checkout]);
  const attempts = fixture.github.authenticationAttempts.length;
  const refused = await gitCommand(["push", "--no-verify", "origin", "HEAD:refs/heads/agent/x"], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(refused.code, 0);
  assert.equal(fixture.github.authenticationAttempts.length, attempts);
  assert.equal(
    fixture.git.trace.some((entry) => entry.path.endsWith("/git-receive-pack")),
    false,
  );
});

test("an oversized development token push is answered 413 before the token is used", async (t) => {
  const pushLimit = 1048576;
  const fixture = await startTokenService(t, { gitPushInputBytes: pushLimit });
  const opened = fixture.service.open({ durationSeconds: 3600, profile: "git-write" });
  const gitCommand = await stockGit(t, fixture, opened);
  const checkout = join(await temporaryDirectory(t, "repository-token-large-"), "checkout");
  await gitCommand(["clone", opened.client.gitRemote, checkout]);
  await gitCommand(["config", "user.name", "Agent fixture"], { cwd: checkout });
  await gitCommand(["config", "user.email", "agent@example.test"], { cwd: checkout });
  // Incompressible content keeps the pack larger than the limit.
  await writeFile(join(checkout, "large.bin"), randomBytes(8 * pushLimit));
  await gitCommand(["add", "large.bin"], { cwd: checkout });
  await gitCommand(["commit", "-m", "Large change"], { cwd: checkout });
  // Git streams a chunked body above http.postBuffer and declares a length below it.
  for (const postBuffer of ["1048576", String(64 * pushLimit)]) {
    const traced = fixture.git.trace.length;
    const refused = await gitCommand(
      ["-c", `http.postBuffer=${postBuffer}`, "push", "origin", "HEAD:refs/heads/agent/large"],
      { cwd: checkout, allowFailure: true },
    );
    assert.notEqual(refused.code, 0, postBuffer);
    // The client reads the refusal instead of a connection reset.
    assert.match(refused.stderr, /\b413\b/, postBuffer);
    assert.doesNotMatch(refused.stderr, /reset by peer/, postBuffer);
    // Only Git's 4-byte auth probe (sent before a chunked body) may reach upstream.
    assert.deepEqual(
      fixture.git.trace
        .slice(traced)
        .filter((entry) => entry.path.endsWith("/git-receive-pack"))
        .filter((entry) => entry.contentLength !== "4"),
      [],
      postBuffer,
    );
  }
  await assert.rejects(fixture.git.ref("refs/heads/agent/large"), missingRef);
});

async function committedCheckout(t, fixture, opened, label) {
  const gitCommand = await stockGit(t, fixture, opened);
  const checkout = join(await temporaryDirectory(t, `repository-token-${label}-`), "checkout");
  await gitCommand(["clone", opened.client.gitRemote, checkout]);
  await gitCommand(["config", "user.name", "Agent fixture"], { cwd: checkout });
  await gitCommand(["config", "user.email", "agent@example.test"], { cwd: checkout });
  await writeFile(join(checkout, "change.txt"), `${label}\n`);
  await gitCommand(["add", "change.txt"], { cwd: checkout });
  await gitCommand(["commit", "-m", label], { cwd: checkout });
  const commit = (await gitCommand(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  return { gitCommand, checkout, commit };
}

// One receive-pack POST with a raw body, authenticated as Git authenticates to the gateway.
function rawGatewayPost(fixture, target, body) {
  const basic = Buffer.from(`gateway-session:${fixture.opened.bearer}`).toString("base64");
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: fixture.listeners.address.port,
        path: target,
        method: "POST",
        ca: fixture.tls.ca,
        headers: {
          host: new URL(fixture.config.gateway.publicOrigin).host,
          authorization: `Basic ${basic}`,
          "content-type": "application/x-git-receive-pack-request",
          accept: "application/x-git-receive-pack-result",
          "content-length": body.length,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("end", () =>
          resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
        );
        incoming.once("error", reject);
      },
    );
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error("fixture request timeout")));
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

const receivePacks = (fixture) =>
  fixture.git.trace.filter((entry) => entry.path.endsWith("/git-receive-pack")).length;

test("development token pushes admit UTF-8 branch names and match the allowlist byte for byte", async (t) => {
  const composed = "refs/heads/caf\u00e9";
  const fixture = await startTokenService(
    t,
    {},
    {
      pushRefAllowlist: ["refs/heads/agent/*", composed],
    },
  );
  const opened = fixture.service.open({ durationSeconds: 3600, profile: "git-write" });
  assert.deepEqual(opened.client.pushRefAllowlist, ["refs/heads/agent/*", composed]);
  const { gitCommand, checkout, commit } = await committedCheckout(t, fixture, opened, "utf8");

  // Composed (NFC) names pass the client hook and the gateway, under a prefix or exactly.
  for (const ref of ["refs/heads/agent/caf\u00e9", composed]) {
    await gitCommand(["push", "origin", `HEAD:${ref}`], { cwd: checkout });
    assert.equal(await fixture.git.ref(ref), commit, ref);
  }

  // The decomposed (NFD) spelling renders the same but is other bytes: both layers refuse it.
  const lookalike = "refs/heads/cafe\u0301";
  const before = receivePacks(fixture);
  const hooked = await gitCommand(["push", "origin", `HEAD:${lookalike}`], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(hooked.code, 0);
  assert.match(hooked.stderr, /repository-push-ref-not-allowed/);
  const bypassed = await gitCommand(["push", "--no-verify", "origin", `HEAD:${lookalike}`], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(bypassed.code, 0);
  assert.match(bypassed.stderr, /\b400\b/);
  await assert.rejects(fixture.git.ref(lookalike), missingRef);

  // Git accepts a refname that is not UTF-8 (argv cannot carry it, so a shell spells it).
  // Under an allowed prefix, the client hook and the gateway still refuse it.
  const shell = (verify) =>
    gitCommand(
      [
        "-c",
        "alias.raw-push=!f() { git push $1 origin \"HEAD:refs/heads/agent/$(printf '\\377')\"; }; f",
        "raw-push",
        verify,
      ],
      { cwd: checkout, allowFailure: true },
    );
  const invalidHooked = await shell("--verify");
  assert.notEqual(invalidHooked.code, 0);
  assert.match(invalidHooked.stderr, /repository-push-ref-not-allowed/);
  const invalidBypassed = await shell("--no-verify");
  assert.notEqual(invalidBypassed.code, 0);
  assert.match(invalidBypassed.stderr, /\b400\b/);

  // Git accepts invisible and direction-changing characters in a name; under an allowed
  // prefix both layers refuse them (Trojan Source). The hook names the code point.
  for (const [code, character] of [
    ["U+202E", "\u202e"],
    ["U+200B", "\u200b"],
    ["U+FEFF", "\ufeff"],
    ["U+2028", "\u2028"],
  ]) {
    const ref = `refs/heads/agent/a${character}b`;
    const refusedByHook = await gitCommand(["push", "origin", `HEAD:${ref}`], {
      cwd: checkout,
      allowFailure: true,
    });
    assert.notEqual(refusedByHook.code, 0, code);
    assert.ok(
      refusedByHook.stderr.includes(
        `repository-push-ref-not-allowed: the ref name contains ${code}, an invisible or direction-changing character`,
      ),
      refusedByHook.stderr,
    );
    const refusedByGateway = await gitCommand(["push", "--no-verify", "origin", `HEAD:${ref}`], {
      cwd: checkout,
      allowFailure: true,
    });
    assert.notEqual(refusedByGateway.code, 0, code);
    assert.match(refusedByGateway.stderr, /\b400\b/, code);
    await assert.rejects(fixture.git.ref(ref), missingRef, code);
  }

  // Git refuses a control byte itself, before any request.
  const control = await gitCommand(
    ["push", "--no-verify", "origin", "HEAD:refs/heads/agent/caf\u0001"],
    { cwd: checkout, allowFailure: true },
  );
  assert.notEqual(control.code, 0);
  // The refused --no-verify pushes reached only the gateway; nothing refused went upstream.
  assert.equal(receivePacks(fixture), before);
  assert.deepEqual(fixture.github.errors, []);
});

test("a development token push of more than 256 refs is refused with its own code", async (t) => {
  const fixture = await startTokenService(t);
  const opened = fixture.service.open({ durationSeconds: 3600, profile: "git-write" });
  const { gitCommand, checkout, commit } = await committedCheckout(t, fixture, opened, "many");
  const refspecs = (count) =>
    Array.from({ length: count }, (_, index) => `HEAD:refs/heads/agent/many-${index}`);
  const before = receivePacks(fixture);
  const refused = await gitCommand(["push", "origin", ...refspecs(257)], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /\b413\b/);
  assert.equal(receivePacks(fixture), before);
  await assert.rejects(fixture.git.ref("refs/heads/agent/many-0"), missingRef);

  // The JSON answer names the limit for clients that read it.
  const lines = refspecs(257).map(
    (_, index) => `${"0".repeat(40)} ${commit} refs/heads/agent/many-${index}`,
  );
  lines[0] += "\0report-status";
  const pktLine = (line) => {
    const payload = Buffer.from(line);
    return Buffer.concat([
      Buffer.from((payload.length + 4).toString(16).padStart(4, "0")),
      payload,
    ]);
  };
  const answer = await rawGatewayPost(
    { ...fixture, opened },
    new URL(opened.client.gitRemote).pathname.replace(/\/?$/, "") + "/git-receive-pack",
    Buffer.concat([...lines.map(pktLine), Buffer.from("0000")]),
  );
  assert.equal(answer.status, 413);
  assert.deepEqual(JSON.parse(answer.body), {
    error: {
      code: "push-ref-limit-exceeded",
      message: "A push may update at most 256 refs. Push the refs in smaller batches.",
    },
  });
  assert.equal(receivePacks(fixture), before);
});

describe("development token repository credentials", { concurrency: 2 }, () => {
  for (const registration of cases) {
    it(...registration);
  }
});
