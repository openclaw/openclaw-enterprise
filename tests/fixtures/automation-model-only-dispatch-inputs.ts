import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { pluginRuntimeEnvironment } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createModelProbeCertificates } from "../helpers/runtime-model-probe-certificates.ts";
import { execute } from "../helpers/runtime-image-docker.ts";

export type DispatchProbeTool = "write" | "exec_command" | "exec";

export async function prepareDispatchInputs(
  directory: string,
  {
    nonce,
    harness,
    probeTool,
  }: { nonce: string; harness: "openclaw" | "codex"; probeTool: DispatchProbeTool },
) {
  await createModelProbeCertificates({ directory, caName: `oce-dispatch-${nonce}`, run: execute });
  await rm(join(directory, "ca-key.pem"));
  await writeFile(join(directory, "hosts"), "127.0.0.1 localhost\n127.0.0.1 api.openai.com\n");
  await writeFile(
    join(directory, "resolv.conf"),
    "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n",
  );
  const ordinary = createHarnessConfiguration(harness, "gpt-5");
  const configuration = {
    ...ordinary,
    agents: {
      defaults: {
        ...ordinary.agents.defaults,
        workspace: harness === "codex" ? "/home/node/workspace" : "/home/node/.openclaw/workspace",
      },
    },
    memory: { search: { enabled: false } },
  };
  if (harness === "openclaw") {
    const provider = configuration.models.providers.openai;
    assert.ok(provider);
    // This is the documented local-provider fixture transport exception, not a tool-policy override.
    Object.assign(provider, { request: { allowPrivateNetwork: true } });
  } else {
    const appServer = configuration.plugins?.entries.codex.config.appServer;
    assert.ok(appServer);
    Object.assign(appServer, {
      sandbox: "workspace-write",
      approvalPolicy: "never",
      remoteWorkspaceRoot: "/home/node/workspace",
    });
  }
  await writeFile(
    join(directory, "openclaw.json"),
    JSON.stringify(admitLoggingConfiguration(configuration, "info")),
  );
  for (const file of [
    "automation-model-only-dispatch-provider.mjs",
    "automation-model-only-dispatch-runtime.mjs",
  ]) {
    await writeFile(
      join(directory, file),
      await readFile(fileURLToPath(new URL(file, import.meta.url))),
    );
  }
  await chmod(directory, 0o755);
  for (const file of [
    "ca.pem",
    "cert.pem",
    "key.pem",
    "hosts",
    "resolv.conf",
    "openclaw.json",
    "automation-model-only-dispatch-provider.mjs",
    "automation-model-only-dispatch-runtime.mjs",
  ]) {
    await chmod(join(directory, file), 0o644);
  }
  const payload = {
    harness,
    nonce,
    probeTool,
    dummyCredential: `synthetic-api-key-${randomUUID()}`,
    gatewayPassword: `synthetic-gateway-${randomUUID()}`,
    transportToken: `synthetic-transport-${randomUUID()}`,
    gatewayEntrypoint: nodeProgramArguments(GATEWAY_RUNTIME_ENTRYPOINT),
    agentEntrypoint: nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT),
    agentEnvironment: pluginRuntimeEnvironment({
      kind: "codex",
      selections: {},
      approvalPolicy: "never",
    }),
  };
  await writeFile(join(directory, "input.json"), JSON.stringify(payload));
  await chmod(join(directory, "input.json"), 0o644); // Contains generated dummy credentials only.
  return payload;
}

export const dispatchEffectsScript = `const fs=require("node:fs"); const [root,nonce]=process.argv.slice(1);
const positive=root+"/occ-dispatch-positive-"+nonce; const negative=root+"/occ-dispatch-negative-"+nonce;
console.log(JSON.stringify({positiveMatches:fs.existsSync(positive)&&fs.readFileSync(positive,"utf8").trimEnd()==="OCE_DISPATCH_POSITIVE_"+nonce, negativeAbsent:!fs.existsSync(negative)}));`;

export function assertDispatchReport(
  report: Record<string, unknown> | undefined,
  harness: string,
  probeTool: DispatchProbeTool,
) {
  assert.ok(report, "supplemental dispatch report must be produced");
  assert.equal(report.kind, "supplemental-dispatch-projection", JSON.stringify(report));
  assert.equal(report.harness, harness);
  assert.equal(report.probeTool, probeTool);
  assert.equal(report.realProvider, false);
  assert.equal(report.positiveCorrelatedDispatchResult, true);
  assert.equal(report.negativeToolsEmpty, true);
  assert.equal(report.negativeCorrelatedRejection, true);
  assert.equal(report.nativeRunRecorded, true);
}
