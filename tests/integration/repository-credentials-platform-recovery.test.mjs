import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryPlatformFixture,
  repositoryPlatformSelected,
} from "../helpers/repository-credentials-platform.mjs";

test(
  "Agent stop recovers a confirmed disposal after the broker dies before its reply",
  {
    skip: repositoryPlatformSelected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1 with dedicated PostgreSQL, disposable k3d and the final-runtime fixture image.",
    timeout: 900_000,
  },
  async (context) => {
    const fixture = await createRepositoryPlatformFixture(context);
    const { namespace, credentials, kube, placement } = fixture;
    const agent = await fixture.createAgent([{ repositoryRef: "repo-a", profile: "git-full" }]);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const revision = await fixture.request("POST", `${path}/deploy`, undefined, 202);
    const pod = await fixture.readyPod(agent, revision);
    const material = await fixture.material(pod);
    assert.equal(material.bindings.length, 1);
    const sessionId = material.bindings[0].sessionId;
    // Real Git traffic creates provider authority for the stopping Agent.
    await fixture.tool(pod, "git", [
      "clone",
      `https://github.com/${credentials.repositories[0].repository}.git`,
    ]);
    const issued = credentials.repositories[0].github.issuesOfTokens.length;
    assert.ok(issued > 0);
    const gate = fixture.control.holdDisposedResponse();
    let observed;
    void gate.observed.then((result) => {
      observed = result;
    });
    const gatewayLog = fixture.followGatewayLog(pod);
    try {
      gatewayLog.mark("stop requested");
      await fixture.request("POST", `${path}/stop`, undefined, 202);
      gatewayLog.mark("stop accepted");
      await gatewayLog.attachOnFailure(context, "confirmed terminal response wait", () =>
        kube.waitFor(
          "confirmed terminal response at the Unix control transport",
          () => observed,
          500,
        ),
      );
      assert.equal(observed.sessionId, sessionId);
      const attempts = await fixture.attempts(revision);
      const attempt = attempts.find((entry) => entry.session_id === sessionId);
      assert.equal(attempt.phase, "closing");
      const receipt = (
        await fixture.pool.query(
          "SELECT state, session_id, revoked FROM occ.repository_broker_receipts WHERE admission_id=$1",
          [attempt.admission_id],
        )
      ).rows[0];
      assert.equal(receipt.state, "disposed");
      assert.equal(receipt.session_id, sessionId);
      assert.ok(Number(receipt.revoked) > 0);
      // The receipt was committed by the original broker, but the worker has
      // not received the reply. Crash the broker and discard the held response.
      await credentials.kill();
      gate.disconnect();
      await credentials.start();
      await kube.waitFor("worker retirement using the recovered terminal receipt", async () => {
        const current = await fixture.request("GET", path);
        const saved = (await fixture.attempts(revision)).find(
          (entry) => entry.admission_id === attempt.admission_id,
        );
        const pods = await kube.resources(
          "pods",
          placement,
          "-l",
          `openclaw.dev/agent=${agent.id}`,
        );
        const retired =
          current.activeRevisionId === undefined &&
          pods.length === 0 &&
          saved?.phase === "disposed";
        if (!retired) {
          await fixture.expediteWork(revision);
        }
        return retired;
      });
      assert.equal(credentials.repositories[0].github.issuesOfTokens.length, issued);
      assert.equal((await credentials.status(sessionId)).state, "DISPOSED");
    } finally {
      await gatewayLog.stop();
      gate.disconnect();
      if (!credentials.process.alive) {
        await credentials.start();
      }
    }
  },
);
