import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { startGitHubFixture } from "../fixtures/repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import {
  cleanEnvironment,
  createTlsMaterial,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import {
  createServiceConfiguration,
  eventually,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import {
  createGitHubTokenServiceFactory,
  startServiceListeners,
} from "../fixtures/repository-credentials/service-resources.mjs";

// Stock Git must reach the gateway under its public HTTPS name. A CONNECT proxy
// forwards only that name to the listener; TLS still terminates at the gateway.
async function startGatewayProxy(resources, gatewayHost, gatewayPort) {
  const sockets = new Set();
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
      sockets.add(one);
      one.once("close", () => {
        sockets.delete(one);
        other.destroy();
      });
      one.on("error", () => other.destroy());
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function startTokenService(t) {
  const resources = createResourceScope();
  t.after(() => resources.close());
  const clock = createControlledClock();
  const tls = await createTlsMaterial(resources);
  const base = await createServiceConfiguration(resources);
  const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
  const github = await startGitHubFixture(resources, { clock, tls });
  const git = await startGitSmartHttpFixture(resources, { authorize: github.authorize, tls });
  // Synthetic host token: the fake GitHub accepts it on git and REST without issuing it.
  const token = `gho_${"t".repeat(36)}`;
  const tokenIndex = github.acceptStatic(token);
  const factory = await createGitHubTokenServiceFactory(resources, {
    config,
    clock,
    token,
    trustedEndpoints: { apiOrigin: github.origin, gitOrigin: git.origin, ca: tls.ca },
  });
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins: [github.origin, git.origin],
  });
  const proxy = await startGatewayProxy(
    resources,
    new URL(config.gateway.publicOrigin).hostname,
    listeners.address.port,
  );
  return { clock, tls, config, github, git, service, listeners, token, tokenIndex, proxy };
}

async function stockGit(t, fixture, opened) {
  const material = await createNativeClientMaterial(t, [{ opened, repositoryRef: "fixture" }], {
    ca: fixture.tls.ca,
  });
  const home = await temporaryDirectory(t, "repository-token-home-");
  const env = cleanEnvironment({
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
  await assert.rejects(git.ref("refs/heads/agent/y"));
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
