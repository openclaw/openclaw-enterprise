import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { setImmediate as drainTurn, setTimeout as delay } from "node:timers/promises";

import {
  channelProxyDeploymentStep,
  createStepRecorder,
} from "../../scripts/ci/first-agent-smoke/process.ts";
import { createApi } from "../../scripts/ci/first-agent-smoke/setup.ts";
import { observeChannelProxyWorkspaceReads } from "../../scripts/ci/first-agent-smoke/workspace-reads.ts";
import { listen } from "../helpers/listen.ts";

const initial = "channel-proxy-initial-deploy";
const move = "channel-proxy-move-deploy";
const namespaceId = "synthetic-namespace";
const agentId = "synthetic-agent-a";
const key = "synthetic-api-key";
const savedEdit = "synthetic saved workspace edit\n";
const responseDetail = "synthetic response detail";

type ReadReply =
  | "saved"
  | "unconfirmed"
  | "mismatch"
  | "invalid-json"
  | "null-envelope"
  | "unconfirmed-invalid-json";
type PlannedRead = ReadReply | (() => Promise<ReadReply>);

async function workspaceFixture(
  t: TestContext,
  reads: PlannedRead[],
  onReport?: (line: string) => void,
) {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    key: string | string[] | undefined;
  }> = [];
  const port = await listen(
    t,
    createServer(async (request, response) => {
      const reply = reads[requests.length];
      requests.push({
        method: request.method,
        path: request.url,
        key: request.headers["x-api-key"],
      });
      const outcome = typeof reply === "function" ? await reply() : reply;
      if (outcome === "saved" || outcome === "mismatch") {
        response.end(
          JSON.stringify({
            data: { name: "USER.md", content: outcome === "saved" ? savedEdit : responseDetail },
          }),
        );
      } else if (outcome === "invalid-json" || outcome === "unconfirmed-invalid-json") {
        response.writeHead(outcome === "invalid-json" ? 200 : 503).end(responseDetail);
      } else if (outcome === "null-envelope") {
        response.end("null");
      } else {
        response
          .writeHead(outcome === "unconfirmed" ? 503 : 500)
          .end(JSON.stringify({ error: { message: responseDetail } }));
      }
    }),
  );
  const reports: string[] = [];
  const recorder = createStepRecorder(() => requests.length);
  const observation = observeChannelProxyWorkspaceReads(
    recorder.smokeStep,
    { api: createApi(`http://127.0.0.1:${port}`, key), namespaceId },
    { id: agentId },
    savedEdit,
    {
      intervalMs: 1,
      report: (line) => {
        reports.push(line);
        onReport?.(line);
      },
    },
  );
  return {
    ...observation,
    timings: recorder.timings,
    reports,
    requestCount: () => requests.length,
    assertRequests() {
      assert.deepEqual(
        requests,
        reads.map(() => ({
          method: "GET",
          path: `/namespaces/${namespaceId}/agents/${agentId}/workspace/files/USER.md`,
          key,
        })),
      );
    },
  };
}

function heldRead() {
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<ReadReply>();
  return {
    started: started.promise,
    release: reply.resolve,
    respond: () => {
      started.resolve();
      return reply.promise;
    },
  };
}

export function registerWorkspaceReadCases() {
  test(
    "workspace reads observe paired and solo channel proxy deployments through the smoke API",
    { timeout: 5_000 },
    async (t) => {
      const recovering = heldRead();
      const uninterrupted = heldRead();
      const fixture = await workspaceFixture(t, [
        "saved",
        "unconfirmed-invalid-json",
        recovering.respond,
        "unconfirmed",
        "saved",
        "saved",
        uninterrupted.respond,
        "saved",
      ]);
      const deployA = channelProxyDeploymentStep({
        smokeStep: fixture.step,
        context: "channel-proxy-initial-deploy-a",
      });
      const deployB = channelProxyDeploymentStep({
        smokeStep: fixture.step,
        context: "channel-proxy-initial-deploy-b",
      });
      const peer = Promise.withResolvers<string>();
      const paired = fixture.step(initial, () =>
        Promise.all([
          deployA("wait", async () => "revision-a"),
          deployB("wait", () => peer.promise),
        ]),
      );
      await recovering.started;
      peer.resolve("revision-b");
      await drainTurn();
      // A post-action request must wait for the overlapping request to finish, while
      // the existing action and its nested waits already have their normal timing rows.
      assert.equal(fixture.requestCount(), 3);
      assert.deepEqual(
        fixture.timings.map(({ phase, startMs, endMs }) => ({ phase, startMs, endMs })),
        [
          { phase: "channel-proxy-initial-deploy-a-wait", startMs: 1, endMs: 1 },
          { phase: "channel-proxy-initial-deploy-b-wait", startMs: 1, endMs: 3 },
          { phase: initial, startMs: 1, endMs: 3 },
        ],
      );
      recovering.release("saved");
      assert.deepEqual(await paired, ["revision-a", "revision-b"]);
      assert.throws(fixture.assertComplete, /did not exercise both phases/);

      const moved = Promise.withResolvers<string>();
      const solo = fixture.step(move, () => moved.promise);
      await uninterrupted.started;
      moved.resolve("moved-revision");
      await drainTurn();
      uninterrupted.release("saved");
      assert.equal(await solo, "moved-revision");
      assert.equal(await fixture.step("channel-proxy-clear-deploy", () => "clear"), "clear");
      fixture.assertComplete();
      fixture.assertRequests();
      assert.equal(fixture.reports.length, 2);
      const observed =
        /^channel-proxy-initial-deploy workspace reads baselineConfirmed=1 duringConfirmed=1 duringUnconfirmed=1 duringMismatch=0 afterConfirmed=1 afterUnconfirmed=1 afterMismatch=0 firstUnconfirmedReadCompletedMs=(\d+) firstConfirmedAfterUnconfirmedReadCompletedMs=(\d+)$/;
      const offsets = observed.exec(fixture.reports[0] ?? "");
      assert.ok(offsets);
      assert.ok(Number(offsets[2]) >= Number(offsets[1]));
      assert.equal(
        fixture.reports[1],
        "channel-proxy-move-deploy workspace reads baselineConfirmed=1 duringConfirmed=1 duringUnconfirmed=0 duringMismatch=0 afterConfirmed=1 afterUnconfirmed=0 afterMismatch=0 firstUnconfirmedReadCompletedMs=-1 firstConfirmedAfterUnconfirmedReadCompletedMs=-1",
      );
    },
  );

  test(
    "workspace reads require an exact baseline before starting deployment",
    { timeout: 5_000 },
    async (t) => {
      const fixture = await workspaceFixture(t, ["unconfirmed"]);
      let started = false;
      await assert.rejects(
        fixture.step(initial, () => {
          started = true;
        }),
        { message: "channel-proxy-initial-deploy: workspace read baseline unconfirmed" },
      );
      assert.equal(started, false);
      assert.deepEqual(fixture.timings, []);
      fixture.assertRequests();
    },
  );

  const scenarios = [
    {
      label: "post-action reads stay unconfirmed",
      overlap: "saved",
      post: ["unconfirmed", "unconfirmed", "unconfirmed"],
      message: "workspace read after deployment could not be confirmed",
    },
    {
      label: "an overlapping read returns different content",
      overlap: "mismatch",
      post: ["saved"],
      message: "workspace read did not match the saved edit",
    },
    {
      label: "a post-action read returns different content",
      overlap: "saved",
      post: ["mismatch"],
      message: "workspace read did not match the saved edit",
    },
    {
      label: "an overlapping HTTP 200 contains invalid JSON before an exact read",
      overlap: "invalid-json",
      post: ["saved"],
      message: "workspace read did not match the saved edit",
    },
    {
      label: "an overlapping HTTP 200 contains a null envelope before an exact read",
      overlap: "null-envelope",
      post: ["saved"],
      message: "workspace read did not match the saved edit",
    },
  ] as const;
  for (const scenario of scenarios) {
    test(`workspace reads fail if ${scenario.label}`, { timeout: 5_000 }, async (t) => {
      const overlap = heldRead();
      const fixture = await workspaceFixture(t, ["saved", overlap.respond, ...scenario.post]);
      const action = Promise.withResolvers<void>();
      const outcome = assert.rejects(
        fixture.step(move, () => action.promise),
        {
          message: `${move}: ${scenario.message}`,
        },
      );
      await overlap.started;
      action.resolve();
      await drainTurn();
      overlap.release(scenario.overlap);
      await outcome;
      assert.equal(fixture.timings[0]?.status, "ok");
      fixture.assertRequests();
      assert.doesNotMatch(fixture.reports.join("\n"), /synthetic|USER\.md/);
    });
  }

  test(
    "workspace reads drain a pending read and preserve the original deployment failure",
    { timeout: 5_000 },
    async (t) => {
      const overlap = heldRead();
      const fixture = await workspaceFixture(t, ["saved", overlap.respond], () => {
        throw new Error("synthetic reporting failure");
      });
      const action = Promise.withResolvers<void>();
      const failure = new Error("synthetic deployment failure");
      let settled = false;
      const result = fixture.step(move, () => action.promise);
      const outcome = assert.rejects(
        result.finally(() => {
          settled = true;
        }),
        (error) => error === failure,
      );
      await overlap.started;
      action.reject(failure);
      await drainTurn();
      assert.equal(fixture.timings[0]?.status, "failed");
      assert.equal(settled, false);
      overlap.release("unconfirmed");
      await outcome;
      // More than one cadence tick has passed, so no observer can make another request.
      await delay(10);
      fixture.assertRequests();
      assert.match(
        fixture.reports[0] ?? "",
        /duringUnconfirmed=1 .*afterConfirmed=0 afterUnconfirmed=0/,
      );
    },
  );
}
