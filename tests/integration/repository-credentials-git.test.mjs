import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gatewayRequest,
  eventually,
  startCredentialServiceFixture,
} from "../fixtures/repository-credentials/service.mjs";
import { run } from "../fixtures/repository-credentials/process.mjs";
import { exerciseGit } from "../fixtures/repository-credentials/workflows.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";

test("real Git clones, fetches, switches and pushes using an explicit development token", async (t) => {
  if (await runInFixtureContainer(t, "tests/integration/repository-credentials-git.test.mjs")) {
    return;
  }
  const fixture = await startCredentialServiceFixture(t, { profile: "git-write" });
  await exerciseGit(t, fixture);
  assert.ok(fixture.git.trace.some((entry) => entry.gitProtocol === "version=2"));
  assert.ok(fixture.git.trace.some((entry) => entry.path.endsWith("/git-receive-pack")));
  assert.equal(fixture.github.issuesOfTokens.length, 0);
});

// The host case runs every acceptance and fault case in the container.
if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("git-read clones, fetches and checks out while denying pushes and REST writes", async (t) => {
    const fixture = await startCredentialServiceFixture(t, {
      profile: "git-read",
    });
    const gitPath = new URL(fixture.opened.client.gitRemote).pathname;
    const gitAuthorization = `Basic ${Buffer.from(
      `${fixture.opened.client.gitUsername}:${fixture.opened.bearer}`,
    ).toString("base64")}`;
    // Denied routes must not issue a credential or contact either upstream,
    // including when a client bypasses receive-pack discovery and posts directly.
    for (const [target, options] of [
      [
        `${gitPath}/info/refs?service=git-receive-pack`,
        { headers: { authorization: gitAuthorization } },
      ],
      [
        `${gitPath}/git-receive-pack`,
        {
          method: "POST",
          headers: {
            authorization: gitAuthorization,
            "content-type": "application/x-git-receive-pack-request",
          },
        },
      ],
      ["/repos/fixture/repository/issues", { method: "POST", body: { title: "Denied issue" } }],
    ]) {
      assert.equal((await gatewayRequest(fixture, target, options)).status, 400);
      assert.equal(fixture.github.issuesOfTokens.length, 0);
      assert.equal(fixture.github.trace.length, 0);
      assert.equal(fixture.github.authenticationAttempts.length, 0);
      assert.equal(fixture.git.trace.length, 0);
    }
    const remoteRefs = () =>
      run("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: fixture.git.bare });
    const beforeRefs = (await remoteRefs()).stdout;
    const { client, checkout, commit } = await exerciseGit(t, fixture, { push: false });
    await client.git(["checkout", "main"], { cwd: checkout });
    assert.equal(
      (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
      await fixture.git.ref("refs/heads/main"),
    );
    await client.git(["checkout", "existing-branch"], { cwd: checkout });
    assert.equal(
      (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
      commit,
    );
    assert.ok(fixture.git.trace.some((entry) => entry.gitProtocol === "version=2"));
    assert.ok(fixture.git.trace.some((entry) => entry.path.endsWith("/git-upload-pack")));
    assert.equal(fixture.github.issuesOfTokens.length, 0);
    assert.equal((await gatewayRequest(fixture, "/repos/fixture/repository")).status, 200);
    assert.equal(
      (
        await gatewayRequest(fixture, "/graphql", {
          method: "POST",
          body: { query: "query { viewer { login } }" },
        })
      ).status,
      400,
    );
    const beforeGit = fixture.git.trace.length;
    const beforeApi = fixture.github.trace.length;
    const beforeAuthentication = fixture.github.authenticationAttempts.length;
    const pushed = await client.git(["push", "origin", "HEAD:refs/heads/agent-feature"], {
      cwd: checkout,
      allowFailure: true,
    });
    assert.notEqual(pushed.code, 0);
    assert.match(pushed.stderr, /400/);
    assert.equal(fixture.git.trace.length, beforeGit);
    assert.equal(fixture.github.trace.length, beforeApi);
    assert.equal(fixture.github.authenticationAttempts.length, beforeAuthentication);
    assert.equal(fixture.github.issuesOfTokens.length, 0);
    assert.equal((await remoteRefs()).stdout, beforeRefs);
    const deletion = await client.git(["push", "origin", "--delete", "existing-branch"], {
      cwd: checkout,
      allowFailure: true,
    });
    assert.notEqual(deletion.code, 0);
    assert.equal((await remoteRefs()).stdout, beforeRefs);
    assert.equal(fixture.git.trace.length, beforeGit);
  });

  test("git-write preserves native repository deletion policy without widening or replay", async (t) => {
    const fixture = await startCredentialServiceFixture(t, { profile: "git-write" });
    // The same repository policy allows branch creation but forbids deletion;
    // real receive-pack must enforce it after the gateway admits the write.
    await run("git", ["config", "receive.denyDeletes", "true"], { cwd: fixture.git.bare });
    const { client, checkout } = await exerciseGit(t, fixture);
    const remoteRefs = () =>
      run("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: fixture.git.bare });
    const beforeRefs = (await remoteRefs()).stdout;
    const beforeGit = fixture.git.trace.length;

    const pushed = await client.git(["push", "origin", "--delete", "agent-feature"], {
      cwd: checkout,
      allowFailure: true,
    });

    assert.notEqual(pushed.code, 0);
    assert.match(pushed.stderr, /\[remote rejected\].*agent-feature.*\(deletion prohibited\)/);
    assert.equal((await remoteRefs()).stdout, beforeRefs);
    assert.deepEqual(
      fixture.git.trace
        .slice(beforeGit)
        .filter((entry) => entry.path.endsWith("/git-receive-pack"))
        .map(({ method, path }) => ({ method, path })),
      [{ method: "POST", path: "/fixture/repository.git/git-receive-pack" }],
    );
    assert.equal(fixture.github.issuesOfTokens.length, 0);
  });

  test("closed gateway sessions deny remote requests while native local work remains usable", async (t) => {
    const fixture = await startCredentialServiceFixture(t);
    const { client, checkout } = await exerciseGit(t, fixture);
    const before = fixture.git.trace.length;
    fixture.service.close(fixture.opened.session.sessionId);
    const denied = await client.git(["fetch", "origin"], { cwd: checkout, allowFailure: true });
    assert.notEqual(denied.code, 0);
    assert.equal(fixture.git.trace.length, before);
    await writeFile(join(checkout, "local.txt"), "Local work after closure\n");
    await client.git(["add", "local.txt"], { cwd: checkout });
    await client.git(["commit", "-m", "Local work after closure"], { cwd: checkout });
    await client.git(["mv", "local.txt", "renamed.txt"], { cwd: checkout });
    await client.git(["commit", "-m", "Local move after closure"], { cwd: checkout });
    await client.git(["rm", "renamed.txt"], { cwd: checkout });
    await client.git(["commit", "-m", "Local removal after closure"], { cwd: checkout });
    assert.equal(
      (await client.git(["log", "-1", "--format=%s"], { cwd: checkout })).stdout.trim(),
      "Local removal after closure",
    );
  });

  test("accepted push with a lost response is never replayed by the service", async (t) => {
    const fixture = await startCredentialServiceFixture(t, {
      configuration: {
        pushRefAllowlist: ["refs/heads/agent-feature", "refs/heads/uncertain-feature"],
      },
    });
    const { client, checkout } = await exerciseGit(t, fixture);
    await writeFile(join(checkout, "uncertain.txt"), "Accepted despite lost response\n");
    await client.git(["add", "uncertain.txt"], { cwd: checkout });
    await client.git(["commit", "-m", "Uncertain push fixture"], { cwd: checkout });
    const head = (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const before = fixture.git.trace.filter((entry) =>
      entry.path.endsWith("/git-receive-pack"),
    ).length;
    fixture.git.disconnectAfterNextAcceptedPush();
    const pushed = await client.git(["push", "origin", "HEAD:refs/heads/uncertain-feature"], {
      cwd: checkout,
      allowFailure: true,
    });
    assert.notEqual(pushed.code, 0);
    assert.equal(await fixture.git.ref("refs/heads/uncertain-feature"), head);
    assert.equal(
      fixture.git.trace.filter((entry) => entry.path.endsWith("/git-receive-pack")).length,
      before + 1,
    );
  });
}

if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("native Git clone respects a separate upload-pack response limit", async (t) => {
    const { randomBytes } = await import("node:crypto");
    const { temporaryDirectory } = await import("../fixtures/repository-credentials/process.mjs");
    const { runPinnedClients } = await import("../fixtures/repository-credentials/clients.mjs");
    const seed = join(await temporaryDirectory(t, "git-large-seed-"), "seed");
    await run("git", ["init", "--initial-branch=main", seed]);
    await run("git", ["config", "user.name", "Fixture"], { cwd: seed });
    await run("git", ["config", "user.email", "fixture@example.test"], { cwd: seed });
    await writeFile(join(seed, "data.bin"), randomBytes(128 * 1024));
    await run("git", ["add", "data.bin"], { cwd: seed });
    await run("git", ["commit", "-m", "Add fixture data"], { cwd: seed });
    for (const limited of [false, true]) {
      await t.test(
        limited ? "rejects a pack above its configured cap" : "streams beyond the ordinary Git cap",
        async (t) => {
          const fixture = await startCredentialServiceFixture(t, {
            limits: limited
              ? { gitFetchResponseBytes: 4096 }
              : { gitResponseBytes: 4096, gitFetchResponseBytes: 200000 },
            profile: "git-read",
          });
          await run("git", ["push", fixture.git.bare, "HEAD:refs/heads/large-fixture"], {
            cwd: seed,
          });
          await run("git", ["symbolic-ref", "HEAD", "refs/heads/large-fixture"], {
            cwd: fixture.git.bare,
          });
          const client = await runPinnedClients(t, fixture);
          const checkout = join(client.directory, "checkout");
          const clone = await client.git(["clone", fixture.opened.client.gitRemote, checkout], {
            allowFailure: limited,
          });
          if (limited) {
            assert.notEqual(clone.code, 0);
          } else {
            assert.equal(
              (await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
              await fixture.git.ref("refs/heads/large-fixture"),
            );
            await run("git", ["fsck", "--full"], { cwd: checkout });
          }
          assert.ok(fixture.git.trace.some((entry) => entry.path.endsWith("/git-upload-pack")));
        },
      );
    }
  });
}

if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("native Git clone survives a quiet upload-pack response and session closure still cancels it", async (t) => {
    const { runPinnedClients } = await import("../fixtures/repository-credentials/clients.mjs");
    const fixture = await startCredentialServiceFixture(t, {
      profile: "git-read",
      limits: { gitFetchStallMs: 8000, gitFetchFirstHeaderMs: 20000 },
    });
    const client = await runPinnedClients(t, fixture);
    const hold = fixture.git.holdNextFetch();
    t.after(hold.release);
    const clone = client.git([
      "clone",
      fixture.opened.client.gitRemote,
      join(client.directory, "quiet"),
    ]);
    await hold.observed;
    // Wait until the upstream header deadline has been replaced by the response
    // stall watchdog; the old route arms 5 seconds, the configured route 8.
    await eventually(() => {
      const deadlines = fixture.clock.deadlines();
      return (
        (deadlines.includes(5000) || deadlines.includes(8000)) &&
        !deadlines.includes(20000) &&
        !deadlines.includes(30000)
      );
    });
    await fixture.clock.advance(6000);
    hold.release();
    await clone;

    const cancelled = fixture.git.holdNextFetch();
    t.after(cancelled.release);
    const interrupted = client.git(
      ["clone", fixture.opened.client.gitRemote, join(client.directory, "closed")],
      { allowFailure: true },
    );
    await cancelled.observed;
    fixture.service.close(fixture.opened.session.sessionId);
    assert.notEqual((await interrupted).code, 0);
    cancelled.release();
  });
}

if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("native Git clone can wait for upload-pack response headers", async (t) => {
    const { runPinnedClients } = await import("../fixtures/repository-credentials/clients.mjs");
    const fixture = await startCredentialServiceFixture(t, {
      profile: "git-read",
      limits: { gitFetchFirstHeaderMs: 40000 },
    });
    const client = await runPinnedClients(t, fixture);
    const hold = fixture.git.holdNextFetch({ beforeHeaders: true });
    t.after(hold.release);
    const clone = client.git([
      "clone",
      fixture.opened.client.gitRemote,
      join(client.directory, "headers"),
    ]);
    await hold.observed;
    await eventually(() =>
      fixture.clock.deadlines().some((deadline) => deadline === 30000 || deadline === 40000),
    );
    await fixture.clock.advance(31000);
    hold.release();
    await clone;
    assert.ok(fixture.git.trace.some((entry) => entry.path.endsWith("/git-upload-pack")));
  });
}

if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("native Git fails when a held upload-pack exceeds its configured timeout", async (t) => {
    const { runPinnedClients } = await import("../fixtures/repository-credentials/clients.mjs");
    for (const beforeHeaders of [true, false]) {
      await t.test(beforeHeaders ? "response headers" : "response progress", async (t) => {
        const fixture = await startCredentialServiceFixture(t, { profile: "git-read" });
        const client = await runPinnedClients(t, fixture);
        const hold = fixture.git.holdNextFetch({ beforeHeaders });
        t.after(hold.release);
        const clone = client.git(
          ["clone", fixture.opened.client.gitRemote, join(client.directory, "timeout")],
          { allowFailure: true },
        );
        await hold.observed;
        const timeout = beforeHeaders ? 30000 : 5000;
        await eventually(() => fixture.clock.deadlines().includes(timeout));
        await fixture.clock.advance(timeout + 1);
        // Git must fail while the fixture still holds the response.
        assert.notEqual((await clone).code, 0);
        hold.release();
      });
    }
  });
}
