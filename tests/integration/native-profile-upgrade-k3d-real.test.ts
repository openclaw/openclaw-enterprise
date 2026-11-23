import test from "node:test";

import { runNativeProfileUpgradeScenario } from "../helpers/native-profile-upgrade.mjs";
import { requiresNativeAdminRouting } from "../helpers/harness-topology-k3d-real.mjs";

test(
  "pre-feature OCE installation upgrades the same retained Agent from shared to delegated native profiles",
  { ...requiresNativeAdminRouting, timeout: 1_800_000 },
  runNativeProfileUpgradeScenario,
);
