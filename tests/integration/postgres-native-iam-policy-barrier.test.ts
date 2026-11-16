import test from "node:test";

import {
  readBarrierFixtureSelection,
  registerBarrierAdmissionCases,
  requireBarrierFixtureTarget,
} from "./postgres-native-iam-policy-barrier-admission.ts";
import { runBarrierAuthorityCases } from "./postgres-native-iam-policy-barrier-authority-cases.ts";
import { createBarrierFixture } from "./postgres-native-iam-policy-barrier-fixture.ts";
import { runBarrierQueueCases } from "./postgres-native-iam-policy-barrier-queue-cases.ts";

registerBarrierAdmissionCases();

const selection = readBarrierFixtureSelection();

test(
  "native IAM policy barrier holds the original authority and blocks all six writers",
  { skip: !selection.enabled, timeout: 120000 },
  async (context) => {
    const target = requireBarrierFixtureTarget(selection);
    const fixture = await createBarrierFixture(context, target);
    const key = await runBarrierAuthorityCases(context, fixture);
    await runBarrierQueueCases(context, fixture, target.appUrl, key);
  },
);
