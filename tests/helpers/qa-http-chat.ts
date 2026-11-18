import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { posix } from "node:path";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createConsoleFixtureTransport } from "./console-fixture-transport.ts";
import { parseNativeRolloutProvenance } from "./native-rollout-provenance.ts";
import { runQaHttpChatWithCleanup } from "./qa-http-chat-cleanup.ts";
import { verifyQaHttpChatIsolation } from "./qa-http-chat-isolation.ts";
import { redactedQaTail, registerQaSecret } from "./qa-secrets.ts";
import { createQaAgent, type createQaInstallation } from "./qa-installation.mjs";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

const toolProofFile = `
  const fs = require('node:fs');
  const [phase, file, marker] = process.argv.slice(1);
  if (phase === 'cleanup') {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    const entry = fs.lstatSync(file, { throwIfNoEntry: false });
    if (phase === 'precheck') {
      if (entry !== undefined) throw new Error('HTTP tool proof path already exists');
    } else {
      if (!entry?.isFile()) throw new Error('HTTP tool proof must be a regular file');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
          throw new Error('HTTP tool proof file changed before readback');
        }
        const expected = Buffer.from(marker);
        const bytes = Buffer.alloc(expected.length + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        process.stdout.write(bytes.subarray(0, length).equals(expected) ? 'match' : 'mismatch');
      } finally {
        fs.closeSync(fd);
      }
    }
  }
`;

async function verifyToolAction(
  f: Fixture,
  agent: Agent,
  marker: string,
  turn: (file: string) => Promise<void>,
): Promise<void> {
  const dedicated = agent.preset === "Codex";
  const role = dedicated ? "agent" : "gateway";
  const workspace = dedicated ? "/home/node/workspace" : "/home/node/.openclaw/workspace";
  const file = posix.join(workspace, `occ-http-chat-${randomUUID()}`);
  const pod = await f.pod(agent, role);
  const { namespace, name, uid } = pod.metadata;
  const containerId = (selected: typeof pod) =>
    selected.status.containerStatuses?.find((status: { name: string }) => status.name === role)
      ?.containerID;
  const id = containerId(pod);
  assert.ok(uid && namespace && name && id, "HTTP tool proof requires an identified workload");
  const container = pod.spec.containers.find(
    (candidate: { name: string }) => candidate.name === role,
  );
  assert.ok(
    container?.volumeMounts?.some(
      (mount: { mountPath: string; readOnly?: boolean }) =>
        mount.mountPath === workspace && mount.readOnly !== true,
    ),
    "HTTP tool proof requires a writable workspace mount in the selected workload",
  );
  const checkWorkload = async () => {
    const selected = await f.pod(agent, role);
    assert.ok(
      selected.metadata.uid === uid &&
        selected.metadata.namespace === namespace &&
        selected.metadata.name === name &&
        containerId(selected) === id,
      "HTTP tool proof workload changed",
    );
  };
  const run = async (phase: "precheck" | "readback" | "cleanup") => {
    // The initial Pod lookup already binds the precheck. Recheck after the HTTP turn.
    if (phase !== "precheck") {
      await checkWorkload();
    }
    const stdout = await f.kubectl(
      "-n",
      namespace,
      "exec",
      name,
      "-c",
      role,
      "--",
      "node",
      "-e",
      toolProofFile,
      phase,
      file,
      marker,
    );
    await checkWorkload();
    return stdout;
  };

  await run("precheck");
  let failed = false;
  try {
    await turn(file);
    assert.equal(
      await run("readback"),
      "match",
      "the selected Harness must execute the HTTP turn's tool action",
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await run("cleanup").catch((error: unknown) => {
      // Preserve the HTTP or readback failure when the owned path cannot be removed.
      if (!failed) {
        throw error;
      }
    });
  }
}

const proofResponseLimit = 1024 * 1024;

// RFC 9110 allows token and quoted-string parameter values on a single media type.
const httpToken = /[!#$%&'*+.^_`|~0-9a-z-]+/.source;
const httpQuotedString = /"(?:[\t \x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t \x21-\x7e\x80-\xff])*"/
  .source;
const sseMediaType = new RegExp(
  String.raw`^[ \t]*text/event-stream[ \t]*(?:;[ \t]*(?:${httpToken}=(?:${httpToken}|${httpQuotedString})[ \t]*)?)*$`,
  "i",
);

export async function readQaHttpChatSse(
  body: AsyncIterable<Buffer> & Readonly<Pick<IncomingMessage, "complete" | "headersDistinct">>,
) {
  const contentTypes = body.headersDistinct["content-type"] ?? [];
  assert.ok(
    contentTypes.length === 1 &&
      contentTypes.every((contentType) => sseMediaType.test(contentType)),
    "native SSE must have a valid text/event-stream Content-Type",
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lineParts: string[] = [];
  const data: string[] = [];
  const answer: string[] = [];
  const nativeErrors: string[] = [];
  let size = 0;
  let applicationError = false;
  let malformed = false;
  let hasChunk = false;
  let done = false;
  let observedBeforeTerminal = false;
  let incremental = false;

  function readLine(line: string) {
    if (done) {
      malformed ||= line !== "";
      return;
    }
    if (line !== "") {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field === "data") {
        data.push(colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, ""));
      }
      return;
    }
    if (data.length === 0) {
      return;
    }
    const payload = data.join("\n");
    data.length = 0;
    if (payload === "") {
      return;
    }
    if (payload === "[DONE]") {
      done = true;
      incremental = observedBeforeTerminal;
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      malformed = true;
      return;
    }
    if (typeof event !== "object" || event === null) {
      malformed = true;
      return;
    }
    if ("error" in event) {
      applicationError = true;
      const error = event.error;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        nativeErrors.push(error.message);
      }
      return;
    }
    if (
      !("object" in event) ||
      event.object !== "chat.completion.chunk" ||
      !("choices" in event) ||
      !Array.isArray(event.choices)
    ) {
      malformed = true;
      return;
    }
    const choices: unknown[] = event.choices;
    // The fixture requests one answer. A lone unindexed choice also refers to choice zero.
    if (choices.length > 1) {
      malformed = true;
      return;
    }
    for (const choice of choices) {
      if (
        typeof choice !== "object" ||
        choice === null ||
        !("delta" in choice) ||
        ("index" in choice && choice.index !== 0)
      ) {
        malformed = true;
        return;
      }
      const delta = choice.delta;
      if (typeof delta !== "object" || delta === null || Array.isArray(delta)) {
        malformed = true;
        return;
      }
      if ("content" in delta && delta.content !== null) {
        if (typeof delta.content !== "string") {
          malformed = true;
          return;
        }
        answer.push(delta.content);
      }
    }
    hasChunk = true;
  }

  for await (const chunk of body) {
    size += chunk.byteLength;
    assert.ok(size <= proofResponseLimit, "proof response exceeded 1 MiB");
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      lineParts.push(text.slice(start, end));
      const line = lineParts.join("").replace(/\r$/, "");
      lineParts.length = 0;
      readLine(line);
      start = end + 1;
    }
    if (start < text.length) {
      lineParts.push(text.slice(start));
    }
    // Node can expose several reads after the HTTP parser has received the entire body.
    observedBeforeTerminal ||= hasChunk && !done && !body.complete;
  }
  decoder.decode(); // Reject an incomplete UTF-8 sequence at EOF.
  malformed ||= lineParts.length > 0 || data.length > 0;

  return {
    applicationError,
    malformed,
    hasChunk,
    done,
    incremental,
    answer: answer.join(""),
    nativeErrors,
  };
}

export async function verifyQaHttpChat(f: Fixture, agent: Agent): Promise<void> {
  const transport = createConsoleFixtureTransport(f.consoleUrl, f.apiUrl);
  const session = await signInWithEmailPassword({
    ...f.credentials,
    origin: f.consoleUrl,
    headers: { origin: f.consoleUrl },
    fetch: transport.fetchThroughLoopback,
  });
  registerQaSecret(session.cookie);
  const human = authenticatedHeaders(session);
  const base = `/namespaces/${agent.namespaceId}`;
  const principal = await f.api("POST", `${base}/iam/service-principals`, {});
  const role = await f.api("POST", `${base}/iam/roles`, {
    name: `http-chat-${randomUUID()}`,
    permissions: [{ action: "operate", resourceKind: "agent" }],
  });
  await f.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: principal.id,
    roleId: role.id,
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const issue = async (principalId = principal.id) => {
    const key = await f.api("POST", "/api/auth/service-keys", {
      namespaceId: agent.namespaceId,
      servicePrincipalId: principalId,
      name: `http-${randomUUID().slice(0, 8)}`,
    });
    registerQaSecret(key.key);
    return key;
  };
  const issuedKeys: string[] = [];
  const key = await issue();
  issuedKeys.push(key.id);
  const service = { "x-api-key": key.key };
  const path = `/agents/${agent.id}/chat`;
  const evidence = {
    httpRequests: 0,
    completedJsonResponses: 0,
    completedSseResponses: 0,
    // In request order, so a valid but coalesced response stays distinct from a failed response.
    sseObservations: [] as ("failed" | "unmeasured" | "incremental")[],
    verifiedToolActions: 0,
  };
  const send = async (
    headers: Record<string, string>,
    body: Record<string, unknown>,
    url = path,
    during?: () => Promise<void>,
  ) => {
    evidence.httpRequests += 1;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        f.apiUrl + url,
        {
          method: "POST",
          headers: {
            host: new URL(f.consoleUrl).host,
            "content-type": "application/json",
            ...headers,
          },
          signal: AbortSignal.timeout(650_000),
        },
        resolve,
      );
      request.once("error", reject);
      request.end(JSON.stringify(body));
    });
    let text = "";
    let size = 0;
    let interrupted = false;
    let intervened = false;
    const sse =
      body.stream === true && response.statusCode === 200 && during === undefined
        ? await readQaHttpChatSse(response).catch((error: unknown) => {
            response.destroy();
            throw error;
          })
        : undefined;
    if (sse === undefined) {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response as AsyncIterable<Buffer>) {
          size += chunk.byteLength;
          assert.ok(size <= proofResponseLimit, "proof response exceeded 1 MiB");
          text += decoder.decode(chunk, { stream: true });
          if (during !== undefined && !intervened) {
            intervened = true;
            await during();
          }
        }
      } catch (error) {
        if (
          during === undefined ||
          !(error instanceof Error) ||
          !["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(Reflect.get(error, "code"))
        ) {
          throw error;
        }
        interrupted = true;
      }
      text += decoder.decode();
    }
    const nativeErrors = sse?.nativeErrors ?? [];
    if (
      sse === undefined &&
      (response.statusCode === 500 || (body.stream === true && response.statusCode === 200))
    ) {
      const payloads =
        body.stream === true
          ? text
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
              .map((line) => line.slice(6))
          : [text];
      for (const payload of payloads) {
        try {
          const message = JSON.parse(payload)?.error?.message;
          if (typeof message === "string") {
            nativeErrors.push(message);
          }
        } catch {
          // Only structured native errors are diagnostic output.
        }
      }
    }
    for (const [index, message] of nativeErrors.entries()) {
      nativeErrors[index] = redactedQaTail(message, f.env, { lines: 3, lineChars: 600 }).join(" ");
    }
    if (response.statusCode === 500 || nativeErrors.length > 0) {
      await f.record(`http-chat-${agent.id}-native-response-error`, { messages: nativeErrors });
      try {
        const logs = await f.api(
          "GET",
          `${base}/agents/${agent.id}/deployments/${agent.revision.id}/runtime/logs?source=gateway&minLevel=warn`,
        );
        await f.record(`http-chat-${agent.id}-native-error`, {
          messages: logs.records
            .slice(-6)
            .map((record: { message?: string; fields?: unknown }) =>
              redactedQaTail(
                `${record.message ?? ""} ${JSON.stringify(record.fields ?? {})}`,
                f.env,
                { lines: 3, lineChars: 600 },
              ).join(" "),
            ),
        });
      } catch {
        // Preserve the HTTP failure if bounded diagnostic collection is unavailable.
      }
    }
    return {
      status: response.statusCode,
      nativeErrors,
      text,
      sse,
      interrupted,
    };
  };
  const message = (content: string, user?: string, stream = false) => ({
    messages: [{ role: "user", content }],
    stream,
    ...(user === undefined ? {} : { user }),
  });
  const completion = (result: Awaited<ReturnType<typeof send>>) => {
    let diagnostic = "";
    if (result.status !== 200) {
      try {
        const nativeMessage = JSON.parse(result.text)?.error?.message;
        if (typeof nativeMessage === "string") {
          diagnostic = redactedQaTail(nativeMessage, f.env, { lines: 3, lineChars: 400 }).join(" ");
        }
      } catch {
        // Do not expose unstructured upstream response bodies.
      }
    }
    assert.equal(result.status, 200, `native completion must succeed: ${diagnostic}`);
    assert.equal(result.interrupted, false, "native completion must finish");
    const json = JSON.parse(result.text);
    assert.equal(json.object, "chat.completion");
    assert.equal(json.data, undefined, "OCC must not wrap the native response");
    evidence.completedJsonResponses += 1;
    return String(json.choices[0].message.content);
  };
  const verify = async () => {
    await verifyQaHttpChatIsolation(f, agent);
    const reader = await f.api("POST", `${base}/iam/service-principals`, {});
    const readRole = await f.api("POST", `${base}/iam/roles`, {
      name: `http-reader-${randomUUID()}`,
      permissions: [{ action: "read", resourceKind: "agent" }],
    });
    await f.api("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: reader.id,
      roleId: readRole.id,
      resourceKind: "agent",
      resourceId: agent.id,
    });
    const readerKey = await issue(reader.id);
    issuedKeys.push(readerKey.id);
    assert.equal(
      (
        await send(
          { "x-api-key": readerKey.key, "x-forwarded-user": "administrator" },
          message("Do not execute this denied request."),
        )
      ).status,
      403,
    );

    // A valid credential with an incomplete JSON body must not retain a socket indefinitely.
    evidence.httpRequests += 1;
    const bodyDeadline = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        f.apiUrl + path,
        {
          method: "POST",
          signal: AbortSignal.timeout(70_000),
          headers: {
            host: new URL(f.consoleUrl).host,
            "content-type": "application/json",
            "content-length": "100",
            ...service,
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            resolve(response.statusCode);
            request.destroy();
          });
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.write('{"messages":[');
    });
    assert.equal(bodyDeadline, 408);
    // Verify a real tool side effect inside the selected Harness, not a model's claim of execution.
    for (const headers of [human, service]) {
      const marker = `proof-${randomUUID()}`;
      await verifyToolAction(f, agent, marker, async (file) => {
        completion(
          await send(
            headers,
            message(
              `Use your command execution tool to write exactly ${marker} to ${file}. Then reply DONE.`,
            ),
          ),
        );
      });
      evidence.verifiedToolActions += 1;
      if (
        agent.preset === "Codex" &&
        process.env.OCC_DEVELOPMENT_CODEX_VERIFICATION_MODE === "danger-full-access"
      ) {
        // Match the unique tool marker to one real native turn; export policy fields only.
        const script = `
          const fs = require('node:fs'); const path = require('node:path');
          const parse = ${parseNativeRolloutProvenance.toString()};
          const marker = process.argv[1]; const observations = [];
          function visit(directory, depth = 0) {
            if (depth > 5 || !fs.existsSync(directory)) return;
            for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
              const name = path.join(directory, entry.name);
              if (entry.isDirectory()) { visit(name, depth + 1); continue; }
              if (!entry.isFile() || !name.endsWith('.jsonl') || fs.statSync(name).size > 8388608) continue;
              const text = fs.readFileSync(name, 'utf8');
              if (!text.includes(marker)) continue;
              const rows = text.trim().split('\\n').map(line => JSON.parse(line));
              const session = rows.find(row => row.type === 'session_meta')?.payload;
              const turns = rows.filter(row => row.type === 'turn_context').map(row => row.payload);
              if (!session || new Set(turns.map(turn => turn.turn_id)).size !== 1) continue;
              const turn = turns[0];
              const result = parse({text, expectedThreadId:session.id, expectedTurnId:turn.turn_id, expectedCwd:turn.cwd});
              observations.push({status:result.status, sandboxPolicy:result.sandboxPolicy, approvalPolicy:result.approvalPolicy,
                permissionProfileType:result.permissionProfileType, activeProfileKind:result.activeProfileKind});
            }
          }
          visit(path.join(process.env.CODEX_HOME, 'sessions'));
          console.log(JSON.stringify(observations));
        `;
        const policies = await f.waitFor(
          "native HTTP turn policy evidence",
          async () => {
            const raw = await f.execRole(agent, "agent", ["node", "-e", script, marker]);
            const rows = JSON.parse(raw.stdout);
            return rows.length > 0 ? rows : false;
          },
          15_000,
        );
        await f.record(
          `http-chat-${agent.id}-permissions-${evidence.verifiedToolActions}`,
          policies,
        );
        assert.equal(
          policies.length,
          1,
          "the HTTP tool turn must have unambiguous native policy evidence",
        );
        assert.equal(policies[0].status, "available");
        assert.equal(policies[0].sandboxPolicy, "danger-full-access");
        assert.equal(policies[0].approvalPolicy, "on-request");
      }
      const observation = evidence.sseObservations.push("failed") - 1;
      const streamed = await send(
        headers,
        message(
          "Without tools, preamble, commentary, or revisions, output the integers 1 through 40 separated by single spaces as one final answer. End with 40 and do not add a trailing newline.",
          undefined,
          true,
        ),
      );
      assert.equal(streamed.status, 200);
      const { sse } = streamed;
      assert.ok(sse);
      assert.ok(
        !sse.applicationError,
        `native SSE must not report an application error: ${streamed.nativeErrors.join("; ")}`,
      );
      assert.ok(!sse.malformed, "native SSE must contain complete, valid events");
      assert.ok(sse.done, "native SSE must end with a complete [DONE] frame");
      assert.ok(sse.hasChunk, "native SSE must contain a chat completion chunk");
      assert.ok(
        /(?:^|\s)(?:40|forty)\s*$/i.test(sse.answer),
        "the streamed model answer must reach the requested final number",
      );
      evidence.sseObservations[observation] = sse.incremental ? "incremental" : "unmeasured";
      assert.ok(
        sse.incremental,
        "SSE must expose a complete chunk before the terminal read while HTTP is open",
      );
      evidence.completedSseResponses += 1;
    }
    const label = `conversation-${randomUUID()}`;
    const memory = `remember-${randomUUID()}`;
    completion(
      await send(
        service,
        message(
          `Keep this phrase only in our current conversation. Do not write files or use memory tools: ${memory}. Reply ACK.`,
          label,
        ),
      ),
    );
    assert.ok(
      completion(
        await send(
          service,
          message(
            "Without tools or persistent memory, return the private phrase from earlier messages in this conversation.",
            label,
          ),
        ),
      ).includes(memory),
    );
    assert.ok(
      !completion(
        await send(
          service,
          message(
            "Without tools or persistent memory, return the private phrase from earlier messages in this conversation, or NONE.",
          ),
        ),
      ).includes(memory),
    );
    assert.ok(
      !completion(
        await send(
          human,
          message(
            "Without tools or persistent memory, return the private phrase from earlier messages in this conversation, or NONE.",
            label,
          ),
        ),
      ).includes(memory),
    );
    const freshMemory = `fresh-${randomUUID()}`;
    completion(
      await send(
        service,
        message(
          `Keep ${freshMemory} only in this conversation, without tools or persistent memory. Reply ACK.`,
        ),
      ),
    );
    assert.ok(
      !completion(
        await send(
          service,
          message(
            "Without tools or persistent memory, return the private phrase from earlier messages in this conversation, or NONE.",
          ),
        ),
      ).includes(freshMemory),
    );
    const other = await createQaAgent(f, agent.preset, undefined, `${agent.qaScenario}-other`, {
      apiKeyAuth: true,
      httpChat: true,
    });
    other.qaScenario = agent.qaScenario;
    const otherPath = `/agents/${other.id}/chat`;
    assert.equal((await send(service, message("Do not execute."), otherPath)).status, 404);
    await f.api("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role.id,
      resourceKind: "agent",
      resourceId: other.id,
    });
    assert.ok(
      !completion(
        await send(
          service,
          message(
            "Without tools or persistent memory, return the private phrase from earlier messages in this conversation, or NONE.",
            label,
          ),
          otherPath,
        ),
      ).includes(memory),
    );
    const replacement = await issue();
    issuedKeys.push(replacement.id);
    await f.api("DELETE", `/api/auth/service-keys/${key.id}`);
    issuedKeys.splice(issuedKeys.indexOf(key.id), 1);
    assert.equal((await send(service, message("Do not execute this request."))).status, 401);
    const rotated = { "x-api-key": replacement.key };
    assert.ok(
      completion(
        await send(
          rotated,
          message(
            "Without tools or persistent memory, return the private phrase from earlier messages in this conversation.",
            label,
          ),
        ),
      ).includes(memory),
    );
    assert.equal((await send({}, message("Do not execute this request."))).status, 401);
    assert.equal(
      (
        await send(
          rotated,
          message("Do not execute this request."),
          `/agents/agt_${randomUUID()}/chat`,
        )
      ).status,
      404,
    );
    for (const header of [
      "x-openclaw-agent",
      "x-openclaw-user",
      "x-openclaw-session-key",
      "x-openclaw-scopes",
    ]) {
      assert.equal(
        (
          await send(
            { ...rotated, [header]: "operator.admin" },
            message("Do not execute this request."),
          )
        ).status,
        400,
      );
    }
    assert.equal(
      (await send(rotated, { ...message("Do not execute this request."), model: "openclaw:other" }))
        .status,
      400,
    );
    assert.equal((await send(rotated, message("x".repeat(20 * 1024 * 1024)))).status, 413);
    // Revoke after native SSE begins. The relay must close without a success terminator;
    // tool effects can remain uncertain, so the test does not claim rollback.
    const streamKey = await issue();
    issuedKeys.push(streamKey.id);
    const interrupted = await send(
      { "x-api-key": streamKey.key },
      message(
        "Use your command tool to run sleep 65, wait until it finishes, then reply DONE.",
        undefined,
        true,
      ),
      path,
      async () => {
        await f.api("DELETE", `/api/auth/service-keys/${streamKey.id}`);
        issuedKeys.splice(issuedKeys.indexOf(streamKey.id), 1);
      },
    );
    assert.equal(interrupted.status, 200, "revocation must happen after native streaming begins");
    assert.equal(interrupted.interrupted, true, "revocation must close the active stream");
    assert.ok(!interrupted.text.includes("data: [DONE]"));
    for (const transition of ["replace", "stop"] as const) {
      const result = await send(
        rotated,
        message(
          "Use your command tool to run sleep 90, wait until it finishes, then reply DONE.",
          undefined,
          true,
        ),
        path,
        async () => {
          if (transition === "replace") {
            await f.deployAndWait(agent);
          } else {
            await f.api("POST", `${base}/agents/${agent.id}/stop`);
          }
        },
      );
      assert.equal(result.status, 200, "lifecycle change must occur during native SSE");
      assert.equal(result.interrupted, true);
      assert.ok(!result.text.includes("data: [DONE]"));
    }
    await f.deployAndWait(agent);
    // Operator opt-out applies only after the replacement revision starts.
    const configurationPath = `${base}/configurations/${agent.configuration.id}`;
    const configuration = await f.api("GET", configurationPath);
    await f.api("PATCH", configurationPath, {
      values: {
        ...configuration.values,
        gateway: {
          ...configuration.values.gateway,
          http: { endpoints: { chatCompletions: { enabled: false } } },
        },
      },
    });
    await f.deployAndWait(agent);
    assert.equal((await send(rotated, message("Do not execute this request."))).status, 503);
    await f.api("POST", `${base}/agents/${agent.id}/stop`);
    assert.equal((await send(rotated, message("Do not execute this request."))).status, 503);
  };
  await runQaHttpChatWithCleanup({
    verify,
    record: () =>
      f.record(`http-chat-${agent.id}-outcomes`, {
        ...evidence,
        preset: agent.preset,
        verificationMode: process.env.OCC_DEVELOPMENT_CODEX_VERIFICATION_MODE || "workspace-write",
        // These count HTTP completions, not internal provider calls or automatic retries.
        providerCallCount: "unobserved",
      }),
    cleanupHandles: issuedKeys,
    dispose: (id) => f.api("DELETE", `/api/auth/service-keys/${id}`),
  });
}
