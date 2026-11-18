import { after } from "node:test";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { registerHarnessExposureGatewayRefusalCases } from "./postgres-worker-harness-exposure-gateway-refusal-cases.ts";
import { registerHarnessExposureQueueCases } from "./postgres-worker-harness-exposure-queue-cases.ts";
import { registerHarnessExposureSweepCases } from "./postgres-worker-harness-exposure-sweep-cases.ts";

const fixtures = createWorkerRevisionFixtures(import.meta.url);
after(fixtures.cleanup);

registerHarnessExposureSweepCases(fixtures);
registerHarnessExposureGatewayRefusalCases(fixtures);
registerHarnessExposureQueueCases(fixtures);
