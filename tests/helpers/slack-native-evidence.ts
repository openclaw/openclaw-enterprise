import assert from "node:assert/strict";
import { parseGatewayObservation } from "./normal-agent-observation-receipts.ts";
import { sessionEvidenceScript } from "./normal-agent-gateway-evidence.ts";

/** Correlate a real Slack ingress with exactly one completed native Codex turn. */
export async function gatewaySlackEvidence(
  execGateway: (...args: string[]) => Promise<string>,
  nonce: string,
) {
  const probe =
    "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite',{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT session_key FROM session_nodes').all().map(x=>x.session_key)));d.close()";
  const keys: unknown = JSON.parse(await execGateway("node", "-e", probe));
  assert.ok(Array.isArray(keys) && keys.every((key) => typeof key === "string"));
  const matches = [];
  for (const key of keys.filter((key) => key.includes("slack"))) {
    const proof = parseGatewayObservation(
      await execGateway(
        "node",
        "-e",
        sessionEvidenceScript,
        key,
        nonce,
        "",
        nonce,
        JSON.stringify({ toolNames: [] }),
      ),
    );
    if (!proof.userMarkerSeen || !proof.terminalAssistantMarkerSeen) {
      continue;
    }
    const turns = (proof.codexTurns ?? []).filter(
      (turn) => turn.promptSeen && turn.terminalAssistantSeen,
    );
    if (turns.length === 0) {
      continue;
    }
    assert.equal(
      turns.length,
      1,
      "one ingress must correlate with one completed native Codex turn",
    );
    matches.push({
      sessionKey: key,
      sessionId: proof.sessionId,
      nativeTurnPrefix: turns[0]!.turnPrefix,
    });
  }
  assert.equal(
    matches.length,
    1,
    "the exact gateway must persist the Slack prompt and one completed native Codex response",
  );
  return matches[0]!;
}
