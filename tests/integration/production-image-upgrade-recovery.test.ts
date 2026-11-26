import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerUpgradeContinuityTests } from "../helpers/production-upgrade-continuity-fixture.ts";
import { assertPrivateReceipt } from "../helpers/production-upgrade-recovery-evidence.ts";
import { createRecoveryFixture } from "../helpers/production-upgrade-recovery-fixture.ts";
import {
  controller,
  createRecoveryTools,
  helmTargetOverrides,
  injectedFault,
  newController,
  spawnResult,
} from "../helpers/production-upgrade-recovery-tools.ts";
import { registerRetainedFleetPreflightTests } from "../helpers/production-upgrade-retained-fleet-preflight.ts";
import { registerFleetAdmissionCases } from "./production-upgrade-fleet-admission-cases.ts";
import { registerHelmRollbackCases } from "./production-upgrade-helm-rollback-cases.ts";
import { registerInstallationRecoveryCases } from "./production-upgrade-installation-recovery-cases.ts";
import { registerStartupPreflightCases } from "./production-upgrade-startup-preflight-cases.ts";
import { registerWriterHandoffCases } from "./production-upgrade-writer-handoff-cases.ts";

// Every case owns its command server, state, and evidence directory. Three sibling
// cases can overlap while the existing nested groups keep their own limits.
await describe("production image upgrade recovery", { concurrency: 3 }, async () => {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const tools = await createRecoveryTools(repository);
  const fixture = createRecoveryFixture(tools);

  test("the recovery kubectl fixture requires a component selector for ReplicaSet evidence", async (t) => {
    const { directory } = await fixture(t);
    const getReplicaSets = (...args: string[]) =>
      spawnResult(join(directory, "bin", "kubectl"), ["get", "replicasets", ...args], {});
    const selector = (component: string) =>
      `app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=oce,app.kubernetes.io/component=${component}`;

    for (const component of ["api", "worker"]) {
      const { status, stdout } = await getReplicaSets(
        "--selector",
        selector(component),
        "-o",
        "json",
      );
      assert.equal(status, 0);
      assert.deepEqual(JSON.parse(stdout), {
        items: [
          {
            metadata: {
              name: `${component}-rs`,
              uid: `${component}-rs-uid`,
              ownerReferences: [
                {
                  kind: "Deployment",
                  name: `openclaw-enterprise-${component}`,
                  uid: `${component}-deployment-uid`,
                  controller: true,
                },
              ],
            },
          },
        ],
      });
    }
    for (const args of [[], ["--selector", ""], ["--selector", selector("other")]]) {
      const { status, stdout, stderr } = await getReplicaSets(...args, "-o", "json");
      assert.equal(status, 1, JSON.stringify(args));
      assert.match(stderr, /--selector/);
      assert.equal(stdout, "");
    }
  });

  registerRetainedFleetPreflightTests(fixture, injectedFault);
  registerUpgradeContinuityTests({
    fixture,
    injectedFault,
    helmTargetOverrides,
    controller,
    newController,
    assertPrivateReceipt,
  });
  registerInstallationRecoveryCases({ fixture });
  registerWriterHandoffCases({ fixture, realHelm: tools.realHelm, repository });
  registerFleetAdmissionCases({ fixture });
  registerStartupPreflightCases({ fixture, realHelm: tools.realHelm, repository });
  registerHelmRollbackCases({ fixture });
});
