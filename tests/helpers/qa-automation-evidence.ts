import assert from "node:assert/strict";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
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
const db = new DatabaseSync("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", {readOnly:true});
try {
  db.exec("PRAGMA busy_timeout=5000");
  const session = db.prepare("SELECT current_session_id,entry_json FROM session_nodes WHERE session_key=?").get(input.sessionKey);
  if (!session || session.current_session_id !== input.sessionId) throw new Error("exact session unavailable");
  const hasSnapshots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_entry_snapshots'").get();
  const snapshot = hasSnapshots ? db.prepare("SELECT value_json FROM session_entry_snapshots WHERE session_key=? AND field='systemPromptReport'").get(input.sessionKey) : undefined;
  const report = snapshot ? JSON.parse(snapshot.value_json) : JSON.parse(session.entry_json).systemPromptReport;
  if (report?.source !== "run" || report.sessionId !== input.sessionId || !Array.isArray(report.tools?.entries)) throw new Error("run-owned tool report unavailable");
  const direct = report.tools.entries.map(t => t.name);
  const deferred = report.tools.deferred?.entries ?? [];
  if (!direct.every(n => typeof n === "string") || !Array.isArray(deferred)) throw new Error("invalid tool inventory");
  const rows = db.prepare("SELECT event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq").all(input.sessionId);
  if (rows.length > 20000) throw new Error("transcript exceeds proof limit");
  let promptSeen=false, answerSeen=false, toolCalls=0, toolResults=0;
  for (const row of rows) {
    const text = row.event_json ?? zstdDecompressSync(row.event_zstd, {maxOutputLength:8388608}).toString("utf8");
    if (row.event_utf8_bytes != null && Buffer.byteLength(text)!==row.event_utf8_bytes) throw new Error("transcript length mismatch");
    const event = JSON.parse(text);
    const message = event.type === "message" ? event.message : undefined;
    if (!message) continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const textContent = typeof message.content === "string" ? message.content : blocks.filter(b=>b.type==="text").map(b=>b.text??"").join("\n");
    if (message.role === "user" && textContent.includes(input.marker)) promptSeen=true;
    if (message.role === "assistant" && textContent.includes(input.marker)) answerSeen=true;
    toolCalls += blocks.filter(b=>["toolCall","tool_use","function_call","custom_tool_call"].includes(b.type)).length;
    if (message.role === "toolResult" || message.role === "tool") toolResults++;
  }
  console.log(JSON.stringify({sessionId:input.sessionId, reportSource:report.source,
    directToolNames:direct, deferredToolCount:deferred.length, promptSeen,answerSeen,toolCalls,toolResults}));
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
      let promptSeen=false,answerSeen=false,toolCalls=0;
      const turns=new Set();
      for (const row of rows) {
        const p=row.payload;
        if (!p || typeof p!=="object") continue;
        if (row.type==="turn_context" && typeof p.turn_id==="string") turns.add(p.turn_id);
        if (row.type==="response_item") {
          if (["function_call","custom_tool_call","local_shell_call","web_search_call","mcp_call","computer_call","image_generation_call","code_interpreter_call"].includes(p.type)) toolCalls++;
          if (p.type==="message" && Array.isArray(p.content)) {
            const text=p.content.map(b=>b.text??"").join("\n");
            if (p.role==="user" && text.includes(input.marker)) promptSeen=true;
            if (p.role==="assistant" && text.includes(input.marker)) answerSeen=true;
          }
        }
        if (row.type==="event_msg" && p.type==="agent_message" && typeof p.message==="string" && p.message.includes(input.marker)) answerSeen=true;
      }
      if (promptSeen) found.set(meta.id,{threadId:meta.id,turnIds:[...turns],dynamicToolCount:dynamic.length,promptSeen,answerSeen,toolCalls});
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

async function observe(f: Fixture, agent: Agent, role: "gateway" | "agent", body: string) {
  const result = await f.execRole(agent, role, ["node", "-e", ...nodeProgramArguments(body)]);
  const value = asRecord(JSON.parse(result.stdout));
  assert.ok(value, "runtime observation must be an object");
  return value;
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
  input: { sessionKey: string; sessionId: string; marker: string },
) {
  const gateway = await observe(
    f,
    agent,
    "gateway",
    program(
      input,
      `try { ${gatewayProgram} } catch { process.stderr.write("Native automation session evidence unavailable."); process.exitCode=1; }`,
    ),
  );
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
export function qaCodexToolQualificationGaps(
  value: Record<string, unknown>,
  threadId: unknown,
): string[] {
  const gaps: string[] = [];
  if (value.unavailable !== undefined) {
    gaps.push(`Native per-thread observation unavailable at ${String(value.unavailable)}.`);
  }
  if (value.threadId === undefined) {
    gaps.push("The live native observation did not identify a thread.");
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
      gaps.push(
        `Native ${name} is ${features?.[name] === true ? "enabled" : "unobserved"}; its disabled state was not established.`,
      );
    }
  }
  // The pinned native protocol exposes feature state, but config/read accepts
  // cwd, not a thread ID. Neither it nor the rollout exposes the transient
  // thread's non-feature controls: web_search, tools.update_plan.enabled,
  // tools.experimental_request_user_input.enabled and orchestrator overrides.
  // Dynamic declarations and no observed calls cannot fill this inventory gap.
  gaps.push(
    "Native built-in tool qualification is incomplete: the collected per-thread feature and discovery APIs do not expose the resolved web/search, plan, user-input and orchestrator tool controls.",
  );
  if (typeof value.mcpDiscoveryToolCount !== "number" || typeof value.mcpServerCount !== "number") {
    gaps.push("Native per-thread MCP discovery metadata is unavailable.");
  } else if (value.mcpDiscoveryToolCount > 0) {
    gaps.push(
      "Native MCP discovery advertises tools; effective model-callable filtering is not established by discovery metadata.",
    );
  }
  if (typeof value.appCallableMetadataCount !== "number") {
    gaps.push("Native per-thread app metadata is unavailable.");
  } else if (value.appCallableMetadataCount > 0) {
    gaps.push(
      "Native app metadata advertises callable apps; complete model-callable policy was not observed.",
    );
  }
  return gaps;
}
