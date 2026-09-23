import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { runPinnedClients } from "../fixtures/repository-credentials/clients.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { run } from "../fixtures/repository-credentials/process.mjs";
import {
  gatewayRequest,
  startCredentialServiceFixture,
} from "../fixtures/repository-credentials/service.mjs";

// Passing path separately preserves escapes and dot segments for the real listener.
// This client sends no invented Git wire body; stock Git owns every allowed RPC.
function rawRequest(fixture, path, { method = "GET", headers = {} } = {}) {
  const origin = new URL(fixture.config.gateway.publicOrigin);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: origin.hostname,
        port: origin.port,
        path,
        method,
        ca: fixture.tls.ca,
        headers,
        agent: false,
      },
      (incoming) => {
        incoming.resume();
        incoming.once("end", () =>
          resolve({ status: incoming.statusCode, headers: incoming.headers }),
        );
        incoming.once("error", reject);
      },
    );
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error("fixture request timeout")));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function gitAuthorization(fixture) {
  return `Basic ${Buffer.from(
    `${fixture.opened.client.gitUsername}:${fixture.opened.bearer}`,
  ).toString("base64")}`;
}

function assertCold(fixture) {
  assert.equal(fixture.github.issuesOfTokens.length, 0);
  assert.equal(fixture.github.trace.length, 0);
  assert.equal(fixture.github.authenticationAttempts.length, 0);
  assert.equal(fixture.git.trace.length, 0);
}

if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD !== "1") {
  test("native Git path composition runs in the controlled container", async (t) => {
    assert.equal(
      await runInFixtureContainer(
        t,
        "tests/integration/repository-credentials-native-paths.test.mjs",
      ),
      true,
    );
  });
} else {
  for (const suffix of ["", ".git"]) {
    const spelling = `/FiXtUrE/RePoSiToRy${suffix}`;
    test(`native Git clones, fetches and pushes through ${spelling}`, async (t) => {
      const fixture = await startCredentialServiceFixture(t, { profile: "git-write" });
      // Both unauthenticated discovery shapes must challenge before any mint or dispatch.
      for (const service of ["git-upload-pack", "git-receive-pack"]) {
        const response = await rawRequest(fixture, `${spelling}/info/refs?service=${service}`);
        assert.equal(response.status, 401);
        assert.equal(
          response.headers["www-authenticate"],
          'Basic realm="repository-credential-service"',
        );
        assert.equal(response.headers.location, undefined);
        assertCold(fixture);
      }

      const client = await runPinnedClients(t, fixture);
      const checkout = join(client.directory, "checkout");
      const remote = `https://github.com${spelling}`;
      await client.git(["clone", remote, checkout]);
      assert.equal(await readFile(join(checkout, "README.md"), "utf8"), "Controlled repository\n");
      assert.equal(
        (
          await client.git(["config", "--get", "remote.origin.url"], { cwd: checkout })
        ).stdout.trim(),
        remote,
      );
      assert.equal(
        (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
        await fixture.git.ref("refs/heads/main"),
      );

      // Change the controlled upstream locally so fetch must transfer a new object.
      const upstream = join(client.directory, "upstream-writer");
      await run("/usr/bin/git", ["clone", fixture.git.bare, upstream]);
      await run("/usr/bin/git", ["config", "user.name", "Fixture"], { cwd: upstream });
      await run("/usr/bin/git", ["config", "user.email", "fixture@example.test"], {
        cwd: upstream,
      });
      await writeFile(join(upstream, "README.md"), "Fetched through the native gateway\n");
      await run("/usr/bin/git", ["commit", "-am", "Advance controlled upstream"], {
        cwd: upstream,
      });
      await run("/usr/bin/git", ["push", "origin", "main"], { cwd: upstream });
      const beforeFetch = fixture.git.trace.length;
      await client.git(["fetch", "origin"], { cwd: checkout });
      assert.equal(
        (await client.git(["rev-parse", "origin/main"], { cwd: checkout })).stdout.trim(),
        await fixture.git.ref("refs/heads/main"),
      );
      assert.equal(
        (await client.git(["show", "origin/main:README.md"], { cwd: checkout })).stdout,
        "Fetched through the native gateway\n",
      );
      assert.ok(
        fixture.git.trace
          .slice(beforeFetch)
          .some(
            ({ method, path }) =>
              method === "POST" && path === "/fixture/repository.git/git-upload-pack",
          ),
      );
      await client.git(["merge", "--ff-only", "origin/main"], { cwd: checkout });
      await client.git(["config", "user.name", "Agent fixture"], { cwd: checkout });
      await client.git(["config", "user.email", "agent@example.test"], { cwd: checkout });
      await writeFile(join(checkout, "native-path.txt"), "Accepted native path push\n");
      await client.git(["add", "native-path.txt"], { cwd: checkout });
      await client.git(["commit", "-m", "Native path fixture"], { cwd: checkout });
      const head = (await client.git(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
      const beforePush = fixture.git.trace.length;
      await client.git(["push", "origin", "HEAD:refs/heads/native-path"], { cwd: checkout });
      assert.equal(await fixture.git.ref("refs/heads/native-path"), head);
      assert.equal(
        (
          await run("/usr/bin/git", ["show", "refs/heads/native-path:native-path.txt"], {
            cwd: fixture.git.bare,
          })
        ).stdout,
        "Accepted native path push\n",
      );
      assert.deepEqual(
        fixture.git.trace.slice(beforePush).map(({ method, path }) => ({ method, path })),
        [
          { method: "GET", path: "/fixture/repository.git/info/refs" },
          { method: "POST", path: "/fixture/repository.git/git-receive-pack" },
        ],
      );
      assert.ok(
        fixture.git.trace.every(({ path }) =>
          [
            "/fixture/repository.git/info/refs",
            "/fixture/repository.git/git-upload-pack",
            "/fixture/repository.git/git-receive-pack",
          ].includes(path),
        ),
      );
      assert.equal(fixture.github.issuesOfTokens.length, 1);
      assert.deepEqual(fixture.github.issuesOfTokens[0].permissions, {
        metadata: "read",
        contents: "write",
        issues: "read",
        pull_requests: "write",
        checks: "read",
        statuses: "read",
      });
    });

    test(`cold git-read denies receive-pack through ${spelling}`, async (t) => {
      const fixture = await startCredentialServiceFixture(t, { profile: "git-read" });
      const authorization = gitAuthorization(fixture);
      const refs = () =>
        run("/usr/bin/git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
          cwd: fixture.git.bare,
        });
      const before = (await refs()).stdout;
      for (const [path, options] of [
        [`${spelling}/info/refs?service=git-receive-pack`, {}],
        [
          `${spelling}/git-receive-pack`,
          {
            method: "POST",
            headers: { "content-type": "application/x-git-receive-pack-request" },
          },
        ],
      ]) {
        const response = await rawRequest(fixture, path, {
          ...options,
          headers: { ...options.headers, authorization },
        });
        assert.equal(response.status, 400);
        assert.equal(response.headers.location, undefined);
        assertCold(fixture);
        assert.equal((await refs()).stdout, before);
      }
    });
  }

  test("native path normalization preserves raw-target denials and exact API routes", async (t) => {
    const fixture = await startCredentialServiceFixture(t, { profile: "git-full" });
    const authorization = `Bearer ${fixture.opened.bearer}`;
    // Non-Git shapes use the API authentication scheme; the real planner must still deny them.
    for (const [path, options] of [
      ["/FiXtUrE/%52ePoSiToRy/info/refs?service=git-upload-pack", {}],
      ["/FiXtUrE/../fixture/repository/info/refs?service=git-upload-pack", {}],
      ["/prefix/FiXtUrE/RePoSiToRy/info/refs?service=git-upload-pack", {}],
      ["/FiXtUrE/RePoSiToRy/info/refs?service=git-upload-pack&service=git-upload-pack", {}],
      ["/FiXtUrE/RePoSiToRy/info/refs?service=git-upload-pack", { method: "POST" }],
      ["/FiXtUrE/RePoSiToRy/git-upload-pack", { method: "GET" }],
      [
        "/FiXtUrE/RePoSiToRy/git-upload-pack",
        { method: "POST", headers: { "content-type": "application/json" } },
      ],
      ["/repos/FiXtUrE/RePoSiToRy", {}],
      ["/repos/fixture/repository.git", {}],
    ]) {
      const response = await rawRequest(fixture, path, {
        ...options,
        headers: { ...options.headers, authorization },
      });
      assert.equal(response.status, 400, path);
      assertCold(fixture);
    }
    const metadata = await gatewayRequest(fixture, "/repos/fixture/repository");
    assert.equal(metadata.status, 200);
    assert.equal(JSON.parse(metadata.body).full_name, "fixture/repository");
    assert.ok(fixture.github.trace.some(({ target }) => target === "/repos/fixture/repository"));
    assert.equal(fixture.github.issuesOfTokens.length, 1);
    assert.equal(fixture.git.trace.length, 0);
  });
}
