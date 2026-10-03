import assert from "node:assert/strict";
import {
  codexRepositoryEvidenceScript,
  completedToolResult,
  expandTranscriptMessage,
  sessionEvidenceScript,
} from "./normal-agent-tools.mjs";
import { submitRepositoryTaskScript } from "./repository-credentials-installed.mjs";

export const repositoryFailureSummaryScript = String.raw`
  ${expandTranscriptMessage.toString()}
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", {readOnly: true});
  const patterns = [
    ["tool-approval-or-policy", /approval required|exec denied|execution denied|not allowed by|host.*not allowed|security policy/i],
    ["command-unavailable", /command not found|spawn.*ENOENT|executable.*not found/i],
    ["repository-authentication", /authentication failed|could not read Username|bad credentials|HTTP Basic: Access denied|returned error: (?:401|403)/i],
    ["repository-unavailable", /repository.*not found|repository.*does not exist|returned error: 404/i],
    ["tls-validation", /certificate verify failed|server certificate verification failed|SSL certificate problem|SSL_ERROR|unable to get local issuer|self.signed certificate/i],
    ["tls-transport-closed", /GnuTLS recv error|TLS connection.*terminated/i],
    ["git-http-server-error", /returned error: 5[0-9]{2}|HTTP\/[0-9.]+ 5[0-9]{2}|HTTP (?:error |status )?5[0-9]{2}/i],
    ["network-resolution-or-connection", /could not resolve host|ENOTFOUND|ECONNREFUSED|connection refused|failed to connect|connection timed out/i],
    ["filesystem-permission", /EACCES|permission denied|read.only file system/i],
    ["git-worktree", /not a git repository|destination path.*already exists|working tree.*overwritten/i],
    ["git-author-identity", /author identity unknown|please tell me who you are|unable to auto.detect email/i],
    ["git-ref-or-push", /src refspec.*does not match|non.fast.forward|failed to push some refs|couldn.t find remote ref/i],
    ["model-rate-or-quota", /rate limit|quota exceeded|insufficient_quota|too many requests/i],
    ["model-authentication", /invalid api key|incorrect api key|authentication_error/i],
  ];
  const classify = message => {
    const content = typeof message.content === "string" ? message.content :
      Array.isArray(message.content) ? message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
    const text = Buffer.from([content, message.details?.aggregated, message.errorMessage].filter(value => typeof value === "string").join("\n"), "utf8").subarray(0, 262144).toString("utf8");
    const categories = patterns.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
    const failed = message.isError === true || message.stopReason === "error" || message.details?.status === "error" ||
      (Number.isInteger(message.details?.exitCode) && message.details.exitCode !== 0);
    return categories.length === 0 && failed ? ["other-failure"] : categories;
  };
  try {
    db.exec("PRAGMA busy_timeout=2000");
    const session = db.prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?").get(process.argv[1]);
    if (!session) { process.stdout.write(JSON.stringify({exists:false})); }
    else {
      const rows = db.prepare("SELECT seq, CASE WHEN length(CAST(event_json AS BLOB)) <= 524288 THEN event_json ELSE NULL END AS event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 128").all(session.current_session_id).reverse();
      const toolResults = [];
      const parentCalls = new Set();
      let finalAssistant, skippedOversizeEvents = 0;
      for (const row of rows) {
        if (row.event_json === null) { skippedOversizeEvents++; continue; }
        const event = JSON.parse(row.event_json);
        if (event.type !== "message" || !event.message) continue;
        for (const {message, seq} of expandTranscriptMessage(event.message, row.seq, parentCalls)) {
        if (message.role === "toolResult") toolResults.push({seq, categories:classify(message)});
        if (message.role === "assistant") finalAssistant = {
          seq,
          stopReason:["stop","length","toolUse","error","aborted"].includes(message.stopReason) ? message.stopReason : "other-or-absent",
          hasToolCalls:Array.isArray(message.content) && message.content.some(block => block?.type === "toolCall"),
          categories:classify(message),
        };
        }
      }
      process.stdout.write(JSON.stringify({exists:true, scannedEvents:rows.length, eventLimit:128, skippedOversizeEvents, toolResults, finalAssistant}));
    }
  } catch { process.stderr.write("repository diagnostic summary unavailable\n"); process.exitCode=1; }
  finally { db.close(); }
`;

export async function verifyNativeRepositoryJourney({
  f,
  dedicated,
  readOnly,
  workspace,
  repository,
  base,
  baseSha,
  branch,
  file,
  content,
  marker,
  commandTool,
  toolNames,
  gateway,
  consumer,
  agent,
  revision,
  attempt,
  exec,
  submitTask,
  consumerExec,
  observe,
  app,
  remote,
  readSession,
  submitViaLoopback = false,
}) {
  const agentPath = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  let remoteEvidence;
  const sessionKey = `agent:main:repository-proof-${f.suffix}`;
  const checkout = `${workspace}/${repository.split("/")[1]}`;
  // The shipped broker profile exposes plugin-skills read-only. A path omitted
  // from that profile may be writable only in the sandbox's private filesystem,
  // so it cannot establish that writes to the real outside file are denied.
  const outsideDirectory = "/home/node/.openclaw/plugin-skills";
  const outside = `${outsideDirectory}/repository-sandbox-${f.suffix}.txt`;
  const sandboxFile = `${workspace}/repository-sandbox-${f.suffix}.txt`;
  const sandboxContent = `sandbox-${f.suffix}\n`;
  const outsideContent = `outside-${f.suffix}\n`;
  const sandboxScript = [
    'const fs=require("node:fs")',
    `if(fs.readFileSync(${JSON.stringify(outside)},"utf8")!==${JSON.stringify(outsideContent)})process.exit(71)`,
    `fs.writeFileSync(${JSON.stringify(sandboxFile)},${JSON.stringify(sandboxContent)})`,
    'let denied="NO_ERROR"',
    `try{fs.writeFileSync(${JSON.stringify(outside)},"escaped")}catch(error){denied=error.code}`,
    'if(!["EACCES","EPERM","EROFS"].includes(denied))process.exit(70)',
    'process.stdout.write("SANDBOX_DENIED:"+denied+"\\n")',
  ].join(";");
  if (dedicated) {
    await consumerExec(
      `const fs=require("node:fs");fs.mkdirSync(${JSON.stringify(outsideDirectory)},{recursive:true});fs.writeFileSync(${JSON.stringify(outside)},${JSON.stringify(outsideContent)})`,
    );
  }
  const commandSpecs = [
    ...(dedicated
      ? [{ operation: "sandboxProbe", workdir: workspace, argv: ["node", "-e", sandboxScript] }]
      : []),
    {
      operation: "clone",
      workdir: workspace,
      argv: ["git", "clone", `https://github.com/${repository}.git`],
    },
    { operation: "fetch", workdir: checkout, argv: ["git", "fetch", "origin"] },
    {
      operation: "readBase",
      workdir: checkout,
      argv: ["git", "rev-parse", `origin/${base}`],
    },
    ...(!readOnly
      ? [
          {
            operation: "branch",
            workdir: checkout,
            argv: ["git", "switch", "-c", branch, baseSha],
          },
          { operation: "add", workdir: checkout, argv: ["git", "add", "--", file] },
          {
            operation: "commit",
            workdir: checkout,
            argv: ["git", "commit", "-m", `Installed credential proof ${f.suffix}`],
          },
        ]
      : []),
    {
      operation: "push",
      workdir: checkout,
      argv: ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
    },
    ...(!readOnly
      ? [
          { operation: "readCommit", workdir: checkout, argv: ["git", "rev-parse", "HEAD"] },
          {
            operation: "nativePr",
            workdir: checkout,
            argv: [
              "gh",
              "pr",
              "create",
              "--base",
              base,
              "--head",
              branch,
              "--title",
              `Installed credential proof ${f.suffix}`,
              "--body",
              marker,
            ],
          },
        ]
      : []),
  ];
  const quoteArgument = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const commands = commandSpecs
    .map(
      ({ operation, workdir, argv }) =>
        `${operation}: exec.workdir=${JSON.stringify(workdir)}, exec.command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`,
    )
    .join("\n");
  const embeddedPrompt = `Complete this authorized disposable repository task once with your exec tool and normal image-installed git/gh commands. Each Git/gh operation below must be its own standalone exec.command, with the specified exec.workdir. Execute the exact arguments in the listed order. Do not use shell cd, chaining, pipelines, redirection, comments, substitutions or wrappers in those Git/gh commands. Run foreground commands and stop on any failure. If exec nevertheless reports a running process, use process.poll on that exact session until completion before continuing. Do not install tools, read credentials, use alternate tokens, force push, call a provider HTTP API to create the PR, or delegate.
After clone, its natural destination is ${checkout}. The readBase output must equal ${baseSha}; stop if it differs. Between branch and add, use exec.workdir=${JSON.stringify(checkout)} for every configuration and file-writing exec call. Configure local disposable Git identity Repository proof <repository-proof@example.invalid>, then use a separate exec call of your own to write exactly the following JSON-encoded bytes to the new file at absolute path ${JSON.stringify(`${checkout}/${file}`)}: ${JSON.stringify(content)}. Author that file yourself; do not change any other file. Make exactly one commit and exactly one same-repository ready-for-review PR. readCommit prints the full commit SHA and nativePr prints the PR URL; do not substitute echo commands for either operation. Do not close the PR or delete its branch. Finish with ${marker}.
${commands}`;
  const dedicatedPrompt = `Complete this authorized disposable repository task once using native Codex shell commands in your workspace. Execute every listed operation, including sandboxProbe, once, in order, as a separate foreground command with its specified working directory. Use the exact arguments; do not add shell cd, chaining, pipelines, redirection, comments, substitutions or wrappers to Git/gh commands. Use non-login shells. Stop on any failure. Do not request escalation, install tools, read credentials, use alternate tokens, force push, call a provider HTTP API to create the PR, or delegate.
After clone, its natural destination is ${checkout}. readBase must equal ${baseSha}; stop if it differs. Between branch and add, configure local Git identity Repository proof <repository-proof@example.invalid> and author exactly these JSON-encoded bytes in the new file ${JSON.stringify(`${checkout}/${file}`)}: ${JSON.stringify(content)}. Do not change any other file. Make one commit and one same-repository ready-for-review PR. readCommit must print the actual commit SHA and nativePr the actual PR URL. Do not close the PR or delete the branch. Finish with ${marker}.
${commandSpecs.map(({ operation, workdir, argv }) => `${operation}: working directory=${JSON.stringify(workdir)}, command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`).join("\n")}`;
  const readOnlyPrompt = `Complete this authorized read-only repository check using native Codex shell commands. Execute every listed operation once, in order, as a separate foreground command with the specified working directory and exact arguments. Use non-login shells and do not use shell cd, chaining, pipelines, redirection, substitutions or wrappers. Do not request escalation, use alternate credentials, or delegate. The sandboxProbe must succeed; clone and fetch must succeed and readBase must equal ${baseSha}. The push is intentionally unauthorized: attempt it exactly once and continue after it fails. Do not create a PR or retry; the attempted push must be the only remote write attempt. Finish with ${marker}.
${commandSpecs.map(({ operation, workdir, argv }) => `${operation}: working directory=${JSON.stringify(workdir)}, command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`).join("\n")}`;
  const prompt = readOnly ? readOnlyPrompt : dedicated ? dedicatedPrompt : embeddedPrompt;

  let taskFailure;
  let taskTransport = { outcome: "unresolved" };
  try {
    const response = JSON.parse(
      await submitTask(
        submitRepositoryTaskScript,
        [],
        JSON.stringify({
          sessionKey,
          prompt,
          ...(dedicated && !submitViaLoopback
            ? {
                gatewayUrl: `https://${f.gatewayHostname}/namespaces/${f.namespace.id}/agents/${agent.id}`,
                completionMarker: marker,
              }
            : {}),
        }),
        610000,
      ),
    );
    taskTransport = {
      outcome: response.status === 200 ? "http-completed" : "http-failed",
      httpStatus: Number.isSafeInteger(response.status) ? response.status : null,
      ...(response.failure === undefined ? {} : { failure: response.failure }),
    };
    assert.equal(response.status, 200);
  } catch (error) {
    taskFailure = error;
    if (taskTransport.outcome === "unresolved") {
      taskTransport = {
        outcome:
          error instanceof SyntaxError
            ? "invalid-submit-response"
            : error instanceof Error && /timeout/i.test(error.message)
              ? "transport-timeout"
              : "transport-or-submit-failed",
      };
    }
  }
  await f.record("Captured task transport diagnostics; repository acceptance pending", {
    evidenceKind: "diagnostic-only",
    taskTransport,
  });
  // A timeout is an unknown mutation outcome. Read actual trace and provider
  // state once; never replay a model task or create the PR in the runner.
  const trace = JSON.parse(
    await exec(sessionEvidenceScript, [
      sessionKey,
      marker,
      commandTool,
      marker,
      JSON.stringify({
        toolNames,
        commands: commandSpecs,
      }),
    ]),
  );
  const nativeTrace = dedicated
    ? JSON.parse(await exec(codexRepositoryEvidenceScript, [marker, JSON.stringify(commandSpecs)]))
    : undefined;
  if (nativeTrace) {
    await f.record("Captured native Codex command diagnostics; repository acceptance pending", {
      evidenceKind: "diagnostic-only",
      threadId: nativeTrace.threadId,
      turnId: nativeTrace.turnId,
      commands: nativeTrace.commands.map(
        ({ operations, status, exitCode, http400, sandboxDenied }) => ({
          operations,
          status,
          exitCode,
          http400,
          sandboxDenied,
        }),
      ),
    });
  }
  // Preserve the normalized call/result evidence before any remote-state
  // assertion can fail and ordinary cleanup removes the Agent transcript.
  // Store only fixed labels and numeric associations, not transcript IDs,
  // arbitrary map keys, output-derived URLs/hashes, or process session IDs.
  const expectedOperations = new Set(commandSpecs.map(({ operation }) => operation));
  const diagnosticStatus = (value) =>
    ["running", "completed", "error"].includes(value) ? value : "other-or-absent";
  const diagnosticNumber = (value) => (Number.isSafeInteger(value) ? value : null);
  const traceCalls = trace.calls ?? [];
  const traceResults = trace.results ?? [];
  const diagnosticTrace = {
    exists: trace.exists === true,
    promptReportFromRun: trace.promptReportSource === "run",
    promptIncludesExec: trace.promptToolNames?.includes("exec") === true,
    promptIncludesProcess: trace.promptToolNames?.includes("process") === true,
    messageCount: diagnosticNumber(trace.messageCount),
    eventCount: diagnosticNumber(trace.diagnostics?.eventCount),
    userMarkerSeen: trace.userMarkerSeen === true,
    assistantMarkerSeen: trace.assistantMarkerSeen === true,
    terminalAssistantMarkerSeen: trace.terminalAssistantMarkerSeen === true,
    assistantError: trace.assistantError === true,
    callCount: traceCalls.length,
    resultCount: traceResults.length,
    captureLimit: 256,
    calls: traceCalls.slice(-256).map((call) => ({
      seq: diagnosticNumber(call.seq),
      tool: toolNames.includes(call.name) ? call.name : "other",
      processPoll: call.name === "process" && call.processAction === "poll",
      operations: (call.operations ?? []).filter((operation) => expectedOperations.has(operation)),
    })),
    results: traceResults.slice(-256).map((result) => ({
      seq: diagnosticNumber(result.seq),
      callSeq: diagnosticNumber(traceCalls.find((call) => call.id === result.toolCallId)?.seq),
      isError: result.isError === true,
      status: diagnosticStatus(result.status),
      exitCode: diagnosticNumber(result.exitCode),
    })),
  };
  await f.record("Captured model tool diagnostics; repository acceptance pending", {
    evidenceKind: "diagnostic-only",
    taskTransport,
    trace: diagnosticTrace,
  });
  let failureSummary;
  try {
    failureSummary = JSON.parse(await exec(repositoryFailureSummaryScript, [sessionKey]));
  } catch {
    failureSummary = { available: false, reason: "bounded-summary-unavailable" };
  }
  const operationProgress = commandSpecs.map(({ operation }) => ({
    operation,
    calls: traceCalls
      .slice(-256)
      .filter((call) => call.operations?.includes(operation))
      .map((call) => ({
        callSeq: call.seq,
        results: traceResults
          .slice(-256)
          .filter((result) => result.toolCallId === call.id && result.seq > call.seq)
          .map((result) => ({
            resultSeq: result.seq,
            isError: result.isError,
            status: diagnosticStatus(result.status),
            exitCode: diagnosticNumber(result.exitCode),
            categories:
              failureSummary.toolResults?.find((entry) => entry.seq === result.seq)?.categories ??
              [],
          })),
      })),
  }));
  await f.record("Captured failure classifications; repository acceptance pending", {
    evidenceKind: "diagnostic-only",
    classificationMeaning: "text-pattern hints, not verified causes or successful operations",
    operationProgress,
    failureSummary,
  });
  assert.equal(
    (await f.get("pod", gateway.metadata.name, gateway.metadata.namespace)).metadata.uid,
    gateway.metadata.uid,
    "the task must remain bound to the observed Agent Pod",
  );
  assert.equal(
    (await f.get("pod", consumer.metadata.name, consumer.metadata.namespace)).metadata.uid,
    consumer.metadata.uid,
    "the task must remain bound to the observed repository consumer",
  );
  assert.equal((await f.api("GET", agentPath)).activeRevisionId, revision.id);
  assert.equal((await readSession(attempt.sessionId)).state, "OPEN");
  if (dedicated) {
    const probe = nativeTrace.commands.find((command) =>
      command.operations.includes("sandboxProbe"),
    );
    assert.ok(
      probe?.status === "completed" && probe.exitCode === 0 && probe.sandboxDenied,
      "the actual native command must report an outside-workspace write denial",
    );
    const call = trace.calls.find(
      (entry) =>
        entry.id === probe.id &&
        entry.name === "bash" &&
        entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${probe.id}:call`,
    );
    const result = trace.results.find(
      (entry) =>
        entry.toolCallId === probe.id &&
        entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${probe.id}:result`,
    );
    assert.ok(call && result && result.seq > call.seq, "the sandbox probe must be mirrored");
    const files = JSON.parse(
      await consumerExec(
        `const fs=require("node:fs");process.stdout.write(JSON.stringify([fs.readFileSync(${JSON.stringify(sandboxFile)},"utf8"),fs.readFileSync(${JSON.stringify(outside)},"utf8")]))`,
      ),
    );
    assert.deepEqual(files, [sandboxContent, outsideContent]);
  }
  const branchResponse = await observe("GET", `git/ref/heads/${branch}`, undefined, [200, 404]);
  if (readOnly) {
    assert.equal(nativeTrace.status, "completed");
    assert.equal(trace.exists, true);
    assert.equal(trace.userMarkerSeen, true);
    assert.equal(trace.terminalAssistantMarkerSeen, true);
    const mirroredTurn = trace.codexTurns.find(
      ({ turnPrefix }) => turnPrefix === nativeTrace.turnId,
    );
    assert.ok(
      mirroredTurn?.promptSeen &&
        mirroredTurn.terminalAssistantSeen &&
        mirroredTurn.toolCallMirrorSeen &&
        mirroredTurn.toolResultMirrorSeen,
    );
    let previousCommand = -1;
    for (const operation of ["clone", "fetch", "readBase", "push"]) {
      const matches = nativeTrace.commands.filter((command) =>
        command.operations.includes(operation),
      );
      assert.equal(matches.length, 1, `${operation} must execute once in the native turn`);
      const command = matches[0];
      const commandIndex = nativeTrace.commands.indexOf(command);
      assert.ok(commandIndex > previousCommand, "read and denial operations must occur in order");
      previousCommand = commandIndex;
      const call = trace.calls.find(
        (entry) =>
          entry.id === command.id &&
          entry.name === "bash" &&
          entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:call`,
      );
      const result = trace.results.find(
        (entry) =>
          entry.toolCallId === command.id &&
          entry.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:result`,
      );
      assert.ok(call && result && result.seq > call.seq, `${operation} must be mirrored`);
      if (operation === "push") {
        assert.equal(command.status, "failed");
        assert.ok(
          Number.isInteger(command.exitCode) && command.exitCode !== 0,
          "the read-only push must fail",
        );
        assert.equal(command.http400, true, "the broker must reject receive-pack discovery");
      } else {
        assert.equal(command.status, "completed");
        assert.equal(command.exitCode, 0, `${operation} must succeed`);
        if (operation === "readBase") {
          assert.ok(command.commitShas.includes(baseSha));
        }
      }
    }
    assert.equal(branchResponse.status, 404, "the denied push must not create a remote ref");
    assert.equal(taskFailure, undefined, "the task transport must complete");
    await f.record("Sandboxed read-only Agent fetched and its push was denied", {
      agentId: agent.id,
      revisionId: revision.id,
      sessionId: attempt.sessionId,
      baseSha,
      branch,
      seccompProfile: process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE,
    });
  } else {
    assert.equal(branchResponse.status, 200, "model task must push its branch");
    const commitSha = branchResponse.data.object.sha;
    const { data: commit } = await observe("GET", `commits/${commitSha}`);
    assert.deepEqual(
      commit.parents.map((p) => p.sha),
      [baseSha],
    );
    assert.deepEqual(
      commit.files.map((value) => ({ filename: value.filename, status: value.status })),
      [{ filename: file, status: "added" }],
    );
    const { data: remoteFile } = await observe("GET", `contents/${file}?ref=${commitSha}`);
    assert.equal(Buffer.from(remoteFile.content, "base64").toString("utf8"), content);
    const { data: pulls } = await observe(
      "GET",
      `pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
    );
    assert.equal(pulls.length, 1);
    const pull = pulls[0];
    assert.equal(pull.head.repo.id, Number(app.repositoryId));
    assert.equal(pull.head.ref, branch);
    assert.equal(pull.head.sha, commitSha);
    assert.equal(pull.base.repo.id, Number(app.repositoryId));
    assert.equal(pull.base.ref, base);
    assert.equal(pull.body, marker);
    assert.equal(pull.state, "open");
    assert.equal(pull.draft, false);
    remoteEvidence = { commitSha, pullNumber: pull.number };
    assert.equal(trace.exists, true);
    if (!dedicated) {
      assert.equal(trace.promptReportSource, "run");
      assert.ok(trace.promptToolNames.includes("exec"));
    }
    assert.equal(trace.userMarkerSeen, true);
    assert.equal(trace.assistantMarkerSeen, true);
    assert.equal(trace.terminalAssistantMarkerSeen, true);
    assert.equal(trace.assistantError, false);
    let paired = trace.calls
      .filter((call) => call.name === "exec")
      .map((call) => ({ ...call, completion: completedToolResult(trace, call) }))
      .filter((call) => call.completion);
    if (dedicated) {
      assert.equal(nativeTrace.status, "completed");
      const mirroredTurn = trace.codexTurns.find(
        ({ turnPrefix }) => turnPrefix === nativeTrace.turnId,
      );
      assert.ok(
        mirroredTurn?.promptSeen &&
          mirroredTurn.terminalAssistantSeen &&
          mirroredTurn.toolCallMirrorSeen &&
          mirroredTurn.toolResultMirrorSeen,
        "native repository commands must belong to the Gateway's mirrored task turn",
      );
      paired = nativeTrace.commands
        .filter((command) => command.status === "completed" && command.exitCode === 0)
        .map((command) => {
          const call = trace.calls.find(
            (call) =>
              call.id === command.id &&
              call.name === "bash" &&
              call.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:call`,
          );
          const result = trace.results.find(
            (result) =>
              result.toolCallId === command.id &&
              !result.isError &&
              result.mirrorIdentity === `${nativeTrace.turnId}:tool:${command.id}:result`,
          );
          assert.ok(
            call && result && result.seq > call.seq,
            "native completion must have the same mirrored command call and result",
          );
          return { id: command.id, operations: command.operations, completion: command };
        });
    }
    for (const { operation } of commandSpecs) {
      assert.ok(
        paired.some((call) => call.operations.includes(operation)),
        `successful standalone tool trace must account for ${operation}`,
      );
    }
    assert.ok(
      paired.some(
        (call) =>
          call.operations.includes("readBase") && call.completion.commitShas.includes(baseSha),
      ),
      "a successful read identifies the independently observed base",
    );
    assert.ok(
      paired.some(
        (call) =>
          call.operations.includes("readCommit") && call.completion.commitShas.includes(commitSha),
      ),
      "the successful git rev-parse HEAD result must identify the independently observed commit",
    );
    const expectedPullUrl = `https://github.com/${remote.full_name}/pull/${pull.number}`;
    assert.equal(pull.html_url, expectedPullUrl);
    assert.ok(
      paired.some(
        (call) =>
          call.operations.includes("nativePr") &&
          call.completion.pullUrls.includes(expectedPullUrl),
      ),
      "the successful native gh pr create result must identify this authorized repository PR",
    );
    assert.equal(taskFailure, undefined, "task transport failed despite reconciled remote outcome");
    await f.record("Model tools and independent provider readback agree", {
      sessionKey,
      taskSessionId: trace.sessionId,
      agentId: agent.id,
      revisionId: revision.id,
      podUid: gateway.metadata.uid,
      credentialSessionId: attempt.sessionId,
      commitSha,
      baseSha,
      branch,
      file,
      pullNumber: pull.number,
      toolCallIds: paired.map((call) => call.id),
    });
  }
  return remoteEvidence;
}
