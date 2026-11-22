import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  image,
  runtimeImageModel,
  imageTestOptions,
  createAdmittedRuntimeImageConfiguration,
  runGatewaySmoke,
  reviewedCodexSeccompSecurityOptions,
} from "../helpers/runtime-image-startup.ts";
import { jsonLogEntries } from "../helpers/runtime-image-gateway-observations.ts";
import { verifyRuntimeSeccompRecord } from "./runtime-image-seccomp-case.ts";
import { verifyRuntimeCodexAuthMount } from "./runtime-image-codex-auth-mount-case.ts";
import { verifyRuntimeGatewayProbeCleanup } from "./runtime-image-gateway-probe-cleanup-case.ts";
import { verifyBundledCodexStartup } from "./runtime-image-bundled-codex-case.ts";
import { verifyDedicatedGatewayAssets } from "./runtime-image-dedicated-assets-case.ts";
import {
  assertBundledSlackPluginLoaded,
  assertGatewayModelLog,
  assertGatewayReadyLog,
  assertNoPackagingFailure,
} from "./runtime-image-startup-assertions.ts";
import { verifyDedicatedCommand } from "./runtime-image-dedicated-command-case.ts";
import { verifyDedicatedSchema } from "./runtime-image-dedicated-schema-case.ts";
import { verifyOpenShellPolicy } from "./runtime-image-openshell-policy-case.ts";
import { verifyStockBroker } from "./runtime-image-stock-broker-case.ts";
import { verifyCodexPackaging } from "./runtime-image-codex-packaging-case.ts";
import { verifyNativeThread } from "./runtime-image-native-thread-case.ts";
import {
  verifyClaudeCodeBinary,
  verifyClaudeCodeSettingsMounts,
} from "./runtime-image-claude-code-case.ts";
import { selectStartupProfile } from "./runtime-image-startup-support.ts";

const profile = await selectStartupProfile(process.env);
const { stagingCodexVersion, historicalCodex, controller } = profile;
const syntheticCodexApiKey = "sk-openclaw-runtime-image-smoke-synthetic";

function requiredImage() {
  assert.ok(image, "This case requires the selected runtime image.");
  return image;
}

function seccompOptions() {
  return reviewedCodexSeccompSecurityOptions({ codexVersion: stagingCodexVersion });
}

async function verifyGatewaySmoke(t: TestContext, collectPlugins: boolean) {
  const configuration = createAdmittedRuntimeImageConfiguration("openclaw", {
    enableSlack: true,
  });
  const { logs, pluginList } = await runGatewaySmoke(t, "openclaw", {
    entrypoint: controller.dockerGateway,
    configuration,
    collectPlugins,
    ...(!collectPlugins ? { extraEnvironment: ["OPENCLAW_LOG_LEVEL=error"] } : {}),
  });
  assert.ok(typeof logs === "string");
  const entries = jsonLogEntries(logs);
  assertGatewayReadyLog(entries);
  assertGatewayModelLog(entries, "openai/" + runtimeImageModel);
  if (collectPlugins) {
    assertBundledSlackPluginLoaded(pluginList);
  }
  assertNoPackagingFailure(logs);
}

test("runtime image seccomp option requires the CI-prepared profile record", (t) =>
  verifyRuntimeSeccompRecord(t, { stagingCodexVersion, historicalCodex }));

test(
  "runtime image applies Dedicated repository policy to native Codex command execution",
  imageTestOptions,
  () => verifyDedicatedCommand(requiredImage(), controller.harness, historicalCodex),
);

test(
  "runtime image gateway ignores inherited OPENCLAW_LOG_LEVEL in favor of native configuration",
  imageTestOptions,
  (t) => verifyGatewaySmoke(t, false),
);

test(
  "runtime image starts an embedded OpenClaw gateway with the Docker driver entrypoint",
  imageTestOptions,
  (t) => verifyGatewaySmoke(t, true),
);

test(
  "runtime image discovers the bundled Codex plugin from a fresh gateway home",
  imageTestOptions,
  (t) => verifyBundledCodexStartup(t, { entrypoint: controller.dockerGateway }),
);

test(
  "runtime image keeps Codex auth writable with a nested generated images mount",
  imageTestOptions,
  (t) => verifyRuntimeCodexAuthMount(t, syntheticCodexApiKey),
);

test(
  "runtime image publishes dedicated assets with the Kubernetes gateway entrypoint",
  imageTestOptions,
  (t) =>
    verifyDedicatedGatewayAssets(t, {
      entrypoint: controller.kubernetesGateway,
      stopTimeoutMs: controller.gatewayStopTimeoutMs,
      assertGatewayReadyLog,
      assertGatewayModelLog,
      assertNoPackagingFailure,
    }),
);

test(
  "runtime image validates the configuration dedicated native OpenClaw renders",
  imageTestOptions,
  (t) => verifyDedicatedSchema(t, requiredImage(), controller),
);

test("runtime image Gateway preserves OpenShell Codex isolation policy", imageTestOptions, () =>
  verifyOpenShellPolicy(requiredImage(), historicalCodex),
);

test(
  "runtime image Gateway probes time out and recover without CLI descendants",
  imageTestOptions,
  (t) => verifyRuntimeGatewayProbeCleanup(t, controller.pluginRuntimeHelpers),
);

test(
  "runtime image routes sandboxed Git through stock Codex and a development token sender",
  imageTestOptions,
  (t) => verifyStockBroker(t, requiredImage(), controller, seccompOptions),
);

test(
  "runtime image shares the reviewed Codex version between the plugin and Dedicated command",
  imageTestOptions,
  () => verifyCodexPackaging(requiredImage(), profile),
);

// The historical staging image predates Claude Code.
const claudeCodeTestOptions = historicalCodex
  ? { skip: "The historical runtime image has no Claude Code." }
  : imageTestOptions;

test(
  "runtime image ships the pinned Claude Code binary and an empty managed settings mount point",
  claudeCodeTestOptions,
  () => verifyClaudeCodeBinary(requiredImage()),
);

test(
  "runtime image Claude Code managed settings and configuration are written by the init and read-only to the Gateway uid",
  claudeCodeTestOptions,
  (t) => verifyClaudeCodeSettingsMounts(t, requiredImage()),
);

test(
  "runtime image applies the repository profile to a native thread shell turn",
  imageTestOptions,
  () =>
    verifyNativeThread(requiredImage(), controller.harness, seccompOptions, syntheticCodexApiKey),
);
