import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { protectedText } from "./qa-secrets.mjs";

/** Real provider streaming plus a shell read whose output the prompt does not disclose. */
export async function verifyQaCustomResponses(f, agent, preset) {
  const nonce = `QA_RESPONSES_${randomUUID()}`;
  const file = `/tmp/qa-responses-${randomUUID()}`;
  const role = preset === "Codex" ? "agent" : "gateway";
  const secret = await protectedText(
    process.env.OCC_TEST_QA_RESPONSES_KEY_FILE,
    "custom Responses credential",
  );
  const gateway = await f.gatewayUrl(agent);
  try {
    // Only the actual Harness can read this Pod-local value. Repeating the prompt cannot satisfy the assertion.
    await f.execRole(agent, role, [
      "node",
      "-e",
      "require('node:fs').writeFileSync(process.argv[1],process.argv[2],{mode:0o600})",
      file,
      nonce,
    ]);
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.gatewayPassword}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: true,
        messages: [
          {
            role: "user",
            content: `Use your shell tool to read ${file}. Reply with exactly the file contents.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.equal(response.status, 200, "custom Responses streaming request must succeed");
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await response.text();
    assert.ok(!body.includes(secret), "stream must not disclose the model credential");
    const chunks = body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const text = chunks
      .flatMap((chunk) => (chunk.choices ?? []).map((choice) => choice.delta?.content ?? ""))
      .join("");
    assert.ok(
      text.includes(nonce),
      "the streaming answer must contain the value obtained through the real shell tool",
    );
    assert.equal(
      agent.revision.harnessAuth.authorizedEndpoint,
      process.env.OCC_TEST_QA_RESPONSES_BASE_URL,
    );
    await f.record("custom-responses", {
      preset,
      agentId: agent.id,
      revisionId: agent.revision.id,
      streaming: true,
      shellRead: true,
    });
  } finally {
    await f.execRole(agent, role, [
      "node",
      "-e",
      "require('node:fs').rmSync(process.argv[1],{force:true})",
      file,
    ]);
    await gateway.close();
  }
}
