import assert from "node:assert/strict";
import { join } from "node:path";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  pluginRuntimeEnvironment,
  type PluginRuntimeSpec,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { cpuScaledImageTimeoutMs } from "../helpers/image-smoke-timeout.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import {
  probeNativeThread,
  probeNativeThreadAccess,
} from "../fixtures/runtime-image-startup/native-thread.ts";
import {
  bundledExport,
  loadCodexClient,
  loadCodexConfig,
} from "../fixtures/runtime-image-startup/bundled-codex.ts";
import { list, parseJson, record, text } from "../fixtures/runtime-image-startup/wire.ts";
import {
  brokerCodexConfiguration,
  renderProbe,
  type SeccompOptions,
} from "./runtime-image-startup-support.ts";

export async function verifyNativeThread(
  image: string,
  seccompOptions: SeccompOptions,
  syntheticCodexApiKey: string,
) {
  // Unlike command/exec qualification, this starts with the actual OCE native
  // config and supplies the broker profile through the packaged thread/turn builders.
  // The provider chooses one command; the real Codex owns its execution and sandbox.
  // This does not start the complete Gateway or prove model behavior.
  const runtime = {
    kind: "codex",
    selections: {},
    approvalPolicy: "never",
    repositoryBrokerNetworkPolicy: { host: "git.oce.svc", domains: {} },
    modelEndpoint: {
      baseUrl: "http://127.0.0.1:4711/v1",
      modelProvider: "openai-compatible",
    },
  } satisfies PluginRuntimeSpec;

  const brokerConfiguration = brokerCodexConfiguration(runtime.repositoryBrokerNetworkPolicy);
  const appServer = record(brokerConfiguration.appServer);
  const networkProxy = record(appServer.networkProxy);
  Object.assign(appServer, {
    transport: "websocket",
    url: "ws://127.0.0.1:4500",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    remoteWorkspaceRoot: "/home/node/workspace",
  });
  // Standard Codex retains this authored base while OCE adds the broker policy.

  networkProxy.baseProfile = "workspace";
  const security = await seccompOptions();
  const probe = renderProbe(
    probeNativeThread,
    [
      bundledExport,
      loadCodexClient,
      loadCodexConfig,
      list,
      parseJson,
      record,
      text,
      probeNativeThreadAccess,
    ],
    "module",
  );
  const { stdout } = await runDocker(
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      "--read-only",
      "--user",
      "node",
      "--cap-drop",
      "ALL",
      ...security,
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/home/node:uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/run/oce/repository-credentials:uid=1000,gid=1000,mode=700",
      "--volume",
      `${join(import.meta.dirname, "../fixtures/synthetic-egress-provider.mjs")}:/tmp/synthetic-egress-provider.mjs:ro`,
      "--workdir",
      "/app",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      probe,
    ],
    { timeout: cpuScaledImageTimeoutMs(120_000) },
    JSON.stringify({
      entrypointArguments: nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT),
      environment: pluginRuntimeEnvironment(runtime),
      brokerConfiguration,
      syntheticApiKey: syntheticCodexApiKey,
    }),
  );
  assert.match(stdout, /native-thread-sandbox-confirmed/);
}
