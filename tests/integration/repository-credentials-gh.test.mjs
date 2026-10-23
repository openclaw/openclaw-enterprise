import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { appRoot, appExtension, appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import {
  startCredentialServiceFixture,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { exerciseGit, exerciseGh } from "../fixtures/repository-credentials/workflows.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";
import { registerResourceCleanup } from "../fixtures/repository-credentials/cleanup.mjs";

test("pinned gh uses selected development token routing for repository, issue and pull-request REST commands", async (t) => {
  // The production launcher requires installed hooks for a push-policy session.
  if (
    await runInFixtureContainer(t, "tests/integration/repository-credentials-gh.test.mjs", {
      packaged: true,
    })
  ) {
    return;
  }
  const fixture = await startCredentialServiceFixture(t, {
    configuration: { pushRefAllowlist: ["refs/heads/agent-feature", "refs/heads/native-feature"] },
  });
  const singleHostsPath = join(fixture.clientDirectory, "gh", "hosts.yml");
  const originalSingleHosts = await readFile(singleHostsPath);
  const { client, checkout } = await exerciseGit(t, fixture);
  await client.git(["push", "origin", "HEAD:refs/heads/native-feature"], { cwd: checkout });
  const { issue } = await exerciseGh(fixture, client);
  // GitHub returns repository-ID links, and issue collections also carry opaque cursors.
  // The actual CLI must follow those links through the canonical gateway route.
  const issueInput = await client.json("pagination-issue.json", { title: "Second issue" });
  const secondIssue = JSON.parse(
    (
      await client.gh([
        "api",
        "--method",
        "POST",
        "repos/fixture/repository/issues",
        "--input",
        issueInput,
      ])
    ).stdout,
  );
  const pages = JSON.parse(
    (
      await client.gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/fixture/repository/issues?state=all&per_page=1",
      ])
    ).stdout,
  );
  assert.deepEqual(
    pages.map((page) => page.map(({ number }) => number)),
    [[issue.number], [secondIssue.number]],
  );
  assert.ok(
    fixture.github.trace.some((entry) => {
      const target = new URL(entry.target, "https://api.github.com");
      return (
        target.pathname === "/repos/fixture/repository/issues" && target.searchParams.has("after")
      );
    }),
  );
  assert.equal(
    fixture.github.trace.some((entry) => entry.target.startsWith("/repositories/")),
    false,
  );
  assert.ok(
    fixture.github.trace.filter((entry) => entry.tokenIndex).every((entry) => entry.userAgent),
  );
  // The controlled provider accepts the actual gh write and loses its reply.
  // Reconcile the exact marker through the same admitted session without replaying creation.
  const marker = "<!-- regression-run:gh-uncertain -->";
  const pullPath = "repos/fixture/repository/pulls";
  const cleanups = [];
  registerResourceCleanup(cleanups, {
    request: async ({ method, path, body }) => {
      const response = await gatewayRequest(fixture, `/${path}`, { method, body });
      assert.ok(response.status < 400);
      return response.body ? JSON.parse(response.body) : undefined;
    },
    repository: "fixture/repository",
    kind: "pulls",
    marker,
    head: "native-feature",
  });
  const uncertainInput = await client.json("uncertain-pull.json", {
    title: "Uncertain pull request",
    body: marker,
    base: "main",
    head: "native-feature",
    draft: true,
  });
  const beforeUncertain = fixture.github.trace.length;
  fixture.github.disconnectAfterMutation("POST", `/${pullPath}`);
  const uncertain = await client.gh(
    ["api", "--method", "POST", pullPath, "--input", uncertainInput],
    { allowFailure: true },
  );
  assert.notEqual(uncertain.code, 0);
  assert.ok(/HTTP 502/.test(uncertain.stderr), "gh must report the lost response status");
  assert.ok(
    /exchange-uncertain/.test(uncertain.stdout + uncertain.stderr),
    "gh must report the uncertain exchange",
  );
  const writes = fixture.github.trace
    .slice(beforeUncertain)
    .filter((entry) => entry.method === "POST" && entry.target === `/${pullPath}`);
  assert.equal(writes.length, 1, "gh must not replay an uncertain pull-request creation");
  assert.ok(writes[0].tokenIndex, "the controlled provider must authenticate the write");
  const accepted = [...fixture.github.pulls.values()].filter((pull) => pull.body === marker);
  assert.equal(accepted.length, 1, "the provider must accept the marked pull request once");
  assert.equal(accepted[0].draft, true);
  await cleanups[0](AbortSignal.timeout(5000));
  assert.equal(fixture.github.pulls.get(accepted[0].number).state, "closed");
  // All fixed runtime paths below live only inside the disposable fixture
  // container. Private HOME configuration proves real child Git is preserved;
  // image-owned system include qualification belongs to the platform tests.
  assert.equal(process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD, "1");
  const materialRoot = "/run/oce/repository-credentials";
  await mkdir(materialRoot, { recursive: true, mode: 0o700 });
  t.after(() => rm(materialRoot, { recursive: true, force: true }));
  const material = await createNativeClientMaterial(
    t,
    [{ opened: fixture.opened, repositoryRef: "fixture" }],
    { root: materialRoot, ca: fixture.tls.ca },
  );
  const hostsPath = join(material.manifest.bindings[0].directory, "gh", "hosts.yml");
  const originalHosts = await readFile(hostsPath, "utf8");
  const mismatchedHosts = originalHosts.replace(fixture.opened.bearer, "x".repeat(48));
  assert.ok(mismatchedHosts !== originalHosts, "fixture bearer must appear in gh material");
  const { routeRepositoryClient } = await appModule(
    "drivers/repo/github/credentials/client/router",
  );
  const spawn = childProcess.spawn;
  const spawnSync = childProcess.spawnSync;
  const now = Date.now;
  let attempts = 0;
  try {
    childProcess.spawn = childProcess.spawnSync = () => {
      attempts += 1;
      throw new Error("unexpected-client-child");
    };
    syncBuiltinESMExports();
    await writeFile(hostsPath, mismatchedHosts);
    await assert.rejects(
      routeRepositoryClient("gh", ["api", "repos/fixture/repository"]),
      /invalid-client-gh-material/,
    );
    assert.equal(attempts, 0);
    await writeFile(hostsPath, originalHosts);
    const deadline = material.manifest.bindings[0].deadlineWallMs;
    let checks = 0;
    Date.now = () => (checks++ === 0 ? deadline - 1 : deadline);
    await assert.rejects(
      routeRepositoryClient("gh", ["api", "repos/fixture/repository"]),
      /repository-session-expired/,
    );
    assert.equal(checks, 2);
    assert.equal(attempts, 0);
  } finally {
    Date.now = now;
    childProcess.spawn = spawn;
    childProcess.spawnSync = spawnSync;
    syncBuiltinESMExports();
    await writeFile(hostsPath, originalHosts);
  }
  const router = join(appRoot, `drivers/repo/github/credentials/client/router.${appExtension}`);
  const pullInput = await client.json("routed-pull.json", {
    title: "Routed pull request",
    head: "native-feature",
    base: "main",
    body: "Selected gateway session",
  });
  const routed = await run(
    process.execPath,
    [
      router,
      "gh",
      "api",
      "--method",
      "POST",
      "repos/fixture/repository/pulls",
      "--input",
      pullInput,
    ],
    {
      cwd: checkout,
      env: cleanEnvironment({
        HOME: client.directory,
        GH_TOKEN: "ambient-token-marker",
        OCE_REPOSITORY_REF: "fixture",
      }),
      allowFailure: true,
    },
  );
  assert.equal(routed.code, 0, routed.stderr);
  assert.equal(routed.stderr.includes("ambient-token-marker"), false);
  const pull = JSON.parse(routed.stdout);
  assert.equal(fixture.github.pulls.get(pull.number).title, "Routed pull request");
  const routedGh = async (args) => {
    const result = await run(process.execPath, [router, "gh", ...args], {
      cwd: checkout,
      env: cleanEnvironment({ HOME: client.directory, OCE_REPOSITORY_REF: "fixture" }),
      allowFailure: true,
    });
    assert.equal(result.code, 0, `gh ${args.slice(0, 2).join(" ")}: ${result.stderr}`);
    return result;
  };
  const repository = JSON.parse((await routedGh(["api", "repos/fixture/repository"])).stdout);
  assert.equal(repository.full_name, "fixture/repository");
  const viewed = JSON.parse(
    (await routedGh(["api", `repos/fixture/repository/pulls/${pull.number}`])).stdout,
  );
  assert.equal(viewed.number, pull.number);
  const pinned = JSON.stringify([
    material.manifest.generation,
    "fixture",
    fixture.opened.session.sessionId,
  ]);
  const deniedPin = await run(process.execPath, [router, "gh", "api", "repos/fixture/repository"], {
    cwd: checkout,
    env: cleanEnvironment({
      HOME: client.directory,
      OCE_REPOSITORY_SELECTION: pinned,
      OCE_REPOSITORY_REF: "other",
    }),
    allowFailure: true,
  });
  assert.notEqual(deniedPin.code, 0);
  assert.equal(deniedPin.stdout, "");
  const before = fixture.github.trace.length;
  for (const target of [
    "/user",
    "/repos/other/repository",
    "/fixture/other.git/info/refs?service=git-upload-pack",
    "/repos/fixture/repository/actions/runs",
    "/repositories/73/issues",
  ]) {
    const denied = await gatewayRequest(fixture, target);
    assert.ok(denied.status >= 400);
  }
  assert.equal(fixture.github.trace.length, before);
  assert.ok(
    (await readFile(singleHostsPath)).equals(originalSingleHosts),
    "repeated single-session gh operations must retain the generated material",
  );
  assert.ok(
    (await readFile(hostsPath)).equals(Buffer.from(originalHosts)),
    "repeated routed gh operations must retain the generated material",
  );
});

// The host case runs this entire file in the container, including this fault case.
if (process.env.REPOSITORY_CREDENTIALS_CONTAINER_CHILD === "1") {
  test("uncertain API POST, PATCH and DELETE requests are sent once", async (t) => {
    const fixture = await startCredentialServiceFixture(t);
    const prefix = "/repos/fixture/repository";
    const issued = await gatewayRequest(fixture, `${prefix}/issues`, {
      method: "POST",
      body: { title: "Replay fixture" },
    });
    const issue = JSON.parse(issued.body);
    const commented = await gatewayRequest(fixture, `${prefix}/issues/${issue.number}/comments`, {
      method: "POST",
      body: { body: "Replay fixture" },
    });
    const comment = JSON.parse(commented.body);
    for (const [method, target, body] of [
      ["POST", `${prefix}/issues`, { title: "Accepted once" }],
      ["PATCH", `${prefix}/issues/${issue.number}`, { title: "Updated once" }],
      ["DELETE", `${prefix}/issues/comments/${comment.id}`, undefined],
    ]) {
      const count = () =>
        fixture.github.trace.filter((entry) => entry.method === method && entry.target === target)
          .length;
      const before = count();
      fixture.github.disconnectAfterMutation(method, target);
      try {
        const response = await gatewayRequest(fixture, target, { method, body });
        assert.ok(response.status >= 400);
      } catch (error) {
        assert.match(error.code ?? error.message, /ECONNRESET|aborted|socket hang up/);
      }
      assert.equal(count(), before + 1);
    }
  });
}
