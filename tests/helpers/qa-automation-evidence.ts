import assert from "node:assert/strict";
import {
  PLUGIN_RUNTIME_HELPERS,
  RUNTIME_READINESS_PATH,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { createQaAgent, createQaInstallation } from "./qa-installation.mjs";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

// Inspect only one test-owned session. Export tool names/counts and marker facts,
// never prompts, model credentials, app identities or full native transcripts.
const gatewayProgram = String.raw`
const { DatabaseSync } = require("node:sqlite");
const { zstdDecompressSync } = require("node:zlib");
observationStage="gateway-database-open";
const db = new DatabaseSync("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", {readOnly:true});
try {
  db.exec("PRAGMA busy_timeout=5000");
  // Native cron removes the exact-run alias after base persistence; its stable
  // owner keeps the transcript. Never follow a different session generation.
  observationStage="gateway-session-owner-read";
  const session = db.prepare("SELECT current_session_id,entry_json FROM session_nodes WHERE session_key=?").get(input.retainedSessionKey);
  observationStage="gateway-session-owner-identity";
  if (!session || session.current_session_id !== input.sessionId) throw new Error("exact session unavailable");
  observationStage="gateway-report-read";
  const hasSnapshots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_entry_snapshots'").get();
  const snapshot = hasSnapshots ? db.prepare("SELECT value_json FROM session_entry_snapshots WHERE session_key=? AND field='systemPromptReport'").get(input.retainedSessionKey) : undefined;
  const report = snapshot ? JSON.parse(snapshot.value_json) : JSON.parse(session.entry_json).systemPromptReport;
  observationStage="gateway-report-provenance";
  if (report?.source !== "run" || report.sessionId !== input.sessionId || !Array.isArray(report.tools?.entries)) throw new Error("run-owned tool report unavailable");
  observationStage="gateway-tool-inventory";
  const direct = report.tools.entries.map(t => t.name);
  const directToolNames=direct.map(name=>typeof input.approved==="string"&&name===input.approved?input.approved:"unapproved");
  const deferred = report.tools.deferred?.entries ?? [];
  if (!direct.every(n => typeof n === "string") || !Array.isArray(deferred)) throw new Error("invalid tool inventory");
  observationStage="gateway-transcript-read";
  const rows = db.prepare("SELECT event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq").all(input.sessionId);
  if (rows.length > 20000) throw new Error("transcript exceeds proof limit");
  let promptSeen=false, answerSeen=false, toolCalls=0, toolResults=0;const calledToolNames=[],calls=[],results=[];
  for (const row of rows) {
    observationStage="gateway-transcript-decode";
    const text = row.event_json ?? zstdDecompressSync(row.event_zstd, {maxOutputLength:8388608}).toString("utf8");
    observationStage="gateway-transcript-integrity";
    if (row.event_utf8_bytes != null && Buffer.byteLength(text)!==row.event_utf8_bytes) throw new Error("transcript length mismatch");
    observationStage="gateway-transcript-parse";
    const event = JSON.parse(text);
    const message = event.type === "message" ? event.message : undefined;
    if (!message) continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const textContent = typeof message.content === "string" ? message.content : blocks.filter(b=>b.type==="text").map(b=>b.text??"").join("\n");
    if (message.role === "user" && textContent.includes(input.marker)) promptSeen=true;
    if (message.role === "assistant" && textContent.includes(input.marker)) answerSeen=true;
    for(const block of blocks.filter(b=>["toolCall","tool_use","function_call","custom_tool_call"].includes(b.type))){toolCalls++;const name=block.name??block.toolName??block.tool_name;calledToolNames.push(typeof input.approved==="string"&&name===input.approved?input.approved:"unapproved");calls.push({type:block.type,id:block.id,name})}
    if (message.role === "toolResult" || message.role === "tool") {toolResults++;results.push(message)}
  }
  let approvedPair=false,approvedCallHash,executionSource=false,knownOutcome=false,auditSucceeded=false;
  if(typeof input.approved==="string"&&calls.length===1&&results.length===1){
    const call=calls[0],result=results[0];
    approvedPair=call.type==="toolCall"&&typeof call.id==="string"&&call.id.length>0&&call.name===input.approved&&result.role==="toolResult"&&result.toolCallId===call.id&&result.toolName===input.approved&&result.isError===false;
    if(approvedPair){
      approvedCallHash=require("node:crypto").createHash("sha256").update(call.id).digest("hex");
      const output=result.__openclaw?.toolOutput;
      executionSource=output?.source==="execution";
      knownOutcome=output?.outcome===undefined;
      observationStage="gateway-audit-read";
      const ledger=new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite",{readOnly:true});
      try {
        ledger.exec("PRAGMA busy_timeout=5000");
        const query=ledger.prepare("SELECT action,status,error_code,run_id FROM audit_events WHERE kind='tool_action' AND session_id=? AND tool_call_id=?");
        const deadline=Date.now()+10000,wait=new Int32Array(new SharedArrayBuffer(4));
        let entries=[],terminal=[];
        do {
          entries=query.all(input.sessionId,"sha256:"+approvedCallHash);
          terminal=entries.filter(entry=>entry.action==="tool.action.finished");
          if(terminal.length>0||Date.now()>=deadline) break;
          Atomics.wait(wait,0,0,100);
        } while(true);
        const runs=new Set(entries.map(entry=>entry.run_id).filter(id=>typeof id==="string"&&id.length>0));
        auditSucceeded=entries.length>0&&runs.size===1&&entries.every(entry=>typeof entry.run_id==="string"&&runs.has(entry.run_id))&&terminal.length===1&&terminal[0].status==="succeeded"&&terminal[0].error_code==null;
      } finally {ledger.close()}
    }
  }
  console.log(JSON.stringify({sessionId:input.sessionId, historySessionKey:input.sessionKey, retainedSessionKey:input.retainedSessionKey, reportSource:report.source,
    directToolNames, deferredToolCount:deferred.length, promptSeen,answerSeen,toolCalls,toolResults,calledToolNames,approvedPair,approvedCallHash,executionSource,knownOutcome,auditSucceeded}));
} finally { db.close(); }
`;

const codexRolloutProgram = String.raw`
function findNativeRun() {
  const fs=require("node:fs"), path=require("node:path"), zlib=require("node:zlib");
  const home=process.env.CODEX_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("native Codex home unavailable");
  const found=new Map(); let files=0;
  function visit(directory,depth=0) {
    if (!fs.existsSync(directory)) return;
    if (depth>8) throw new Error("native history depth exceeds proof limit");
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if (entry.isDirectory()) { visit(file,depth+1); continue; }
      if (!entry.isFile() || !/\.jsonl(?:\.zst)?$/.test(file)) continue;
      if (++files>1000) throw new Error("native history exceeds proof limit");
      if (fs.statSync(file).size>8388608) throw new Error("native rollout exceeds proof limit");
      let bytes=fs.readFileSync(file);
      if (file.endsWith(".zst")) bytes=zlib.zstdDecompressSync(bytes,{maxOutputLength:8388608});
      const text=bytes.toString("utf8");
      if (!text.includes(input.marker)) continue;
      const lines=text.split("\n"); lines.pop(); // A live append may have an incomplete last line.
      const rows=lines.filter(Boolean).map(line=>JSON.parse(line));
      const meta=rows.find(row=>row.type==="session_meta")?.payload;
      if (!meta || typeof meta.id!=="string") continue;
      const dynamic=meta.dynamic_tools ?? [];
      if (!Array.isArray(dynamic)) throw new Error("native dynamic tool metadata invalid");
      let promptSeen=false,answerSeen=false,toolCalls=0;const calledToolNames=[],calls=[],outputs=[];
      const turns=new Set();
      for (const row of rows) {
        const p=row.payload;
        if (!p || typeof p!=="object") continue;
        if (row.type==="turn_context" && typeof p.turn_id==="string") turns.add(p.turn_id);
        if (row.type==="response_item") {
          if (["function_call","custom_tool_call","local_shell_call","web_search_call","mcp_call","computer_call","image_generation_call","code_interpreter_call"].includes(p.type)){toolCalls++;const name=p.name??p.tool_name??p.tool??p.type;calledToolNames.push(typeof input.approved==="string"&&name===input.approved?input.approved:"unapproved");calls.push(p)}
          if(p.type==="function_call_output") outputs.push(p);
          if (p.type==="message" && Array.isArray(p.content)) {
            const text=p.content.map(b=>b.text??"").join("\n");
            if (p.role==="user" && text.includes(input.marker)) promptSeen=true;
            if (p.role==="assistant" && text.includes(input.marker)) answerSeen=true;
          }
        }
        if (row.type==="event_msg" && p.type==="agent_message" && typeof p.message==="string" && p.message.includes(input.marker)) answerSeen=true;
      }
      const approvedDirectDeclaration=typeof input.approved==="string"&&dynamic.length===1&&dynamic[0]?.type==="function"&&dynamic[0].name===input.approved;
      const call=calls[0],output=outputs[0];
      const approvedDirectCall=typeof input.approved==="string"&&calls.length===1&&outputs.length===1&&call.type==="function_call"&&call.name===input.approved&&typeof call.call_id==="string"&&call.call_id.length>0&&output.call_id===call.call_id;
      const approvedCallHash=approvedDirectCall?require("node:crypto").createHash("sha256").update(call.call_id).digest("hex"):undefined;
      if (promptSeen) found.set(meta.id,{threadId:meta.id,turnIds:[...turns],dynamicToolCount:dynamic.length,approvedDirectDeclaration,approvedDirectCall,approvedCallHash,promptSeen,answerSeen,toolCalls,calledToolNames});
    }
  }
  visit(path.join(home,"sessions")); visit(path.join(home,"archived_sessions"));
  if (found.size>1) throw new Error("marker matched multiple native threads");
  return [...found.values()][0];
}
`;

const codexObservationProgram = String.raw`
${PLUGIN_RUNTIME_HELPERS}
${codexRolloutProgram}
const liveObservation={}; let observationStage="native-thread";
(async () => {
  const deadline=Date.now()+180000;
  let run;
  while (!(run=findNativeRun()) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,200));
  if (!run) throw new Error("native marker thread unavailable");
  liveObservation.threadId=run.threadId;
  observationStage="native-authenticated-transport";
  const port=pluginRuntimeStatusPort();
  if (port===undefined) throw new Error("local native status unavailable");
  const statusResponse=await fetch("http://127.0.0.1:"+port+PLUGIN_STATUS_PATH,{signal:AbortSignal.timeout(15000)});
  if (statusResponse.status!==200) throw new Error("local native status unavailable");
  const status=await statusResponse.json();
  if (status?.revisionId!==pluginRuntimeRevisionId() || status.container!=="agent" || status.phase!=="ready" || typeof status.startupId!=="string") throw new Error("native status identity mismatch");
  process.env.APP_SERVER_TOKEN=derivePluginAppServerToken(status.startupId);
  async function pageAll(method,base) {
    const data=[]; let cursor; const seen=new Set();
    do {
      const page=await codexAppServerRequest(method,{...base,...(cursor?{cursor}:{}),limit:100});
      if (!Array.isArray(page.data)) throw new Error("native observation page unavailable");
      data.push(...page.data); cursor=page.nextCursor;
      if (cursor && (typeof cursor!=="string" || seen.has(cursor))) throw new Error("invalid native cursor");
      if (cursor) seen.add(cursor);
      if (data.length>5000) throw new Error("native observation exceeds proof limit");
    } while (cursor);
    return data;
  }
  observationStage="native-feature-flags";
  const features=await pageAll("experimentalFeature/list",{threadId:run.threadId});
  const selected={};
  for (const feature of features) {
    if (typeof feature.name!=="string" || typeof feature.enabled!=="boolean" || Object.hasOwn(selected,feature.name)) throw new Error("native feature metadata invalid");
    selected[feature.name]=feature.enabled;
  }
  liveObservation.features=selected;
  observationStage="native-mcp-discovery-metadata";
  const servers=await pageAll("mcpServerStatus/list",{threadId:run.threadId,detail:"toolsAndAuthOnly"});
  let mcpToolCount=0;
  for (const server of servers) {
    if (!server.tools || typeof server.tools!=="object" || Array.isArray(server.tools)) throw new Error("native MCP inventory unavailable");
    mcpToolCount+=Object.keys(server.tools).length;
  }
  liveObservation.mcpDiscoveryToolCount=mcpToolCount;
  liveObservation.mcpServerCount=servers.length;
  observationStage="native-app-discovery-metadata";
  const installed=await codexAppServerRequest("app/installed",{threadId:run.threadId});
  if (!Array.isArray(installed.apps) || installed.apps.some(a=>typeof a.callable!=="boolean")) throw new Error("native app inventory unavailable");
  liveObservation.appCallableMetadataCount=installed.apps.filter(a=>a.callable).length;
  console.log(JSON.stringify(liveObservation));
})().catch(() => { console.log(JSON.stringify({...liveObservation,unavailable:observationStage})); });
`;

function program(input: object, body: string) {
  return `const input=${JSON.stringify(input)};\n${body}`;
}

function gatewayObservationProgram(input: object) {
  return program(
    input,
    `let observationStage="gateway-module"; try { ${gatewayProgram} } catch (error) {
      const category=error instanceof SyntaxError?"json":error?.code==="ERR_SQLITE_ERROR"?"sqlite":error?.code==="ERR_INVALID_ARG_TYPE"?"invalid-storage-value":"invariant";
      process.stderr.write(JSON.stringify({evidenceUnavailable:true,stage:observationStage,category})); process.exitCode=1;
    }`,
  );
}

async function observe(f: Fixture, agent: Agent, role: "gateway" | "agent", body: string) {
  const result = await f.execRole(agent, role, ["node", "-e", ...nodeProgramArguments(body)]);
  const value = asRecord(JSON.parse(result.stdout));
  assert.ok(value, "runtime observation must be an object");
  return value;
}

const imageDigestPattern = /^sha256:[a-f0-9]{64}$/u;
function immutableImageDigest(reference: unknown, reason: string): string {
  assert.ok(typeof reference === "string", reason);
  const digest = reference.match(/@(sha256:[a-f0-9]{64})$/u)?.[1];
  assert.ok(digest && imageDigestPattern.test(digest), reason);
  return digest;
}

function imageCommandEnvironment(f: Fixture): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]);
  return Object.fromEntries(Object.entries(f.env).filter(([name]) => allowed.has(name)));
}

function fixtureNode(f: Fixture, nodeName: string): void {
  assert.ok(
    nodeName.startsWith("k3d-" + f.cluster + "-") && /-(?:server|agent)-[0-9]+$/u.test(nodeName),
    "the scheduled node must belong to the QA fixture",
  );
}

// Keep OCI bytes inside the scheduled node and exact Agent container. The parser
// hashes each blob before it extracts only the identity facts needed by this proof.
const imageMetadataProgram = String.raw`
const fs=require("node:fs"),crypto=require("node:crypto");
try {
  const [digest,platform,revision]=process.argv.slice(1),chunks=[];let total=0;
  const part=Buffer.alloc(65536);for(;;){const count=fs.readSync(0,part,0,part.length,null);if(!count)break;
    total+=count;if(total>4194304)throw new Error("metadata limit");chunks.push(Buffer.from(part.subarray(0,count)));}
  const bytes=Buffer.concat(chunks);if("sha256:"+crypto.createHash("sha256").update(bytes).digest("hex")!==digest)throw new Error("digest mismatch");
  const value=JSON.parse(bytes.toString("utf8")),valid=/^sha256:[a-f0-9]{64}$/;
  const [os,architecture]=platform.split("/");let result;
  if(["application/vnd.oci.image.index.v1+json","application/vnd.docker.distribution.manifest.list.v2+json"].includes(value.mediaType)){
    if(!Array.isArray(value.manifests))throw new Error("index unavailable");
    const matches=value.manifests.filter(item=>item?.platform?.os===os&&item.platform.architecture===architecture);
    if(matches.length!==1||!valid.test(matches[0].digest))throw new Error("platform unavailable");
    result={kind:"index",manifestDigest:matches[0].digest};
  }else if(["application/vnd.oci.image.manifest.v1+json","application/vnd.docker.distribution.manifest.v2+json"].includes(value.mediaType)){
    if(!valid.test(value.config?.digest))throw new Error("config unavailable");result={kind:"manifest",configDigest:value.config.digest};
  }else{
    if(value.os!==os||value.architecture!==architecture||value.config?.Labels?.["org.opencontainers.image.revision"]!==revision)throw new Error("config identity unavailable");
    result={kind:"config",platformMatches:true,sourceRevisionMatches:true};
  }
  process.stdout.write(JSON.stringify(result));
}catch{process.stderr.write("image metadata unavailable");process.exitCode=1;}
`;

async function imageMetadata(
  f: Fixture,
  nodeName: string,
  containerID: string,
  digest: string,
  platform: string,
  sourceRevision: string,
) {
  fixtureNode(f, nodeName);
  const id = /^containerd:\/\/([a-f0-9]{64})$/u.exec(containerID)?.[1];
  assert.ok(
    id && imageDigestPattern.test(digest),
    "the exact fixture container and image digest are required",
  );
  const output = String(
    await f.run(
      "docker",
      [
        "exec",
        nodeName,
        "sh",
        "-ec",
        'set -o pipefail; ctr -n k8s.io content get "$1" | crictl exec -i "$2" node -e "$3" "$1" "$4" "$5"',
        "verify-agent-image",
        digest,
        id,
        imageMetadataProgram,
        platform,
        sourceRevision,
      ],
      {
        env: imageCommandEnvironment(f),
        timeout: 15_000,
        maxBuffer: 16 * 1024,
        privateFailureOutput: true,
      },
    ),
  );
  const result = asRecord(JSON.parse(output));
  assert.ok(result, "the installed image metadata proof must be an object");
  return result;
}

async function installedRoleImage(
  f: Fixture,
  nodeName: string,
  containerID: string,
  roleDigest: string,
  platform: string,
) {
  const sourceRevision = String(
    await f.run("git", ["rev-parse", "HEAD"], {
      env: imageCommandEnvironment(f),
      timeout: 15_000,
      privateFailureOutput: true,
    }),
  ).trim();
  assert.ok(/^[a-f0-9]{40}$/u.test(sourceRevision), "the QA source revision must be exact");
  const root = await imageMetadata(f, nodeName, containerID, roleDigest, platform, sourceRevision);
  let manifestDigest = roleDigest;
  let manifest = root;
  if (root.kind === "index") {
    assert.ok(
      typeof root.manifestDigest === "string" && imageDigestPattern.test(root.manifestDigest),
      "the installed Agent index must select one scheduled platform image",
    );
    manifestDigest = root.manifestDigest;
    manifest = await imageMetadata(
      f,
      nodeName,
      containerID,
      manifestDigest,
      platform,
      sourceRevision,
    );
  }
  assert.ok(
    manifest.kind === "manifest" &&
      typeof manifest.configDigest === "string" &&
      imageDigestPattern.test(manifest.configDigest),
    "the installed Agent platform image must name a config digest",
  );
  const configDigest = manifest.configDigest;
  const config = await imageMetadata(
    f,
    nodeName,
    containerID,
    configDigest,
    platform,
    sourceRevision,
  );
  assert.ok(
    config.kind === "config" &&
      config.platformMatches === true &&
      config.sourceRevisionMatches === true,
    "the installed Agent config must match the scheduled platform and exact QA source",
  );
  return { sourceRevision, manifestDigest, configDigest };
}

async function scheduledPlatform(
  f: Fixture,
  pod: unknown,
): Promise<{ nodeName: string; platform: string }> {
  const nodeName = asRecord(asRecord(pod)?.spec)?.nodeName;
  assert.ok(typeof nodeName === "string" && nodeName.length > 0, "the Agent Pod must be scheduled");
  const node = asRecord(JSON.parse(await f.kubectl("get", "node", nodeName, "-o", "json")));
  const metadata = asRecord(node?.metadata);
  const status = asRecord(node?.status);
  const info = asRecord(status?.nodeInfo);
  assert.ok(
    metadata?.name === nodeName &&
      typeof metadata.uid === "string" &&
      info?.operatingSystem === "linux" &&
      (info.architecture === "amd64" || info.architecture === "arm64"),
    "the scheduled Agent node must expose a supported exact platform",
  );
  return { nodeName, platform: "linux/" + info.architecture };
}

async function runningConfigDigest(
  f: Fixture,
  nodeName: string,
  containerID: string,
  podUID: string,
): Promise<string> {
  const id = /^containerd:\/\/([a-f0-9]{64})$/u.exec(containerID)?.[1];
  fixtureNode(f, nodeName);
  assert.ok(id, "the exact fixture containerd container is required");
  const fields =
    '{{.status.id}}{{" "}}{{index .status.labels "io.kubernetes.pod.uid"}}{{" "}}{{if .status.imageId}}{{.status.imageId}}{{else}}{{.info.config.image.image}}{{end}}';
  const output = String(
    await f.run(
      "docker",
      ["exec", nodeName, "crictl", "inspect", "--output=go-template", "--template", fields, id],
      { env: imageCommandEnvironment(f), timeout: 15_000, privateFailureOutput: true },
    ),
  );
  const [actualID, actualUID, digest] = output.trim().split(/ +/u);
  assert.ok(
    actualID === id && actualUID === podUID && digest && imageDigestPattern.test(digest),
    "the runtime must inspect the exact scheduled Agent container",
  );
  return digest;
}

/** Read the managed native feature requirements in the exact dedicated Agent Pod. */
export async function readQaCodexAutomationRequirements(f: Fixture, agent: Agent) {
  assert.equal(agent.preset, "Codex");
  const before = await f.pod(agent, "agent");
  const container = before.spec.containers.find(
    (value: { name: string }) => value.name === "agent",
  );
  const status = before.status.containerStatuses.find(
    (value: { name: string }) => value.name === "agent",
  );
  assert.ok(
    container &&
      status &&
      typeof container.image === "string" &&
      typeof status.imageID === "string" &&
      typeof status.containerID === "string" &&
      status.containerID.length > 0 &&
      before.status.phase === "Running" &&
      status.ready === true &&
      typeof before.metadata.uid === "string" &&
      before.metadata.labels["openclaw.dev/agent"] === agent.id &&
      before.metadata.labels["openclaw.dev/workload-role"] === "agent" &&
      before.metadata.labels["openclaw.dev/revision"] === agent.revision.id,
    "the exact dedicated Agent Pod and container must be ready",
  );
  const marker = Array.isArray(container.env)
    ? container.env.filter(
        (value: { name?: string; value?: string }) =>
          value.name === "OCE_CODEX_AUTOMATION_REQUIREMENTS",
      )
    : [];
  const probe = asRecord(container.readinessProbe);
  const http = asRecord(probe?.httpGet);
  const ready = Array.isArray(before.status.conditions)
    ? before.status.conditions.filter((value: { type?: string }) => value.type === "Ready")
    : [];
  assert.ok(
    marker.length === 1 &&
      marker[0]?.value === "required" &&
      http?.path === RUNTIME_READINESS_PATH &&
      http.port === "plugin-status" &&
      ready.length === 1 &&
      ready[0]?.status === "True",
    "the exact Agent Pod must pass the required resident automation readiness probe",
  );
  // This is the launcher input, not proof that the independently selected Agent role descends from it.
  const selectedSource = process.env.OCC_TEST_QA_RUNTIME_IMAGE;
  const selectedSourceDigestInput =
    selectedSource === undefined
      ? null
      : immutableImageDigest(selectedSource, "the selected QA runtime source must be immutable");
  const { nodeName, platform } = await scheduledPlatform(f, before);
  const compute = asRecord(
    asRecord(asRecord(asRecord(asRecord(f)?.configuration)?.drivers)?.compute)?.configuration,
  );
  const roleImage = asRecord(compute?.images)?.agent;
  const selectedAgentRoleDigest = immutableImageDigest(
    roleImage,
    "the dedicated Agent role image must be immutable",
  );
  assert.ok(
    container.image === roleImage,
    "the Agent Pod must select its configured Compute role image",
  );
  const image = await installedRoleImage(
    f,
    nodeName,
    status.containerID,
    selectedAgentRoleDigest,
    platform,
  );
  const observedImageDigest = status.imageID.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  assert.ok(observedImageDigest, "the observed Agent image identity must be immutable");
  let inspectedRunningConfigDigest: string | null = null;
  if (
    observedImageDigest === selectedAgentRoleDigest &&
    selectedAgentRoleDigest !== image.manifestDigest
  ) {
    inspectedRunningConfigDigest = await runningConfigDigest(
      f,
      nodeName,
      status.containerID,
      before.metadata.uid,
    );
    assert.ok(
      inspectedRunningConfigDigest === image.configDigest,
      "the running Agent container must use the selected platform config",
    );
  } else {
    assert.ok(
      observedImageDigest === image.manifestDigest || observedImageDigest === image.configDigest,
      "the observed Agent image must match the installed platform manifest or config",
    );
  }
  const after = await f.pod(agent, "agent");
  assert.ok(
    after.metadata.uid === before.metadata.uid &&
      after.metadata.labels["openclaw.dev/agent"] === agent.id &&
      after.metadata.labels["openclaw.dev/workload-role"] === "agent" &&
      after.metadata.labels["openclaw.dev/revision"] === agent.revision.id &&
      after.spec.nodeName === nodeName,
    "the exact Agent Pod, revision and scheduled node must remain",
  );
  const afterContainer = after.spec.containers.find(
    (value: { name: string }) => value.name === "agent",
  );
  const afterStatus = after.status.containerStatuses.find(
    (value: { name: string }) => value.name === "agent",
  );
  assert.ok(
    afterContainer?.image === container.image &&
      afterStatus?.imageID === status.imageID &&
      afterStatus?.containerID === status.containerID &&
      afterStatus?.ready === true,
    "the exact Agent container and image must remain",
  );
  // With the required marker, the resident probe returns ready only after the
  // native server reports all four feature requirements as false.
  return {
    markerRequired: true,
    revisionMatches: true,
    requirementsEvidenceSource: "resident-readiness" as const,
    readinessDerivedDisabled: {
      code_mode_host: true,
      code_mode: true,
      code_mode_only: true,
      sleep_tool: true,
    },
    podIdentityMatches: true,
    sourceRevision: image.sourceRevision,
    scheduledPlatform: platform,
    selectedSourceDigestInput,
    selectedAgentRoleDigest,
    installedPlatformManifestDigest: image.manifestDigest,
    installedConfigDigest: image.configDigest,
    observedImageDigest,
    inspectedRunningConfigDigest,
  };
}

export function startQaCodexToolObservation(f: Fixture, agent: Agent, marker: string) {
  // Start before enabling: transient scheduled threads can unload immediately on completion.
  const observation = observe(f, agent, "agent", program({ marker }, codexObservationProgram));
  void observation.catch(() => {});
  return observation;
}

export async function readQaAutomationRunEvidence(
  f: Fixture,
  agent: Agent,
  input: { sessionKey: string; retainedSessionKey: string; sessionId: string; marker: string },
) {
  const gateway = await observe(f, agent, "gateway", gatewayObservationProgram(input));
  assert.equal(gateway.reportSource, "run");
  assert.equal(gateway.promptSeen, true);
  assert.equal(gateway.answerSeen, true);
  assert.deepEqual(
    gateway.directToolNames,
    [],
    "scheduled model must receive no direct Gateway tools",
  );
  assert.equal(
    gateway.deferredToolCount,
    0,
    "scheduled model must receive no deferred Gateway tools",
  );
  assert.equal(gateway.toolCalls, 0);
  assert.equal(gateway.toolResults, 0);
  if (agent.preset !== "Codex") {
    return { gateway };
  }
  const native = await observe(
    f,
    agent,
    "agent",
    program(
      input,
      `${codexRolloutProgram}\ntry { console.log(JSON.stringify(findNativeRun() ?? {unavailable:"native rollout missing"})); } catch { process.stderr.write("Native automation rollout evidence unavailable."); process.exitCode=1; }`,
    ),
  );
  assert.equal(native.promptSeen, true);
  assert.equal(native.answerSeen, true);
  assert.equal(native.dynamicToolCount, 0);
  assert.equal(native.toolCalls, 0, "native shell/code/MCP/delegation calls must be absent");
  return { gateway, native };
}

/** Native observations are partial; never promote discovery or non-use into a full tool inventory. */
export function qaCodexObservationLimits(
  value: Record<string, unknown>,
  threadId: unknown,
): string[] {
  const limits: string[] = [];
  if (value.unavailable !== undefined) {
    limits.push(`Native per-thread observation unavailable at ${String(value.unavailable)}.`);
  }
  if (value.threadId === undefined) {
    limits.push("The live native observation did not identify a thread.");
  } else {
    assert.equal(
      value.threadId,
      threadId,
      "native observations must identify the exact completed thread",
    );
  }
  const features = asRecord(value.features);
  for (const name of ["code_mode", "shell_tool", "unified_exec"]) {
    if (features?.[name] !== false) {
      limits.push(
        `Native ${name} is ${features?.[name] === true ? "enabled" : "unobserved"}; its disabled state was not established.`,
      );
    }
  }
  // The pinned native protocol exposes feature state, but config/read accepts
  // cwd, not a thread ID. Neither it nor the rollout exposes the transient
  // thread's non-feature controls: web_search, tools.update_plan.enabled,
  // tools.experimental_request_user_input.enabled and orchestrator overrides.
  // Dynamic declarations and no observed calls cannot fill this inventory gap.
  limits.push(
    "The collected per-thread feature and discovery APIs do not expose a complete resolved built-in tool inventory, including web/search, plan, user-input and orchestrator controls.",
  );
  if (typeof value.mcpDiscoveryToolCount !== "number" || typeof value.mcpServerCount !== "number") {
    limits.push("Native per-thread MCP discovery metadata is unavailable.");
  } else if (value.mcpDiscoveryToolCount > 0) {
    limits.push(
      "Native MCP discovery advertises tools; effective model-callable filtering is not established by discovery metadata.",
    );
  }
  if (typeof value.appCallableMetadataCount !== "number") {
    limits.push("Native per-thread app metadata is unavailable.");
  } else if (value.appCallableMetadataCount > 0) {
    limits.push(
      "Native app metadata advertises callable apps; complete model-callable policy was not observed.",
    );
  }
  return limits;
}

/** Inspect the exact completed run and reject calls outside its captured MCP cap. */
export async function readQaAutomationMcpRunEvidence(
  f: Fixture,
  agent: Agent,
  input: { sessionKey: string; retainedSessionKey: string; sessionId: string; marker: string },
  approved: string,
) {
  const gateway = await observe(
    f,
    agent,
    "gateway",
    gatewayObservationProgram({ ...input, approved }),
  );
  assert.equal(gateway.reportSource, "run");
  assert.equal(gateway.promptSeen, true);
  assert.equal(gateway.answerSeen, true);
  assert.ok(Array.isArray(gateway.directToolNames));
  assert.ok(
    gateway.directToolNames.every((name) => name === approved),
    "the run must not expose unrelated Gateway tools",
  );
  assert.equal(gateway.deferredToolCount, 0);
  assert.ok(Array.isArray(gateway.calledToolNames));
  assert.ok(
    gateway.calledToolNames.every((name) => name === approved),
    "the Gateway transcript must not contain a forbidden call",
  );
  assert.equal(gateway.toolCalls, 1, "the Gateway must record exactly one approved call");
  assert.equal(gateway.toolResults, 1, "the Gateway must record exactly one result");
  assert.equal(
    gateway.approvedPair,
    true,
    "the approved Gateway call and successful result must share one exact ID and name",
  );
  assert.equal(
    gateway.auditSucceeded,
    true,
    "the exact approved call needs one authoritative successful terminal audit",
  );
  assert.equal(typeof gateway.approvedCallHash, "string");
  if (agent.preset !== "Codex") {
    return { gateway };
  }
  assert.equal(gateway.executionSource, true, "the Codex result must come from tool execution");
  assert.equal(gateway.knownOutcome, true, "an explicit Codex outcome is not established success");
  const native = await observe(
    f,
    agent,
    "agent",
    program(
      { ...input, approved },
      `${codexRolloutProgram}\nconsole.log(JSON.stringify(findNativeRun()??{}));`,
    ),
  );
  assert.equal(native.promptSeen, true);
  assert.equal(native.answerSeen, true);
  assert.equal(native.dynamicToolCount, 1, "the native thread must declare exactly one tool");
  assert.equal(
    native.approvedDirectDeclaration,
    true,
    "the native thread must declare the exact approved direct function",
  );
  assert.equal(
    native.approvedDirectCall,
    true,
    "the native call must be one direct function_call with one matching output",
  );
  assert.equal(
    native.approvedCallHash,
    gateway.approvedCallHash,
    "native and Gateway evidence must identify the same approved call",
  );
  assert.deepEqual(
    native.calledToolNames,
    [approved],
    "the native transcript must contain only the exact approved direct function call",
  );
  return { gateway, native };
}
