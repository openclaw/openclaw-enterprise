import test from "node:test";

import { registerCompleteLifecycleCases } from "./ci-runner-complete-lifecycle-cases.ts";
import {
  checkFileEnvironmentPrecedence,
  checkGatewayRoutingEnvironment,
  checkGatewayRoutingImageMirror,
  checkQaLaneInputsAndArtifacts,
  checkRunnerSelectorIsolation,
} from "./ci-runner-environment-cases.ts";
import { checkRunnerManifest } from "./ci-runner-manifest-cases.ts";
import { registerNativeWorkerProofCases } from "./ci-runner-native-worker-proof-cases.ts";
import {
  registerOpenShellAdmissionCases,
  registerOpenShellSelectionCases,
} from "./ci-runner-openshell-input-cases.ts";
import { registerProvenanceCases } from "./ci-runner-provenance-cases.ts";
import { registerReporterCases } from "./ci-runner-reporter-cases.ts";
import { checkReporterRedaction } from "./ci-runner-reporter-redaction-case.ts";
import { registerResourceDiagnosticsCases } from "./ci-runner-resource-diagnostics-cases.ts";

registerProvenanceCases();

test(
  "gateway routing preparation preserves infrastructure env without overriding Slack selection",
  checkGatewayRoutingEnvironment,
);

test(
  "gateway routing preparation admits cert-manager mirror images",
  checkGatewayRoutingImageMirror,
);

test(
  "runner applies file environment over real preparation defaults without replacing generated values",
  checkFileEnvironmentPrecedence,
);

registerCompleteLifecycleCases();

test("run resolves lane documents relative to the manifest and preserves ordered case accounting", async (t) => {
  return checkRunnerManifest(t);
});

registerOpenShellAdmissionCases();

test(
  "run clears inherited selectors and keep flags while preserving explicit lane and file inputs",
  checkRunnerSelectorIsolation,
);

registerOpenShellSelectionCases();

test(
  "QA lane forwards selected models and observer input and retains outcomes at the requested path",
  checkQaLaneInputsAndArtifacts,
);

test("run redacts arbitrary stdout, stderr, assertion payloads, and stacks from artifacts", async (t) => {
  return checkReporterRedaction(t);
});

registerReporterCases();
registerResourceDiagnosticsCases();
registerNativeWorkerProofCases();
