import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryPlatformFixture,
  repositoryPlatformSelected,
} from "../helpers/repository-credentials-platform.mjs";

test(
  "ordinary Agent worker withholds readiness when material expires during a Kubernetes observation",
  {
    skip: repositoryPlatformSelected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1 with dedicated PostgreSQL, disposable k3d and the final-runtime fixture image.",
    timeout: 900_000,
  },
  async (context) => {
    const fixture = await createRepositoryPlatformFixture(context);
    const { namespace, kube, placement } = fixture;
    const agent = await fixture.createAgent([{ repositoryRef: "repo-a", profile: "git-full" }]);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const gate = await fixture.armMaterialExpiry(agent.id);
    const eventCursor = fixture.events.length;
    let released = false;
    try {
      const revision = await fixture.request("POST", `${path}/deploy`, undefined, 202);
      const observed = await gate.observed();
      assert.notEqual(
        observed.failed,
        true,
        "Compute failed before producing its readiness result",
      );
      assert.equal(observed.revisionId, revision.id);
      assert.ok(observed.podUid && observed.podResourceVersion && observed.generation);
      assert.ok(observed.before < observed.deadline);
      assert.ok(observed.after >= observed.deadline);
      assert.equal(observed.readyBeforeHit, false);
      assert.equal(observed.materialReady, false, "Compute must reject the expired observation");
      assert.equal(observed.ready, false, "Compute must not report expired material ready");
      assert.equal(observed.activations, 0);
      const materialSelector = `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`;
      const claimed = await fixture.pool.query(
        "SELECT idempotency_key FROM occ.controller_work WHERE revision_id=$1 AND state='claimed'",
        [revision.id],
      );
      assert.equal(claimed.rowCount, 1, "the observed pass must retain its original Work claim");
      const workId = claimed.rows[0].idempotency_key;
      // Repeated deferrals with the same code add no audit row, so count the worker's
      // pending completions of this exact Work item instead.
      const incompleteCount = () =>
        fixture.events.filter(
          (event) =>
            event.event === "worker.completed" &&
            event.workId === workId &&
            event.outcome === "pending" &&
            event.code === "REVISION_INCOMPLETE",
        ).length;
      const priorIncomplete = incompleteCount();
      await gate.release(true);
      released = true;
      await gate.resumed();
      await kube.waitFor("the worker to defer the exact incomplete revision", async () => {
        const current = await fixture.request("GET", path);
        return (
          current.desiredRuntimeState === "running" &&
          current.activeRevisionId !== revision.id &&
          incompleteCount() > priorIncomplete
        );
      });
      const beforeStop = await gate.inspect();
      assert.equal(beforeStop.state, "resumed");
      assert.equal(beforeStop.activations, 0);
      const materialSecrets = await kube.resources("secrets", placement, "-l", materialSelector);
      assert.equal(materialSecrets.length, 1, "the revision must have an owned material Secret");
      assert.ok(materialSecrets[0].metadata.uid, "the material Secret must have a Kubernetes UID");
      assert.equal(
        fixture.events
          .slice(eventCursor)
          .some((event) => event.code === "CLAIM_LOST" || event.code === "WORKER_UNAVAILABLE"),
        false,
        "claim loss or worker unavailability must not explain the incomplete result",
      );
      await fixture.request("POST", `${path}/stop`, undefined, 202);
      await gate.finish();
      await kube.waitFor(
        "ordinary stop to remove the workload and settle its session",
        async () => {
          const current = await fixture.request("GET", path);
          const pods = await kube.resources(
            "pods",
            placement,
            "-l",
            `openclaw.dev/agent=${agent.id}`,
          );
          const attempts = await fixture.attempts(revision);
          const secrets = await kube.resources("secrets", placement, "-l", materialSelector);
          return (
            current.desiredRuntimeState === "stopped" &&
            current.activeRevisionId === undefined &&
            pods.length === 0 &&
            secrets.length === 0 &&
            attempts.length > 0 &&
            attempts.every(({ phase }) => phase === "disposed" || phase === "invalidated")
          );
        },
      );
      assert.equal((await gate.inspect()).activations, 0);
      assert.equal(
        fixture.events
          .slice(eventCursor)
          .some((event) => event.code === "CLAIM_LOST" || event.code === "WORKER_UNAVAILABLE"),
        false,
        "the observed pass and cleanup must retain their Work authority",
      );
    } finally {
      if (!released) {
        // A failed assertion must not release a ready result to the worker.
        await gate.release(false);
      } else {
        await gate.finish();
      }
    }
  },
);
