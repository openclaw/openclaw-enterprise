import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appFunction } from "../fixtures/repository-credentials/app-functions.ts";
import { exerciseLiveWorkflow } from "../fixtures/repository-credentials/live-workflow.ts";
import type { SessionStatus } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { JsonValue } from "../../apps/controller/src/drivers/repo/access/json-value.ts";
import {
  createNativeClientMaterial,
  loadRepositoryClientModule,
} from "../fixtures/repository-credentials/clients.ts";
import { appRoot, appExtension } from "../fixtures/repository-credentials/runtime.ts";
import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.ts";
import {
  startCredentialServiceFixture,
  gatewayRequest,
} from "../fixtures/repository-credentials/service-fixture.ts";
import { exerciseGit, exerciseGh } from "../fixtures/repository-credentials/workflows.ts";
import { runInFixtureContainer } from "../fixtures/repository-credentials/container.ts";
import {
  registerResourceCleanup,
  type ResourceCleanup,
} from "../fixtures/repository-credentials/cleanup.ts";

function jsonObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return jsonObject(value);
}

test("pinned gh uses selected development token routing for repository, issue and pull-request REST commands", async (t) => {
  // The production launcher requires installed hooks for a push-policy session.
  if (
    await runInFixtureContainer(t, "tests/integration/repository-credentials-gh.test.ts", {
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
  const issueNumber = await exerciseGh(fixture, client);
  // GitHub returns repository-ID links, and issue collections also carry opaque cursors.
  // The actual CLI must follow those links through the canonical gateway route.
  const issueInput = await client.json("pagination-issue.json", { title: "Second issue" });
  const secondIssue = parseJsonObject(
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
  const secondIssueNumber = secondIssue.number;
  assert.ok(typeof secondIssueNumber === "number" && Number.isSafeInteger(secondIssueNumber));
  const pages: unknown = JSON.parse(
    (
      await client.gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/fixture/repository/issues?state=all&per_page=1",
      ])
    ).stdout,
  );
  assert.ok(Array.isArray(pages));
  assert.deepEqual(
    pages.map((page: unknown) => {
      assert.ok(Array.isArray(page));
      return page.map((entry: unknown) => jsonObject(entry).number);
    }),
    [[issueNumber], [secondIssueNumber]],
  );
  assert.ok(
    fixture.github.trace.some((entry) => {
      assert.ok(entry.target);
      const target = new URL(entry.target, "https://api.github.com");
      return (
        target.pathname === "/repos/fixture/repository/issues" && target.searchParams.has("after")
      );
    }),
  );
  assert.equal(
    fixture.github.trace.some((entry) => entry.target?.startsWith("/repositories/")),
    false,
  );
  assert.ok(
    fixture.github.trace.filter((entry) => entry.tokenIndex).every((entry) => entry.userAgent),
  );
  // The controlled provider accepts the actual gh write and loses its reply.
  // Reconcile the exact marker through the same admitted session without replaying creation.
  const marker = "<!-- regression-run:gh-uncertain -->";
  const pullPath = "repos/fixture/repository/pulls";
  const cleanups: ResourceCleanup[] = [];
  registerResourceCleanup(cleanups, {
    request: async ({ method, path, body }) => {
      const response = await gatewayRequest(fixture, `/${path}`, { method, body });
      assert.ok(response.status !== undefined && response.status < 400);
      if (!response.body) {
        return undefined;
      }
      const data: unknown = JSON.parse(response.body);
      return data;
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
  assert.ok(writes[0]?.tokenIndex, "the controlled provider must authenticate the write");
  const pulls = fixture.github.pulls;
  const accepted = [...pulls].filter(([, pull]) => pull.body === marker);
  assert.equal(accepted.length, 1, "the provider must accept the marked pull request once");
  const acceptedPull = accepted[0];
  assert.ok(acceptedPull);
  const [pullNumber, storedPull] = acceptedPull;
  assert.equal(storedPull.draft, true);
  assert.ok(cleanups[0]);
  await cleanups[0](AbortSignal.timeout(5000));
  assert.equal(pulls.get(pullNumber)?.state, "closed");
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
  const binding = material.manifest.bindings[0];
  assert.ok(binding);
  const hostsPath = join(binding.directory, "gh", "hosts.yml");
  const originalHosts = await readFile(hostsPath, "utf8");
  const mismatchedHosts = originalHosts.replace(fixture.opened.bearer, "x".repeat(48));
  assert.ok(mismatchedHosts !== originalHosts, "fixture bearer must appear in gh material");
  const { routeRepositoryClient } = await loadRepositoryClientModule<
    typeof import("../../apps/controller/src/drivers/repo/github/access/client/router.ts")
  >("router", ["routeRepositoryClient"]);
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
    const deadline = binding.deadlineWallMs;
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
  const router = join(appRoot, `drivers/repo/github/access/client/router.${appExtension}`);
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
  const pull = parseJsonObject(routed.stdout);
  assert.ok(typeof pull.number === "number");
  assert.equal(pulls.get(pull.number)?.title, "Routed pull request");
  const routedGh = async (args: string[]) => {
    const result = await run(process.execPath, [router, "gh", ...args], {
      cwd: checkout,
      env: cleanEnvironment({ HOME: client.directory, OCE_REPOSITORY_REF: "fixture" }),
      allowFailure: true,
    });
    assert.equal(result.code, 0, `gh ${args.slice(0, 2).join(" ")}: ${result.stderr}`);
    return result;
  };
  const repository = parseJsonObject((await routedGh(["api", "repos/fixture/repository"])).stdout);
  assert.equal(repository.full_name, "fixture/repository");
  const viewed = parseJsonObject(
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
    assert.ok(denied.status !== undefined && denied.status >= 400);
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
  for (const loseCommentReply of [false, true]) {
    test(
      loseCommentReply
        ? "the shared smoke workflow cleans up after losing an accepted comment reply"
        : "the shared smoke workflow cleans up after stock Git and gh succeed",
      async (t) => {
        // The operator stamps admissions with wall time, so the real socket
        // and the operator must share the system clock for this case.
        const createSystemClock = await appFunction(
          "drivers/repo/access/clock",
          "createSystemClock",
        );
        const fixture = await startCredentialServiceFixture(t, {
          clock: createSystemClock(),
          configuration: { pushRefAllowlist: ["refs/heads/credential-smoke/*"] },
        });
        const prefix = "/repos/fixture/repository";
        const keepRef = "refs/heads/credential-smoke/unrelated";
        const bare = { cwd: fixture.git.bare };
        const git = (args: string[]) => run("/usr/bin/git", args, bare);
        const main = await fixture.git.ref("refs/heads/main");
        await git(["update-ref", keepRef, main]);
        // The receiving Git repository records committed ref transitions, even
        // when cleanup deletes the pushed ref before the test can read it.
        const auditPath = join(fixture.git.bare, "ref-transactions");
        await writeFile(
          join(fixture.git.bare, "hooks", "reference-transaction"),
          '#!/bin/sh\nif [ "$1" = committed ]; then cat >> ref-transactions; fi\n',
          { mode: 0o755 },
        );

        const unrelatedIssue = await gatewayRequest(fixture, `${prefix}/issues`, {
          method: "POST",
          body: { title: "Unrelated issue", body: "Retain this issue" },
        });
        assert.equal(unrelatedIssue.status, 201);
        const issueNumber = parseJsonObject(unrelatedIssue.body).number;
        assert.equal(typeof issueNumber, "number");
        const unrelatedComment = await gatewayRequest(
          fixture,
          `${prefix}/issues/${issueNumber}/comments`,
          { method: "POST", body: { body: "Retain this comment" } },
        );
        assert.equal(unrelatedComment.status, 201);
        const unrelatedPull = await gatewayRequest(fixture, `${prefix}/pulls`, {
          method: "POST",
          body: {
            title: "Unrelated pull",
            body: "Retain this pull",
            base: "main",
            head: "existing-branch",
          },
        });
        assert.equal(unrelatedPull.status, 201);
        const priorIssues = [...fixture.github.issues.entries()].map((entry) =>
          structuredClone(entry),
        );
        const priorPulls = [...fixture.github.pulls.entries()].map((entry) =>
          structuredClone(entry),
        );
        const priorComments = [...fixture.github.comments.entries()].map((entry) =>
          structuredClone(entry),
        );
        const traceStart = fixture.github.trace.length;
        const disposed: SessionStatus[] = [];
        t.after(fixture.service.observeDisposal((status) => disposed.push(status)));
        if (loseCommentReply) {
          // All earlier writes complete. The provider records the comment and
          // then disconnects, leaving the workflow without a comment ID.
          fixture.github.disconnectAfterMutation(
            "POST",
            /^\/repos\/fixture\/repository\/issues\/\d+\/comments$/,
          );
        }
        const work = exerciseLiveWorkflow(t, {
          socket: fixture.config.gateway.controlSocket,
          readPublicCa: () => readFile(fixture.tls.certFile),
        });
        if (loseCommentReply) {
          await assert.rejects(work, /^Error: command failed \(exit 1\)$/);
        } else {
          await work;
        }

        const transitions = (await readFile(auditPath, "utf8")).trim().split("\n");
        assert.equal(transitions.length, 2, "only the run-owned ref may be written");
        const [addition, deletion] = transitions;
        assert.ok(addition && deletion);
        const [zero, commit, ref] = addition.split(" ");
        assert.ok(commit && ref);
        assert.match(commit, /^[a-f0-9]{40}$/);
        assert.equal(zero, "0".repeat(40));
        assert.match(ref, /^refs\/heads\/credential-smoke\/[a-f0-9]{32}$/);
        assert.equal(deletion, `${commit} ${zero} ${ref}`);
        assert.equal(
          (await git(["show", "-s", "--format=%P%n%s", commit])).stdout.trim(),
          `${main}\nCredential gateway smoke`,
        );
        assert.deepEqual(
          (await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).stdout
            .trim()
            .split("\n"),
          [`${keepRef} ${main}`, `refs/heads/existing-branch ${main}`, `refs/heads/main ${main}`],
        );

        const branch = ref.slice("refs/heads/".length);
        const [pull] = [...fixture.github.pulls.values()].filter(
          (value) => value.body === `<!-- ${branch}:pull -->`,
        );
        const [issue] = [...fixture.github.issues.values()].filter(
          (value) => value.body === `<!-- ${branch}:issue -->`,
        );
        assert.ok(pull && issue);
        assert.equal(fixture.github.pulls.size, priorPulls.length + 1);
        assert.equal(fixture.github.issues.size, priorIssues.length + 1);
        assert.equal(pull.state, "closed");
        assert.equal(pull.title, "Credential gateway smoke checked");
        assert.equal(issue.state, "closed");
        assert.deepEqual([...fixture.github.comments], priorComments);
        for (const [number, value] of priorIssues) {
          assert.deepEqual(fixture.github.issues.get(number), value);
        }
        for (const [number, value] of priorPulls) {
          assert.deepEqual(fixture.github.pulls.get(number), value);
        }
        const writes = fixture.github.trace
          .slice(traceStart)
          .flatMap(({ method, target, tokenIndex }) => {
            if (method === "POST" || method === "PATCH" || method === "DELETE") {
              assert.ok(tokenIndex, "the provider must authenticate each write");
              return [`${method} ${target}`];
            }
            return [];
          });
        const [
          createdPull,
          updatedPull,
          createdIssue,
          createdComment,
          deletedComment,
          closedIssue,
          closedPull,
        ] = writes;
        assert.deepEqual(
          [createdPull, updatedPull, createdIssue, createdComment],
          [
            `POST ${prefix}/pulls`,
            `PATCH ${prefix}/pulls/${pull.number}`,
            `POST ${prefix}/issues`,
            `POST ${prefix}/issues/${issue.number}/comments`,
          ],
        );
        assert.ok(deletedComment?.startsWith(`DELETE ${prefix}/issues/comments/`));
        assert.deepEqual(
          [closedIssue, closedPull],
          [`PATCH ${prefix}/issues/${issue.number}`, `PATCH ${prefix}/pulls/${pull.number}`],
        );
        assert.equal(writes.length, 7);

        assert.equal(disposed.length, 1, "the work session must dispose before fixture shutdown");
        const [status] = disposed;
        assert.ok(status);
        assert.notEqual(status.sessionId, fixture.opened.session.sessionId);
        assert.equal(status.state, "DISPOSED");
        assert.equal(status.activeUses, 0);
        assert.equal(status.cleanup.active, 0);
        assert.equal(status.cleanup.pending, 0);
        assert.equal(status.cleanup.uncertain, 0);
        assert.equal(status.cleanup.auxiliaryPending, false);
        assert.deepEqual(fixture.github.errors, []);
      },
    );
  }

  test("uncertain API POST, PATCH and DELETE requests are sent once", async (t) => {
    const fixture = await startCredentialServiceFixture(t);
    const prefix = "/repos/fixture/repository";
    const issued = await gatewayRequest(fixture, `${prefix}/issues`, {
      method: "POST",
      body: { title: "Replay fixture" },
    });
    const issue = parseJsonObject(issued.body);
    const commented = await gatewayRequest(fixture, `${prefix}/issues/${issue.number}/comments`, {
      method: "POST",
      body: { body: "Replay fixture" },
    });
    const comment = parseJsonObject(commented.body);
    for (const [method, target, body] of [
      ["POST", `${prefix}/issues`, { title: "Accepted once" }],
      ["PATCH", `${prefix}/issues/${issue.number}`, { title: "Updated once" }],
      ["DELETE", `${prefix}/issues/comments/${comment.id}`, undefined],
    ] satisfies [string, string, JsonValue | undefined][]) {
      const count = (): number =>
        fixture.github.trace.filter((entry) => entry.method === method && entry.target === target)
          .length;
      const before = count();
      fixture.github.disconnectAfterMutation(method, target);
      try {
        const response = await gatewayRequest(fixture, target, { method, body });
        assert.ok(response.status !== undefined && response.status >= 400);
      } catch (error) {
        assert.ok(error instanceof Error);
        const code = "code" in error && typeof error.code === "string" ? error.code : error.message;
        assert.match(code, /ECONNRESET|aborted|socket hang up/);
      }
      assert.equal(count(), before + 1);
    }
  });
}
