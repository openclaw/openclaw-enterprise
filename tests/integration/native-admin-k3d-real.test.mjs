import test from "node:test";

import { requiresNativeAdminRouting } from "../helpers/harness-topology-k3d-real.mjs";
import {
  runNativeAdminScenario,
  runSharedNativeScenario,
} from "../helpers/native-admin-browser.mjs";

test(
  "production native admin UI opens through OCC and preserves Agent boundaries",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  runNativeAdminScenario,
);

test(
  "two people share an embedded native Gateway with selective stream withdrawal",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  runSharedNativeScenario,
);
