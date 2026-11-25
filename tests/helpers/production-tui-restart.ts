import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { installedGatewayRpc } from "./installed-gateway-rpc.ts";
import type { createKubernetesClient } from "./kubernetes-real.ts";

const chatHistory = Type.Object({
  sessionId: Type.String(),
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Optional(Type.Unknown()),
      __openclaw: Type.Optional(
        Type.Object({ continuation: Type.Optional(Type.Object({ source: Type.String() })) }),
      ),
    }),
  ),
});
const runStatus = Type.Object({
  session: Type.Object({
    hasActiveRun: Type.Boolean(),
    activeRunIds: Type.Optional(Type.Array(Type.String())),
  }),
});

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  const blocks = Type.Array(
    Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }),
  );
  return Check(blocks, content)
    ? content
        .filter(({ type }) => type === "text")
        .map(({ text }) => text)
        .join("\n")
        .trim()
    : "";
}

type InterruptedTurn = {
  runId: string;
  sessionKey: string;
  sessionId: string;
  prompt: string;
  nonce: string;
  ledger: string;
};

export function productionTuiRestart({
  kubectl,
  tenant,
  waitFor,
}: {
  kubectl: (...args: string[]) => Promise<string>;
  tenant: string;
  waitFor: ReturnType<typeof createKubernetesClient>["waitFor"];
}) {
  const inGateway = (pod: string, ...args: string[]) =>
    kubectl("-n", tenant, "exec", pod, "-c", "gateway", "--", ...args);

  const gateway = (pod: string) =>
    installedGatewayRpc((script) => inGateway(pod, "node", "-e", script), 15_000);

  async function call<Schema extends TSchema>(
    pod: string,
    method: string,
    params: Record<string, unknown>,
    schema: Schema,
  ) {
    const reply = await gateway(pod).call(method, params);
    assert.ok(Check(schema, reply), `Unexpected Gateway response from ${method}`);
    return reply;
  }

  const history = (pod: string, sessionKey: string) =>
    call(pod, "chat.history", { sessionKey, limit: 100 }, chatHistory);
  const status = (pod: string, key: string) => call(pod, "sessions.describe", { key }, runStatus);

  async function readAvailableHistory(pod: string, sessionKey: string) {
    const reply = await gateway(pod).readAvailableHistory(sessionKey, 100);
    assert.ok(reply === undefined || Check(chatHistory, reply), "Unexpected chat.history response");
    return reply;
  }

  async function assertActive(pod: string, turn: Pick<InterruptedTurn, "sessionKey" | "runId">) {
    const { session } = await status(pod, turn.sessionKey);
    assert.equal(session.hasActiveRun, true, "The original turn must still be running");
    assert.ok(session.activeRunIds?.includes(turn.runId), "The submitted run must be active");
  }

  async function send(pod: string, sessionKey: string, message: string) {
    return call(
      pod,
      "chat.send",
      { sessionKey, idempotencyKey: randomUUID(), message },
      Type.Object({ runId: Type.String() }),
    );
  }

  const readLedger = (pod: string, ledger: string) =>
    inGateway(
      pod,
      "node",
      "-e",
      "const fs = require('node:fs'); if (fs.existsSync(process.argv[1])) process.stdout.write(fs.readFileSync(process.argv[1], 'utf8'));",
      ledger,
    );

  const replies = (messages: Awaited<ReturnType<typeof history>>["messages"], nonce: string) =>
    messages.filter(({ role, content }) => role === "assistant" && messageText(content) === nonce);

  async function start(pod: string): Promise<InterruptedTurn> {
    const sessionKey = `agent:main:upgrade-${randomUUID()}`;
    const nonce = `UPGRADE_RECOVERED_${randomUUID()}`;
    const ledger = `/home/node/.openclaw/workspace/${nonce}.txt`;
    const prompt = [
      `Use the shell tool to inspect ${ledger}.`,
      `If it is absent, run: printf 'started\\n' >> ${ledger}; sleep 600`,
      "Wait for the command to finish before replying. Do not start background work.",
      "After a restart, inspect the file and continue without appending again or repeating the sleep.",
      `After the command finishes or after recovering the existing file, reply with exactly ${nonce}.`,
    ].join("\n");
    const { runId } = await send(pod, sessionKey, prompt);
    await waitFor("the model to record the effect before sleeping", async () => {
      return (await readLedger(pod, ledger)) === "started\n";
    });
    const before = await history(pod, sessionKey);
    await assertActive(pod, { sessionKey, runId });
    assert.equal(replies(before.messages, nonce).length, 0, "The turn must be unfinished");
    return { runId, sessionKey, sessionId: before.sessionId, prompt, nonce, ledger };
  }

  async function abort(pod: string, turn: InterruptedTurn) {
    const { aborted } = await call(
      pod,
      "chat.abort",
      { sessionKey: turn.sessionKey, userInitiated: true },
      Type.Object({ aborted: Type.Boolean() }),
    );
    assert.equal(aborted, true, "The negative control must cancel the active turn");
    await waitFor("the cancelled turn to settle", async () => {
      return !(await status(pod, turn.sessionKey)).session.hasActiveRun;
    });
    const cancelled = await history(pod, turn.sessionKey);
    assert.equal(replies(cancelled.messages, turn.nonce).length, 0);
    return cancelled;
  }

  async function assertResumed(pod: string, turn: InterruptedTurn) {
    // This function observes the retained session without submitting another turn.
    const after = await waitFor("the interrupted turn to finish after replacement", async () => {
      const current = await readAvailableHistory(pod, turn.sessionKey);
      if (current === undefined) {
        return undefined;
      }
      const { session } = await status(pod, turn.sessionKey);
      return !session.hasActiveRun && replies(current.messages, turn.nonce).length > 0
        ? current
        : undefined;
    });
    assert.equal(after.sessionId, turn.sessionId, "Recovery must keep the same session");
    assert.equal(
      after.messages.filter(
        ({ role, content }) => role === "user" && messageText(content) === turn.prompt,
      ).length,
      1,
      "Recovery must preserve the single original user input",
    );
    assert.equal(
      after.messages.filter((message) => message.__openclaw?.continuation?.source === "restart")
        .length,
      1,
      "The replacement must admit one native restart continuation",
    );
    assert.equal(replies(after.messages, turn.nonce).length, 1);
    assert.equal(await readLedger(pod, turn.ledger), "started\n");
  }

  async function assertStillCancelled(
    pod: string,
    turn: InterruptedTurn,
    cancelled: Awaited<ReturnType<typeof abort>>,
  ) {
    const freshSession = `agent:main:upgraded-${randomUUID()}`;
    const nonce = `UPGRADE_READY_${randomUUID()}`;
    await send(pod, freshSession, `Reply with exactly ${nonce}. Do not use tools.`);
    await waitFor("a fresh reply from the restarted Agent", async () => {
      const current = await readAvailableHistory(pod, freshSession);
      return current !== undefined && replies(current.messages, nonce).length > 0;
    });
    // The fresh reply establishes model and Gateway readiness for the negative control.
    const after = await history(pod, turn.sessionKey);
    assert.equal(after.sessionId, turn.sessionId, "Stopping must retain the cancelled session");
    assert.deepEqual(
      after.messages,
      cancelled.messages,
      "The cancelled session must remain unchanged",
    );
    assert.equal((await status(pod, turn.sessionKey)).session.hasActiveRun, false);
    assert.equal(await readLedger(pod, turn.ledger), "started\n");
  }

  return { start, assertActive, abort, assertResumed, assertStillCancelled };
}
