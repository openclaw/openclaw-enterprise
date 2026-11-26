import assert from "node:assert/strict";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
  NATIVE_WORKER_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
  REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts";
import type { CodexRepositoryBrokerNetworkPolicy } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { codexOpenClawConfiguration } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import { parseJson, record, text } from "../fixtures/runtime-image-startup/wire.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";

type ControllerStartupInputs = {
  dockerGateway: string;
  kubernetesGateway: string;
  harness: string;
  repositoryMaterialInit: string;
  repositoryNativeGitInit: string;
  repositoryGitHelperPath: string;
  nativeWorker: string;
  gatewayStopTimeoutMs: number;
  pluginRuntimeHelpers: string;
  policySourceCommit: string;
};

export type StartupProfile = {
  stagingCodexVersion: "0.164.0" | "0.163.0-alpha.2";
  historicalCodex: boolean;
  controller: ControllerStartupInputs;
};
export type SeccompOptions = () => Promise<string[]>;

const historicalControllerRevision = "54bfa7fc1b99e362450beb5f9211e164991fa7b4";

export async function selectStartupProfile(
  environment: NodeJS.ProcessEnv,
): Promise<StartupProfile> {
  // Only the trusted staging verifier selects the reviewed historical expectations.
  const stagingCodexVersion = environment.OCC_TEST_STAGING_CODEX_VERSION ?? "0.164.0";
  assert.ok(stagingCodexVersion === "0.164.0" || stagingCodexVersion === "0.163.0-alpha.2");
  if (stagingCodexVersion === "0.164.0") {
    return {
      stagingCodexVersion,
      historicalCodex: false,
      controller: {
        dockerGateway: DOCKER_GATEWAY_ENTRYPOINT,
        kubernetesGateway: GATEWAY_RUNTIME_ENTRYPOINT,
        harness: AGENT_RUNTIME_ENTRYPOINT,
        repositoryMaterialInit: REPOSITORY_MATERIAL_INIT_ENTRYPOINT,
        repositoryNativeGitInit: REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT,
        repositoryGitHelperPath:
          "/opt/oce/repository-credentials/dist/drivers/repo/github/access/client/git-helper.js",
        nativeWorker: NATIVE_WORKER_ENTRYPOINT,
        gatewayStopTimeoutMs: GATEWAY_STOP_TIMEOUT_MS,
        pluginRuntimeHelpers: PLUGIN_RUNTIME_HELPERS,
        policySourceCommit: GATEWAY_TOOL_POLICY_SOURCE_COMMIT,
      },
    };
  }
  assert.equal(environment.EXPECTED_OCC_REVISION, historicalControllerRevision);
  const imageId = environment.OCC_TEST_PRODUCTION_IMAGE;
  assert.ok(imageId, "The historical startup profile requires OCC_TEST_PRODUCTION_IMAGE.");
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  // Verify the local image selected by staging before running any of its code.
  const inspected = await runDocker([
    "image",
    "inspect",
    "--format",
    '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}',
    imageId,
  ]);
  assert.equal(
    inspected.stdout.trim(),
    `${imageId} ${historicalControllerRevision}`,
    "The historical startup profile requires the matching controller image ID and OCE revision.",
  );
  // Read every launcher and its companion values from the same packaged controller.
  const { stdout } = await runDocker([
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--entrypoint=node",
    imageId,
    "--input-type=module",
    "-e",
    `
      import { GATEWAY_RUNTIME_ENTRYPOINT as dockerGateway } from "./apps/controller/src/drivers/compute/docker/index.ts";
      import {
        GATEWAY_RUNTIME_ENTRYPOINT as kubernetesGateway,
        AGENT_RUNTIME_ENTRYPOINT as harness,
        NATIVE_WORKER_ENTRYPOINT as nativeWorker,
        GATEWAY_STOP_TIMEOUT_MS as gatewayStopTimeoutMs,
        PLUGIN_RUNTIME_HELPERS as pluginRuntimeHelpers,
      } from "./apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
      import {
        REPOSITORY_MATERIAL_INIT_ENTRYPOINT as repositoryMaterialInit,
        REPOSITORY_NATIVE_GIT_INIT_ENTRYPOINT as repositoryNativeGitInit,
      } from "./apps/controller/src/drivers/compute/kubernetes/repository-material-init.ts";
      import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT as policySourceCommit } from "./apps/controller/src/drivers/compute/gateway-tool-policy.ts";
      console.log(JSON.stringify({
        dockerGateway, kubernetesGateway, harness, nativeWorker,
        gatewayStopTimeoutMs, pluginRuntimeHelpers, policySourceCommit,
        repositoryMaterialInit, repositoryNativeGitInit,
      }));
    `,
  ]);
  const inputs = record(parseJson(stdout));
  const { gatewayStopTimeoutMs } = inputs;
  assert.ok(
    typeof gatewayStopTimeoutMs === "number" &&
      Number.isSafeInteger(gatewayStopTimeoutMs) &&
      gatewayStopTimeoutMs > 0,
    "Expected a positive historical Gateway stop timeout in milliseconds.",
  );
  return {
    stagingCodexVersion,
    historicalCodex: true,
    controller: {
      dockerGateway: text(inputs.dockerGateway),
      kubernetesGateway: text(inputs.kubernetesGateway),
      harness: text(inputs.harness),
      repositoryMaterialInit: text(inputs.repositoryMaterialInit),
      repositoryNativeGitInit: text(inputs.repositoryNativeGitInit),
      repositoryGitHelperPath:
        "/opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/git-helper.js",
      nativeWorker: text(inputs.nativeWorker),
      gatewayStopTimeoutMs,
      pluginRuntimeHelpers: text(inputs.pluginRuntimeHelpers),
      policySourceCommit: text(inputs.policySourceCommit),
    },
  };
}

export function brokerCodexConfiguration(
  repositoryBrokerNetworkPolicy: CodexRepositoryBrokerNetworkPolicy,
) {
  const configuration = codexOpenClawConfiguration({}, [], {
    repositoryBrokerNetworkPolicy,
    dedicatedCodex: true,
  });
  assert.ok(configuration);
  const plugins = record(configuration.plugins);
  return record(record(record(plugins.entries).codex).config);
}

// Node erases these functions before the test renders them. Each probe is
// self-contained apart from its explicit arguments. Keep the image's Node
// process in the original module mode and leave its stdin free for launcher bytes.
export function renderProbe<Args extends unknown[]>(
  probe: (...args: Args) => unknown,
  args: Args,
  mode: "commonjs" | "module" = "commonjs",
) {
  const source = args.map((arg) =>
    typeof arg === "function" ? "(" + arg.toString() + ")" : (JSON.stringify(arg) ?? "undefined"),
  );
  const call = "(" + probe.toString() + ")(" + source.join(", ") + ")";
  return mode === "module"
    ? "await " + call + ";"
    : call + ".catch((error) => { console.error(error); process.exitCode = 1; });";
}
