import test from "node:test";

import { chartTooling } from "../helpers/production-chart.ts";
import { separateDatabaseUpgradeCase } from "./installation-change-preflight-cases.ts";

test(
  "a separate database deployment requires current history only on upgrade",
  await chartTooling(),
  separateDatabaseUpgradeCase,
);
