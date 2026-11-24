import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import {
  createReceiptPersistenceFaults,
  readReceipt,
  stageReceiptExchange,
} from "./static-egress-receipt-support.ts";

export async function runStaticEgressReceiptRestartCase(t: TestContext): Promise<void> {
  const f = await staticEgressFixture(t);
  const { captured, ready, input, permit } = await stageReceiptExchange(f);
  assert.ok((await f.authorize(permit)).allowed);
  const possible = await readReceipt(f, input);
  assert.ok(possible);
  assert.deepEqual(possible.outcome, { kind: "uncertain", dispatch: "possible" });
  assert.equal(possible.observation, null);
  const response = await f.send(captured, ready);
  const foreign = await f.beginExchange(
    f.metadata({ instance_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  );
  foreign.stream.write({ response });
  await assert.rejects(
    foreign.next(),
    { code: 7 },
    "another response stream cannot claim the accepted reply",
  );
  const protectedResponse = await f.protect(captured, response);
  assert.ok("body" in protectedResponse && protectedResponse.body);
  const observed = await readReceipt(f, input);
  assert.ok(observed);
  assert.deepEqual(observed.observation, { kind: "response", dispatch: "confirmed", status: 200 });
  assert.deepEqual(observed.outcome, possible.outcome);
  assert.deepEqual(observed.authorization, possible.authorization);
  assert.equal(
    observed.settled,
    false,
    "body decision bytes are not final supplier application proof",
  );
  assert.equal(observed.feedback, null);
  assert.deepEqual(
    Object.keys(observed).sort(),
    [
      "sender",
      "instanceId",
      "useId",
      "attemptId",
      "material",
      "deadlineAt",
      "authorization",
      "observation",
      "outcome",
      "settled",
      "feedback",
    ].sort(),
  );
  assert.ok(!JSON.stringify(observed).includes("synthetic-key-initial"));
  await f.restartAuthority();
  const replay = (await f.resolve(captured)).ready;
  assert.ok(replay, "restarted authority has no transient operation registry");
  assert.ok((await f.authorize(f.permitRequest(captured, replay))).refused);
  assert.deepEqual(await readReceipt(f, input), observed);
  assert.equal(f.providerRequests.length, 1, "recovery never dispatches another request");
}

export async function runStaticEgressCredentialRejectionCase(t: TestContext): Promise<void> {
  const f = await staticEgressFixture(t);
  type ProviderBody = NonNullable<Parameters<typeof f.setResponse>[0]["body"]>;
  async function exchange(status: number, body: ProviderBody) {
    f.setResponse({ status, body });
    const { captured, ready, input, permit } = await stageReceiptExchange(f);
    assert.ok((await f.authorize(permit)).allowed);
    const result = await f.protect(captured, await f.send(captured, ready));
    const receipt = await readReceipt(f, input);
    assert.ok(receipt);
    return { result, receipt };
  }
  const nonRejections: [number, ProviderBody][] = [
    [401, { error: "invalid credential" }],
    [401, { error: { code: "insufficient_quota", type: "invalid_request_error" } }],
    [403, { error: { code: "invalid_api_key", type: "invalid_request_error" } }],
  ];
  for (const [status, body] of nonRejections) {
    const value = await exchange(status, body);
    assert.ok("body" in value.result && value.result.body);
    assert.deepEqual(value.receipt.observation, {
      kind: "response",
      dispatch: "confirmed",
      status,
    });
    assert.equal(value.receipt.feedback, null, "HTTP failure alone is not credential rejection");
  }
  // Even recognizable bytes in an unfinished supplier unit do not establish a
  // complete provider rejection. Block the response without fencing the credential.
  f.setResponse({
    status: 401,
    body: { error: { code: "invalid_api_key", type: "invalid_request_error" } },
  });
  const partial = await stageReceiptExchange(f);
  assert.ok((await f.authorize(partial.permit)).allowed);
  const partialResponse = await f.send(partial.captured, partial.ready);
  const incomplete = await f.protect(partial.captured, {
    ...partialResponse,
    response_complete: false,
  });
  assert.ok("blocked" in incomplete);
  assert.equal(incomplete.blocked, true);
  const partialReceipt = await readReceipt(f, partial.input);
  assert.ok(partialReceipt?.observation);
  assert.equal(partialReceipt.observation.kind, "response_blocked");
  assert.equal(partialReceipt.feedback, null);
  const acceptedRejection = await exchange(401, {
    error: { code: "invalid_api_key", type: "invalid_request_error" },
  });
  assert.ok("body" in acceptedRejection.result && acceptedRejection.result.body);
  assert.deepEqual(acceptedRejection.receipt.observation, {
    kind: "provider_rejected",
    dispatch: "confirmed",
    status: 401,
  });
  assert.equal(acceptedRejection.receipt.feedback, "fenced");
  await f.rotateSecret("synthetic-key-next-version");
  const rejection = {
    error: {
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: "synthetic-key-next-version",
    },
  };
  const blocked = await exchange(401, rejection);
  assert.ok("blocked" in blocked.result && blocked.result.blocked);
  assert.deepEqual(blocked.receipt.observation, {
    kind: "response_blocked",
    dispatch: "confirmed",
    code: "response_policy",
  });
  assert.equal(
    blocked.receipt.feedback,
    "fenced",
    "actual rejection fences even when response bytes cannot be returned",
  );
  assert.equal(blocked.receipt.settled, false);
  assert.ok(!JSON.stringify(blocked.receipt).includes("synthetic-key-next-version"));
  const next = f.capture();
  const ready = (await f.resolve(next)).ready;
  assert.ok(ready);
  assert.ok((await f.authorize(f.permitRequest(next, ready))).refused);
  assert.equal(f.providerRequests.length, 6);
}

export async function runStaticEgressReceiptAuthorizationFailureCase(
  t: TestContext,
): Promise<void> {
  for (const scenario of [
    "reject",
    "lost_ack",
    "revoke",
    "deny_lost_ack",
    "deadline",
    "check_deadline",
    "cancel",
  ] as const) {
    await t.test(scenario, async (t) => {
      let elapsed = 0;
      const fault = createReceiptPersistenceFaults();
      const f = await staticEgressFixture(t, {
        now: () => new Date(Date.now() + elapsed),
        appFactory: fault.appFactory,
      });
      const { captured, input, permit } = await stageReceiptExchange(f);
      let method: Parameters<typeof fault.arm>[0] = "insert";
      if (scenario === "check_deadline") {
        method = "isEgressMaterialRejected";
      } else if (scenario === "lost_ack") {
        method = "authorize";
      }
      const kind = scenario === "reject" || scenario === "lost_ack" ? scenario : "pause";
      const gate = fault.arm(method, kind);
      t.after(gate.release);
      const result = f.authorize(permit, scenario === "cancel" ? { cancelAfterMs: 50 } : {});
      if (scenario !== "reject") {
        const cancellation =
          scenario === "cancel" ? assert.rejects(result, { code: 1 }) : undefined;
        await gate.reached;
        if (scenario === "revoke" || scenario === "deny_lost_ack") {
          await f.revoke();
        }
        // The refused settlement commits but its acknowledgment is lost: the sender sees
        // unavailable, while the receipt records the committed refusal.
        const settlement = scenario === "deny_lost_ack" ? fault.arm("save", "lost_ack") : undefined;
        if (settlement) {
          t.after(settlement.release);
        }
        if (scenario === "deadline" || scenario === "check_deadline") {
          elapsed = 31_000;
        }
        if (scenario === "check_deadline") {
          // The final policy-and-receipt transaction has committed. Prune the
          // expired handle before its acknowledgment returns; no permit may escape.
          assert.ok((await f.resolve(f.capture())).ready);
        }
        if (cancellation) {
          await cancellation;
        }
        gate.release();
        if (settlement) {
          await settlement.reached;
          settlement.release();
        }
      }
      if (scenario !== "cancel") {
        const { refused } = await result;
        assert.ok(refused, scenario);
        if (scenario === "deny_lost_ack") {
          assert.equal(refused.code, f.refusalCode("UNAVAILABLE"));
        }
      }
      const stored = await readReceipt(f, input);
      if (scenario === "reject") {
        assert.equal(stored, undefined);
      } else {
        assert.ok(stored);
        if (scenario === "lost_ack") {
          assert.ok(
            stored.authorization?.association.custodyId,
            "lost the exact authorized dispatch acknowledgment, not an earlier begin",
          );
          assert.equal(stored.settled, false);
          assert.deepEqual(stored.outcome, { kind: "uncertain", dispatch: "possible" });
          await f.restartAuthority();
          const replay = (await f.resolve(captured)).ready;
          assert.ok(replay);
          assert.ok((await f.authorize(f.permitRequest(captured, replay))).refused);
        }
        if (["revoke", "deadline"].includes(scenario)) {
          assert.equal(stored.outcome.kind, "refused");
          assert.equal(stored.outcome.dispatched, false);
        }
        if (scenario === "check_deadline") {
          assert.ok(stored.authorization?.association.custodyId);
          assert.deepEqual(stored.outcome, { kind: "uncertain", dispatch: "possible" });
          assert.equal(stored.settled, false);
        }
        if (scenario === "deny_lost_ack") {
          assert.equal(
            stored.settled,
            true,
            "refusal committed before its acknowledgment was lost",
          );
          assert.equal(stored.authorization, null);
          assert.deepEqual(stored.outcome, {
            kind: "refused",
            dispatched: false,
            error: { kind: "denied", code: "unauthorized" },
          });
        }
      }
      assert.equal(f.providerRequests.length, 0);
    });
  }
}

export async function runStaticEgressResponseCommitCase(t: TestContext): Promise<void> {
  for (const scenario of ["reject", "lost_ack", "deadline"] as const) {
    await t.test(scenario, async (t) => {
      let elapsed = 0;
      const fault = createReceiptPersistenceFaults();
      const f = await staticEgressFixture(t, {
        now: () => new Date(Date.now() + elapsed),
        appFactory: fault.appFactory,
      });
      f.setResponse({
        status: 401,
        body: { error: { code: "invalid_api_key", type: "invalid_request_error" } },
      });
      const { captured, ready, input, permit } = await stageReceiptExchange(f);
      assert.ok((await f.authorize(permit)).allowed);
      const response = await f.send(captured, ready);
      const gate = fault.arm("save", scenario === "deadline" ? "pause" : scenario);
      t.after(gate.release);
      const pending = f.protect(captured, response);
      const failed = scenario === "deadline" ? undefined : assert.rejects(pending, { code: 14 });
      if (scenario !== "reject") {
        await gate.reached;
        if (scenario === "deadline") {
          elapsed = 31_000;
        }
        gate.release();
      }
      if (failed) {
        await failed;
      } else {
        const result = await pending;
        assert.ok("blocked" in result && result.blocked);
      }
      const receipt = await readReceipt(f, input);
      assert.ok(receipt);
      assert.deepEqual(receipt.outcome, { kind: "uncertain", dispatch: "possible" });
      assert.equal(receipt.settled, false);
      const fenced = await f.controller.transact((unit) =>
        unit.credentialSources.isEgressMaterialRejected(input.material),
      );
      assert.equal(
        fenced,
        scenario !== "reject",
        "observation and exact-version fence share one real state transaction",
      );
      assert.equal(receipt.feedback, fenced ? "fenced" : null);
      assert.equal(receipt.observation?.kind, fenced ? "provider_rejected" : undefined);
      assert.equal(f.providerRequests.length, 1);
    });
  }
}
