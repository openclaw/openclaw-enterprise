import assert from "node:assert/strict";
import {
  type AgentSelection,
  type createGatewaySessionEvidence,
  type SessionEvidenceOptions,
} from "./plugin-gateway-session-evidence.ts";

type SessionReader = ReturnType<typeof createGatewaySessionEvidence>["sessionEvidence"];
type SessionEvidence = Awaited<ReturnType<SessionReader>>;
type ProofMode = Parameters<typeof createGatewaySessionEvidence>[0]["proofMode"];
type SuccessOptions = SessionEvidenceOptions & {
  expectedExitCode?: number;
  requireAutomaticReview?: boolean;
};
type TranscriptRecord = Record<string, unknown>;
type ApprovalReview = {
  id?: unknown;
  status?: unknown;
  riskLevel?: unknown;
  userAuthorization?: unknown;
  rationale?: unknown;
};
type ApprovalResult = {
  toolCallId?: unknown;
  isError?: unknown;
  approvalReviews?: unknown;
};

// Codex's automatic reviewer reports a judgement as approved or denied with a risk level
// and user authorization. When the review itself cannot finish (session, parse or prompt
// errors) Codex fails closed: "denied" with no risk or authorization and a rationale that
// starts with this prefix. A review that ran out of time reports "timed_out". A changed
// authorization fails closed the same way but may be the policy's own change, so it is
// kept apart and never treated as a reviewer error.
const reviewerFailedRationale = "Automatic approval review failed: ";
const staleAuthorizationRationale = `${reviewerFailedRationale}authorization changed before approval could be applied`;

export function approvalReviewKind(review: ApprovalReview | null | undefined) {
  if (review?.status === "timed_out") {
    return "reviewer-error";
  }
  if (review?.status !== "denied") {
    return review?.status ?? "unknown";
  }
  if (typeof review.riskLevel === "string" || typeof review.userAuthorization === "string") {
    return "judged-deny";
  }
  if (typeof review.rationale !== "string") {
    return "denied-unclassified";
  }
  if (review.rationale.startsWith(staleAuthorizationRationale)) {
    return "stale-authorization";
  }
  return review.rationale.startsWith(reviewerFailedRationale)
    ? "reviewer-error"
    : "denied-unclassified";
}

// One line per failure: rationales (session and parse errors among them) can span lines.
export function describeApprovalReviews(results: readonly ApprovalResult[]) {
  const reviews = results.flatMap((result) => readApprovalReviews(result));
  if (reviews.length === 0) {
    return "no approval review recorded";
  }
  return reviews
    .map((review) => {
      const facts = [
        typeof review.riskLevel === "string" && review.riskLevel && `risk: ${review.riskLevel}`,
        typeof review.userAuthorization === "string" &&
          review.userAuthorization &&
          `authorization: ${review.userAuthorization}`,
      ].filter(Boolean);
      const reason =
        typeof review.rationale === "string" && review.rationale
          ? `: ${review.rationale.replace(/\s+/g, " ").trim()}`
          : "";
      return `${approvalReviewKind(review)}${facts.length ? ` (${facts.join(", ")})` : ""}${reason}`;
    })
    .join("; ");
}

// True only when the call failed and every review of it is a reviewer error, so no
// judgement (deny, approve or unclassified) was reached for it.
export function automaticReviewerErrored(results: readonly ApprovalResult[]) {
  return (
    results.length > 0 &&
    results.every((result) => {
      if (result.isError !== true) {
        return false;
      }
      const reviews = readApprovalReviews(result);
      return (
        reviews.length > 0 &&
        reviews.every((review) => approvalReviewKind(review) === "reviewer-error")
      );
    })
  );
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is TranscriptRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function transcriptRecords(value: unknown, label: string): TranscriptRecord[] {
  assert.ok(isArray(value) && value.every(isRecord), `expected ${label}`);
  return value;
}

function readApprovalReviews(result: ApprovalResult): ApprovalReview[] {
  return transcriptRecords(result.approvalReviews ?? [], "Gateway approval reviews");
}

function completedCodexRun(turn: TranscriptRecord) {
  return turn.promptSeen && (turn.terminalAssistantSeen || turn.gatewayRunCompletion);
}

// For a later reply, a different valid pair can establish that the run completed.
// It cannot establish which tool produced the result we are reporting.
function completedCodexToolPair(
  turn: TranscriptRecord,
  call: TranscriptRecord,
  result: TranscriptRecord,
) {
  return (
    completedCodexRun(turn) &&
    (turn.terminalAssistantSeen ||
      (typeof call.id === "string" &&
        call.id.trim().length > 0 &&
        result.toolCallId === call.id &&
        typeof call.seq === "number" &&
        typeof result.seq === "number" &&
        call.seq < result.seq &&
        typeof call.mirrorIdentity === "string" &&
        result.mirrorIdentity === call.mirrorIdentity.slice(0, -":call".length) + ":result"))
  );
}

function codexToolTurnPrefix(identity: unknown, suffix: ":call" | ":result") {
  if (typeof identity !== "string" || !identity.endsWith(suffix)) {
    return undefined;
  }
  const withoutSuffix = identity.slice(0, -suffix.length);
  const marker = ":tool:";
  const index = withoutSuffix.lastIndexOf(marker);
  return index === -1 ? undefined : withoutSuffix.slice(0, index);
}

function assertSuccessfulSession(
  evidence: SessionEvidence,
  { sessionKey }: SessionEvidenceOptions,
) {
  assert.equal(evidence.exists, true, `${sessionKey} must have a persisted transcript.`);
  assert.equal(
    evidence.userMarkerSeen,
    true,
    `${sessionKey} must include the marker-bearing user request.`,
  );
  assert.equal(
    evidence.assistantMarkerSeen,
    true,
    `${sessionKey} must include the completed marker-bearing assistant response.`,
  );
  assert.equal(evidence.assistantError, false, `${sessionKey} assistant turn must succeed.`);
}

function findSuccessfulToolPair(
  calls: readonly TranscriptRecord[],
  results: readonly TranscriptRecord[],
  options: SuccessOptions,
) {
  for (const call of calls) {
    if (
      (options.expectedArguments !== undefined || options.codeModeCall !== undefined) &&
      call.matchesArguments !== true
    ) {
      continue;
    }
    const result = results.find(
      (candidate) =>
        candidate.toolCallId === call.id &&
        candidate.isError === false &&
        candidate.matchesResult === true,
    );
    if (result) {
      return { call, result };
    }
  }
}

function assertCompletedCodexToolTurn(
  evidence: SessionEvidence,
  sessionKey: string,
  call: TranscriptRecord,
  result: TranscriptRecord,
  messages: { mirror: string; completion: string },
) {
  const turnPrefix = codexToolTurnPrefix(call.mirrorIdentity, ":call");
  assert.ok(
    turnPrefix && turnPrefix === codexToolTurnPrefix(result.mirrorIdentity, ":result"),
    messages.mirror,
  );
  const turn = transcriptRecords(evidence.codexTurns, "Gateway Codex turns").find(
    (candidate) => candidate.turnPrefix === turnPrefix,
  );
  assert.ok(
    turn &&
      completedCodexToolPair(turn, call, result) &&
      turn.toolCallMirrorSeen &&
      turn.toolResultMirrorSeen,
    `${sessionKey} ${messages.completion}: ${JSON.stringify({
      runtime: evidence.runtime,
      sessionId: evidence.sessionId,
      turnPrefix,
      turn,
      markerUserMessages: evidence.markerUserMessages,
      markerAssistantMessages: evidence.markerAssistantMessages,
    })}`,
  );
  return turn;
}

export function createPluginTranscriptAssertions(
  sessionEvidence: SessionReader,
  proofMode: ProofMode,
) {
  async function assertSessionToolCallEvidence(agent: AgentSelection, options: SuccessOptions) {
    const evidence = await sessionEvidence(agent, options);
    assertSuccessfulSession(evidence, options);
    const calls = transcriptRecords(evidence.calls, "Gateway tool calls");
    const results = transcriptRecords(evidence.results, "Gateway tool results");
    const matchedPair = findSuccessfulToolPair(calls, results, options);
    if (!matchedPair) {
      const approvalReviewSummary = describeApprovalReviews(results);
      // Lead with the review outcome so the first line says whether a reviewer judged
      // the read or failed to judge it (finding 1980).
      const error = new assert.AssertionError({
        message: `native transcript for ${options.sessionKey} did not include ${options.toolName ?? "a list_calendars tool"} with a matching successful result (approval reviews: ${approvalReviewSummary}): ${JSON.stringify(
          {
            runtime: evidence.runtime,
            sessionId: evidence.sessionId,
            promptReportSource: evidence.promptReportSource,
            promptToolNames: evidence.promptToolNames,
            calls: evidence.calls,
            results: evidence.results,
            diagnostics: evidence.diagnostics,
          },
        )}`,
        actual: undefined,
        expected: true,
        operator: "==",
      });
      throw Object.assign(error, {
        automaticReviewerErrored: automaticReviewerErrored(results),
        approvalReviewSummary,
      });
    }
    const { call: matched, result } = matchedPair;
    if (proofMode === "openclaw") {
      assert.ok(
        isArray(evidence.promptToolNames),
        `${options.sessionKey} must have a run-sourced systemPromptReport.tools.entries snapshot: ${JSON.stringify(
          {
            runtime: evidence.runtime,
            sessionId: evidence.sessionId,
            promptReport: evidence.promptReportShape,
          },
        )}`,
      );
      assert.ok(
        evidence.promptToolNames.includes(matched.name),
        `${options.sessionKey} prompt tools must advertise ${matched.name}: ${JSON.stringify({
          runtime: evidence.runtime,
          sessionId: evidence.sessionId,
          promptReportSource: evidence.promptReportSource,
          promptToolNames: evidence.promptToolNames,
        })}`,
      );
    }
    if (options.expectedExitCode !== undefined) {
      assert.equal(
        result.exitCode,
        options.expectedExitCode,
        `native tool ${matched.name} must exit with code ${options.expectedExitCode}: ${JSON.stringify(result.resultDetails)}`,
      );
    }
    const codexTurn =
      proofMode === "codex"
        ? assertCompletedCodexToolTurn(evidence, options.sessionKey, matched, result, {
            mirror: `${options.sessionKey} Codex native tool call/result must share one mirrored turn.`,
            completion:
              "Codex run must include a native prompt and tool call/result plus an owned terminal reply",
          })
        : undefined;
    const approvedReviews = transcriptRecords(
      result.approvalReviews,
      "Gateway approval reviews",
    ).filter((review) => review.status === "approved");
    if (options.requireAutomaticReview) {
      assert.equal(calls.length, 1, "the reviewed turn must perform exactly the requested read");
      assert.ok(
        approvedReviews.length > 0,
        "the successful native read must carry an approved automatic review",
      );
    }
    return {
      runtime: evidence.runtime,
      sessionId: evidence.sessionId,
      toolName: matched.name,
      toolCallId: matched.id,
      ...(matched.targetId ? { targetId: matched.targetId, targetName: matched.targetName } : {}),
      ...(options.expectedCatalog ? { catalog: result.catalog } : {}),
      promptAdvertised: proofMode === "openclaw",
      ...(proofMode === "openclaw"
        ? {
            promptReport: {
              ...(isRecord(evidence.promptReportShape) ? evidence.promptReportShape : {}),
              toolNames: evidence.promptToolNames,
            },
          }
        : {}),
      ...(codexTurn?.terminalAssistantSeen ? { codexMirrorTurnVerified: true } : {}),
      ...(codexTurn?.gatewayRunCompletion
        ? { codexGatewayRunCompletion: codexTurn.gatewayRunCompletion }
        : {}),
      resultMatched: true,
      ...(options.codeModeCall ? { codeModeProgramVerified: result.codeModeProgramVerified } : {}),
      ...(options.expectedExitCode === undefined ? {} : { exitCode: result.exitCode }),
      approvedReviewIds: approvedReviews.map((review) => review.id),
    };
  }

  async function assertSessionToolFailureEvidence(
    agent: AgentSelection,
    options: SessionEvidenceOptions,
  ) {
    const evidence = await sessionEvidence(agent, options);
    assert.equal(evidence.userMarkerSeen, true);
    assert.equal(evidence.assistantMarkerSeen, true);
    const calls = transcriptRecords(evidence.calls, "Gateway tool calls");
    assert.equal(
      calls.length,
      1,
      `the denied turn must attempt exactly the requested tool: ${JSON.stringify(evidence.diagnostics)}`,
    );
    const results = transcriptRecords(evidence.results, "Gateway tool results");
    assert.equal(results.length, 1, "the denied call must have a terminal result");
    // The two length assertions guarantee the first record in each array.
    const call = calls[0]!;
    const result = results[0]!;
    assert.equal(result.toolCallId, call.id);
    assert.equal(result.matchesTarget, true, "the refusal must belong to the attempted target");
    if (proofMode === "openclaw") {
      assert.ok(
        isArray(evidence.promptToolNames) && evidence.promptToolNames.includes(call.name),
        "the run must advertise the actual attempted tool or dispatcher",
      );
    }
    if (proofMode === "codex") {
      assertCompletedCodexToolTurn(evidence, options.sessionKey, call, result, {
        mirror: "denial must correlate to the attempted native call",
        completion:
          "denied Codex run must include a native prompt and tool call/result plus an owned terminal reply",
      });
    }
    assert.equal(result.isError, true, "denial must prevent a successful tool result");
    return { sessionId: evidence.sessionId, call, result };
  }

  async function assertSessionToolDeniedEvidence(
    agent: AgentSelection,
    options: SessionEvidenceOptions,
  ) {
    const { result } = await assertSessionToolFailureEvidence(agent, options);
    assert.equal(
      result.deniedByUser,
      true,
      "the native failure must come from denied approval, not a provider error",
    );
    assert.equal(result.matchesResult, false, "denial must not expose the provider result");
  }

  async function assertSessionToolPolicyDeniedEvidence(
    agent: AgentSelection,
    options: SessionEvidenceOptions,
  ) {
    const patterns = [options.resultPattern].flat();
    assert.ok(
      patterns.length > 0 &&
        patterns.every((pattern) => typeof pattern === "string" && pattern.length),
      "policy proof requires the expected native refusal",
    );
    assert.ok(
      options.expectedArguments || options.codeModeCall,
      "policy proof requires the intended invocation target",
    );
    const { sessionId, call, result } = await assertSessionToolFailureEvidence(agent, options);
    assert.equal(
      call.matchesArguments,
      true,
      "the model must attempt the exact requested action and target",
    );
    assert.equal(
      result.matchesResult,
      true,
      `the attempted tool must return the policy refusal: ${JSON.stringify({ resultDetails: result.resultDetails, errorLines: result.errorLines })}`,
    );
    return {
      sessionId,
      toolCallId: call.id,
      toolName: call.name,
      ...(options.codeModeCall ? { codeModeProgramVerified: result.codeModeProgramVerified } : {}),
      ...(Array.isArray(options.resultPattern)
        ? { matchedRefusal: result.matchedResultPattern }
        : {}),
      ...(call.targetId
        ? {
            targetId: call.targetId,
            targetName: call.targetName,
          }
        : {}),
    };
  }

  async function assertNoSessionToolCallEvidence(
    agent: AgentSelection,
    options: SessionEvidenceOptions,
  ) {
    const evidence = await sessionEvidence(agent, { ...options, resultPattern: "" });
    assertSuccessfulSession(evidence, options);
    if (proofMode === "openclaw") {
      assert.ok(
        isArray(evidence.promptToolNames),
        `${options.sessionKey} must have a run-sourced systemPromptReport.tools.entries snapshot.`,
      );
      assert.equal(
        evidence.promptToolNames.includes(options.toolName),
        false,
        `${options.sessionKey} direct prompt schemas still advertised ${options.toolName}: ${JSON.stringify(
          {
            runtime: evidence.runtime,
            sessionId: evidence.sessionId,
            promptReportSource: evidence.promptReportSource,
            promptToolNames: evidence.promptToolNames,
          },
        )}`,
      );
    } else {
      // The Gateway prompt report omits native Codex tools. An empty trace alone cannot
      // distinguish a filtered tool from a turn that never ran or finished.
      assert.ok(
        transcriptRecords(evidence.codexTurns, "Gateway Codex turns").some(completedCodexRun),
        `${options.sessionKey} must include a completed marker-bearing Codex run: ${JSON.stringify({
          runtime: evidence.runtime,
          sessionId: evidence.sessionId,
          codexTurns: evidence.codexTurns,
          markerUserMessages: evidence.markerUserMessages,
          markerAssistantMessages: evidence.markerAssistantMessages,
        })}`,
      );
    }
    assert.equal(
      transcriptRecords(evidence.calls, "Gateway tool calls").length,
      0,
      `disabled/removed/sibling turn ${options.sessionKey} still invoked ${options.toolName}: ${JSON.stringify(
        {
          runtime: evidence.runtime,
          sessionId: evidence.sessionId,
          calls: evidence.calls,
        },
      )}`,
    );
  }

  return {
    assertSessionToolCallEvidence,
    assertSessionToolDeniedEvidence,
    assertSessionToolPolicyDeniedEvidence,
    assertNoSessionToolCallEvidence,
  };
}
