import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// TODO: Remove refusal-only metadata after the managed native-profile blocker is resolved.
// Return only fixed diagnostic labels. Never retain text from a native error,
// HTTP body or process log, which can contain model data and credentials.
export function nativeTaskFailureSummary(value) {
  const text = typeof value === "string" ? value.slice(0, 65_536) : "";
  const patterns = [
    ["profile-grant-mismatch", /Codex did not grant the requested (?:named )?permission profile/i],
    [
      "profile-not-found",
      /(?:unknown|missing|unrecognized|not found).*permission.*profile|permission.*profile.*(?:not found|not configured|does not exist|unknown)/i,
    ],
    [
      "managed-profile-refusal",
      /allowed_permission_profiles|allowedPermissionProfiles|permission profile.*(?:not allowed|disallowed|requirements|managed)|requirements.*permission.*profile/i,
    ],
    [
      "native-policy-refusal",
      /sandbox policy.*(?:refused|denied|not allowed)|approval.*(?:required|denied)|permission.*(?:denied|not allowed)/i,
    ],
    ["thread-unavailable", /thread.*(?:not found|not loaded|unavailable|missing)/i],
    [
      "gateway-authentication",
      /gateway.*(?:unauthorized|authentication failed|password mismatch|auth failed)|missing gateway token|gateway token mismatch/i,
    ],
    [
      "device-identity-required",
      /device identity required|pairing required|device identity.*(?:missing|required)/i,
    ],
    [
      "model-authentication",
      /invalid api key|incorrect api key|authentication_error|invalid authentication|Codex.*(?:unauthorized|authentication failed)/i,
    ],
    ["model-rate-or-quota", /rate.limit|quota exceeded|insufficient_quota|too many requests/i],
    [
      "network-or-tls",
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connection refused|failed to connect|certificate.*(?:failed|invalid)|SSL_ERROR/i,
    ],
  ];
  const classes = patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const method = ["thread/start", "thread/resume", "thread/fork", "turn/start"].find((name) =>
    text.includes(name),
  );
  return {
    classes: classes.length ? classes : ["unclassified"],
    nativeMethod: method ?? "unknown",
  };
}

export function nativePolicyRequirementsSummary(response) {
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(response) || !Object.hasOwn(response, "requirements")) {
    return { available: false };
  }
  const requirements = response.requirements;
  if (requirements === null) {
    return { available: true, requirementsPresent: false };
  }
  if (!record(requirements)) {
    return { available: false };
  }
  const allowlist = requirements.allowedPermissionProfiles;
  const present =
    record(allowlist) && Object.values(allowlist).every((value) => typeof value === "boolean");
  const allowlistKnown =
    Object.hasOwn(requirements, "allowedPermissionProfiles") && (allowlist === null || present);
  const keys = present ? Object.keys(allowlist) : [];
  const defaultId = requirements.defaultPermissions;
  const builtin = {
    ":workspace": "builtin-workspace",
    ":read-only": "builtin-read-only",
    ":danger-full-access": "builtin-danger-full-access",
  };
  return {
    available: true,
    requirementsPresent: true,
    profileAllowlistKnown: allowlistKnown,
    profileAllowlistPresent: allowlistKnown ? present : "unknown",
    profileAllowlistCount: present ? keys.length : "unknown",
    workspaceAllowed: present ? allowlist[":workspace"] === true : "unknown",
    readOnlyAllowed: present ? allowlist[":read-only"] === true : "unknown",
    generatedNetworkProfilesAllowed: present
      ? keys.filter((key) => /^openclaw-network-[a-f0-9]{16}$/.test(key) && allowlist[key] === true)
          .length
      : "unknown",
    defaultProfileKind: Object.hasOwn(builtin, defaultId)
      ? builtin[defaultId]
      : typeof defaultId === "string"
        ? "other-named"
        : "unknown",
  };
}

// A trace may record an interim tool error before that same call completes.
// Only its latest result, or an exact process-session poll, can prove success.
export function completedToolResult(trace, call) {
  const succeeded = (result) =>
    !result.isError && result.status === "completed" && result.exitCode === 0;
  const result = trace.results.findLast(
    (result) => result.toolCallId === call.id && result.seq > call.seq,
  );
  if (!result || result.isError) {
    return undefined;
  }
  if (succeeded(result)) {
    return result;
  }
  if (result.status !== "running" || typeof result.processSessionId !== "string") {
    return undefined;
  }
  for (const poll of trace.calls) {
    if (
      poll.name !== "process" ||
      poll.processAction !== "poll" ||
      poll.processSessionId !== result.processSessionId ||
      poll.seq <= result.seq
    ) {
      continue;
    }
    const completed = trace.results.findLast(
      (done) => done.toolCallId === poll.id && done.seq > poll.seq,
    );
    if (
      completed &&
      completed.processSessionId === result.processSessionId &&
      succeeded(completed)
    ) {
      return completed;
    }
  }
  return undefined;
}

// Nested code-mode calls are runtime records, not commands inferred from model code.
// Keep the actual parent linkage and place their call before their result.
export function expandTranscriptMessage(message, seq, parentCalls) {
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type === "toolCall" && typeof block.id === "string") {
        parentCalls.add(block.id);
      }
    }
  }
  const details = message.details;
  if (message.role !== "custom" || message.customType !== "openclaw.nested-tool.v1") {
    return [{ seq: seq * 2, message }];
  }
  if (
    !details ||
    !parentCalls.has(details.parentToolCallId) ||
    typeof details.toolCallId !== "string" ||
    typeof details.toolName !== "string" ||
    !details.input ||
    typeof details.input !== "object" ||
    !details.result ||
    typeof details.result !== "object"
  ) {
    return [];
  }
  return [
    {
      seq: seq * 2,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: details.toolCallId,
            name: details.toolName,
            arguments: details.input,
          },
        ],
      },
    },
    {
      seq: seq * 2 + 1,
      message: {
        ...details.result,
        role: "toolResult",
        toolCallId: details.toolCallId,
        toolName: details.toolName,
        isError: details.isError === true || details.result.isError === true,
      },
    },
  ];
}

const repositoryCommandEvidence = String.raw`
  // This is the deliberately small grammar requested by this installed task,
  // not a general shell parser: one command, literal arguments and explicit cwd.
  // Shell operators, expansions, comments and multiline commands are not proof.
  function standaloneArguments(command) {
    if (typeof command !== "string" || command.length > 8192 || /[\r\n\0]/.test(command)) return undefined;
    const args = [];
    let word = "", quote, started = false;
    for (let index = 0; index < command.length; index++) {
      const char = command[index];
      if (quote) {
        if (char === quote) { quote = undefined; continue; }
        if (quote === '"' && char === "\\") {
          const escaped = command[++index];
          if (![34, 36, 92, 96].includes(escaped?.charCodeAt(0))) return undefined;
          word += escaped;
          continue;
        }
        if (quote === '"' && (char === "$" || char.charCodeAt(0) === 96)) return undefined;
        word += char;
        continue;
      }
      if (char === "'" || char === '"') { quote = char; started = true; continue; }
      if (char === " " || char === "\t") {
        if (started) { args.push(word); word = ""; started = false; }
        continue;
      }
      if (char === "\\") {
        const escaped = command[++index];
        if (!["'", '"', "\\", " ", "\t"].includes(escaped)) return undefined;
        word += escaped; started = true; continue;
      }
      if (/[;&|<>(){}$#*?\[\]~]/.test(char) || char.charCodeAt(0) === 96) return undefined;
      word += char; started = true;
    }
    if (quote) return undefined;
    if (started) args.push(word);
    return args;
  }
`;

export const sessionEvidenceScript = String.raw`
  const { DatabaseSync } = require("node:sqlite");
  const { zstdDecompressSync } = require("node:zlib");
  const sessionKey = process.argv[1];
  const marker = process.argv[2];
  const toolName = process.argv[3];
  const resultPattern = process.argv[4];
  // Optional bounded summaries let installed scenarios inspect real calls without
  // exporting their raw arguments, output, or credential-bearing environment.
  const summary = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;
  ${repositoryCommandEvidence}
  ${expandTranscriptMessage.toString()}
  function operationsFor(block) {
    if (!["exec", "bash"].includes(block.name)) return [];
    const args = standaloneArguments(block.arguments?.command);
    if (!args || !["git", "gh"].includes(args[0])) return [];
    return (summary.commands ?? []).filter(expected =>
      (block.name === "bash" ? block.arguments.cwd : block.arguments.workdir) === expected.workdir && args.length === expected.argv.length &&
      args.every((argument, index) => argument === expected.argv[index])
    ).map(expected => expected.operation);
  }
  const selectedTools = summary?.toolNames ?? [toolName];
  const databasePath = "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const db = new DatabaseSync(databasePath, { readOnly: true });
  function contains(value, needle) {
    if (!needle) return false;
    if (typeof value === "string") return value.includes(needle);
    if (Array.isArray(value)) return value.some((entry) => contains(entry, needle));
    if (value && typeof value === "object") {
      return Object.values(value).some((entry) => contains(entry, needle));
    }
    return false;
  }
  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const session = db.prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey);
    if (!session) {
      process.stdout.write(JSON.stringify({ databasePath, sessionKey, exists: false }));
      process.exit(0);
    }
    const entry = JSON.parse(session.entry_json);
    // Current runtimes store large entry fields separately; older runtimes inline them.
    const hasSnapshots = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_entry_snapshots'").get();
    const snapshot = hasSnapshots ? db.prepare("SELECT value_json FROM session_entry_snapshots WHERE session_key = ? AND field = 'systemPromptReport'").get(sessionKey) : undefined;
    const promptReport = snapshot ? JSON.parse(snapshot.value_json) : entry?.systemPromptReport;
    const promptTools =
      promptReport?.source === "run" &&
      Array.isArray(promptReport.tools?.entries)
        ? promptReport.tools.entries
            .map((tool) => tool?.name)
            .filter((name) => typeof name === "string")
        : undefined;
    const rows = db
      .prepare("SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(session.current_session_id);
    const messages = [];
    const calls = [];
    const results = [];
    const eventTypeCounts = {};
    const roleCounts = {};
    const contentBlockTypeCounts = {};
    const observedToolNames = new Set();
    const resultToolNames = new Set();
    const finalAssistantDiagnostics = {
      mentionsUnavailable: false,
      mentionsAuth: false,
    };
    const codexTurns = new Map();
    function turn(prefix) {
      const current = codexTurns.get(prefix) ?? {
        turnPrefix: prefix,
        promptSeen: false,
        terminalAssistantSeen: false,
        terminalAssistantDelivered: false,
        toolCallMirrorSeen: false,
        toolResultMirrorSeen: false,
      };
      codexTurns.set(prefix, current);
      return current;
    }
    function prefixForMirrorIdentity(identity, suffix) {
      return typeof identity === "string" && identity.endsWith(suffix)
        ? identity.slice(0, -suffix.length)
        : undefined;
    }
    function prefixForToolMirrorIdentity(identity, suffix) {
      if (typeof identity !== "string" || !identity.endsWith(suffix)) return undefined;
      const withoutSuffix = identity.slice(0, -suffix.length);
      const marker = ":tool:";
      const index = withoutSuffix.lastIndexOf(marker);
      return index === -1 ? undefined : withoutSuffix.slice(0, index);
    }
    const parentCalls = new Set();
    for (const row of rows) {
      const eventText = row.event_json ?? zstdDecompressSync(row.event_zstd).toString("utf8");
      if (Buffer.byteLength(eventText) !== (row.event_utf8_bytes ?? Buffer.byteLength(eventText))) {
        throw new Error("transcript event length mismatch");
      }
      const event = JSON.parse(eventText);
      eventTypeCounts[event.type ?? "unknown"] = (eventTypeCounts[event.type ?? "unknown"] ?? 0) + 1;
      if (event.type !== "message") continue;
      for (const { message, seq } of expandTranscriptMessage(event.message, row.seq, parentCalls)) {
      const hasMarker = contains(message, marker);
      const mirrorIdentity = message?.__openclaw?.mirrorIdentity;
      roleCounts[message.role ?? "unknown"] = (roleCounts[message.role ?? "unknown"] ?? 0) + 1;
      const promptPrefix = prefixForMirrorIdentity(mirrorIdentity, ":prompt");
      if (message.role === "user" && hasMarker && promptPrefix !== undefined) {
        turn(promptPrefix).promptSeen = true;
      }
      const assistantPrefix = prefixForMirrorIdentity(mirrorIdentity, ":assistant");
      if (message.role === "assistant" && assistantPrefix !== undefined) {
        // Delivery is owned by the exact runtime mirror identity. The model's
        // optional completion wording is a separate diagnostic fact.
        turn(assistantPrefix).terminalAssistantDelivered = true;
        if (hasMarker) {
          turn(assistantPrefix).terminalAssistantSeen = true;
        }
      }
      messages.push({
        seq,
        role: message.role,
        hasMarker,
        stopReason: message.stopReason,
        hasToolCalls: Array.isArray(message.content) && message.content.some(block => block?.type === "toolCall"),
        mirrorIdentity,
      });
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          const blockType = block?.type ?? "unknown";
          contentBlockTypeCounts[blockType] = (contentBlockTypeCounts[blockType] ?? 0) + 1;
          if (typeof block?.name === "string") observedToolNames.add(block.name);
          if (block?.type === "toolCall" && selectedTools.includes(block.name)) {
            const toolPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":call");
            if (toolPrefix !== undefined) turn(toolPrefix).toolCallMirrorSeen = true;
            calls.push({ seq, id: block.id, name: block.name, mirrorIdentity,
              ...(summary ? { processSessionId: block.name === "process" && typeof block.arguments?.sessionId === "string" ? block.arguments.sessionId : undefined, processAction: block.name === "process" ? block.arguments?.action : undefined, operations: operationsFor(block) } : {}),
            });
          }
        }
        if (hasMarker) {
          const text = textOf(message.content).toLowerCase();
          finalAssistantDiagnostics.mentionsUnavailable ||=
            /unavailable|not available|unable|cannot|can't|could not|no access|not connected|not installed/.test(text);
          finalAssistantDiagnostics.mentionsAuth ||=
            /auth|permission|credential|login|connect|unauthoriz/.test(text);
        }
      }
      if (message.role === "toolResult" && calls.some((call) => call.id === message.toolCallId)) {
        const resultPrefix = prefixForToolMirrorIdentity(mirrorIdentity, ":result");
        if (resultPrefix !== undefined) turn(resultPrefix).toolResultMirrorSeen = true;
        const resultText = textOf(message.content) + (typeof message.details?.aggregated === "string" ? "\n" + message.details.aggregated : "");
        results.push({
          seq,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError === true,
          matchesResult: contains(message, resultPattern) || textOf(message.content).includes(resultPattern),
          mirrorIdentity,
          ...(summary ? {
            status: message.details?.status,
            exitCode: message.details?.exitCode,
            processSessionId: message.details?.sessionId,
            commitShas: [...new Set(resultText.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-f0-9]{40}$/.test(line)))],
            pullUrls: [...new Set(resultText.split(/\r?\n/).map(line => line.trim()).filter(line => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(line)))],
          } : {}),
        });
      }
      if (message.role === "toolResult" && typeof message.toolName === "string") {
        resultToolNames.add(message.toolName);
      }
      }
    }
    process.stdout.write(JSON.stringify({
      databasePath,
      sessionKey,
      sessionId: session.current_session_id,
      exists: true,
      promptReportSource: promptReport?.source,
      promptToolNames: promptTools,
      messageCount: messages.length,
      userMarkerSeen: messages.some((message) => message.role === "user" && message.hasMarker),
      assistantMarkerSeen: messages.some((message) => message.role === "assistant" && message.hasMarker),
      ...(summary ? { terminalAssistantMarkerSeen: (() => { const last = messages.filter(message => message.role === "assistant").at(-1); return !!last?.hasMarker && !last.hasToolCalls && last.stopReason !== "error"; })() } : {}),
      assistantError: messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
      calls,
      results,
      codexTurns: Array.from(codexTurns.values()),
      diagnostics: {
        eventCount: rows.length,
        eventTypeCounts,
        roleCounts,
        contentBlockTypeCounts,
        observedToolNames: Array.from(observedToolNames).sort(),
        resultToolNames: Array.from(resultToolNames).sort(),
        finalAssistantDiagnostics,
      },
    }));
  } finally {
    db.close();
  }
`;

// Read only: command success comes from the owning Codex thread, whose mirrored
// display transcript can omit exit status. Never start or replay a model turn.
export const codexRepositoryEvidenceScript = String.raw`
  const WebSocket = require("ws");
  const marker = process.argv[1];
  const expected = JSON.parse(process.argv[2]);
  ${repositoryCommandEvidence}
  ${PLUGIN_RUNTIME_HELPERS}
  (async () => {
    // Plugin-enabled peers rotate their transport token for each startup.
    // Resolve it through the same verified status contract as gateway startup;
    // ordinary Codex peers continue to use the admitted base token.
    const runtime = readGatewayPluginRuntime();
    if (runtime?.manifest?.kind === "codex" && hasEnabledPluginSelections(runtime)) {
      const status = await readPeerPluginRuntimeStatus();
      process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(status.startupId);
    }
    // The gateway observes a remote peer, not the runtime helper's local client.
    const socket = new WebSocket(process.env.APP_SERVER_URL, {
      headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
    });
    const pending = new Map();
    let nextId = 0;
    let stage = "connect";
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      try { socket.close(); } catch { /* Always retain the fixed observer receipt. */ }
      process.stdout.write(JSON.stringify(value), () => process.exit(0));
    };
    const unavailable = (reason, failure) => finish({ status: "unavailable", observerStage: stage, observerReason: reason, ...(failure ? { failure } : {}), commands: [] });
    const deadline = setTimeout(() => unavailable("deadline"), 20000);
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      message.error
        ? operation.reject(new Error("native read failed"))
        : operation.resolve(message.result);
    });
    socket.addEventListener("error", () => unavailable("connection"));
    socket.addEventListener("open", async () => {
      try {
        stage = "initialize";
        await request("initialize", { clientInfo: { name: "repository-acceptance-observer", version: "1.0.0" } });
        socket.send(JSON.stringify({ method: "initialized" }));
        stage = "thread-list";
        const listed = await request("thread/list", { limit: 20, modelProviders: [] });
        if (listed.nextCursor !== null) return unavailable("inventory-limit");
        const matches = [];
        for (const candidate of listed.data) {
          stage = "thread-read";
          const { thread } = await request("thread/read", { threadId: candidate.id, includeTurns: true });
          for (const turn of thread.turns) {
            if (!turn.items.some(item => item.type === "userMessage" && item.content.some(block => block.type === "text" && block.text.includes(marker)))) continue;
            const commands = turn.items.filter(item => item.type === "commandExecution").map(item => {
              // Codex reports the actual shell argv as a quoted command. Accept
              // only its single non-login shell wrapper around one literal command.
              let args = standaloneArguments(item.command);
              if (args?.length === 3 && ["/bin/bash", "/bin/sh", "/usr/bin/bash"].includes(args[0]) && args[1] === "-c") args = standaloneArguments(args[2]);
              const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-262144) : "";
              const lines = output.split(/\r?\n/).map(line => line.trim());
              // Hints from bounded native output, never raw output or verified causes.
              const failureCategories = [
                ["dns", /could not resolve host|ENOTFOUND|EAI_AGAIN/i],
                ["connect-refused", /ECONNREFUSED|connection refused/i],
                ["connect-failed", /failed to connect|ENETUNREACH|EHOSTUNREACH/i],
                ["connect-timeout", /ETIMEDOUT|connection timed out|connection timeout/i],
                ["connect-reset", /ECONNRESET|connection reset/i],
                ["tls", /certificate verify failed|server certificate verification failed|SSL certificate problem|SSL_ERROR|unable to get local issuer|self.signed certificate|GnuTLS recv error|TLS connection.*terminated/i],
                ["http-auth-rejected", /returned error: (?:401|403)\b|HTTP\/[0-9.]+ (?:401|403)\b|HTTP (?:error |status )?(?:401|403)\b/i],
                ["local-path", /not a git repository|destination path.*already exists|no such file or directory|ENOENT/i],
                ["filesystem-denied", /EACCES|EPERM|EROFS|permission denied|read.only file system/i],
              ].filter(([, pattern]) => pattern.test(output)).map(([category]) => category);
              return {
                id: item.id,
                operations: expected.filter(command => item.cwd === command.workdir && args?.length === command.argv.length && args.every((arg, index) => arg === command.argv[index])).map(command => command.operation),
                status: item.status,
                exitCode: item.exitCode,
                http400: /returned error: 400\b/i.test(item.aggregatedOutput ?? ""),
                pushRefRefused: /repository-push-ref-not-allowed\b/.test(item.aggregatedOutput ?? ""),
                sandboxDenied: /SANDBOX_DENIED:(?:EACCES|EPERM|EROFS)\b/.test(output),
                failureCategories,
                commitShas: lines.filter(line => /^[a-f0-9]{40}$/.test(line)),
                pullUrls: lines.filter(line => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(line)),
              };
            });
            matches.push({
              threadId: thread.id,
              turnId: turn.id,
              status: turn.status,
              cwdMatchesExpectedWorkspace: thread.cwd === expected[0]?.workdir,
              rolloutPath: thread.path,
              commands,
            });
          }
        }
        if (matches.length !== 1) return unavailable(matches.length ? "ambiguous-owned-turn" : "no-owned-turn");
        finish(matches[0]);
      } catch (error) {
        unavailable("native-read-failed", error?.diagnostic);
      }
    });
  })().catch(() => {
    process.stdout.write(JSON.stringify({ status: "unavailable", observerStage: "startup", observerReason: "connection-or-runtime-unavailable", commands: [] }));
  });
`;

// One read on the deployed peer, independent of whether a model turn exists.
// TODO: remove after the managed native-profile blocker is resolved.
export const codexRepositoryRequirementsScript = String.raw`
  const WebSocket = require("ws");
  ${PLUGIN_RUNTIME_HELPERS}
  const summarize = ${nativePolicyRequirementsSummary.toString()};
  let socket;
  let stage = "runtime-status";
  let finished = false;
  const finish = (value) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    try { socket?.close(); } catch { /* Keep the fixed receipt. */ }
    process.stdout.write(JSON.stringify({ evidenceKind: "diagnostic-only", observerStage: stage, ...value }), () => process.exit(0));
  };
  const deadline = setTimeout(() => finish({ available: false, reason: "observer-timeout" }), 20000);
  (async () => {
    const runtime = readGatewayPluginRuntime();
    if (runtime?.manifest?.kind === "codex" && hasEnabledPluginSelections(runtime)) {
      const status = await readPeerPluginRuntimeStatus();
      process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(status.startupId);
    }
    stage = "connect";
    socket = new WebSocket(process.env.APP_SERVER_URL, { headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN } });
    socket.addEventListener("error", () => finish({ available: false, reason: "connection-unavailable" }));
    socket.addEventListener("close", () => finish({ available: false, reason: "connection-closed" }));
    socket.addEventListener("open", () => {
      stage = "initialize";
      socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "repository-policy-observer", version: "1.0.0" }, capabilities: { experimentalApi: true } } }));
    });
    socket.addEventListener("message", ({ data }) => {
      try {
        const response = JSON.parse(String(data));
        if ((response.id === 1 && stage !== "initialize") || (response.id === 2 && stage !== "requirements-read") || (response.id !== 1 && response.id !== 2)) return;
        if (response.error) {
          const codes = { "-32601": "method-not-found", "-32602": "invalid-params", "-32603": "internal-error", "-32000": "server-error" };
          return finish({ available: false, reason: "native-rpc-refused", rpcCode: Object.hasOwn(codes, response.error.code) ? codes[response.error.code] : "other" });
        }
        if (response.id === 1) {
          socket.send(JSON.stringify({ method: "initialized" }));
          stage = "requirements-read";
          socket.send(JSON.stringify({ id: 2, method: "configRequirements/read" }));
        } else finish(summarize(response.result));
      } catch { finish({ available: false, reason: "invalid-native-response" }); }
    });
  })().catch(() => finish({ available: false, reason: "runtime-or-connection-unavailable" }));
`;
