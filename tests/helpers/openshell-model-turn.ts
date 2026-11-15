import assert from "node:assert/strict";
import { openShellGrantCredentialIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-token-grant.ts";
import type {
  ModelOriginObservation,
  ModelOriginToolTurn,
  ModelOriginTurn,
} from "../fixtures/openshell-model-origin.ts";

type ModelTurnReceipt = Extract<ModelOriginObservation, { kind: "turn" }>;
type ToolTurnReceipt = Extract<ModelOriginObservation, { kind: "tool" }>;

interface ModelGrantApproval {
  recipientId: string;
  requestId: string;
  bindingId: string;
  namespaceId: string;
  agentId: string;
  revisionId: string;
  credentialIdentity: string | null;
  consumed: boolean;
  assertionReplayClaimed: boolean;
}

interface ModelGrantEvidence {
  expected: {
    providerId: string;
    credentialKey: string;
    sandboxId: string;
    bindingId: string;
    namespaceId: string;
    agentId: string;
    revisionId: string;
  };
  readApprovals: () => Promise<readonly ModelGrantApproval[]>;
}

interface OpenShellModelTurnOptions {
  gatewayUrl: string;
  gatewayPassword: string;
  sessionKey: string;
  turn: ModelOriginTurn;
  readOriginTurn: (turnId: string) => Promise<ModelTurnReceipt | undefined>;
  grantEvidence?: ModelGrantEvidence;
  forbiddenCredentials?: readonly string[];
  signal?: AbortSignal;
}

async function completeGatewayTurn(
  {
    gatewayUrl,
    gatewayPassword,
    sessionKey,
    turn,
    forbiddenCredentials = [],
    signal,
  }: Omit<OpenShellModelTurnOptions, "readOriginTurn">,
  timeoutMs: number,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetch(new URL("/v1/chat/completions", gatewayUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayPassword}`,
      "content-type": "application/json",
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      // The runtime must supply prior assistant history on a continued session.
      messages: [{ role: "user", content: turn.marker }],
    }),
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
  });
  const body = await response.text();
  for (const credential of [gatewayPassword, ...forbiddenCredentials]) {
    if (credential) {
      assert.equal(body.includes(credential), false, "The Gateway response exposed a credential.");
    }
  }
  assert.equal(response.status, 200, "The installed Gateway must complete the model turn.");
  let reply: unknown;
  try {
    reply = JSON.parse(body).choices?.[0]?.message;
  } catch {
    assert.fail("The installed Gateway did not return a valid chat completion.");
  }
  assert.ok(
    reply !== null && typeof reply === "object" && "role" in reply && reply.role === "assistant",
    "The Gateway must return an assistant message.",
  );
  assert.equal(
    "content" in reply && typeof reply.content === "string" && reply.content.trim() === turn.answer,
    true,
    "The Gateway must return the answer held by the upstream fixture.",
  );
  return response.status;
}

/** Exercise the installed Gateway and its selected native Harness. The
 * provider-only answer and origin count together distinguish an upstream request from
 * credential probes, a cached response, and the Harness echoing its input. */
export async function assertOpenShellModelTurn({
  gatewayUrl,
  gatewayPassword,
  sessionKey,
  turn,
  readOriginTurn,
  grantEvidence,
  forbiddenCredentials = [],
  signal,
}: OpenShellModelTurnOptions) {
  assert.ok(gatewayPassword, "The installed Gateway needs an authenticated caller.");
  assert.ok(sessionKey, "The installed turn needs its caller-owned session.");
  assert.equal(
    (await readOriginTurn(turn.id)) === undefined,
    true,
    "The installed turn must begin with an unused origin marker.",
  );
  // Snapshot after startup, immediately before this request. Even an unconsumed
  // startup approval must not become fresh evidence when it completes later.
  const baseline = grantEvidence ? await grantEvidence.readApprovals() : undefined;
  const httpStatus = await completeGatewayTurn(
    {
      gatewayUrl,
      gatewayPassword,
      sessionKey,
      turn,
      forbiddenCredentials,
      ...(signal === undefined ? {} : { signal }),
    },
    180_000,
  );
  const observed = await readOriginTurn(turn.id);
  assert.ok(observed, "The origin must observe the authenticated model request.");
  assert.equal(
    observed.event === "request" &&
      observed.kind === "turn" &&
      observed.harness === turn.harness &&
      observed.status === 200 &&
      observed.turnId === turn.id &&
      observed.count === 1,
    true,
    "The origin must authenticate exactly one matching model request.",
  );
  assert.equal(
    observed.priorTurnObserved === (turn.priorTurnId !== undefined),
    true,
    "The origin must observe the required prior assistant reply.",
  );
  const origin: ModelTurnReceipt = {
    event: "request",
    auth: observed.auth,
    kind: "turn",
    harness: observed.harness,
    status: observed.status,
    turnId: observed.turnId,
    count: observed.count,
    priorTurnObserved: observed.priorTurnObserved,
  };
  let grant;
  if (grantEvidence && baseline) {
    const { expected } = grantEvidence;
    const priorRequests = new Set(baseline.map((approval) => approval.requestId));
    const credentialIdentity = openShellGrantCredentialIdentity(
      expected.providerId,
      expected.credentialKey,
    );
    const approvals = await grantEvidence.readApprovals();
    const consumed = approvals.find(
      (approval) =>
        !priorRequests.has(approval.requestId) &&
        approval.recipientId === expected.sandboxId &&
        approval.bindingId === expected.bindingId &&
        approval.namespaceId === expected.namespaceId &&
        approval.agentId === expected.agentId &&
        approval.revisionId === expected.revisionId &&
        approval.credentialIdentity === credentialIdentity &&
        approval.consumed === true &&
        approval.assertionReplayClaimed === true,
    );
    // Consumption proves the authority accepted this Gateway assertion, not
    // final material release by itself. The authenticated origin response above
    // is the separate evidence that the model request obtained its credential.
    assert.ok(consumed, "The model turn needs a fresh matching consumed Gateway assertion.");
    grant = {
      providerId: expected.providerId,
      sandboxId: expected.sandboxId,
      bindingId: expected.bindingId,
      requestId: consumed.requestId,
      assertionConsumed: true as const,
    };
  }
  return {
    sessionKey,
    turnId: turn.id,
    harness: turn.harness,
    httpStatus,
    origin,
    ...(grant ? { grant } : {}),
  };
}

interface OpenShellToolTurnOptions extends Omit<
  OpenShellModelTurnOptions,
  "turn" | "readOriginTurn" | "grantEvidence"
> {
  turn: ModelOriginToolTurn;
  readOriginToolTurn: (turnId: string) => Promise<ToolTurnReceipt | undefined>;
}

/** Run the fixture-owned command through the Agent's native tool and require
 * its terminal result before accepting the configured assistant answer. */
export async function assertOpenShellToolTurn({
  gatewayUrl,
  gatewayPassword,
  sessionKey,
  turn,
  readOriginToolTurn,
  forbiddenCredentials = [],
  signal,
}: OpenShellToolTurnOptions) {
  assert.ok(gatewayPassword, "The installed Gateway needs an authenticated caller.");
  assert.ok(sessionKey, "The installed turn needs its caller-owned session.");
  assert.equal(
    (await readOriginToolTurn(turn.id)) === undefined,
    true,
    "The installed tool turn must begin with an unused origin marker.",
  );
  const httpStatus = await completeGatewayTurn(
    {
      gatewayUrl,
      gatewayPassword,
      sessionKey,
      turn,
      forbiddenCredentials,
      ...(signal === undefined ? {} : { signal }),
    },
    turn.timeoutMs + 5_000,
  );
  const observed = await readOriginToolTurn(turn.id);
  assert.ok(observed, "The origin must observe the native tool's terminal result.");
  assert.equal(
    observed.event === "request" &&
      observed.kind === "tool" &&
      observed.harness === "codex" &&
      observed.status === 200 &&
      observed.turnId === turn.id &&
      observed.count === 1 &&
      observed.commandCount === 1 &&
      Number.isSafeInteger(observed.pollCount) &&
      observed.pollCount >= 0 &&
      observed.exitCode === 0 &&
      observed.completed === true &&
      observed.outputMatched === true,
    true,
    "The origin must verify one completed native command with the expected output.",
  );
  const origin: ToolTurnReceipt = {
    event: "request",
    auth: observed.auth,
    kind: "tool",
    harness: observed.harness,
    status: observed.status,
    turnId: observed.turnId,
    count: observed.count,
    commandCount: observed.commandCount,
    pollCount: observed.pollCount,
    exitCode: observed.exitCode,
    completed: observed.completed,
    outputMatched: observed.outputMatched,
  };
  return { sessionKey, turnId: turn.id, harness: turn.harness, httpStatus, origin };
}
