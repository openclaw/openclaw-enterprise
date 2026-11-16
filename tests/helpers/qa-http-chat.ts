import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createConsoleFixtureTransport } from "./console-fixture-transport.ts";
import { parseNativeRolloutProvenance } from "./native-rollout-provenance.ts";
import { verifyQaHttpChatIsolation } from "./qa-http-chat-isolation.ts";
import { redactedQaTail, registerQaSecret } from "./qa-secrets.ts";
import { createQaAgent, type createQaInstallation } from "./qa-installation.mjs";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

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
    verifiedToolActions: 0,
  };
  const send = async (
    headers: Record<string, string>,
    body: Record<string, unknown>,
    url = path,
    during?: () => Promise<void>,
  ) => {
    evidence.httpRequests += 1;
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
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
    let chunks = 0;
    let firstChunkAt: number | undefined;
    let interrupted = false;
    let intervened = false;
    try {
      for await (const chunk of response) {
        firstChunkAt ??= Date.now();
        chunks += 1;
        text += String(chunk);
        assert.ok(Buffer.byteLength(text) <= 1024 * 1024, "proof response exceeded 1 MiB");
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
    if (response.statusCode === 500) {
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
      text,
      chunks,
      firstChunkAt,
      endedAt: Date.now(),
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
  try {
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
      const file = `/tmp/occ-http-chat-${randomUUID()}`;
      completion(
        await send(
          headers,
          message(
            `Use your command execution tool to write exactly ${marker} to ${file}. Then reply DONE.`,
          ),
        ),
      );
      const observed = await f.execRole(agent, agent.preset === "Codex" ? "agent" : "gateway", [
        "node",
        "-e",
        "const fs=require('node:fs'); const p=process.argv[1]; process.stdout.write(fs.readFileSync(p,'utf8')); fs.unlinkSync(p)",
        file,
      ]);
      assert.equal(
        observed.stdout,
        marker,
        "the selected Harness must execute the HTTP turn's tool action",
      );
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
      const streamed = await send(
        headers,
        message(
          "List the numbers from one through forty, each on a separate line.",
          undefined,
          true,
        ),
      );
      assert.equal(streamed.status, 200);
      assert.ok(
        streamed.chunks > 1 && streamed.firstChunkAt! < streamed.endedAt,
        "SSE must arrive incrementally",
      );
      assert.match(streamed.text, /data: \[DONE\]/);
      assert.match(streamed.text, /chat.completion.chunk/);
      const events = streamed.text
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));
      assert.ok(
        events.every((event) => event.error === undefined),
        "native SSE must not report an application error",
      );
      const answer = events
        .flatMap((event) => event.choices ?? [])
        .map((choice) => choice.delta?.content ?? "")
        .join("");
      assert.match(
        answer,
        /40|forty/i,
        "the streamed model answer must reach the requested final number",
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
  } finally {
    await f.record(`http-chat-${agent.id}-outcomes`, {
      ...evidence,
      preset: agent.preset,
      verificationMode: process.env.OCC_DEVELOPMENT_CODEX_VERIFICATION_MODE || "workspace-write",
      // These count HTTP completions, not internal provider calls or automatic retries.
      providerCallCount: "unobserved",
    });
    for (const id of issuedKeys) {
      await f.api("DELETE", `/api/auth/service-keys/${id}`);
    }
  }
}
