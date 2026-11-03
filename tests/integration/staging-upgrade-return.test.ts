import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDistinctControllers,
  assertReturnedAgents,
  returnedDatabaseConnections,
  selectRehearsalControllers,
} from "../helpers/staging-upgrade-return.ts";

const controller = (digest: string, config: string, commit: string) => ({
  reference: `ghcr.io/openclaw/openclaw-enterprise-controller@sha256:${digest.repeat(64)}`,
  configDigest: `sha256:${config.repeat(64)}`,
  revision: commit.repeat(40),
});

test("return rehearsal rejects different manifest references that contain the same controller", () => {
  const previous = controller("1", "2", "3");
  assert.doesNotThrow(() => assertDistinctControllers(previous, controller("4", "5", "6")));
  assert.throws(
    () => assertDistinctControllers(previous, controller("4", "2", "6")),
    /contents must differ/u,
  );
});

test("return rehearsal refuses image selection in the credentialed TUI lane", async () => {
  const noImageInspection = () => Promise.reject(new Error("unexpected image inspection"));
  await assert.rejects(
    selectRehearsalControllers(noImageInspection, { CI: "true" }),
    /run the controller rehearsal locally/u,
  );
  await assert.rejects(
    selectRehearsalControllers(noImageInspection, { OPENAI_API_KEY: "invented-fixture-value" }),
    /without model credentials/u,
  );
});

test("return readback rejects a stale restore and a recreated Agent with the same name", () => {
  const baseline = {
    id: "agt_before",
    namespaceId: "ns_original",
    name: "before-upgrade",
    configurationId: "cfg_original",
  };
  const accepted = { ...baseline, id: "agt_accepted", name: "acknowledged-after-upgrade" };
  assert.doesNotThrow(() => assertReturnedAgents(baseline, accepted, [baseline, accepted]));
  assert.throws(
    () => assertReturnedAgents(baseline, accepted, [baseline]),
    /missing or changed acknowledged Agent agt_accepted/u,
  );
  assert.throws(
    () =>
      assertReturnedAgents(baseline, accepted, [baseline, { ...accepted, id: "agt_recreated" }]),
    /missing or changed acknowledged Agent agt_accepted/u,
  );
  assert.throws(
    () =>
      assertReturnedAgents(baseline, accepted, [
        { ...baseline, configurationId: "cfg_other" },
        accepted,
      ]),
    /missing or changed preexisting Agent agt_before/u,
  );
});

test("return readback requires both serving Pods to use the restored database", () => {
  const podIPs = ["192.0.2.1", "192.0.2.2"];
  const restored = ["occ_return:192.0.2.1", "occ_return:192.0.2.2"];
  assert.equal(returnedDatabaseConnections(restored, podIPs), true);
  assert.equal(returnedDatabaseConnections(restored.slice(0, 1), podIPs), false);
  assert.throws(
    () => returnedDatabaseConnections([...restored, "openclaw_enterprise:192.0.2.2"], podIPs),
    /retained candidate database still has an application connection/u,
  );
});
