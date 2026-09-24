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
        if (quote === '"' && (char === "$" || char.charCodeAt(0) === 96 || char === "\\")) return undefined;
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
  const sessionKey = process.argv[1];
  const marker = process.argv[2];
  const toolName = process.argv[3];
  const resultPattern = process.argv[4];
  // Optional bounded summaries let installed scenarios inspect real calls without
  // exporting their raw arguments, output, or credential-bearing environment.
  const summary = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;
  ${repositoryCommandEvidence}
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
    const promptTools =
      entry?.systemPromptReport?.source === "run" &&
      Array.isArray(entry.systemPromptReport.tools?.entries)
        ? entry.systemPromptReport.tools.entries
            .map((tool) => tool?.name)
            .filter((name) => typeof name === "string")
        : undefined;
    const rows = db
      .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
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
    for (const row of rows) {
      const event = JSON.parse(row.event_json);
      eventTypeCounts[event.type ?? "unknown"] = (eventTypeCounts[event.type ?? "unknown"] ?? 0) + 1;
      if (event.type !== "message") continue;
      const message = event.message;
      const hasMarker = contains(message, marker);
      const mirrorIdentity = message?.__openclaw?.mirrorIdentity;
      roleCounts[message.role ?? "unknown"] = (roleCounts[message.role ?? "unknown"] ?? 0) + 1;
      const promptPrefix = prefixForMirrorIdentity(mirrorIdentity, ":prompt");
      if (message.role === "user" && hasMarker && promptPrefix !== undefined) {
        turn(promptPrefix).promptSeen = true;
      }
      const assistantPrefix = prefixForMirrorIdentity(mirrorIdentity, ":assistant");
      if (message.role === "assistant" && hasMarker && assistantPrefix !== undefined) {
        turn(assistantPrefix).terminalAssistantSeen = true;
      }
      messages.push({
        seq: row.seq,
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
            calls.push({ seq: row.seq, id: block.id, name: block.name, mirrorIdentity,
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
          seq: row.seq,
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
    process.stdout.write(JSON.stringify({
      databasePath,
      sessionKey,
      sessionId: session.current_session_id,
      exists: true,
      promptReportSource: entry?.systemPromptReport?.source,
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
  const assert = require("node:assert/strict");
  const marker = process.argv[1];
  const expected = JSON.parse(process.argv[2]);
  ${repositoryCommandEvidence}
  const socket = new WebSocket(process.env.APP_SERVER_URL, {
    headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
  });
  const pending = new Map();
  let nextId = 0;
  const deadline = setTimeout(() => {
    process.stderr.write("Codex repository evidence timed out\n");
    socket.close();
    process.exitCode = 1;
  }, 20000);
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
    message.error ? operation.reject(new Error("Codex evidence request failed")) : operation.resolve(message.result);
  });
  socket.addEventListener("error", () => { process.exitCode = 1; });
  socket.addEventListener("open", async () => {
    try {
      await request("initialize", { clientInfo: { name: "repository-acceptance-observer", version: "1.0.0" } });
      socket.send(JSON.stringify({ method: "initialized" }));
      const listed = await request("thread/list", { limit: 20, sourceKinds: ["appServer"], modelProviders: [] });
      assert.equal(listed.nextCursor, null, "fresh Agent must have a bounded thread inventory");
      const matches = [];
      for (const candidate of listed.data) {
        const { thread } = await request("thread/read", { threadId: candidate.id, includeTurns: true });
        for (const turn of thread.turns) {
          if (!turn.items.some(item => item.type === "userMessage" && item.content.some(block => block.type === "text" && block.text.includes(marker)))) continue;
          const commands = turn.items.filter(item => item.type === "commandExecution").map(item => {
            // Codex reports the actual shell argv as a quoted command. Accept
            // only its single non-login shell wrapper around one literal command.
            let args = standaloneArguments(item.command);
            if (args?.length === 3 && ["/bin/bash", "/bin/sh", "/usr/bin/bash"].includes(args[0]) && args[1] === "-c") args = standaloneArguments(args[2]);
            const lines = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.split(/\r?\n/).map(line => line.trim()) : [];
            return {
              id: item.id,
              operations: expected.filter(command => item.cwd === command.workdir && args?.length === command.argv.length && args.every((arg, index) => arg === command.argv[index])).map(command => command.operation),
              status: item.status,
              exitCode: item.exitCode,
              commitShas: lines.filter(line => /^[a-f0-9]{40}$/.test(line)),
              pullUrls: lines.filter(line => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(line)),
            };
          });
          matches.push({ threadId: thread.id, turnId: turn.id, status: turn.status, commands });
        }
      }
      assert.equal(matches.length, 1, "the repository task must identify one native Codex turn");
      process.stdout.write(JSON.stringify(matches[0]));
    } catch {
      process.stderr.write("Codex repository evidence unavailable\n");
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      socket.close();
    }
  });
`;
