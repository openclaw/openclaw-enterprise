import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { loadDispatchScenario } from "./automation-model-only-dispatch-scenarios.mjs";

export type DispatchProbe = "write" | "exec_command" | "exec" | "delegation" | "messaging";

export async function prepareDispatchInputs(
  directory: string,
  {
    nonce,
    harness,
    probe,
    nonemptyCap = false,
  }: { nonce: string; harness: "openclaw" | "codex"; probe: DispatchProbe; nonemptyCap?: boolean },
) {
  await createModelProbeCertificates({ directory, caName: `oce-dispatch-${nonce}`, run: execute });
  await rm(join(directory, "ca-key.pem"));
  await writeFile(join(directory, "hosts"), "127.0.0.1 localhost\n127.0.0.1 api.openai.com\n");
  await writeFile(
    join(directory, "resolv.conf"),
    "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n",
  );
  const scenario = probe === "delegation" || probe === "messaging" ? probe : undefined;
  const scenarioModule = await loadDispatchScenario(scenario, {
    nonce,
    harness,
    workspace: harness === "codex" ? "/home/node/workspace" : "/home/node/.openclaw/workspace",
  });
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
  if (nonemptyCap) {
    const peer = `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{let q;try{q=JSON.parse(line)}catch{return}if(q.id===undefined)return;let r;if(q.method==='initialize')r={protocolVersion:q.params?.protocolVersion??'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'qa',version:'1'}};else if(q.method==='tools/list')r={tools:[{name:'allowed_probe',description:'Record a local fixture effect',inputSchema:{type:'object',properties:{}}}]};else if(q.method==='tools/call'){fs.writeFileSync('/tmp/occ-dispatch-peer-${nonce}','called');r={content:[{type:'text',text:'called'}]}}else r={};send({jsonrpc:'2.0',id:q.id,result:r})});`;
    Object.assign(configuration, {
      tools: { profile: "full", codeMode: false, toolSearch: false },
      mcp: {
        servers: {
          qa: {
            transport: "stdio",
            command: "node",
            args: ["-e", peer],
            toolFilter: { include: ["allowed_probe"] },
            ...(harness === "codex" ? { codex: { defaultToolsApprovalMode: "approve" } } : {}),
          },
        },
      },
    });
  }
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
    JSON.stringify(
      admitLoggingConfiguration(
        scenarioModule?.module.configure?.(configuration, { nonce }) ?? configuration,
        "info",
      ),
    ),
  );
  const fixtureFiles = (await readdir(fileURLToPath(new URL(".", import.meta.url)))).filter(
    (file) => /^automation-model-only-(?:dispatch|delegation|messaging)-.*[.]mjs$/.test(file),
  );
  for (const file of fixtureFiles) {
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
    ...fixtureFiles,
  ]) {
    await chmod(join(directory, file), 0o644);
  }
  const payload = {
    harness,
    nonce,
    probe,
    nonemptyCap,
    scenario,
    scenarioEnvironment: scenarioModule?.module.environment?.({ nonce }) ?? {},
    fixtureFiles,
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

export const dispatchPeerEffectScript = `const fs=require("node:fs");console.log(JSON.stringify({peerEffectAbsent:!fs.existsSync("/tmp/occ-dispatch-peer-"+process.argv[1])}));`;

export const dispatchEffectsScript = `const fs=require("node:fs"); const [root,nonce]=process.argv.slice(1);
const positive=root+"/occ-dispatch-positive-"+nonce; const negative=root+"/occ-dispatch-negative-"+nonce;
console.log(JSON.stringify({positiveMatches:fs.existsSync(positive)&&fs.readFileSync(positive,"utf8").trimEnd()==="OCE_DISPATCH_POSITIVE_"+nonce, negativeAbsent:!fs.existsSync(negative)}));`;

export function assertDispatchReport(
  report: Record<string, unknown> | undefined,
  harness: string,
  probe: DispatchProbe,
  nonemptyCap = false,
) {
  assert.ok(report, "supplemental dispatch report must be produced");
  assert.equal(report.kind, "supplemental-dispatch-projection", JSON.stringify(report));
  assert.equal(report.harness, harness);
  assert.equal(report.probe, probe);
  assert.equal(report.realProvider, false);
  assert.equal(report.positiveCorrelatedDispatchResult, true);
  assert.equal(report.negativeToolsEmpty, !nonemptyCap);
  assert.equal(report.negativeMcpOnly, nonemptyCap);
  assert.equal(report.negativeCorrelatedRejection, true);
  assert.equal(report.nativeRunRecorded, true);
  if (probe === "delegation" || probe === "messaging") {
    const evidence = report.scenarioEvidence as Record<string, unknown> | undefined;
    assert.equal(evidence?.positiveEffectVerified, true, JSON.stringify(report));
    assert.equal(evidence?.negativeEffectAbsent, true, JSON.stringify(report));
  }
}
