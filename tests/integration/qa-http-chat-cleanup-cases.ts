import assert from "node:assert/strict";
import test from "node:test";
import { runQaHttpChatWithCleanup } from "../helpers/qa-http-chat-cleanup.ts";

const expectedTrace = [
  "verify",
  "record started",
  "record finished",
  "first disposal started",
  "first disposal finished",
  "second disposal started",
  "second disposal finished",
];

function startVerification({
  bodyFailure,
  recordingFailure,
  firstDisposalFailure,
  secondDisposalFailure,
}: {
  bodyFailure?: { error: unknown };
  recordingFailure?: Error;
  firstDisposalFailure?: Error;
  secondDisposalFailure?: Error;
} = {}) {
  const trace: string[] = [];
  const first = Symbol("first handle");
  const second = Symbol("second handle");
  const cleanupHandles: symbol[] = [];

  async function finalize(step: string, failure: Error | undefined) {
    // Separate start and finish so the trace detects overlapping finalizers.
    trace.push(`${step} started`);
    await Promise.resolve();
    trace.push(`${step} finished`);
    if (failure !== undefined) {
      throw failure;
    }
  }

  const verification = runQaHttpChatWithCleanup({
    async verify() {
      trace.push("verify");
      await Promise.resolve();
      cleanupHandles.push(first, second);
      if (bodyFailure !== undefined) {
        throw bodyFailure.error;
      }
    },
    record: () => finalize("record", recordingFailure),
    cleanupHandles,
    dispose(handle) {
      assert.ok(handle === first || handle === second, "dispose only registered handles");
      return handle === first
        ? finalize("first disposal", firstDisposalFailure)
        : finalize("second disposal", secondDisposalFailure);
    },
  });
  return { trace, verification };
}

export function registerQaHttpChatCleanupCases() {
  test("QA HTTP chat finalization records outcomes and disposes registered handles in order", async () => {
    const { trace, verification } = startVerification();
    await verification;
    assert.deepEqual(trace, expectedTrace);
  });

  test("QA HTTP chat finalization preserves the body failure when recording and disposal fail", async () => {
    const primary = new Error("verification failed");
    const { trace, verification } = startVerification({
      bodyFailure: { error: primary },
      recordingFailure: new Error("recording failed"),
      firstDisposalFailure: new Error("first disposal failed"),
    });
    await assert.rejects(verification, (error) => error === primary);
    assert.deepEqual(trace, expectedTrace);
  });

  test("QA HTTP chat finalization preserves an undefined body rejection", async () => {
    const { trace, verification } = startVerification({
      bodyFailure: { error: undefined },
      firstDisposalFailure: new Error("first disposal failed"),
    });
    await assert.rejects(verification, (error) => error === undefined);
    assert.deepEqual(trace, expectedTrace);
  });

  test("QA HTTP chat finalization disposes registered handles after recording fails", async () => {
    const recording = new Error("recording failed");
    const { trace, verification } = startVerification({ recordingFailure: recording });
    await assert.rejects(verification, (error) => error === recording);
    assert.deepEqual(trace, expectedTrace);
  });

  test("QA HTTP chat finalization continues after a disposal fails", async () => {
    const firstDisposal = new Error("first disposal failed");
    const { trace, verification } = startVerification({ firstDisposalFailure: firstDisposal });
    await assert.rejects(verification, (error) => error === firstDisposal);
    assert.deepEqual(trace, expectedTrace);
  });

  test("QA HTTP chat finalization aggregates recording and disposal failures in order", async () => {
    const recording = new Error("recording failed");
    const firstDisposal = new Error("first disposal failed");
    const secondDisposal = new Error("second disposal failed");
    const { trace, verification } = startVerification({
      recordingFailure: recording,
      firstDisposalFailure: firstDisposal,
      secondDisposalFailure: secondDisposal,
    });
    await assert.rejects(verification, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 3);
      assert.equal(error.errors[0], recording);
      assert.equal(error.errors[1], firstDisposal);
      assert.equal(error.errors[2], secondDisposal);
      return true;
    });
    assert.deepEqual(trace, expectedTrace);
  });
}
