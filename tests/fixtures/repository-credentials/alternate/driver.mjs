import { randomBytes, createHash } from "node:crypto";
import { createAlternatePlan, denied } from "./policy.mjs";

export { denied } from "./policy.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createAlternateDriver({
  binding,
  authority,
  custody,
  origin,
  clock,
  accepted,
  lifetimeMs,
  operationMs,
  controls,
  events,
}) {
  for (const key of Object.keys(binding)) {
    if (authority[key] !== binding[key]) {
      throw new Error("foreign-authority");
    }
  }
  const outcomes = new WeakMap();
  const plans = new WeakSet();
  const handles = new WeakMap();
  const renewalBytes = randomBytes(32);
  const renewalDigest = digest(renewalBytes);
  const renewal = custody.retainRenewal(renewalBytes);
  renewalBytes.fill(0);
  let finalized = false;
  let current;
  let generation = 0;
  function result(attempt, value, settled = Promise.resolve()) {
    const original = Object.freeze({ attemptId: attempt.id, ...value });
    outcomes.set(original, settled);
    return original;
  }
  const driver = {
    binding,
    replacement: "drain-before",
    cleanup: "revocable",
    async acquire(attempt, previous, minimumValidityMs) {
      custody.assertAttempt(attempt, "acquire");
      if (previous !== undefined && !handles.has(previous)) {
        throw new Error("foreign-credential");
      }
      let dispatched = false;
      try {
        attempt.assertAdmitted();
        if (finalized) {
          return result(attempt, {
            kind: "reauthorization-required",
            code: "authority-unavailable",
          });
        }
        await custody.withRenewal(renewal, async (bytes) => {
          if (digest(bytes) !== renewalDigest) {
            throw new Error("renewal-lost");
          }
        });
        attempt.assertAdmitted();
        attempt.observeDispatch();
        dispatched = true;
        events.push({
          kind: "rotate",
          attemptId: attempt.id,
          sessionId: authority.sessionId,
          generation: ++generation,
          permission: "source:update",
          previous: previous !== undefined,
        });
        const capture = () => {
          if (current) {
            accepted.delete(handles.get(current).digest);
          }
          const bytes = randomBytes(24).toString("hex");
          const observation = {
            observedWallMs: clock.wallNow(),
            expiresAtWallMs: clock.wallNow() + lifetimeMs,
          };
          const credential = custody.capture(attempt, Buffer.from(bytes), observation);
          handles.set(credential, {
            digest: digest(bytes),
            expires: observation.expiresAtWallMs,
          });
          accepted.set(digest(bytes), observation.expiresAtWallMs);
          current = credential;
          controls.observe?.({ kind: "capture", attemptId: attempt.id });
          return { kind: "acquired", credential, ...observation };
        };
        if (controls.lateCapture) {
          const settled = controls.lateCapture.then(() => {
            capture();
          });
          if (controls.waitForAcquisitionAbort) {
            await new Promise((resolve) => {
              if (attempt.signal.aborted) {
                resolve();
              } else {
                attempt.signal.addEventListener("abort", resolve, { once: true });
              }
            });
          }
          return result(attempt, { kind: "uncertain" }, settled);
        }
        const acquired = capture();
        if (controls.rejectScope) {
          return result(attempt, { kind: "rejected", code: "scope-mismatch" });
        }
        if (lifetimeMs < minimumValidityMs) {
          return result(attempt, { kind: "rejected", code: "insufficient-validity" });
        }
        return result(attempt, acquired);
      } catch {
        return result(attempt, { kind: dispatched ? "uncertain" : "not-dispatched" });
      }
    },
    async retire(attempt, credential) {
      custody.assertAttempt(attempt, "retire");
      if (!handles.has(credential)) {
        throw new Error("foreign-credential");
      }
      try {
        attempt.assertAdmitted();
        await custody.withRetirement(attempt, credential, async (bytes) => {
          attempt.observeDispatch();
          // Retirement revokes this access token, never the replacement or
          // the session's independent renewal authority.
          accepted.delete(digest(bytes));
        });
        events.push({ kind: "retire", sessionId: authority.sessionId });
        return result(attempt, { kind: "revoked" });
      } catch {
        return result(attempt, { kind: "uncertain" });
      }
    },
    async finalize(attempt) {
      custody.assertAttempt(attempt, "finalize");
      try {
        attempt.assertAdmitted();
        await custody.withRenewal(renewal, async (bytes) => {
          if (digest(bytes) !== renewalDigest) {
            throw new Error("renewal-lost");
          }
          attempt.observeDispatch();
        });
        await custody.disposeRenewal(renewal);
        finalized = true;
        events.push({ kind: "finalize", sessionId: authority.sessionId });
        return result(attempt, { kind: "finalized" });
      } catch {
        return result(attempt, { kind: "cleanup-pending", reason: "uncertain" });
      }
    },
    async settle(original) {
      if (!outcomes.has(original)) {
        throw new Error("foreign-outcome");
      }
      controls.observe?.({ kind: "settlement-started", attemptId: original.attemptId });
      await outcomes.get(original);
      controls.observe?.({ kind: "settlement-completed", attemptId: original.attemptId });
    },
    plan(request) {
      const plan = createAlternatePlan(request, {
        sessionId: authority.sessionId,
        origin,
        operationMs,
      });
      if (plan === denied) {
        return plan;
      }
      plans.add(plan);
      controls.observe?.({ kind: "plan", method: plan.method });
      return plan;
    },
    prepareAuthentication(credential, plan) {
      if (finalized || !plans.has(plan) || !handles.has(credential)) {
        throw new Error("foreign-or-closed-authority");
      }
      return async (bytes, send) => {
        events.push({ kind: "authentication", sessionId: authority.sessionId });
        await controls.beforeSend?.();
        return send(
          Object.freeze({
            plan,
            headers: Object.freeze({
              ...plan.requestHeaders,
              "x-repository-key": Buffer.from(bytes).toString(),
            }),
          }),
        );
      };
    },
  };
  return driver;
}
