import assert from "node:assert/strict";
import type { CodexRepositoryBrokerNetworkPolicy } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { codexOpenClawConfiguration } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import { parseJson, record, text } from "../fixtures/runtime-image-startup/wire.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";

type HistoricalController = { docker: string; kubernetes: string; commit: string };
export type StartupProfile = {
  stagingCodexVersion: "0.164.0" | "0.163.0-alpha.2";
  historicalCodex: boolean;
  historicalController?: HistoricalController;
};
export type SeccompOptions = () => Promise<string[]>;

export async function selectStartupProfile(
  environment: NodeJS.ProcessEnv,
): Promise<StartupProfile> {
  // Only the trusted staging verifier selects the reviewed historical expectations.
  const stagingCodexVersion = environment.OCC_TEST_STAGING_CODEX_VERSION ?? "0.164.0";
  assert.ok(stagingCodexVersion === "0.164.0" || stagingCodexVersion === "0.163.0-alpha.2");
  if (stagingCodexVersion === "0.164.0") {
    return { stagingCodexVersion, historicalCodex: false };
  }
  assert.equal(environment.EXPECTED_OCC_REVISION, "54bfa7fc1b99e362450beb5f9211e164991fa7b4");
  const imageId = environment.OCC_TEST_PRODUCTION_IMAGE;
  assert.ok(imageId);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  // Staging verified this pair. Read the launchers in the selected controller
  // and execute them only in the matching runtime.
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
      import { GATEWAY_RUNTIME_ENTRYPOINT as docker } from "./apps/controller/src/drivers/compute/docker/index.ts";
      import { GATEWAY_RUNTIME_ENTRYPOINT as kubernetes } from "./apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
      import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT as commit } from "./apps/controller/src/drivers/compute/gateway-tool-policy.ts";
      console.log(JSON.stringify({ docker, kubernetes, commit }));
    `,
  ]);
  const launchers = record(parseJson(stdout));
  return {
    stagingCodexVersion,
    historicalCodex: true,
    historicalController: {
      docker: text(launchers.docker),
      kubernetes: text(launchers.kubernetes),
      commit: text(launchers.commit),
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
