import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNativeClientMaterial,
  runPinnedClients,
} from "../fixtures/repository-credentials/clients.mjs";
import { appRoot, appExtension, appModule } from "../fixtures/repository-credentials/runtime.mjs";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.mjs";
import {
  startCredentialServiceFixture,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { exerciseGit, exerciseGh } from "../fixtures/repository-credentials/workflows.mjs";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.mjs";

test("pinned gh uses canonical GitHub identity for repository, issue and pull-request commands", async (t) => {
  if (await runInFixtureContainer(t, "tests/integration/repository-credentials-gh.test.mjs")) {
    return;
  }
  const fixture = await startCredentialServiceFixture(t);
  const singleHostsPath = join(fixture.clientDirectory, "gh", "hosts.yml");
  const originalSingleHosts = await readFile(singleHostsPath);
  const { client, checkout } = await exerciseGit(t, fixture);
  await client.git(["push", "origin", "HEAD:refs/heads/native-feature"], { cwd: checkout });
  const { issue } = await exerciseGh(t, fixture, client);
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
  const trace = join(client.directory, "native-child-git.jsonl");
  await writeFile(
    join(client.directory, ".gitconfig"),
    `[include]\n\tpath = ${join(materialRoot, "gitconfig")}\n[trace2]\n\teventTarget = ${trace}\n`,
  );
  await client.git(["push", "origin", "HEAD:refs/heads/router-feature"], { cwd: checkout });
  await rm(trace, { force: true });
  const router = join(appRoot, `drivers/repo/github/credentials/client/router.${appExtension}`);
  const routed = await run(
    process.execPath,
    [
      router,
      "gh",
      "pr",
      "create",
      "-R",
      "fixture/repository",
      "--head",
      "router-feature",
      "--base",
      "main",
      "--title",
      "Routed native child",
      "--body",
      "Selected gateway session",
    ],
    {
      cwd: checkout,
      env: cleanEnvironment({
        HOME: client.directory,
        GH_TOKEN: "ambient-token-marker",
        GIT_CONFIG_SYSTEM: "/dev/null",
        OCE_REPOSITORY_REF: "fixture",
      }),
      allowFailure: true,
    },
  );
  assert.equal(routed.code, 0, routed.stderr);
  assert.equal(routed.stderr.includes("ambient-token-marker"), false);
  const events = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    events.some((event) => event.event === "start" && /(?:^|\/)git$/.test(event.argv[0])),
    "gh must execute real native Git with the normal user configuration",
  );
  assert.ok(
    [...fixture.github.pulls.values()].some((pull) => pull.title === "Routed native child"),
  );
  const routedGh = async (args) => {
    const result = await run(process.execPath, [router, "gh", ...args], {
      cwd: checkout,
      env: cleanEnvironment({ HOME: client.directory, OCE_REPOSITORY_REF: "fixture" }),
      allowFailure: true,
    });
    assert.equal(result.code, 0, `gh ${args.slice(0, 2).join(" ")}: ${result.stderr}`);
    return result;
  };
  const pull = [...fixture.github.pulls.values()].find(
    (value) => value.title === "Routed native child",
  );
  // Exercise actual pinned gh commands, including their GraphQL requests and
  // raw REST response media, through the same router delivered to Agents.
  const repository = JSON.parse(
    (await routedGh(["repo", "view", "FiXtUrE/RePoSiToRy", "--json", "nameWithOwner"])).stdout,
  );
  assert.equal(repository.nameWithOwner, "fixture/repository");
  const overview = await routedGh(["repo", "view"]);
  assert.match(overview.stdout, /fixture\/repository/);
  assert.match(overview.stdout, /Fixture README/);
  for (const [kind, resource] of [
    ["issue", fixture.github.issues.get(issue.number)],
    ["pr", pull],
  ]) {
    const listed = JSON.parse(
      (await routedGh([kind, "list", "--state", "all", "--limit", "101", "--json", "number,title"]))
        .stdout,
    );
    assert.ok(listed.some(({ number }) => number === resource.number));
    const viewed = JSON.parse(
      (await routedGh([kind, "view", String(resource.number), "--json", "number,title"])).stdout,
    );
    assert.equal(viewed.number, resource.number);
    assert.equal(viewed.title, resource.title);
    assert.match((await routedGh([kind, "view", String(resource.number)])).stdout, /title:/);
    const body = `Native ${kind} comment`;
    await routedGh([kind, "comment", String(resource.number), "--body", body]);
    assert.ok([...fixture.github.comments.values()].some((comment) => comment.body === body));
    assert.match(
      (await routedGh([kind, "view", String(resource.number), "--comments"])).stdout,
      new RegExp(body),
    );
  }
  const created = await routedGh([
    "issue",
    "create",
    "--title",
    "Native issue",
    "--body",
    "Created by pinned gh",
  ]);
  assert.match(created.stdout, /https:\/\/github\.com\/fixture\/repository\/issues\/\d+/);
  assert.ok([...fixture.github.issues.values()].some((value) => value.title === "Native issue"));
  const checks = JSON.parse(
    (await routedGh(["pr", "checks", String(pull.number), "--json", "name,state"])).stdout,
  );
  assert.ok(checks.some(({ name, state }) => name === "fixture-check" && state === "SUCCESS"));
  assert.match(
    (await routedGh(["pr", "checks", String(pull.number), "--required"])).stdout,
    /fixture-check/,
  );
  for (const flags of [[], ["--patch"], ["--name-only"]]) {
    const diff = await routedGh(["pr", "diff", String(pull.number), ...flags]);
    assert.match(diff.stdout, /README\.md/);
  }
  assert.ok(
    fixture.github.trace.some(
      ({ target, accept }) =>
        target === `/repos/fixture/repository/pulls/${pull.number}` && /diff/.test(accept ?? ""),
    ),
  );
  assert.ok(
    fixture.github.trace.some(
      ({ target, accept }) =>
        target === `/repos/fixture/repository/pulls/${pull.number}` && /patch/.test(accept ?? ""),
    ),
  );
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
  test("native gh reads and writes follow each selected access level", async (t) => {
    for (const profile of ["git-read", "git-write", "git-full"]) {
      await t.test(profile, async (t) => {
        const fixture = await startCredentialServiceFixture(t, { profile });
        const client = await runPinnedClients(t, fixture);
        // These provider-owned records predate the selected Agent session.
        // The real client must read them before attempting its own mutations.
        const issue = {
          id: 50,
          node_id: "I_50",
          number: 50,
          title: "Existing issue",
          body: "",
          state: "open",
          html_url: "https://github.com/fixture/repository/issues/50",
        };
        const pull = {
          id: 51,
          node_id: "PR_51",
          number: 51,
          title: "Existing pull",
          body: "",
          state: "open",
          html_url: "https://github.com/fixture/repository/pull/51",
          head: { ref: "existing-branch" },
          base: { ref: "main" },
        };
        fixture.github.issues.set(issue.number, issue);
        fixture.github.pulls.set(pull.number, pull);
        for (const [kind, resource] of [
          ["issue", issue],
          ["pr", pull],
        ]) {
          const read = JSON.parse(
            (await client.gh([kind, "view", String(resource.number), "--json", "number,title"]))
              .stdout,
          );
          assert.equal(read.title, resource.title);
          const commented = await client.gh(
            [kind, "comment", String(resource.number), "--body", `${profile} ${kind} comment`],
            { allowFailure: true },
          );
          const writable = profile === "git-full" || (kind === "pr" && profile === "git-write");
          assert.equal(
            commented.code === 0,
            writable,
            `${profile} ${kind} comment: ${commented.stderr}`,
          );
          if (!writable) {
            assert.match(commented.stderr, /Resource not accessible by integration/);
          }
          assert.equal(
            [...fixture.github.comments.values()].some(
              ({ body }) => body === `${profile} ${kind} comment`,
            ),
            writable,
          );
        }
        const created = await client.gh(
          ["issue", "create", "--title", "New issue", "--body", "Native creation"],
          { allowFailure: true },
        );
        assert.equal(created.code === 0, profile === "git-full", created.stderr);
        if (profile !== "git-full") {
          assert.match(created.stderr, /Resource not accessible by integration/);
        }
        assert.equal(
          [...fixture.github.issues.values()].some(({ title }) => title === "New issue"),
          profile === "git-full",
        );
        const checked = await client.gh(["pr", "checks", "51", "--json", "name,state"], {
          allowFailure: true,
        });
        assert.equal(checked.code, 0, checked.stderr);
        const checks = JSON.parse(checked.stdout);
        assert.ok(checks.some(({ name }) => name === "fixture-check"));
        assert.match((await client.gh(["pr", "diff", "51"])).stdout, /README\.md/);
        assert.equal(fixture.github.errors.length, 0);
      });
    }
  });

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
