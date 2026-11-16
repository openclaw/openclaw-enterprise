import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerFor, isNonce, promptFor, replyPrefix } from "./box-workload.ts";
const workspace = "/home/node/workspace";
const marker = join(workspace, ".oce-model-marker");
const gatewayUrl = "ws://127.0.0.1:18789";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {};
function privateRead(file: string, max: number) {
  const s = lstatSync(file);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    (s.mode & 0o077) !== 0 ||
    s.uid !== process.getuid?.() ||
    s.size < 1 ||
    s.size > max
  )
    throw Error("PRIVATE_INPUT_REFUSED");
  return readFileSync(file, "utf8");
}
function save(path: string, row: Obj) {
  writeFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600, flag: "wx" });
}
function checkMarker() {
  const st = lstatSync(marker, { bigint: true });
  if (
    !st.isFile() ||
    st.nlink !== 1n ||
    st.size !== 49n ||
    (st.mode & 0o077n) !== 0n ||
    st.uid !== BigInt(process.getuid?.() ?? -1)
  )
    throw Error("MARKER_IDENTITY_REFUSED");
  return {
    markerSha256: sha(Buffer.from(privateRead(marker, 49))),
    device: st.dev.toString(),
    inode: st.ino.toString(),
  };
}
function seed(root: string) {
  if (realpathSync(workspace) !== workspace) throw Error("WORKSPACE_PATH_REFUSED");
  writeFileSync(marker, randomBytes(24).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  save(join(root, "expected.json"), {
    ...checkMarker(),
    sessionKey: `agent:main:box-repro-${randomUUID()}`,
    nonce: randomBytes(24).toString("hex"),
  });
}
function textParts(message: Obj): string[] {
  if (typeof message.content === "string") return [message.content];
  return Array.isArray(message.content)
    ? message.content
        .map(obj)
        .flatMap((part) =>
          part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
    : [];
}
export function inspectHistory(
  value: unknown,
  key: string,
  nonce: string,
  digest: string,
): boolean {
  const result = obj(value);
  if (
    result.sessionKey !== key ||
    result.windowReset === true ||
    !Array.isArray(result.messages) ||
    result.messages.length < 2 ||
    result.messages.length > 8
  )
    return false;
  const rows = result.messages.map(obj);
  const users = rows.filter((message) => message.role === "user");
  const outputs = rows
    .filter((message) => message.role === "assistant")
    .flatMap((message) => textParts(message).filter((text) => text.includes(replyPrefix)));
  const last = rows.at(-1);
  const userText = textParts(users[0] ?? {});
  const finalText = textParts(last ?? {});
  const expected = answerFor(nonce, digest);
  return (
    users.length === 1 &&
    rows[0] === users[0] &&
    userText.length === 1 &&
    userText[0] === promptFor(nonce) &&
    last?.role === "assistant" &&
    finalText.length === 1 &&
    finalText[0] === expected &&
    outputs.length === 1 &&
    outputs[0] === expected
  );
}
export function inspectTerminal(value: unknown, runId: string): boolean {
  const result = obj(value);
  return result.runId === runId && result.status === "ok";
}
export function inspectFixture(
  rows: unknown[],
  nonce: string,
  marker: { markerSha256: string; device: string; inode: string },
): boolean {
  const [namespace, intent, result] = rows.map(obj);
  const callId = intent?.callId;
  return (
    rows.length === 3 &&
    namespace?.stage === "same_network_namespace" &&
    namespace.synthetic === true &&
    namespace.nonce === nonce &&
    intent?.stage === "tool_intent" &&
    intent.nonce === nonce &&
    typeof callId === "string" &&
    /^call_[a-f0-9-]{36}$/.test(callId) &&
    result?.stage === "tool_verified" &&
    result.nonce === nonce &&
    result.callId === callId &&
    result.uid === 0 &&
    result.device === marker.device &&
    result.inode === marker.inode &&
    result.markerSha256 === marker.markerSha256 &&
    result.shellAlternateDenied === true &&
    result.answer === answerFor(nonce, marker.markerSha256)
  );
}
export function inspectPolicyRecords(raw: string) {
  const path = "/opt/demo/verifier/oce-workspace-verifier";
  let allow = 0,
    deny = 0;
  const rows = raw.trimEnd().split("\n");
  if (rows.length > 10000) return false;
  for (const line of rows) {
    const root = obj(JSON.parse(line) as unknown);
    for (const r of Array.isArray(root.resourceLogs) ? root.resourceLogs.map(obj) : [])
      for (const scope of Array.isArray(r.scopeLogs) ? r.scopeLogs.map(obj) : [])
        for (const log of Array.isArray(scope.logRecords) ? scope.logRecords.map(obj) : []) {
          if (!Array.isArray(log.attributes)) continue;
          const a = new Map(log.attributes.map(obj).map((entry) => [entry.key, obj(entry.value)]));
          const text = (key: string) => a.get(key)?.stringValue;
          if (
            text("strands.box.policy.action") !== "shell:spawn" ||
            text("process.command") !== path ||
            text("process.working_directory") !== workspace
          )
            continue;
          const fields = obj(a.get("process.command_args")?.arrayValue).values;
          const args = Array.isArray(fields) ? fields.map(obj).map((arg) => arg.stringValue) : [];
          if (
            text("strands.box.policy.verdict") === "permit" &&
            text("strands.box.policy.rule") === "oce_workspace_verifier" &&
            args.length === 1 &&
            args[0] === path
          )
            allow++;
          if (
            text("strands.box.policy.verdict") === "deny" &&
            args.length === 2 &&
            args[0] === path &&
            args[1] === "--refused-alternate"
          )
            deny++;
        }
  }
  return allow === 1 && deny === 1;
}
function executable(value: string | undefined) {
  if (!value?.startsWith("/") || realpathSync(value) !== value || !lstatSync(value).isFile())
    throw Error("PINNED_GATEWAY_CLI_REQUIRED");
  return value;
}
function ownerReceipt(root: string, fresh: boolean): string {
  const path = join(root, "owner-wss.json");
  const row = obj(JSON.parse(privateRead(path, 2048)) as unknown);
  if (
    row.stage !== "original_box_wss" ||
    row.verifiedTls !== true ||
    typeof row.generationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.generationSha256) ||
    (fresh && Math.abs(Date.now() - lstatSync(path).mtimeMs) > 90000)
  )
    throw Error("LIVE_OWNER_RECEIPT_REQUIRED");
  return row.generationSha256;
}
export function gatewayChatCall(
  method: "chat.send" | "chat.history" | "agent.wait",
  key: string,
  runId: string,
  nonce: string,
  expectedUrl = gatewayUrl,
) {
  const params =
    method === "chat.send"
      ? {
          sessionKey: key,
          message: promptFor(nonce),
          deliver: false,
          timeoutMs: 90000,
          idempotencyKey: runId,
        }
      : method === "chat.history"
        ? { sessionKey: key, limit: 8 }
        : { runId, timeoutMs: 5000 };
  return [
    "gateway",
    "call",
    method,
    "--expect-url",
    expectedUrl,
    "--params",
    JSON.stringify(params),
    "--json",
  ];
}
function callGateway(cli: string, args: string[]) {
  const env = { ...process.env };
  delete env.APP_SERVER_TOKEN;
  delete env.APP_SERVER_URL;
  return spawnSync(cli, args, { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 10000, env });
}
function runDirectory(root: string | undefined): string {
  if (!root?.startsWith("/") || realpathSync(root) !== root) throw Error("REPRO_ROOT_REFUSED");
  const st = lstatSync(root);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw Error("REPRO_ROOT_REFUSED");
  return root;
}

function installedGatewayUrl(root: string): string {
  const file = join(root, "gateway.json");
  let contents: string;
  try {
    contents = privateRead(file, 2048);
  } catch (error) {
    if (obj(error).code === "ENOENT") return gatewayUrl;
    throw error;
  }
  const gateway = obj(JSON.parse(contents));
  if (Object.keys(gateway).length !== 1 || typeof gateway.url !== "string") {
    throw Error("INSTALLED_GATEWAY_ORIGIN_REFUSED");
  }
  const url = new URL(gateway.url);
  if (
    url.protocol !== "wss:" ||
    url.href !== gateway.url ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw Error("INSTALLED_GATEWAY_ORIGIN_REFUSED");
  }
  return url.href;
}
export function seededNonce(root: string | undefined): string {
  const expected = obj(
    JSON.parse(privateRead(join(runDirectory(root), "expected.json"), 2048)) as unknown,
  );
  if (!isNonce(expected.nonce)) throw Error("PROBE_NONCE_REFUSED");
  return expected.nonce;
}
function main() {
  process.umask(0o077);
  const [mode, run, arg] = process.argv.slice(2);
  const root = runDirectory(run);
  if (process.argv.length > 5) throw Error("USAGE_REFUSED");
  if (mode === "seed" && !arg) {
    seed(root);
    return;
  }
  const expected = obj(JSON.parse(privateRead(join(root, "expected.json"), 2048)) as unknown);
  const nonce = expected.nonce;
  if (!isNonce(nonce)) throw Error("PROBE_NONCE_REFUSED");
  const expectedUrl = installedGatewayUrl(root);
  const current = checkMarker();
  const key = expected.sessionKey;
  if (
    current.markerSha256 !== expected.markerSha256 ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    typeof key !== "string" ||
    !/^agent:main:box-repro-[a-f0-9-]{36}$/.test(key)
  )
    throw Error("ORIGINAL_MARKER_CHANGED");
  if (mode === "submit") {
    const cli = executable(arg);
    const generationSha256 = ownerReceipt(root, true);
    const runId = randomUUID();
    save(join(root, "intent.json"), {
      stage: "one_chat_intent",
      sessionKey: key,
      generationSha256,
      runId,
      nonce,
      prompt: promptFor(nonce),
      gatewayUrl: expectedUrl,
    });
    const result = callGateway(cli, gatewayChatCall("chat.send", key, runId, nonce, expectedUrl));
    const reply = result.status === 0 ? obj(JSON.parse(result.stdout) as unknown) : {};
    const accepted =
      reply.runId === runId && (reply.status === "started" || reply.status === "accepted");
    save(join(root, "client-exit.json"), { code: result.status, signal: result.signal, accepted });
    if (!accepted) throw Error("CHAT_CLIENT_UNCERTAIN");
    process.stdout.write("BOX_REPRO_CHAT_ACCEPTED\n");
  } else if (mode === "verify") {
    const cli = executable(arg);
    const intent = obj(JSON.parse(privateRead(join(root, "intent.json"), 4096)) as unknown);
    if (
      intent.stage !== "one_chat_intent" ||
      intent.sessionKey !== key ||
      intent.nonce !== nonce ||
      intent.prompt !== promptFor(nonce) ||
      (intent.gatewayUrl ?? gatewayUrl) !== expectedUrl ||
      intent.generationSha256 !== ownerReceipt(root, false) ||
      typeof intent.runId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(intent.runId)
    )
      throw Error("ORIGINAL_CHAT_INTENT_REQUIRED");
    if (!inspectPolicyRecords(privateRead(join(root, "box-records.jsonl"), 1024 * 1024)))
      throw Error("STOCK_POLICY_RECEIPT_REQUIRED");
    const waited = callGateway(
      cli,
      gatewayChatCall("agent.wait", key, intent.runId, nonce, expectedUrl),
    );
    if (waited.status !== 0 || !inspectTerminal(JSON.parse(waited.stdout) as unknown, intent.runId))
      throw Error("ORIGINAL_CHAT_TERMINAL_REQUIRED");
    const read = callGateway(
      cli,
      gatewayChatCall("chat.history", key, intent.runId, nonce, expectedUrl),
    );
    if (
      read.status !== 0 ||
      !inspectHistory(JSON.parse(read.stdout) as unknown, key, nonce, current.markerSha256)
    )
      throw Error("ORDINARY_CHAT_RESULT_UNVERIFIED");
    const records = privateRead(join(root, "controlled-chat.jsonl"), 8192)
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    if (!inspectFixture(records, nonce, current)) throw Error("SAME_MARKER_TOOL_RECEIPT_REQUIRED");
    process.stdout.write(
      JSON.stringify({
        stage: "ordinary_chat_verified",
        syntheticModel: true,
        sameMarkerInode: true,
        alternateArgumentDenied: true,
      }) + "\n",
    );
  } else throw Error("USAGE_REFUSED");
}
if (import.meta.main)
  try {
    main();
  } catch (error) {
    process.stderr.write(
      (error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "BOX_REPRO_REFUSED") + "\n",
    );
    process.exitCode = 1;
  }
