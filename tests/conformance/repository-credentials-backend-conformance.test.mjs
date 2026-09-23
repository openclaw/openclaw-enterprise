import { registerCredentialFixtureRegressions } from "../fixtures/repository-credentials/regressions.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:https";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import {
  createAlternateDriverFactory,
  startAlternateUpstream,
} from "../fixtures/repository-credentials/alternate.mjs";
import {
  createServiceConfiguration,
  eventually,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { run, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { removeRemoteBranches } from "../fixtures/repository-credentials/workflows.mjs";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { startServiceListeners } from "../fixtures/repository-credentials/service-resources.mjs";
import { requestHead } from "../fixtures/repository-credentials/builders.mjs";

registerCredentialFixtureRegressions();

test("controlled Git fixture runs real smart HTTP and records an accepted push before disconnect", async (t) => {
  const upstream = await startGitSmartHttpFixture(t);
  const directory = await temporaryDirectory(t);
  const checkout = join(directory, "checkout");
  const git = (args, options = {}) =>
    run("git", ["-c", `http.sslCAInfo=${upstream.tls.certFile}`, ...args], options);
  await git(["clone", `${upstream.origin}/fixture/repository.git`, checkout]);
  await git(["config", "user.name", "Fixture"], { cwd: checkout });
  await git(["config", "user.email", "fixture@example.test"], { cwd: checkout });
  await writeFile(join(checkout, "write.txt"), "Real Git fixture change\n");
  await git(["add", "write.txt"], { cwd: checkout });
  await git(["commit", "-m", "Fixture mutation"], { cwd: checkout });
  const head = (await git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  upstream.disconnectAfterNextAcceptedPush();
  const pushed = await git(["push", "origin", "HEAD:refs/heads/accepted"], {
    cwd: checkout,
    allowFailure: true,
  });
  assert.notEqual(pushed.code, 0);
  assert.equal(await upstream.ref("refs/heads/accepted"), head);
  assert.equal(
    upstream.trace.filter((entry) => entry.path.endsWith("/git-receive-pack")).length,
    1,
  );
  // Cleanup must find an accepted write even when its response was lost, and
  // must tolerate a companion branch that the interrupted operation never made.
  await removeRemoteBranches({ git }, checkout, ["accepted", "never-created"]);
  assert.equal(
    (await git(["ls-remote", "--heads", "origin", "refs/heads/accepted"], { cwd: checkout }))
      .stdout,
    "",
  );
});

test("second backend retains renewal through expiry and finalizes through the real common owner", async (t) => {
  const clock = createControlledClock();
  const config = await createServiceConfiguration(t);
  const factory = createAlternateDriverFactory({
    origin: "https://forge.example.test",
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
  });
  const { createCredentialService } = await appModule("drivers/repo/credentials/service");
  const service = createCredentialService({ config, factory, clock });
  t.after(() => service.shutdown(1000));
  const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
  const head = () =>
    requestHead("GET", "/team/nested/project", {}, { receivedMonoMs: clock.monotonicNow() });
  const perform = async (sender) => {
    const exchange = service.reserve(opened.bearer, head(), new AbortController().signal);
    assert.notEqual(exchange.kind, "denied");
    return service.execute(
      exchange,
      sender ??
        (async (_privateRequest, { gate }) =>
          gate.dispatch(
            () => {},
            () => ({ kind: "completed", status: 200 }),
          )),
    );
  };
  assert.equal((await perform()).kind, "completed");
  assert.equal(opened.session.binding.repositoryId, "repo:team/nested/project");
  const firstIdentity = opened.session.binding;
  await clock.advance(13 * 3600000 + 1000);
  assert.equal((await perform()).kind, "completed");
  assert.deepEqual(service.status(opened.session.sessionId).binding, firstIdentity);
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 2);
  for (let iteration = 0; iteration < 4; iteration++) {
    await clock.advance(100000);
    assert.equal((await perform()).kind, "completed");
  }
  // Reclaimed access slots must leave independent renewal authority available
  // for session finalization after all short-lived access tokens have expired.
  await clock.advance(100000);
  service.close(opened.session.sessionId);
  await eventually(() => service.status(opened.session.sessionId)?.state === "DISPOSED");
  assert.equal(factory.events.filter((event) => event.kind === "finalize").length, 1);
  assert.equal(service.reserve(opened.bearer, head(), new AbortController().signal).kind, "denied");
  await assert.rejects(
    factory.drivers[0].settle(Object.freeze({ kind: "finalized", attemptId: "foreign" })),
    /foreign/,
  );
  await assert.rejects(
    factory.drivers[0].withAuthentication(Object.freeze({}), Object.freeze({}), async () => {}),
    /foreign/,
  );
});

test("second backend uses the production HTTPS sender and distinct native authentication", async (t) => {
  if (
    await runInFixtureContainer(
      t,
      "tests/conformance/repository-credentials-backend-conformance.test.mjs",
    )
  ) {
    return;
  }
  const resources = createResourceScope();
  t.after(() => resources.close());
  const clock = createControlledClock();
  const config = await createServiceConfiguration(resources);
  const upstream = await startAlternateUpstream(resources, { clock });
  const factory = createAlternateDriverFactory({
    origin: upstream.origin,
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    accepted: upstream.accepted,
  });
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    tls: upstream.tls,
    factory,
    clock,
    upstreamOrigins: [upstream.origin],
  });
  const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
  const fixture = { config, opened, listeners, tls: upstream.tls };
  const headers = {
    authorization: `Bearer ${opened.bearer}`,
    cookie: "repository-credentials-probe=nonsecret",
  };
  assert.equal((await gatewayRequest(fixture, "/team/nested/project", { headers })).status, 200);
  await clock.advance(13 * 3600000 + 1);
  assert.equal((await gatewayRequest(fixture, "/team/nested/project", { headers })).status, 200);
  assert.equal(upstream.trace.length, 2);
  assert.equal(upstream.trace[1].path, "/v2/projects/team%2Fnested%2Fproject");
  // Native-key acceptance must not carry either caller credential header upstream.
  for (const entry of upstream.trace) {
    assert.equal(entry.authorizationPresent, false, "caller Authorization reached upstream");
    assert.equal(entry.cookiePresent, false, "caller Cookie reached upstream");
  }
});

test("drain-before rotation waits for a streamed upstream write and preserves the replacement", async (t) => {
  if (
    await runInFixtureContainer(
      t,
      "tests/conformance/repository-credentials-backend-conformance.test.mjs",
    )
  ) {
    return;
  }
  const resources = createResourceScope();
  t.after(() => resources.close());
  const clock = createControlledClock();
  const config = await createServiceConfiguration(resources, { credentialMarginMs: 100 });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = await startAlternateUpstream(resources, {
    clock,
    controls: { beforeWriteChunk: () => held },
  });
  const observations = [];
  const factory = createAlternateDriverFactory({
    origin: upstream.origin,
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    accepted: upstream.accepted,
    lifetimeMs: 90000,
    operationMs: 60000,
    controls: { observe: (event) => observations.push(event) },
  });
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    tls: upstream.tls,
    factory,
    clock,
    upstreamOrigins: [upstream.origin],
  });
  resources.after(release);
  const opened = service.open({ durationSeconds: 86400, profile: "git-write" });
  const fixture = { config, opened, listeners, tls: upstream.tls };
  const body = Buffer.concat([Buffer.alloc(256, "a"), Buffer.alloc(256, "b")]);
  let outgoing;
  let completed = false;
  const write = new Promise((resolve, reject) => {
    outgoing = request(
      `${config.gateway.publicOrigin}/team/nested/project`,
      {
        method: "POST",
        ca: upstream.tls.ca,
        headers: {
          authorization: `Bearer ${opened.bearer}`,
          "content-type": "application/octet-stream",
          "content-length": body.length,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once("error", reject);
        incoming.once("end", () => {
          completed = true;
          resolve(incoming.statusCode);
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("streamed write timed out")));
    outgoing.write(body.subarray(0, 256));
  });
  void write.catch(() => {});
  resources.after(async () => {
    release();
    outgoing.destroy();
    await write.catch(() => {});
  });
  await eventually(() => upstream.trace[0]?.bodyBytes === 256);
  const predecessor = [...upstream.accepted.keys()];
  assert.equal(predecessor.length, 1);
  assert.equal(service.status(opened.session.sessionId).activeUses, 1);

  // The first body is incomplete at the upstream. A new exchange now needs
  // longer validity than this key has left, forcing drain-before replacement.
  await clock.advance(40000);
  const replacementRead = gatewayRequest(fixture, "/team/nested/project");
  void replacementRead.catch(() => {});
  resources.after(async () => {
    release();
    outgoing.destroy();
    await replacementRead.catch(() => {});
  });
  await eventually(() =>
    observations.some((event) => event.kind === "plan" && event.method === "GET"),
  );
  assert.equal(completed, false);
  assert.equal(upstream.trace[0].committed, false);
  assert.equal(upstream.trace.length, 1, "replacement request remains undispatched during drain");
  assert.deepEqual([...upstream.accepted.keys()], predecessor);
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 1);
  assert.equal(factory.events.filter((event) => event.kind === "retire").length, 0);

  outgoing.end(body.subarray(256));
  release();
  assert.equal(await write, 200, "the predecessor stays valid until the write commits");
  assert.equal((await replacementRead).status, 200);
  assert.equal((await gatewayRequest(fixture, "/team/nested/project")).status, 200);
  assert.equal(factory.events.filter((event) => event.kind === "rotate").length, 2);
  assert.equal(upstream.accepted.has(predecessor[0]), false);
  assert.equal(upstream.accepted.size, 1);
  assert.deepEqual(
    upstream.trace.filter((entry) => entry.method === "POST"),
    [
      {
        method: "POST",
        path: "/v2/projects/team%2Fnested%2Fproject",
        authorizationPresent: false,
        cookiePresent: false,
        bodyBytes: body.length,
        committed: true,
        bodyDigest: createHash("sha256").update(body).digest("hex"),
      },
    ],
    "the complete streamed write commits once without replay",
  );
  assert.equal(upstream.trace.length, 3);
  service.close(opened.session.sessionId);
  await eventually(() => service.status(opened.session.sessionId).state === "DISPOSED");
  assert.equal(upstream.accepted.size, 0);
  assert.equal(factory.events.filter((event) => event.kind === "finalize").length, 1);
});
