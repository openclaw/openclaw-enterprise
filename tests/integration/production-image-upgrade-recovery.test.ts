import { describe } from "node:test";
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
