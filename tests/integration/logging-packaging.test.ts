import test from "node:test";

import { chartTooling } from "../helpers/production-chart.ts";
import { developmentLoggingOverride } from "./logging-packaging-compose-cases.ts";
import {
  productionCollectorSelectors,
  productionHelmLoggingCollector,
  productionHelmLoggingRefusals,
} from "./logging-packaging-helm-cases.ts";

const helmTooling = await chartTooling();

test(
  "development logging override routes only OCC-owned services through the private Collector",
  developmentLoggingOverride,
);

test(
  "production Helm logging Collector is opt-in and isolated from application credentials",
  helmTooling,
  productionHelmLoggingCollector,
);

test(
  "production Helm logging rejects mutable images, broad egress, and shared application Secrets",
  helmTooling,
  productionHelmLoggingRefusals,
);

test(
  "production Collector requires paired private metrics and exporter selectors",
  helmTooling,
  productionCollectorSelectors,
);
