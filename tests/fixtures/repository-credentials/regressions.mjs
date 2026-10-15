import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, temporaryDirectory } from "./process.mjs";
import { registerResourceCleanup, closeAndDispose } from "./cleanup.mjs";
import { appModule } from "./runtime.mjs";
import { startCredentialServiceFixture, gatewayRequest } from "./service.mjs";
import { runInFixtureContainer } from "./container.mjs";
import { socketDirectory } from "../../helpers/socket-directory.mjs";

async function runningProcessesMentioning(marker) {
  const running = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const commandLine = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (
        commandLine.includes(marker) &&
        !/\) Z /.test(await readFile(`/proc/${entry}/stat`, "utf8"))
      ) {
        running.push(Number(entry));
      }
    } catch (error) {
      // procfs may lose the task during lookup (ENOENT) or the read (ESRCH).
      // With hidepid, other users' entries are unreadable (EACCES/EPERM); the
      // owned command tree runs as this user, so its entries stay readable.
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) {
        throw error;
      }
    }
  }
  return running;
}

// The published PID once it is complete and its process is live, else undefined.
function liveDescendantPid(pidFile) {
  try {
    const value = readFileSync(pidFile, "utf8");
    if (!/^[1-9]\d*\n$/.test(value)) {
      return undefined;
    }
    const pid = Number(value);
    return /\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")) ? undefined : pid;
  } catch (error) {
    // Not published yet (ENOENT), or the process vanished during the read (ESRCH).
    if (error.code === "ENOENT" || error.code === "ESRCH") {
      return undefined;
    }
    throw error;
  }
}

// An owned descendant lives this long unless the command stops it. Settling in
// time is proven by its expiry marker being absent, not by a wall-clock bound.
const descendantLifetimeMs = 30000;

// Blocks this thread until the descendant is live. The command's timers cannot
// fire meanwhile, so its timeout or cancellation always lands on a started
// descendant however slowly the two Node processes start.
function holdUntilDescendantRuns(pidFile) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + descendantLifetimeMs;
  for (;;) {
    const pid = liveDescendantPid(pidFile);
    if (pid !== undefined) {
      return pid;
    }
    if (performance.now() > deadline) {
      throw new Error("descendant did not start");
    }
    Atomics.wait(pause, 0, 0, 10);
  }
}

// A SIGKILLed process can still be listed until it is scheduled to exit, so poll
// until the owned tree is gone. A leaked descendant stays until its expiry
// writes the marker, which the caller rejects.
async function ownedProcessesAfterExit(pidFile, naturalExitFile) {
  const deadline = performance.now() + 2 * descendantLifetimeMs;
  for (;;) {
    const running = await runningProcessesMentioning(pidFile);
    if (running.length === 0 || existsSync(naturalExitFile) || performance.now() > deadline) {
      return running;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function registerCredentialFixtureRegressions() {
  for (const reason of ["timeout", "output overflow", "cancelled"]) {
    test(`owned command tree stops on ${reason} without leaking diagnostics`, async (t) => {
      const directory = await temporaryDirectory(t);
      const pidFile = join(directory, "descendant.pid");
      const naturalExitFile = join(directory, "natural-exit");
      const descendant = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
      setTimeout(() => fs.writeFileSync(${JSON.stringify(naturalExitFile)}, 'expired'), ${descendantLifetimeMs});
      ${reason === "output overflow" ? "process.stdout.write('sensitive-fixture-value'.repeat(150000));" : ""}`;
      const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'});`;
      // Both carry the PID file path in their command lines. Never leave either
      // running, even when an assertion fails.
      t.after(async () => {
        for (const pid of await runningProcessesMentioning(pidFile)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // It exited after the scan.
          }
        }
      });
      const controller = new AbortController();
      // Only the case under test may stop the command: its own timeout fires long
      // after the descendant would expire, so a command that waits instead fails.
      const settled = run(process.execPath, ["-e", launcher], {
        timeout: reason === "timeout" ? 250 : 4 * descendantLifetimeMs,
        signal: controller.signal,
      });
      let startedPid;
      let readinessError;
      if (reason !== "output overflow") {
        // Overflow needs the event loop to read output; it follows the PID write.
        try {
          startedPid = holdUntilDescendantRuns(pidFile);
        } catch (error) {
          readinessError = error;
        }
      }
      if (reason === "cancelled") {
        controller.abort("sensitive-fixture-value");
      }
      await assert.rejects(
        settled,
        (error) =>
          error.message.includes(reason) && !error.message.includes("sensitive-fixture-value"),
      );
      if (readinessError) {
        throw readinessError;
      }
      // A killed orphan may await the container init's reap; a zombie cannot
      // execute or retain pipes. No running launcher or descendant may survive.
      assert.deepEqual(
        await ownedProcessesAfterExit(pidFile, naturalExitFile),
        [],
        "owned descendant remains running",
      );
      assert.equal(
        existsSync(naturalExitFile),
        false,
        "owned descendant outlived the command (waited for or leaked)",
      );
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "descendant PID must be valid");
      if (reason !== "output overflow") {
        assert.equal(pid, startedPid, `${reason} must observe the owned descendant`);
      }
    });
  }

  test("pre-registered cleanup reconciles accepted creations with lost responses without replay", async (t) => {
    if (await runInFixtureContainer(t, "tests/fixtures/repository-credentials/regressions.mjs")) {
      return;
    }
    // Reconciliation uses the same admitted session and production sender as the
    // original write, including when the provider accepted it but lost its reply.
    const serviceFixture = await startCredentialServiceFixture(t);
    const fixture = serviceFixture.github;
    const send = async ({ method, path, body }) => {
      const response = await gatewayRequest(serviceFixture, `/${path}`, { method, body });
      assert.ok(response.status < 400);
      return response.body ? JSON.parse(response.body) : undefined;
    };
    const repository = "fixture/repository";
    const prefix = `repos/${repository}`;
    const parent = await send({
      method: "POST",
      path: `${prefix}/issues`,
      body: { title: "Parent", body: "Unrelated issue" },
    });
    const other = await send({
      method: "POST",
      path: `${prefix}/pulls`,
      body: { title: "Unrelated", head: "other", base: "main", body: "Unrelated PR" },
    });
    await send({
      method: "POST",
      path: `${prefix}/issues/${parent.number}/comments`,
      body: { body: "Unrelated comment" },
    });
    const cleanups = [];
    for (const [kind, label, head] of [
      ["issues", "issue"],
      ["comment", "comment"],
      ["pulls", "rest", "unique-rest"],
      ["pulls", "native", "unique-native"],
    ]) {
      const marker = `<!-- regression-run:${label} -->`;
      registerResourceCleanup(cleanups, {
        request: send,
        repository,
        kind,
        marker,
        head,
        issueNumber: parent.number,
      });
      const path =
        label === "native"
          ? "graphql"
          : `${prefix}/${kind === "comment" ? `issues/${parent.number}/comments` : kind}`;
      const input = { title: "Owned", body: marker, base: "main", head };
      const body =
        label === "native"
          ? {
              query:
                "mutation CreatePullRequest($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id number url } } }",
              variables: {
                input: {
                  repositoryId: "R_fixture",
                  title: input.title,
                  body: marker,
                  headRefName: head,
                  baseRefName: "main",
                },
              },
            }
          : input;
      const posts = () =>
        fixture.trace.filter((entry) => entry.method === "POST" && entry.target === `/${path}`)
          .length;
      const postsBefore = posts();
      fixture.disconnectAfterMutation("POST", `/${path}`);
      // The provider accepted the write and then lost the connection, so the gateway
      // reports an uncertain exchange (not an ordinary failure) and never replays it.
      const lost = await gatewayRequest(serviceFixture, `/${path}`, { method: "POST", body });
      assert.equal(lost.status, 502, `${label} lost response status`);
      assert.deepEqual(JSON.parse(lost.body), { error: { code: "exchange-uncertain" } });
      assert.equal(posts() - postsBefore, 1, `${label} creation must dispatch exactly once`);
      const resources = kind === "comment" ? fixture.comments : fixture[kind];
      assert.equal(
        [...resources.values()].filter((resource) => resource.body === marker).length,
        1,
        `${label} creation must be accepted exactly once before fixture cleanup`,
      );
    }
    for (const action of cleanups.reverse()) {
      await action(AbortSignal.timeout(5000));
    }
    assert.equal(fixture.issues.get(parent.number).state, "open");
    assert.equal(fixture.pulls.get(other.number).state, "open");
    assert.equal(fixture.comments.size, 1);
    assert.equal([...fixture.comments.values()][0].body, "Unrelated comment");
    assert.equal([...fixture.issues.values()].filter((x) => x.state === "closed").length, 1);
    assert.equal([...fixture.pulls.values()].filter((x) => x.state === "closed").length, 2);
    assert.equal(
      fixture.trace.filter(
        (x) => x.method === "POST" && x.target !== "/app/installations/41/access_tokens",
      ).length,
      7,
    );
    const missing = [];
    registerResourceCleanup(missing, {
      request: send,
      repository,
      kind: "issues",
      marker: "<!-- unresolved-run -->",
    });
    await assert.rejects(missing[0](), /unresolved issues identity/);
  });

  test("control cleanup rejects unavailable and pending disposal through the actual operator client", async (t) => {
    const { callControl } = await appModule("drivers/repo/github/credentials/client/operator");
    const directory = await socketDirectory(t, "cleanup-control-");
    const socket = join(directory, "control.sock");
    const sessionId = "cleanup-session";
    const resolved = {
      sessionId,
      state: "DISPOSED",
      activeUses: 0,
      cleanup: {
        active: 0,
        pending: 0,
        uncertain: 0,
        auxiliaryPending: false,
      },
    };
    const pending = { ...resolved, state: "CLOSED", cleanup: { ...resolved.cleanup, pending: 1 } };
    let response = { error: "unavailable" };
    let statusUnavailable = false;
    let pendingStatusReads = 0;
    let statusReads = 0;
    const server = createServer((request, reply) => {
      request.resume();
      let body = response;
      if (request.method === "GET") {
        statusReads++;
        if (statusUnavailable) {
          body = { error: "unavailable" };
        } else if (pendingStatusReads > 0) {
          pendingStatusReads--;
          body = pending;
        }
      }
      reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await assert.rejects(
      closeAndDispose(callControl, socket, sessionId),
      /local closure unconfirmed/,
    );
    for (const state of ["OPEN", "DISPOSED"]) {
      response = { ...resolved, state, sessionId: state === "OPEN" ? sessionId : "foreign" };
      await assert.rejects(
        closeAndDispose(callControl, socket, sessionId),
        /local closure unconfirmed/,
      );
    }
    response = pending;
    await assert.rejects(
      closeAndDispose(callControl, socket, sessionId, { timeoutMs: 60, pollMs: 10 }),
      /local closure confirmed; disposal pending/,
    );
    // Pending cleanup is polled until it resolves. Counting status reads, not the
    // round trips that happen to fit in a short deadline, keeps this load-independent.
    response = resolved;
    pendingStatusReads = 2;
    statusReads = 0;
    assert.deepEqual(await closeAndDispose(callControl, socket, sessionId, { pollMs: 10 }), {
      localClosure: "confirmed",
      disposal: "confirmed",
    });
    assert.equal(statusReads, 3, "pending cleanup must be polled until it resolves");
    response = { ...resolved, cleanup: { ...resolved.cleanup, uncertain: 1 } };
    await assert.rejects(
      closeAndDispose(callControl, socket, sessionId, { timeoutMs: 30, pollMs: 10 }),
      /disposal pending/,
    );
    response = resolved;
    statusUnavailable = true;
    await assert.rejects(
      closeAndDispose(callControl, socket, sessionId),
      /local closure confirmed/,
    );
    statusUnavailable = false;
    assert.deepEqual(await closeAndDispose(callControl, socket, sessionId), {
      localClosure: "confirmed",
      disposal: "confirmed",
    });
  });
}

// Container qualification also selects this fixture directly with source or emitted owners.
if (import.meta.main) {
  registerCredentialFixtureRegressions();
}
